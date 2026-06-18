//! Native A2UI canvas windows.
//!
//! These are ordinary OS windows with labels derived from a validated id
//! (`aethon-canvas-<id>`). The main webview remains the bridge owner; canvas
//! windows hydrate their own persisted record and render a bare A2UI surface.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const STORE_FILE: &str = "native-windows.json";
const LABEL_PREFIX: &str = "aethon-canvas-";
const KIND_CANVAS: &str = "canvas";
const DEFAULT_TITLE: &str = "Aethon Canvas";
const DEFAULT_WIDTH: f64 = 900.0;
const DEFAULT_HEIGHT: f64 = 650.0;
const MIN_WIDTH: f64 = 420.0;
const MIN_HEIGHT: f64 = 300.0;
const MAX_ID_LEN: usize = 80;
const MAX_TITLE_LEN: usize = 160;

#[derive(Default)]
pub struct NativeWindowsState {
    records: Mutex<HashMap<String, NativeCanvasWindowRecord>>,
}

impl NativeWindowsState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCanvasWindowRecord {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default = "default_restore_on_launch")]
    pub restore_on_launch: bool,
    #[serde(default)]
    pub components: Vec<Value>,
    #[serde(default = "default_state")]
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeWindowsStore {
    version: u32,
    windows: Vec<NativeCanvasWindowRecord>,
}

impl Default for NativeWindowsStore {
    fn default() -> Self {
        Self {
            version: 1,
            windows: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCanvasWindowOpenInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub tab_id: Option<String>,
    pub components: Option<Vec<Value>>,
    pub state: Option<Value>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub focus: Option<bool>,
    pub restore_on_launch: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWindowClosedEvent {
    id: String,
    label: String,
}

fn default_restore_on_launch() -> bool {
    true
}

fn default_state() -> Value {
    json!({})
}

pub fn label_for_id(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

fn id_from_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(LABEL_PREFIX)
        .filter(|id| is_valid_id(id))
}

pub fn is_valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return false;
    }
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn generate_id() -> String {
    format!("canvas-{}", uuid::Uuid::new_v4().simple())
}

fn normalize_title(title: Option<String>) -> String {
    let trimmed = title.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        return DEFAULT_TITLE.to_string();
    }
    trimmed.chars().take(MAX_TITLE_LEN).collect()
}

fn finite_or_default(value: Option<f64>, default: f64, min: f64) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.max(min),
        _ => default,
    }
}

fn normalize_state(value: Option<Value>) -> Value {
    match value {
        Some(v) if v.is_object() => v,
        Some(v) if v.is_array() => v,
        _ => default_state(),
    }
}

fn validate_record(record: &NativeCanvasWindowRecord) -> Result<(), String> {
    if !is_valid_id(&record.id) {
        return Err("id must match /^[A-Za-z][\\w-]*$/".to_string());
    }
    let expected = label_for_id(&record.id);
    if record.label != expected {
        return Err("label must match id".to_string());
    }
    if record.kind != KIND_CANVAS {
        return Err("kind must be \"canvas\"".to_string());
    }
    Ok(())
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(STORE_FILE))
}

fn load_store(app: &AppHandle) -> NativeWindowsStore {
    let Ok(path) = store_path(app) else {
        return NativeWindowsStore::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str::<NativeWindowsStore>(&s)
            .unwrap_or_else(|e| {
                tracing::warn!(
                    target: "aethon::native_windows",
                    "parse {}: {e}",
                    path.display()
                );
                NativeWindowsStore::default()
            }),
        _ => NativeWindowsStore::default(),
    }
}

