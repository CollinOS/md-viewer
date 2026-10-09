//! `mdfile://` serves local images and media referenced by a document.
//!
//! URLs look like `http://mdfile.localhost/<doc id>/<percent-encoded path>`.
//! The path is a single encoded segment so `..` can't be normalized away by
//! the URL parser, and it's resolved against the document's folder in Rust.
//! Only media file types are served.

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::AppState;

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = req.uri().path().to_owned();
    std::thread::spawn(move || responder.respond(serve(app.try_state::<AppState>().as_deref(), &path)));
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

fn serve(state: Option<&AppState>, uri_path: &str) -> Response<Vec<u8>> {
    let Some(state) = state else { return status(StatusCode::SERVICE_UNAVAILABLE) };
    let mut parts = uri_path.trim_start_matches('/').splitn(2, '/');
    let Some(id) = parts.next().and_then(|s| s.parse::<u64>().ok()) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let Ok(rel) = percent_decode_str(parts.next().unwrap_or_default()).decode_utf8() else {
        return status(StatusCode::BAD_REQUEST);
    };
    let Some(doc_path) = state.doc_path(id) else { return status(StatusCode::NOT_FOUND) };
    let target = resolve(&doc_path, &rel);
    let Some(mime) = media_type(&target) else { return status(StatusCode::FORBIDDEN) };
    match std::fs::read(&target) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap(),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

/// Resolves a link or image path from a document, the way GitHub does:
/// relative to the document's folder, or relative to the repository root if
/// it starts with `/`. Absolute Windows paths are used as-is.
pub fn resolve(doc_path: &Path, rel: &str) -> PathBuf {
    let doc_dir = doc_path.parent().unwrap_or(Path::new(""));
    let as_path = Path::new(rel);
    // A leading slash means the repo root, as on GitHub. On Linux and macOS
    // that's also an absolute path, so fall back to it only if the repo
    // version doesn't exist and the absolute one does.
    if let Some(stripped) = rel.strip_prefix(['/', '\\']) {
        let in_repo = project_root(doc_dir).join(stripped);
        if !in_repo.exists() && as_path.is_absolute() && as_path.exists() {
            return as_path.to_path_buf();
        }
        return in_repo;
    }
    if as_path.is_absolute() {
        as_path.to_path_buf()
    } else {
        doc_dir.join(rel)
    }
}

/// The nearest folder containing `.git`, or the document's own folder.
pub fn project_root(dir: &Path) -> PathBuf {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .unwrap_or(dir)
        .to_path_buf()
}

fn media_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn resolves_relative_to_document_unix() {
        let doc = Path::new("/home/me/notes/guide/intro.md");
        assert_eq!(resolve(doc, "img/a.png"), Path::new("/home/me/notes/guide/img/a.png"));
        assert_eq!(resolve(doc, "../shared/b.png"), Path::new("/home/me/notes/guide/../shared/b.png"));
        // An absolute path is used as-is, except a leading slash means the
        // repo root, so this one resolves against the document's folder tree.
        assert!(resolve(doc, "/pics/c.png").ends_with("pics/c.png"));
    }

    #[test]
    #[cfg(windows)]
    fn resolves_relative_to_document() {
        let doc = Path::new(r"C:\notes\guide\intro.md");
        assert_eq!(resolve(doc, "img/a.png"), Path::new(r"C:\notes\guide\img/a.png"));
        assert_eq!(resolve(doc, "../shared/b.png"), Path::new(r"C:\notes\guide\../shared/b.png"));
        assert_eq!(resolve(doc, r"D:\pics\c.png"), Path::new(r"D:\pics\c.png"));
        assert_eq!(resolve(doc, "D:/pics/c.png"), Path::new("D:/pics/c.png"));
    }

    #[test]
    fn root_relative_uses_repo_root() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("docs").join("deep")).unwrap();
        let doc = repo.join("docs").join("deep").join("x.md");
        assert_eq!(resolve(&doc, "/assets/logo.png"), repo.join("assets/logo.png"));
    }

    #[test]
    fn absolute_paths_to_existing_files_still_work() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("pic.png");
        std::fs::write(&img, b"x").unwrap();
        let doc = Path::new("/somewhere/else/doc.md");
        assert_eq!(resolve(doc, img.to_str().unwrap()), img);
    }

    #[test]
    fn only_media_is_served() {
        assert_eq!(media_type(Path::new("a.PNG")), Some("image/png"));
        assert_eq!(media_type(Path::new("a.svg")), Some("image/svg+xml"));
        assert_eq!(media_type(Path::new("secrets.txt")), None);
        assert_eq!(media_type(Path::new("noext")), None);
    }
}
