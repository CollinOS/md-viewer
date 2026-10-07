//! Commands called from the frontend. They're all async so file I/O and
//! rendering never run on the main thread.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::doc;
use crate::protocol;
use crate::render;
use crate::settings::Settings;
use crate::state::{canonical, load, lock, AppState, Loaded};
use crate::windows;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDoc {
    id: u64,
    path: String,
    name: String,
    html: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenOutcome {
    Opened(OpenedDoc),
    /// Already open in the calling window.
    Existing { id: u64 },
    /// Already open in another window, which was focused instead.
    Elsewhere,
    Failed { path: String, message: String },
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Returns an outcome if the file is already open somewhere.
fn check_open(app: &AppHandle, state: &AppState, window: &str, path: &Path) -> Option<OpenOutcome> {
    let (id, owner) = state.find_open(path)?;
    if owner == window {
        return Some(OpenOutcome::Existing { id });
    }
    let w = app.get_webview_window(&owner)?;
    let _ = w.emit_to(owner.as_str(), "activate-doc", id);
    windows::focus(&w);
    Some(OpenOutcome::Elsewhere)
}

fn attach(app: &AppHandle, state: &AppState, window: &str, mut loaded: Loaded) -> OpenOutcome {
    if let Some(outcome) = check_open(app, state, window, &loaded.path) {
        return outcome;
    }
    let path = loaded.path.to_string_lossy().into_owned();
    let name = file_name(&loaded.path);
    let html = std::mem::take(&mut loaded.html);
    let id = state.register(loaded, window);
    OpenOutcome::Opened(OpenedDoc { id, path, name, html })
}

fn failed(path: &Path, message: String) -> OpenOutcome {
    OpenOutcome::Failed { path: path.to_string_lossy().into_owned(), message }
}

/// Called once by each window on startup. Returns the documents it was
/// created with, which were loaded in the background while it booted.
#[tauri::command]
pub async fn boot(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> Result<Vec<OpenOutcome>, ()> {
    crate::perf::mark("boot: called");
    let jobs = lock(&state.prefetch).remove(window.label()).unwrap_or_default();
    let mut out = Vec::new();
    for (path, job) in jobs {
        out.push(match job.join() {
            Ok(Ok(loaded)) => attach(&app, &state, window.label(), loaded),
            Ok(Err(message)) => failed(&path, message),
            Err(_) => failed(&path, "failed to load".into()),
        });
    }
    crate::perf::mark("boot: docs ready");
    Ok(out)
}

#[tauri::command]
pub async fn open_doc(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, path: String) -> Result<OpenOutcome, ()> {
    let path = PathBuf::from(path);
    let canon = match canonical(&path) {
        Ok(c) => c,
        Err(message) => return Ok(failed(&path, message)),
    };
    if let Some(outcome) = check_open(&app, &state, window.label(), &canon) {
        return Ok(outcome);
    }
    Ok(match load(&canon) {
        Ok(loaded) => attach(&app, &state, window.label(), loaded),
        Err(message) => failed(&path, message),
    })
}

#[tauri::command]
pub async fn close_doc(state: State<'_, AppState>, id: u64) -> Result<(), ()> {
    state.close(id);
    Ok(())
}

#[tauri::command]
pub async fn pick_files(window: WebviewWindow) -> Result<Vec<String>, ()> {
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "mkdn", "txt"])
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub async fn render_md(text: String, sourcepos: bool) -> Result<String, ()> {
    Ok(render::render(&text, sourcepos))
}

#[tauri::command]
pub async fn get_text(state: State<'_, AppState>, id: u64) -> Result<String, String> {
    lock(&state.docs).get(&id).map(|d| d.text.clone()).ok_or_else(|| "document is not open".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInfo {
    /// Set when the file had to be saved in a different encoding.
    warning: Option<String>,
}

#[tauri::command]
pub async fn save_doc(state: State<'_, AppState>, id: u64, text: String) -> Result<SaveInfo, String> {
    let (path, format, old_hash) = {
        let docs = lock(&state.docs);
        let d = docs.get(&id).ok_or("document is not open")?;
        (d.path.clone(), d.format, d.disk_hash)
    };
    let encoded = doc::encode(&text, format);
    let new_hash = doc::hash(&encoded.bytes);
    // Record the hash before writing so the watcher recognizes our own save.
    if let Some(d) = lock(&state.docs).get_mut(&id) {
        d.disk_hash = new_hash;
    }
    if let Err(e) = doc::write_atomic(&path, &encoded.bytes) {
        if let Some(d) = lock(&state.docs).get_mut(&id) {
            d.disk_hash = old_hash;
        }
        return Err(format!("Couldn't save {}: {e}", file_name(&path)));
    }
    let warning = (encoded.format.encoding != format.encoding)
        .then(|| "Some characters couldn't be saved in Windows-1252, so the file was saved as UTF-8.".to_owned());
    if let Some(d) = lock(&state.docs).get_mut(&id) {
        d.text = text;
        d.format = encoded.format;
    }
    crate::perf::mark("saved");
    Ok(SaveInfo { warning })
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkAction {
    /// A markdown file the frontend should open in a tab.
    Open { path: String, fragment: String },
    Done,
    Failed { message: String },
}

fn has_scheme(href: &str) -> bool {
    let Some(colon) = href.find(':') else { return false };
    // A single letter is a drive (C:\...), not a scheme.
    colon > 1 && href[..colon].chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd" | "mkdn"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn open_link(app: AppHandle, state: State<'_, AppState>, id: u64, href: String) -> Result<LinkAction, ()> {
    let lower = href.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        return Ok(match app.opener().open_url(&href, None::<&str>) {
            Ok(()) => LinkAction::Done,
            Err(e) => LinkAction::Failed { message: e.to_string() },
        });
    }

    let (target, fragment) = if lower.starts_with("file:") {
        let Some(path) = tauri::Url::parse(&href).ok().and_then(|u| u.to_file_path().ok()) else {
            return Ok(LinkAction::Failed { message: format!("Invalid link: {href}") });
        };
        (path, String::new())
    } else if has_scheme(&href) {
        return Ok(LinkAction::Failed { message: format!("Unsupported link: {href}") });
    } else {
        let (before_hash, fragment) = href.split_once('#').unwrap_or((&href, ""));
        let rel = before_hash.split('?').next().unwrap_or_default();
        let rel = percent_encoding::percent_decode_str(rel).decode_utf8_lossy().into_owned();
        let Some(doc_path) = state.doc_path(id) else { return Ok(LinkAction::Done) };
        (protocol::resolve(&doc_path, &rel), fragment.to_owned())
    };

    let Ok(target) = canonical(&target) else {
        return Ok(LinkAction::Failed { message: format!("Not found: {}", target.display()) });
    };
    if target.is_file() && is_markdown(&target) {
        return Ok(LinkAction::Open { path: target.to_string_lossy().into_owned(), fragment });
    }
    Ok(match app.opener().reveal_item_in_dir(&target) {
        Ok(()) => LinkAction::Done,
        Err(e) => LinkAction::Failed { message: e.to_string() },
    })
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    let merged = {
        let mut current = lock(&state.settings);
        let window = current.window.clone();
        *current = Settings { window, ..settings };
        current.clone()
    };
    merged.save(&state.settings_path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", merged);
    Ok(())
}

#[tauri::command]
pub async fn new_window(app: AppHandle) -> Result<(), String> {
    windows::create_window(&app, Vec::new()).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_ready(window: WebviewWindow) -> Result<(), ()> {
    windows::show(&window);
    crate::perf::mark("window shown");
    Ok(())
}

#[tauri::command]
pub async fn perf_mark(label: String) -> Result<(), ()> {
    crate::perf::mark(&label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_detection() {
        assert!(has_scheme("vscode://file/x"));
        assert!(!has_scheme(r"C:\notes\a.md"));
        assert!(!has_scheme("notes/a.md"));
        assert!(!has_scheme("a.md#section:2"));
    }
}
