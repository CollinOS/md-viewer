pub mod commands;
pub mod doc;
pub mod perf;
pub mod protocol;
pub mod render;
pub mod settings;
pub mod state;
pub mod watcher;
pub mod windows;

use std::path::{Path, PathBuf};

use tauri::Manager;

use settings::{settings_path, Settings};
use state::{lock, AppState};

/// File arguments from a command line, resolved against `cwd`.
fn cli_paths(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a))
        .collect()
}

pub fn run() {
    perf::init();
    let args: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        // Must be registered first so a second launch exits as early as possible.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            windows::open_from_os(app, cli_paths(&argv, Path::new(&cwd)));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("mdfile", protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::boot,
            commands::open_doc,
            commands::close_doc,
            commands::pick_files,
            commands::render_md,
            commands::get_text,
            commands::save_doc,
            commands::open_link,
            commands::save_settings,
            commands::new_window,
            commands::window_ready,
            commands::park_window,
            commands::perf_mark,
        ])
        .setup(move |app| {
            perf::mark("setup");
            render::warm_up();
            let config_dir = match std::env::var_os("MDV_CONFIG_DIR") {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_config_dir()?,
            };
            let path = settings_path(config_dir);
            app.manage(AppState::new(Settings::load(&path), path));

            let state = app.state::<AppState>();
            *lock(&state.watcher) = watcher::DirWatcher::new(app.handle().clone()).ok();

            let cwd = std::env::current_dir().unwrap_or_default();
            windows::create_window(app.handle(), cli_paths(&args, &cwd))?;
            Ok(())
        })
        .on_window_event(windows::on_event)
        .run(tauri::generate_context!())
        .expect("error while running md-viewer");
}
