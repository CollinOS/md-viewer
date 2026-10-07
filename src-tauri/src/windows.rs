//! Window creation and lifecycle.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;
use tauri::webview::Color;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

use crate::settings::{system_prefers_dark, theme_background, WindowGeometry};
use crate::state::{load, lock, AppState};

/// How long to wait for the frontend to say it's ready before showing the
/// window anyway, so a frontend error never leaves an invisible window.
const SHOW_FALLBACK: Duration = if cfg!(debug_assertions) { Duration::from_millis(3000) } else { Duration::from_millis(800) };

const CASCADE: f64 = 32.0;

fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(1420))
        }
        _ => false,
    }
}

/// Where to put a new window: offset from the window the user was just
/// using, or the last saved position if it's still on a connected monitor.
fn placement(app: &AppHandle, saved: &WindowGeometry) -> (WindowGeometry, bool) {
    let state = app.state::<AppState>();
    let last = lock(&state.last_focused).clone().and_then(|l| app.get_webview_window(&l));
    if let Some(w) = last {
        if let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor()) {
            let pos = pos.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            let geom = WindowGeometry {
                x: Some(pos.x + CASCADE),
                y: Some(pos.y + CASCADE),
                width: size.width,
                height: size.height,
                maximized: false,
            };
            return (geom, true);
        }
    }
    let on_screen = match (saved.x, saved.y) {
        (Some(x), Some(y)) => app.available_monitors().unwrap_or_default().iter().any(|m| {
            let s = m.scale_factor();
            let p = m.position().to_logical::<f64>(s);
            let z = m.size().to_logical::<f64>(s);
            x + 60.0 >= p.x && x + 60.0 <= p.x + z.width && y + 10.0 >= p.y && y + 10.0 <= p.y + z.height
        }),
        _ => false,
    };
    (saved.clone(), on_screen)
}

pub fn create_window(app: &AppHandle, paths: Vec<PathBuf>) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let label = state.next_window_label();

    // Start reading and rendering the files while the webview boots.
    let jobs = paths.into_iter().map(|p| (p.clone(), std::thread::spawn(move || load(&p)))).collect();
    lock(&state.prefetch).insert(label.clone(), jobs);

    let settings = lock(&state.settings).clone();
    let dark = system_prefers_dark();
    let (r, g, b) = theme_background(settings.active_theme(dark));
    let boot = json!({ "settings": settings, "systemDark": dark, "perf": crate::perf::enabled() });

    let (geom, use_position) = placement(app, &settings.window);
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("MD Viewer")
        .inner_size(geom.width.max(420.0), geom.height.max(320.0))
        .min_inner_size(420.0, 320.0)
        .visible(false)
        .background_color(Color(r, g, b, 255))
        .initialization_script(format!("window.__MDV_BOOT__ = {boot};"))
        .on_navigation(|url| is_app_url(url));
    builder = match (use_position, geom.x, geom.y) {
        (true, Some(x), Some(y)) => builder.position(x, y),
        _ => builder.center(),
    };
    let window = builder.build()?;
    if geom.maximized {
        lock(&state.maximize_on_show).push(label.clone());
    }
    crate::perf::mark("window built");

    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        if !w.is_visible().unwrap_or(true) {
            show(&w);
        }
    });
    Ok(window)
}

pub fn show(window: &WebviewWindow) {
    let state = window.state::<AppState>();
    let maximize = {
        let mut list = lock(&state.maximize_on_show);
        let before = list.len();
        list.retain(|l| l != window.label());
        list.len() != before
    };
    if maximize {
        let _ = window.maximize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn focus(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();
}

/// Files opened from Explorer or the command line while the app is already
/// running. Files that are already open just get focused.
pub fn open_from_os(app: &AppHandle, paths: Vec<PathBuf>) {
    let state = app.state::<AppState>();
    let mut fresh = Vec::new();
    let mut activated = false;
    for p in paths {
        let found = crate::state::canonical(&p).ok().and_then(|c| state.find_open(&c));
        match found.and_then(|(id, label)| app.get_webview_window(&label).map(|w| (id, w))) {
            Some((id, w)) => {
                let _ = w.emit_to(w.label(), "activate-doc", id);
                focus(&w);
                activated = true;
            }
            None => fresh.push(p),
        }
    }

    let target = lock(&state.last_focused).clone().and_then(|l| app.get_webview_window(&l));
    if fresh.is_empty() {
        if activated {
            return;
        }
        match target {
            Some(w) => focus(&w),
            None => {
                let _ = create_window(app, fresh);
            }
        }
        return;
    }
    let new_window = lock(&state.settings).open_in == "window";
    if let (Some(w), false) = (&target, new_window) {
        let list: Vec<String> = fresh.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let _ = w.emit_to(w.label(), "open-paths", list);
        focus(w);
        return;
    }
    let _ = create_window(app, fresh);
}

fn save_geometry(window: &Window) {
    let Ok(scale) = window.scale_factor() else { return };
    let state = window.state::<AppState>();
    let mut settings = lock(&state.settings);
    let maximized = window.is_maximized().unwrap_or(false);
    settings.window.maximized = maximized;
    if !maximized && !window.is_minimized().unwrap_or(false) {
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
            let pos = pos.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            settings.window.x = Some(pos.x);
            settings.window.y = Some(pos.y);
            settings.window.width = size.width;
            settings.window.height = size.height;
        }
    }
    let _ = settings.save(&state.settings_path);
}

pub fn on_event(window: &Window, event: &WindowEvent) {
    let state = window.state::<AppState>();
    match event {
        WindowEvent::Focused(true) => {
            *lock(&state.last_focused) = Some(window.label().to_owned());
        }
        WindowEvent::CloseRequested { .. } => save_geometry(window),
        WindowEvent::Destroyed => {
            state.close_window(window.label());
            let mut last = lock(&state.last_focused);
            if last.as_deref() == Some(window.label()) {
                *last = window.app_handle().webview_windows().into_keys().find(|l| l != window.label());
            }
        }
        _ => {}
    }
}
