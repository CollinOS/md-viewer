//! Markdown to HTML. Parsing is comrak (GFM), code highlighting is syntect
//! emitting CSS classes, so switching color schemes never needs a re-render.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::{self, Write};
use std::sync::OnceLock;

use comrak::adapters::{CodefenceRendererAdapter, SyntaxHighlighterAdapter};
use comrak::html::escape;
use comrak::nodes::Sourcepos;
use comrak::options::Plugins;
use comrak::{markdown_to_html_with_plugins, Options};
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

/// Code blocks larger than this are shown unhighlighted. syntect is the
/// slowest part of rendering and a huge block is rarely worth the wait.
const MAX_HIGHLIGHT_BYTES: usize = 256 * 1024;

pub const CLASS_PREFIX: &str = "hl-";

static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();

fn syntaxes() -> &'static SyntaxSet {
    SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
}

/// Loads the syntax definitions on a background thread so the first code
/// block doesn't pay for it.
pub fn warm_up() {
    std::thread::spawn(syntaxes);
}

struct Highlighter;

fn write_attrs(out: &mut dyn Write, attrs: HashMap<&'static str, Cow<'_, str>>) -> fmt::Result {
    let mut attrs: Vec<_> = attrs.into_iter().collect();
    attrs.sort_by_key(|(k, _)| *k);
    for (k, v) in attrs {
        write!(out, " {k}=\"")?;
        escape(out, &v)?;
        out.write_char('"')?;
    }
    Ok(())
}

impl SyntaxHighlighterAdapter for Highlighter {
    fn write_highlighted(&self, out: &mut dyn Write, lang: Option<&str>, code: &str) -> fmt::Result {
        let lang = lang.filter(|l| !l.is_empty());
        let (Some(lang), true) = (lang, code.len() <= MAX_HIGHLIGHT_BYTES) else {
            return escape(out, code);
        };
        let ss = syntaxes();
        let Some(syntax) = ss.find_syntax_by_token(lang) else {
            return escape(out, code);
        };
        let mut gen = ClassedHTMLGenerator::new_with_class_style(
            syntax,
            ss,
            ClassStyle::SpacedPrefixed { prefix: CLASS_PREFIX },
        );
        for line in LinesWithEndings::from(code) {
            if gen.parse_html_for_line_which_includes_newline(line).is_err() {
                return escape(out, code);
            }
        }
        out.write_str(&gen.finalize())
    }

    fn write_pre_tag(&self, out: &mut dyn Write, attrs: HashMap<&'static str, Cow<'_, str>>) -> fmt::Result {
        out.write_str("<pre")?;
        write_attrs(out, attrs)?;
        out.write_char('>')
    }

    fn write_code_tag(&self, out: &mut dyn Write, attrs: HashMap<&'static str, Cow<'_, str>>) -> fmt::Result {
        out.write_str("<code")?;
        write_attrs(out, attrs)?;
        out.write_char('>')
    }
}

/// Mermaid blocks are left as source for the frontend to render. The hash
/// lets the DOM differ skip diagrams whose source hasn't changed.
struct Mermaid;

impl CodefenceRendererAdapter for Mermaid {
    fn write(&self, out: &mut dyn Write, _lang: &str, _meta: &str, code: &str, sourcepos: Option<Sourcepos>) -> fmt::Result {
        write!(out, "<pre class=\"mermaid\" data-hash=\"{:x}\"", xxhash_rust::xxh3::xxh3_64(code.as_bytes()))?;
        if let Some(sp) = sourcepos {
            write!(out, " data-sourcepos=\"{sp}\"")?;
        }
        out.write_char('>')?;
        escape(out, code)?;
        out.write_str("</pre>\n")
    }
}

fn options(sourcepos: bool) -> Options<'static> {
    let mut o = Options::default();
    let e = &mut o.extension;
    e.strikethrough = true;
    e.table = true;
    e.autolink = true;
    e.tasklist = true;
    e.footnotes = true;
    e.alerts = true;
    e.header_id_prefix = Some(String::new());
    e.front_matter_delimiter = Some("---".into());
    o.render.r#unsafe = true;
    o.render.tasklist_classes = true;
    o.render.sourcepos = sourcepos;
    o
}

