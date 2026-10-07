//! Reading and writing documents on disk while preserving their original
//! encoding, byte order mark and line endings.

use std::borrow::Cow;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFormat {
    pub encoding: Encoding,
    pub bom: bool,
    pub line_ending: LineEnding,
}

pub struct Decoded {
    /// Text with line endings normalized to `\n`.
    pub text: String,
    pub format: FileFormat,
}

pub fn hash(bytes: &[u8]) -> u64 {
    xxhash_rust::xxh3::xxh3_64(bytes)
}

pub fn decode(bytes: &[u8]) -> Decoded {
    let (mut encoding, bom, body) = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (Encoding::Utf8, true, rest)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        (Encoding::Utf16Le, true, rest)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        (Encoding::Utf16Be, true, rest)
    } else {
        (Encoding::Utf8, false, bytes)
    };

    let raw: Cow<str> = match encoding {
        Encoding::Utf8 => match std::str::from_utf8(body) {
            Ok(s) => Cow::Borrowed(s),
            Err(_) => {
                encoding = Encoding::Windows1252;
                WINDOWS_1252.decode_without_bom_handling(body).0
            }
        },
        Encoding::Utf16Le => UTF_16LE.decode_without_bom_handling(body).0,
        Encoding::Utf16Be => UTF_16BE.decode_without_bom_handling(body).0,
        Encoding::Windows1252 => unreachable!(),
    };

    let line_ending = match raw.find('\n') {
        Some(i) if i > 0 && raw.as_bytes()[i - 1] == b'\r' => LineEnding::Crlf,
        _ => LineEnding::Lf,
    };

    Decoded {
        text: normalize_newlines(raw),
        format: FileFormat { encoding, bom, line_ending },
    }
}

/// Converts `\r\n` and lone `\r` to `\n`. Returns the input untouched when
/// there is nothing to convert, which is the common case for LF files.
fn normalize_newlines(s: Cow<str>) -> String {
    if !s.contains('\r') {
        return s.into_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

pub struct Encoded {
    pub bytes: Vec<u8>,
    /// The format actually used. Differs from the requested one only when the
    /// text can't be represented in Windows-1252 and we fell back to UTF-8.
    pub format: FileFormat,
}

/// Encodes LF-normalized `text` back into the file's original format.
pub fn encode(text: &str, format: FileFormat) -> Encoded {
    let text: Cow<str> = match format.line_ending {
        LineEnding::Crlf => Cow::Owned(text.replace('\n', "\r\n")),
        LineEnding::Lf => Cow::Borrowed(text),
    };
    let mut format = format;
    let bytes = match format.encoding {
        Encoding::Utf8 => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if format.bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
            out
        }
        // encoding_rs only decodes UTF-16, so encode it by hand.
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let le = format.encoding == Encoding::Utf16Le;
            let mut out = Vec::with_capacity(text.len() * 2 + 2);
            if format.bom {
                out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            }
            for unit in text.encode_utf16() {
                out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            out
        }
        Encoding::Windows1252 => {
            let (bytes, _, unmappable) = WINDOWS_1252.encode(&text);
            if unmappable {
                // encoding_rs would have written HTML character references
                // for these, which corrupts the file. Use UTF-8 instead.
                format.encoding = Encoding::Utf8;
                format.bom = false;
                text.as_bytes().to_vec()
            } else {
                bytes.into_owned()
            }
        }
    };
    Encoded { bytes, format }
}

/// Writes through a temp file in the same folder and renames it over the
/// original, so a crash mid-write never leaves a half-written document.
/// Falls back to writing in place if the rename is refused (for example when
/// another program holds the file open without delete sharing).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().readonly() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the file is read-only"));
        }
    }
    let dir = path.parent().ok_or_else(|| io::Error::other("path has no parent folder"))?;
    let name = path.file_name().ok_or_else(|| io::Error::other("path has no file name"))?;
    let tmp = dir.join(format!(".{}.mdv-tmp", name.to_string_lossy()));

    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if written.is_ok() && fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(&tmp);
    fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(bytes: &[u8]) -> Vec<u8> {
        let d = decode(bytes);
        encode(&d.text, d.format).bytes
    }

    #[test]
    fn plain_utf8_lf() {
        let d = decode(b"# Hi\nthere\n");
        assert_eq!(d.text, "# Hi\nthere\n");
        assert_eq!(d.format, FileFormat { encoding: Encoding::Utf8, bom: false, line_ending: LineEnding::Lf });
        assert_eq!(roundtrip(b"# Hi\nthere\n"), b"# Hi\nthere\n");
    }

    #[test]
    fn crlf_is_normalized_and_restored() {
        let src = b"a\r\nb\r\n\r\nc";
        let d = decode(src);
        assert_eq!(d.text, "a\nb\n\nc");
        assert_eq!(d.format.line_ending, LineEnding::Crlf);
        assert_eq!(roundtrip(src), src);
    }

    #[test]
    fn utf8_bom_roundtrips() {
        let src = b"\xEF\xBB\xBFcaf\xC3\xA9\r\n";
        let d = decode(src);
        assert_eq!(d.text, "café\n");
        assert!(d.format.bom);
        assert_eq!(roundtrip(src), src);
    }

    #[test]
    fn utf16le_roundtrips() {
        let mut src = vec![0xFF, 0xFE];
        for u in "héllo\r\nwörld".encode_utf16() {
            src.extend_from_slice(&u.to_le_bytes());
        }
        let d = decode(&src);
        assert_eq!(d.text, "héllo\nwörld");
        assert_eq!(d.format.encoding, Encoding::Utf16Le);
        assert_eq!(roundtrip(&src), src);
    }

    #[test]
    fn utf16be_roundtrips() {
        let mut src = vec![0xFE, 0xFF];
        for u in "x\ny".encode_utf16() {
            src.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(decode(&src).text, "x\ny");
        assert_eq!(roundtrip(&src), src);
    }

    #[test]
    fn invalid_utf8_falls_back_to_windows_1252() {
        let src = b"caf\xE9 \x93quoted\x94\n";
        let d = decode(src);
        assert_eq!(d.format.encoding, Encoding::Windows1252);
        assert_eq!(d.text, "café \u{201C}quoted\u{201D}\n");
        assert_eq!(roundtrip(src), src);
    }

    #[test]
    fn unmappable_1252_text_upgrades_to_utf8() {
        let d = decode(b"caf\xE9\n");
        let e = encode("café 日本\n", d.format);
        assert_eq!(e.format.encoding, Encoding::Utf8);
        assert_eq!(e.bytes, "café 日本\n".as_bytes());
    }

    #[test]
    fn lone_cr_is_normalized() {
        assert_eq!(decode(b"a\rb").text, "a\nb");
    }

    #[test]
    fn atomic_write_replaces_contents() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.md");
        fs::write(&p, "old").unwrap();
        write_atomic(&p, b"new contents").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new contents");
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "temp file should be gone");
    }

    #[test]
    fn atomic_write_refuses_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ro.md");
        fs::write(&p, "x").unwrap();
        let mut perms = fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&p, perms.clone()).unwrap();
        assert!(write_atomic(&p, b"y").is_err());
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&p, perms).unwrap();
    }
}
