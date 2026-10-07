//! Startup and render timing. Enabled by setting `MDV_PERF` to a log file
//! path; each line is `<ms since process start> <label>`.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
static LOG: OnceLock<Option<String>> = OnceLock::new();

pub fn init() {
    START.get_or_init(Instant::now);
    LOG.get_or_init(|| std::env::var("MDV_PERF").ok().filter(|s| !s.is_empty()));
}

pub fn elapsed_ms() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

pub fn enabled() -> bool {
    matches!(LOG.get(), Some(Some(_)))
}

pub fn mark(label: &str) {
    if let Some(Some(path)) = LOG.get() {
        let line = format!("{:.1} {label}\n", elapsed_ms());
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}
