//! Agent child-process supervision.
//!
//! Four submodules carve up the concern:
//!
//! - [`sidecar`] — locating the agent binary: `project_root` (dev) and
//!   the bundled `aethon-agent` sidecar (release).
//! - [`spawn`] — building the `Command`, applying the user/worker env,
//!   spawning the child with piped stdio, and wiring its handles to
//!   the reader threads. Idempotent per agent key.
//! - [`readers`] — the stdout / stderr reader threads. Stdout is also
//!   the producer side of the `mutation_routes` map and the source of
//!   `agent-reloaded` / `agent-crashed` events.
//! - [`process`] — the public surface: `AgentProcesses` (the state
//!   handle Tauri `.manage`s), `AgentWorker`, the `GLOBAL_AGENT_KEY`
//!   constant, key helpers, and the high-level
//!   `ensure_global_agent` / `write_agent_payload` /
//!   `retire_agent_key` / `route_payload_key` entry points called from
//!   `agent_commands` and the extension-reload pipeline.
//!
//! Re-exports below keep the public import paths
//! (`crate::agent_process::AgentProcesses`, etc.) identical to the
//! pre-split single-file layout, so `lib.rs` and every caller stay
//! unchanged.

mod process;
mod readers;
mod sidecar;
mod spawn;

pub(crate) use process::{
    AgentProcesses, AgentWorker, GLOBAL_AGENT_KEY, WorkerMeta, ensure_global_agent,
    retire_agent_key, route_payload_key, write_agent_payload,
};
pub(crate) use sidecar::project_root;
