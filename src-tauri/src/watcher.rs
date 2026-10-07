//! Auto-reload. We watch each open document's parent folder rather than the
//! file itself, because many editors save by writing a new file and renaming
//! it over the old one, which breaks a watch on the original file.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::doc;
use crate::render;
use crate::state::{lock, same_path, AppState};

const DEBOUNCE: Duration = Duration::from_millis(60);

pub struct DirWatcher {
    debouncer: Debouncer<RecommendedWatcher>,
    counts: HashMap<PathBuf, usize>,
}

impl DirWatcher {
    pub fn new(app: AppHandle) -> notify::Result<Self> {
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<PathBuf> = Vec::new();
            for e in events {
                if !paths.iter().any(|p| same_path(p, &e.path)) {
                    paths.push(e.path);
                }
            }
            for p in paths {
                on_file_changed(&app, &p);
            }
        })?;
        Ok(Self { debouncer, counts: HashMap::new() })
    }

    pub fn watch(&mut self, dir: &Path) {
        if let Some(c) = self.counts.get_mut(dir) {
            *c += 1;
        } else if self.debouncer.watcher().watch(dir, RecursiveMode::NonRecursive).is_ok() {
            self.counts.insert(dir.to_path_buf(), 1);
        }
    }

    pub fn unwatch(&mut self, dir: &Path) {
        if let Some(c) = self.counts.get_mut(dir) {
            *c -= 1;
            if *c == 0 {
                self.counts.remove(dir);
                let _ = self.debouncer.watcher().unwatch(dir);
            }
        }
    }
}

#[derive(Clone, Serialize)]
pub struct DocChanged {
    pub id: u64,
    pub html: String,
}

pub fn on_file_changed(app: &AppHandle, path: &Path) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let targets: Vec<(u64, String, u64)> = lock(&state.docs)
        .iter()
        .filter(|(_, d)| same_path(&d.path, path))
        .map(|(id, d)| (*id, d.window.clone(), d.disk_hash))
        .collect();
    if targets.is_empty() {
        return;
    }

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            for (id, window, _) in &targets {
                let _ = app.emit_to(window.as_str(), "doc-missing", *id);
            }
            return;
        }
        Err(_) => return,
    };
    let hash = doc::hash(&bytes);
    if targets.iter().all(|(_, _, h)| *h == hash) {
        // Unchanged, or our own save.
        return;
    }

    let decoded = doc::decode(&bytes);
    let html = render::render(&decoded.text, false);
    for (id, window, _) in targets {
        {
            let mut docs = lock(&state.docs);
            let Some(d) = docs.get_mut(&id) else { continue };
            d.disk_hash = hash;
            d.format = decoded.format;
            d.text.clone_from(&decoded.text);
        }
        let _ = app.emit_to(window.as_str(), "doc-changed", DocChanged { id, html: html.clone() });
    }
    crate::perf::mark("watcher: reloaded");
}
