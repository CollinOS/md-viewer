//! Shared app state. Every open document has an ID and belongs to one window;
//! a window's tabs are just the documents that point at it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;

use crate::doc::{self, FileFormat};
use crate::render;
use crate::settings::Settings;
use crate::watcher::DirWatcher;

/// Refuse anything bigger than this. It's almost certainly not markdown.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub struct Doc {
    pub path: PathBuf,
    pub window: String,
    pub format: FileFormat,
    /// Hash of the bytes we last saw on disk (or last wrote). The watcher
    /// compares against it to skip no-op events and our own saves.
    pub disk_hash: u64,
    /// LF-normalized text matching `disk_hash`, handed to the editor.
    pub text: String,
}

/// A file read, decoded and rendered, but not yet attached to a window.
pub struct Loaded {
    pub path: PathBuf,
    pub format: FileFormat,
    pub hash: u64,
    pub text: String,
    pub html: String,
}

pub type Prefetch = Vec<(PathBuf, JoinHandle<Result<Loaded, String>>)>;

pub struct AppState {
    pub docs: Mutex<HashMap<u64, Doc>>,
    next_doc: AtomicU64,
    next_window: AtomicU64,
    pub last_focused: Mutex<Option<String>>,
    /// Files being loaded in the background while a new window starts up.
    pub prefetch: Mutex<HashMap<String, Prefetch>>,
    /// Windows that should be maximized when they're first shown.
    pub maximize_on_show: Mutex<Vec<String>>,
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub watcher: Mutex<Option<DirWatcher>>,
}

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Windows paths are case-insensitive.
pub fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

pub fn canonical(path: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn load(path: &Path) -> Result<Loaded, String> {
    let path = canonical(path)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{} is too large to open ({} MB)", path.display(), meta.len() / 1024 / 1024));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let hash = doc::hash(&bytes);
    let decoded = doc::decode(&bytes);
    let html = render::render(&decoded.text, false);
    Ok(Loaded { path, format: decoded.format, hash, text: decoded.text, html })
}

impl AppState {
    pub fn new(settings: Settings, settings_path: PathBuf) -> Self {
        Self {
            docs: Mutex::default(),
            next_doc: AtomicU64::new(1),
            next_window: AtomicU64::new(1),
            last_focused: Mutex::default(),
            prefetch: Mutex::default(),
            maximize_on_show: Mutex::default(),
            settings: Mutex::new(settings),
            settings_path,
            watcher: Mutex::default(),
        }
    }

    pub fn next_window_label(&self) -> String {
        format!("w{}", self.next_window.fetch_add(1, Ordering::Relaxed))
    }

    /// The document already showing this file, if any, and its window.
    pub fn find_open(&self, path: &Path) -> Option<(u64, String)> {
        lock(&self.docs)
            .iter()
            .find(|(_, d)| same_path(&d.path, path))
            .map(|(id, d)| (*id, d.window.clone()))
    }

    pub fn register(&self, loaded: Loaded, window: &str) -> u64 {
        let id = self.next_doc.fetch_add(1, Ordering::Relaxed);
        if let Some(dir) = loaded.path.parent() {
            if let Some(w) = lock(&self.watcher).as_mut() {
                w.watch(dir);
            }
        }
        lock(&self.docs).insert(
            id,
            Doc { path: loaded.path, window: window.to_owned(), format: loaded.format, disk_hash: loaded.hash, text: loaded.text },
        );
        id
    }

    pub fn close(&self, id: u64) {
        let removed = lock(&self.docs).remove(&id);
        if let Some(doc) = removed {
            if let (Some(dir), Some(w)) = (doc.path.parent(), lock(&self.watcher).as_mut()) {
                w.unwatch(dir);
            }
        }
    }

    pub fn close_window(&self, label: &str) {
        let ids: Vec<u64> = lock(&self.docs).iter().filter(|(_, d)| d.window == label).map(|(id, _)| *id).collect();
        for id in ids {
            self.close(id);
        }
        lock(&self.prefetch).remove(label);
    }

    pub fn doc_path(&self, id: u64) -> Option<PathBuf> {
        lock(&self.docs).get(&id).map(|d| d.path.clone())
    }
}
