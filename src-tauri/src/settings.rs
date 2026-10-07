//! User settings, stored as JSON in the app config folder. Rust reads them
//! before creating a window so the very first paint uses the right theme.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowGeometry {
    /// Logical position. None until a window has been closed once.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self { x: None, y: None, width: 1000.0, height: 760.0, maximized: false }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "system", "light" or "dark"
    pub mode: String,
    pub light_theme: String,
    pub dark_theme: String,
    /// CSS color, or empty to use the theme's own accent.
    pub accent: String,
    pub font_size: u32,
    /// Max content width in px, 0 for full width.
    pub content_width: u32,
    /// "sans", "serif" or "mono"
    pub body_font: String,
    pub code_font: String,
    /// "tab" or "window"
    pub open_in: String,
    /// Hide the last window instead of exiting, so the next file opens instantly.
    pub keep_running: bool,
    pub window: WindowGeometry,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: "system".into(),
            light_theme: "github-light".into(),
            dark_theme: "github-dark".into(),
            accent: String::new(),
            font_size: 16,
            content_width: 880,
            body_font: "sans".into(),
            code_font: String::new(),
            open_in: "tab".into(),
            keep_running: false,
            window: WindowGeometry::default(),
        }
    }
}

/// Page background for each theme, used as the window color before the
/// webview has painted. Keep in sync with `src/styles/themes.css`.
pub fn theme_background(theme: &str) -> (u8, u8, u8) {
    match theme {
        "github-dark" => (0x0d, 0x11, 0x17),
        "solarized-light" => (0xfd, 0xf6, 0xe3),
        "solarized-dark" => (0x00, 0x2b, 0x36),
        "nord" => (0x2e, 0x34, 0x40),
        "dracula" => (0x28, 0x2a, 0x36),
        "gruvbox-dark" => (0x28, 0x28, 0x28),
        "sepia" => (0xf8, 0xf1, 0xe3),
        _ => (0xff, 0xff, 0xff),
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::doc::write_atomic(path, &json)
    }

    pub fn active_theme(&self, system_dark: bool) -> &str {
        let dark = match self.mode.as_str() {
            "light" => false,
            "dark" => true,
            _ => system_dark,
        };
        if dark { &self.dark_theme } else { &self.light_theme }
    }
}

pub fn settings_path(config_dir: PathBuf) -> PathBuf {
    config_dir.join("settings.json")
}

#[cfg(windows)]
pub fn system_prefers_dark() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("AppsUseLightTheme"))
        .map(|light| light == 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn system_prefers_dark() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_partial_file_uses_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        assert_eq!(Settings::load(&p), Settings::default());
        fs::write(&p, r#"{"fontSize": 18, "unknownKey": 1}"#).unwrap();
        let s = Settings::load(&p);
        assert_eq!(s.font_size, 18);
        assert_eq!(s.mode, "system");
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested").join("settings.json");
        let s = Settings { dark_theme: "nord".into(), ..Default::default() };
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s);
    }

    #[test]
    fn active_theme_follows_mode() {
        let mut s = Settings::default();
        assert_eq!(s.active_theme(true), "github-dark");
        assert_eq!(s.active_theme(false), "github-light");
        s.mode = "light".into();
        assert_eq!(s.active_theme(true), "github-light");
    }
}