/// Renders markdown to HTML. `sourcepos` adds `data-sourcepos` attributes
/// (used for scroll sync while editing).
pub fn render(markdown: &str, sourcepos: bool) -> String {
    let highlighter = Highlighter;
    let mermaid = Mermaid;
    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&highlighter);
    plugins.render.codefence_renderers.insert("mermaid".into(), &mermaid);
    markdown_to_html_with_plugins(markdown, &options(sourcepos), &plugins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gfm_features() {
        let html = render(
            "# Title\n\n~~gone~~ https://example.com\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\nnote[^1]\n\n[^1]: the note\n",
            false,
        );
        assert!(html.contains(r#"<h1 id="title">"#), "{html}");
        assert!(html.contains("<del>gone</del>"), "{html}");
        assert!(html.contains(r#"<a href="https://example.com">"#), "{html}");
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("task-list-item"), "{html}");
        assert!(html.contains("checked"), "{html}");
        assert!(html.contains("footnote"), "{html}");
    }

    #[test]
    fn duplicate_headings_get_unique_ids() {
        let html = render("## Setup\n\n## Setup\n", false);
        assert!(html.contains(r#"id="setup""#), "{html}");
        assert!(html.contains(r#"id="setup-1""#), "{html}");
    }

    #[test]
    fn alerts() {
        let html = render("> [!WARNING]\n> careful\n", false);
        assert!(html.contains("markdown-alert-warning"), "{html}");
    }

    #[test]
    fn code_is_highlighted_with_classes() {
        let html = render("```rust\nfn main() {}\n```\n", false);
        assert!(html.contains(r#"class="language-rust""#), "{html}");
        assert!(html.contains("hl-keyword") || html.contains("hl-storage"), "{html}");
        assert!(!html.contains("style="), "{html}");
    }

    #[test]
    fn extended_syntaxes_are_available() {
        for lang in ["ts", "typescript", "toml", "dockerfile"] {
            let html = render(&format!("```{lang}\nlet x = 1\n```\n"), false);
            assert!(html.contains("hl-source"), "{lang} not highlighted: {html}");
        }
    }

    #[test]
    fn unknown_language_is_escaped() {
        let html = render("```nonsense\n<b>x</b>\n```\n", false);
        assert!(html.contains("&lt;b&gt;x&lt;/b&gt;"), "{html}");
    }

    #[test]
    fn mermaid_blocks_are_passed_through() {
        let html = render("```mermaid\ngraph TD; A-->B\n```\n", false);
        assert!(html.contains(r#"<pre class="mermaid" data-hash=""#), "{html}");
        assert!(html.contains("A--&gt;B"), "{html}");
        assert!(!html.contains("hl-"), "{html}");
    }

    #[test]
    fn mermaid_hash_tracks_source() {
        let a = render("```mermaid\ngraph TD; A-->B\n```\n", false);
        let b = render("```mermaid\ngraph TD; A-->C\n```\n", false);
        let c = render("intro\n\n```mermaid\ngraph TD; A-->B\n```\n", false);
        let hash = |s: &str| s.split("data-hash=\"").nth(1).unwrap().split('"').next().unwrap().to_owned();
        assert_ne!(hash(&a), hash(&b));
        assert_eq!(hash(&a), hash(&c));
    }

    #[test]
    fn front_matter_is_hidden() {
        let html = render("---\ntitle: x\n---\n\n# Body\n", false);
        assert!(!html.contains("title: x"), "{html}");
        assert!(html.contains("Body"), "{html}");
    }

    #[test]
    fn raw_html_is_kept() {
        let html = render("<details><summary>More</summary>\n\nhidden\n\n</details>\n", false);
        assert!(html.contains("<details>"), "{html}");
    }

    #[test]
    fn sourcepos_is_optional() {
        assert!(!render("# a\n", false).contains("data-sourcepos"));
        assert!(render("# a\n", true).contains("data-sourcepos=\"1:1-1:3\""));
    }
}