fn save_persisted(app: &AppHandle, state: &NativeWindowsState) -> Result<(), String> {
    let records: Vec<NativeCanvasWindowRecord> = state
        .records
        .lock()
        .unwrap()
        .values()
        .filter(|r| r.restore_on_launch)
        .cloned()
        .collect();
    let store = NativeWindowsStore {
        version: 1,
        windows: records,
    };
    let path = store_path(app)?;
    let body = serde_json::to_string_pretty(&store).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

fn upsert_record(
    app: &AppHandle,
    state: &NativeWindowsState,
    record: NativeCanvasWindowRecord,
) -> Result<NativeCanvasWindowRecord, String> {
    validate_record(&record)?;
    {
        let mut records = state.records.lock().unwrap();
        records.insert(record.id.clone(), record.clone());
    }
    save_persisted(app, state)?;
    let _ = app.emit("native-window-record", &record);
    Ok(record)
}

fn remove_record(
    app: &AppHandle,
    state: &NativeWindowsState,
    id: &str,
) -> Result<Option<NativeCanvasWindowRecord>, String> {
    let removed = {
        let mut records = state.records.lock().unwrap();
        records.remove(id)
    };
    save_persisted(app, state)?;
    if let Some(record) = &removed {
        let _ = app.emit(
            "native-window-closed",
            NativeWindowClosedEvent {
                id: record.id.clone(),
                label: record.label.clone(),
            },
        );
    }
    Ok(removed)
}

fn build_record(input: NativeCanvasWindowOpenInput) -> Result<NativeCanvasWindowRecord, String> {
    let id = input
        .id
        .filter(|id| !id.trim().is_empty())
        .map(|id| id.trim().to_string())
        .unwrap_or_else(generate_id);
    if !is_valid_id(&id) {
        return Err("id must match /^[A-Za-z][\\w-]*$/".to_string());
    }
    Ok(NativeCanvasWindowRecord {
        label: label_for_id(&id),
        id,
        kind: KIND_CANVAS.to_string(),
        title: normalize_title(input.title),
        tab_id: input
            .tab_id
            .filter(|tab_id| !tab_id.trim().is_empty())
            .map(|tab_id| tab_id.trim().to_string()),
        restore_on_launch: input.restore_on_launch.unwrap_or(true),
        components: input.components.unwrap_or_default(),
        state: normalize_state(input.state),
    })
}

fn open_canvas_window(
    app: &AppHandle,
    record: &NativeCanvasWindowRecord,
    input: &NativeCanvasWindowOpenInput,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&record.label) {
        if let Err(e) = window.set_title(&record.title) {
            tracing::warn!(target: "aethon::native_windows", "set_title: {e}");
        }
        let _ = window.show();
        if input.focus.unwrap_or(true) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?surface=canvas-window&id={}", record.id).into());
    let width = finite_or_default(input.width, DEFAULT_WIDTH, MIN_WIDTH);
    let height = finite_or_default(input.height, DEFAULT_HEIGHT, MIN_HEIGHT);
    let focus = input.focus.unwrap_or(true);
    let mut builder = WebviewWindowBuilder::new(app, &record.label, url)
        .title(&record.title)
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .visible(false)
        .focused(focus);
    if let (Some(x), Some(y)) = (input.x, input.y)
        && x.is_finite()
        && y.is_finite()
    {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    builder
        .build()
        .map_err(|e| format!("create native canvas window: {e}"))?;
    crate::window_state::restore_window(app, &record.label, focus)
}

#[tauri::command]
pub async fn native_window_open_canvas(
    input: NativeCanvasWindowOpenInput,
    app: AppHandle,
    state: tauri::State<'_, NativeWindowsState>,
) -> Result<NativeCanvasWindowRecord, String> {
    let record = build_record(input.clone())?;
    let record = upsert_record(&app, &state, record)?;
    if let Err(e) = open_canvas_window(&app, &record, &input) {
        let _ = remove_record(&app, &state, &record.id);
        return Err(e);
    }
    Ok(record)
}

#[tauri::command]
pub fn native_window_save_canvas(
    record: NativeCanvasWindowRecord,
    app: AppHandle,
    state: tauri::State<'_, NativeWindowsState>,
) -> Result<NativeCanvasWindowRecord, String> {
    upsert_record(&app, &state, record)
}

#[tauri::command]
pub fn native_window_get_canvas(
    id: String,
    state: tauri::State<'_, NativeWindowsState>,
) -> Result<Option<NativeCanvasWindowRecord>, String> {
    if !is_valid_id(&id) {
        return Err("id must match /^[A-Za-z][\\w-]*$/".to_string());
    }
    Ok(state.records.lock().unwrap().get(&id).cloned())
}

#[tauri::command]
pub fn native_window_list(
    state: tauri::State<'_, NativeWindowsState>,
) -> Result<Vec<NativeCanvasWindowRecord>, String> {
    let mut records: Vec<_> = state.records.lock().unwrap().values().cloned().collect();
    records.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(records)
}

#[tauri::command]
pub fn native_window_focus(id: String, app: AppHandle) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("id must match /^[A-Za-z][\\w-]*$/".to_string());
    }
    let label = label_for_id(&id);
    let Some(window) = app.get_webview_window(&label) else {
        return Err("window not found".to_string());
    };
    let _ = window.show();
    let _ = window.unminimize();
    window.set_focus().map_err(|e| format!("focus: {e}"))
}

