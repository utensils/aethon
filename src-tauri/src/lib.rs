use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

struct AgentProcess(Mutex<Option<Child>>);

#[tauri::command]
fn send_message(
    message: String,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // Spawn agent if not running
    if guard.is_none() {
        let child = Command::new("bun")
            .arg("run")
            .arg("agent/main.ts")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn agent: {e}"))?;
        *guard = Some(child);

        // Spawn a reader thread for stdout
        let child_ref = guard.as_mut().unwrap();
        let stdout = child_ref.stdout.take().ok_or("no stdout")?;
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let _ = app_clone.emit("agent-response", text);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Write message to agent stdin
    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    let payload = serde_json::json!({"type": "chat", "content": message});
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![send_message])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
