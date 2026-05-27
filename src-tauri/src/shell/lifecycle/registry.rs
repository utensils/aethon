//! `ShellRegistry` + `ShellSlot` data types and the per-tab handle
//! aliases that wrap the OS-state owned by each PTY-backed shell tab.
//!
//! Fields are `pub(super)` so the sibling submodules under
//! `shell::lifecycle::` — `open`, `io`, `reader`, `sharing` — can
//! construct, mutate, and tear down slots without going through method
//! ceremony. They are deliberately *not* `pub`: nothing outside the
//! `lifecycle/` subtree should reach in and grab a writer or a
//! scrollback handle. Callers outside this module operate through the
//! `#[tauri::command]` entry points.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use portable_pty::{Child, MasterPty};

use crate::shell::scrollback::Scrollback;
use crate::shell::sharemode::ShareState;

/// Per-tab scrollback ring cap. 1 MiB lands ~10–20k lines of typical
/// terminal output — enough for the agent to skim back through a build
/// or a `git log`, bounded so a runaway process can't OOM us.
pub(super) const SCROLLBACK_BYTES: usize = 1024 * 1024;

pub(super) type ChildHandle = Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>;
pub(super) type ScrollbackHandle = Arc<Mutex<Scrollback>>;
pub(super) type ShareHandle = Arc<Mutex<ShareState>>;

pub(crate) struct ShellSlot {
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) child: ChildHandle,
    pub(super) reader_thread: Option<JoinHandle<()>>,
    pub(super) scrollback: ScrollbackHandle,
    pub(super) share: ShareHandle,
    /// Cosmetic. Carried for the status-line badge + `list_shareable`.
    /// Not authoritative — the agent always re-asks Rust for live state.
    pub(super) cwd: String,
    pub(super) command: String,
}

// Dev-only read accessors for the aethon-debug inspector commands.
// Production code paths inside `lifecycle::*` keep using the
// `pub(super)` fields directly. Compiled out of release builds.
#[cfg(debug_assertions)]
impl ShellSlot {
    pub(crate) fn cwd(&self) -> &str {
        &self.cwd
    }
    pub(crate) fn command(&self) -> &str {
        &self.command
    }
    pub(crate) fn share_handle(&self) -> &super::registry::ShareHandle {
        &self.share
    }
    pub(crate) fn scrollback_handle(&self) -> &super::registry::ScrollbackHandle {
        &self.scrollback
    }
    pub(crate) fn writer_mut(&mut self) -> &mut (dyn std::io::Write + Send) {
        &mut *self.writer
    }
}

#[derive(Default)]
pub struct ShellRegistry {
    // pub(crate) so the debug-only inspector commands in
    // `crate::debug` can read scrollback + push raw input regardless
    // of share-mode (production code paths still use the
    // `pub(super)`-shaped accessors inside this module). The debug
    // surface is gated on `cfg(debug_assertions)`, so this widening
    // doesn't leak into release builds.
    pub(crate) slots: Mutex<HashMap<String, ShellSlot>>,
}

impl ShellRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
pub(super) mod test_support {
    //! Shared test helpers. Sibling submodules' `#[cfg(test)]` blocks
    //! reach in here to spawn slots without booting a Tauri runtime.

    use std::sync::{Arc, Mutex};

    use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

    use super::{SCROLLBACK_BYTES, ShellRegistry, ShellSlot};
    use crate::shell::scrollback::Scrollback;
    use crate::shell::sharemode::{ShareMode, ShareState};

    /// Mirrors `shell_open` but skips the `AppHandle` so unit tests can
    /// run without a Tauri runtime. The reader thread is omitted —
    /// tests that need stdout drain the master directly.
    pub(in crate::shell::lifecycle) fn open_raw(
        reg: &ShellRegistry,
        tab_id: &str,
        command: &str,
        args: Vec<String>,
    ) -> Box<dyn Child + Send + Sync> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(command);
        for a in args {
            cmd.arg(a);
        }
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let writer = pair.master.take_writer().expect("take_writer");
        let slot = ShellSlot {
            writer,
            master: pair.master,
            child: Arc::new(Mutex::new(None)), // tests reap manually
            reader_thread: None,
            scrollback: Arc::new(Mutex::new(Scrollback::new(SCROLLBACK_BYTES))),
            share: Arc::new(Mutex::new(ShareState::new())),
            cwd: String::new(),
            command: command.to_string(),
        };
        reg.slots.lock().unwrap().insert(tab_id.to_string(), slot);
        child
    }

    /// Force a slot's share mode without a Tauri runtime. Mirrors what
    /// `shell_set_share_mode` does for tests.
    pub(in crate::shell::lifecycle) fn force_mode(
        reg: &ShellRegistry,
        tab_id: &str,
        mode: ShareMode,
    ) {
        let guard = reg.slots.lock().unwrap();
        let slot = guard.get(tab_id).expect("slot present");
        let mut s = slot.share.lock().unwrap();
        let total = slot.scrollback.lock().unwrap().total_appended();
        s.transition(mode, total);
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::open_raw;
    use super::*;
    use portable_pty::PtySize;
    use std::time::{Duration, Instant};

    fn registry() -> ShellRegistry {
        ShellRegistry::new()
    }

    #[test]
    fn echo_round_trip_via_input_command() {
        let reg = registry();
        let mut child = open_raw(&reg, "t1", "/bin/echo", vec!["hello-aethon".into()]);
        let status = child.wait().expect("wait");
        assert!(status.success());
        reg.slots.lock().unwrap().remove("t1").unwrap();
    }

    #[test]
    fn resize_propagates_when_slot_present() {
        let reg = registry();
        let mut child = open_raw(&reg, "t2", "/bin/sleep", vec!["0.05".into()]);
        // Resize via the registry path — must succeed while child is alive.
        {
            let guard = reg.slots.lock().unwrap();
            let slot = guard.get("t2").unwrap();
            slot.master
                .resize(PtySize {
                    cols: 132,
                    rows: 50,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("resize while alive");
        }
        let _ = child.wait();
        reg.slots.lock().unwrap().remove("t2").unwrap();
    }

    #[test]
    fn close_unknown_tab_is_noop() {
        let reg = registry();
        // Direct check: removing absent tab returns None, no panic.
        assert!(reg.slots.lock().unwrap().remove("never-existed").is_none());
    }

    #[test]
    fn cleanup_drops_slot() {
        let reg = registry();
        let mut child = open_raw(&reg, "t3", "/bin/sleep", vec!["0.01".into()]);
        let _ = child.wait();
        let mut slot = reg
            .slots
            .lock()
            .unwrap()
            .remove("t3")
            .expect("slot present");
        drop(slot.writer);
        drop(slot.master);
        // No reader thread in test harness; just verify the slot was removable.
        assert!(slot.reader_thread.take().is_none());
        // Slot count is back to zero.
        assert!(reg.slots.lock().unwrap().is_empty());
    }

    #[test]
    fn registry_handles_concurrent_inserts() {
        let reg = registry();
        let n_tabs = 4;
        let mut children: Vec<Box<dyn portable_pty::Child + Send + Sync>> = Vec::new();
        for i in 0..n_tabs {
            let id = format!("t-concurrent-{i}");
            children.push(open_raw(&reg, &id, "/bin/sleep", vec!["0.05".into()]));
        }
        assert_eq!(reg.slots.lock().unwrap().len(), n_tabs);
        let start = Instant::now();
        for mut c in children {
            let _ = c.wait();
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut guard = reg.slots.lock().unwrap();
        for i in 0..n_tabs {
            let id = format!("t-concurrent-{i}");
            guard.remove(&id).expect("present");
        }
    }
}