#[tauri::command]
pub fn native_window_close(
    id: String,
    app: AppHandle,
    state: tauri::State<'_, NativeWindowsState>,
) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("id must match /^[A-Za-z][\\w-]*$/".to_string());
    }
    let label = label_for_id(&id);
    let _ = remove_record(&app, &state, &id)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| format!("close: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_window_set_title(
    id: String,
    title: String,
    app: AppHandle,
    state: tauri::State<'_, NativeWindowsState>,
) -> Result<NativeCanvasWindowRecord, String> {
    if !is_valid_id(&id) {
        return Err("id must match /^[A-Za-z][\\w-]*$/".to_string());
    }
    let mut record = {
        let records = state.records.lock().unwrap();
        records
            .get(&id)
            .cloned()
            .ok_or_else(|| "window not found".to_string())?
    };
    record.title = normalize_title(Some(title));
    let record = upsert_record(&app, &state, record)?;
    if let Some(window) = app.get_webview_window(&record.label) {
        window
            .set_title(&record.title)
            .map_err(|e| format!("set_title: {e}"))?;
    }
    Ok(record)
}

pub fn restore_on_setup(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<NativeWindowsState>();
    let store = load_store(app);
    for mut record in store.windows {
        if validate_record(&record).is_err() {
            tracing::warn!(
                target: "aethon::native_windows",
                "skipping invalid persisted native window id={}",
                record.id
            );
            continue;
        }
        if record.title.trim().is_empty() {
            record.title = DEFAULT_TITLE.to_string();
        }
        {
            let mut records = state.records.lock().unwrap();
            records.insert(record.id.clone(), record.clone());
        }
        if !record.restore_on_launch {
            continue;
        }
        let input = NativeCanvasWindowOpenInput {
            id: Some(record.id.clone()),
            title: Some(record.title.clone()),
            tab_id: record.tab_id.clone(),
            components: Some(record.components.clone()),
            state: Some(record.state.clone()),
            width: Some(DEFAULT_WIDTH),
            height: Some(DEFAULT_HEIGHT),
            x: None,
            y: None,
            focus: Some(false),
            restore_on_launch: Some(record.restore_on_launch),
        };
        if let Err(e) = open_canvas_window(app, &record, &input) {
            tracing::warn!(
                target: "aethon::native_windows",
                "restore {}: {e}",
                record.label
            );
        }
    }
    Ok(())
}

pub fn handle_window_closed(app: &AppHandle, label: &str) {
    let Some(id) = id_from_label(label).map(str::to_string) else {
        return;
    };
    let state = app.state::<NativeWindowsState>();
    if let Err(e) = remove_record(app, &state, &id) {
        tracing::warn!(
            target: "aethon::native_windows",
            "remove closed {label}: {e}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_canvas_ids_and_labels() {
        for id in ["Canvas", "canvas-1", "c_1", "A1"] {
            assert!(is_valid_id(id), "{id} should be valid");
            assert_eq!(label_for_id(id), format!("aethon-canvas-{id}"));
        }
        for id in ["", "1bad", "-bad", "bad/slash", "bad.dot", "bad space"] {
            assert!(!is_valid_id(id), "{id} should be invalid");
        }
    }

    #[test]
    fn record_validation_requires_derived_label_and_canvas_kind() {
        let ok = NativeCanvasWindowRecord {
            id: "Canvas".into(),
            label: label_for_id("Canvas"),
            kind: KIND_CANVAS.into(),
            title: DEFAULT_TITLE.into(),
            tab_id: None,
            restore_on_launch: true,
            components: Vec::new(),
            state: json!({}),
        };
        assert!(validate_record(&ok).is_ok());
        assert!(
            validate_record(&NativeCanvasWindowRecord {
                label: "wrong".into(),
                ..ok.clone()
            })
            .is_err()
        );
        assert!(
            validate_record(&NativeCanvasWindowRecord {
                kind: "browser".into(),
                ..ok
            })
            .is_err()
        );
    }

    #[test]
    fn store_schema_serializes_canvas_records() {
        let store = NativeWindowsStore {
            version: 1,
            windows: vec![NativeCanvasWindowRecord {
                id: "Canvas".into(),
                label: label_for_id("Canvas"),
                kind: KIND_CANVAS.into(),
                title: DEFAULT_TITLE.into(),
                tab_id: Some("tab-1".into()),
                restore_on_launch: true,
                components: vec![json!({"id":"root","type":"card"})],
                state: json!({"count":1}),
            }],
        };
        let body = serde_json::to_string(&store).unwrap();
        assert!(body.contains("\"version\":1"));
        assert!(body.contains("\"restoreOnLaunch\":true"));
        let back: NativeWindowsStore = serde_json::from_str(&body).unwrap();
        assert_eq!(back.windows[0].label, "aethon-canvas-Canvas");
        assert_eq!(back.windows[0].tab_id.as_deref(), Some("tab-1"));
    }
}
