//! Markdown to HTML. Parsing is comrak (GFM), code highlighting is syntect
//! emitting CSS classes, so switching color schemes never needs a re-render.
//!
//! Highlighting is by far the slowest step, so code blocks are highlighted
//! in parallel across cores and the results are cached by content. Live
//! preview and reloads then only pay for the blocks that actually changed.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::{self, Write};
use std::sync::{Arc, Mutex, OnceLock};

use comrak::adapters::{CodefenceRendererAdapter, SyntaxHighlighterAdapter};
use comrak::html::escape;
use comrak::nodes::{NodeValue, Sourcepos};
use comrak::options::Plugins;
use comrak::{format_html_with_plugins, parse_document, Arena, Options};
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

/// Code blocks larger than this are shown unhighlighted. A single huge block
/// can't be split across threads, and it's rarely worth the wait.
const MAX_HIGHLIGHT_BYTES: usize = 256 * 1024;

/// Below this much uncached code, threads cost more than they save.
const PARALLEL_MIN_BYTES: usize = 24 * 1024;

/// The cache is cleared when it grows past this.
const CACHE_LIMIT_BYTES: usize = 48 * 1024 * 1024;

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

#[derive(Default)]
struct Cache {
    map: HashMap<u64, Arc<str>>,
    bytes: usize,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

#[cfg(test)]
fn clear_cache() {
    let mut c = cache().lock().unwrap();
    c.map.clear();
    c.bytes = 0;
}

fn cache_key(lang: &str, code: &str) -> u64 {
    let mut h = xxhash_rust::xxh3::Xxh3::new();
    h.update(lang.as_bytes());
    h.update(&[0]);
    h.update(code.as_bytes());
    h.digest()
}

fn escaped(code: &str) -> String {
    let mut s = String::with_capacity(code.len() + code.len() / 8);
    let _ = escape(&mut s, code);
    s
}

/// Highlighted HTML for one block, or the escaped source if the language
/// is unknown or the block is too big.
fn highlight(lang: &str, code: &str) -> String {
    if lang.is_empty() || code.len() > MAX_HIGHLIGHT_BYTES {
        return escaped(code);
    }
    let ss = syntaxes();
    let Some(syntax) = ss.find_syntax_by_token(lang) else {
        return escaped(code);
    };
    let mut gen = ClassedHTMLGenerator::new_with_class_style(syntax, ss, ClassStyle::SpacedPrefixed { prefix: CLASS_PREFIX });
    for line in LinesWithEndings::from(code) {
        if gen.parse_html_for_line_which_includes_newline(line).is_err() {
            return escaped(code);
        }
    }
    gen.finalize()
}

struct Job {
    key: u64,
    lang: String,
    code: String,
}

fn highlight_jobs(jobs: Vec<Job>) -> Vec<(u64, String)> {
    let total: usize = jobs.iter().map(|j| j.code.len()).sum();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let threads = cores.min(jobs.len()).min(16);
    if total < PARALLEL_MIN_BYTES || threads < 2 {
        return jobs.into_iter().map(|j| (j.key, highlight(&j.lang, &j.code))).collect();
    }
    // Spread the work evenly: biggest blocks first, each to the least loaded thread.
    let mut jobs = jobs;
    jobs.sort_by_key(|j| std::cmp::Reverse(j.code.len()));
    let mut buckets: Vec<(usize, Vec<Job>)> = (0..threads).map(|_| (0, Vec::new())).collect();
    for job in jobs {
        let b = buckets.iter_mut().min_by_key(|(load, _)| *load).unwrap();
        b.0 += job.code.len();
        b.1.push(job);
    }
    std::thread::scope(|s| {
        let handles: Vec<_> = buckets
            .into_iter()
            .map(|(_, bucket)| s.spawn(move || bucket.into_iter().map(|j| (j.key, highlight(&j.lang, &j.code))).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

/// Language as comrak passes it to the highlighter: the first word of the info string.
fn fence_lang(info: &str) -> &str {
    info.split(|c: char| c.is_ascii_whitespace()).next().unwrap_or("")
}

/// Writes code blocks from the precomputed results.
struct Highlighter {
    results: HashMap<u64, Arc<str>>,
}

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
        let lang = lang.unwrap_or("");
        match self.results.get(&cache_key(lang, code)) {
            Some(html) => out.write_str(html),
            None => out.write_str(&highlight(lang, code)),
        }
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
    let opts = options(sourcepos);
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &opts);

    // Find code blocks, and which of them aren't cached yet.
    let mut results: HashMap<u64, Arc<str>> = HashMap::new();
    let mut jobs: Vec<Job> = Vec::new();
    let mut queued: std::collections::HashSet<u64> = std::collections::HashSet::new();
    {
        let cache = cache().lock().unwrap_or_else(|e| e.into_inner());
        for node in root.descendants() {
            let data = node.data();
            let NodeValue::CodeBlock(cb) = &data.value else { continue };
            let lang = fence_lang(&cb.info);
            if lang.is_empty() || lang == "mermaid" || lang == "math" || cb.literal.len() > MAX_HIGHLIGHT_BYTES {
                continue;
            }
            let key = cache_key(lang, &cb.literal);
            if results.contains_key(&key) || queued.contains(&key) {
                continue;
            }
            match cache.map.get(&key) {
                Some(html) => {
                    results.insert(key, html.clone());
                }
                None => {
                    queued.insert(key);
                    jobs.push(Job { key, lang: lang.to_owned(), code: cb.literal.clone() });
                }
            }
        }
    }

    if !jobs.is_empty() {
        let fresh = highlight_jobs(jobs);
        let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
        let added: usize = fresh.iter().map(|(_, h)| h.len()).sum();
        if cache.bytes + added > CACHE_LIMIT_BYTES {
            cache.map.clear();
            cache.bytes = 0;
        }
        for (key, html) in fresh {
            let html: Arc<str> = html.into();
            cache.bytes += html.len();
            cache.map.insert(key, html.clone());
            results.insert(key, html);
        }
    }

    let highlighter = Highlighter { results };
    let mermaid = Mermaid;
    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&highlighter);
    plugins.render.codefence_renderers.insert("mermaid".into(), &mermaid);
    let mut out = String::with_capacity(markdown.len() * 2);
    let _ = format_html_with_plugins(root, &opts, &mut out, &plugins);
    out
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

    #[test]
    fn parallel_and_cached_output_match_sequential() {
        let mut md = String::new();
        for i in 0..200 {
            md.push_str(&format!("## Block {i}

```rust
fn f{i}() -> u32 {{ {i} }}
```

```python
def g{i}():
    return {i}
```

"));
        }
        md.push_str("```rust
fn f0() -> u32 { 0 }
```
"); // duplicate block
        clear_cache();
        let first = render(&md, false);
        let cached = render(&md, false);
        assert_eq!(first, cached);
        // Same output as highlighting each block on its own.
        for i in [0, 57, 199] {
            let single = render(&format!("```rust
fn f{i}() -> u32 {{ {i} }}
```
"), false);
            let block = single.trim();
            assert!(first.contains(block), "block {i} differs");
        }
    }

    #[test]
    fn oversized_blocks_are_escaped_not_highlighted() {
        let big = format!("```rust
{}
```
", "let x = 1; // <tag>
".repeat(20_000));
        let html = render(&big, false);
        assert!(!html.contains("hl-"));
        assert!(html.contains("&lt;tag&gt;"));
    }
}

/// Timing for the generated files in `bench/files`. Run with:
/// `cargo test --release --lib render_benchmark -- --ignored --nocapture`
#[cfg(test)]
mod bench {
    use std::time::Instant;

    #[test]
    #[ignore]
    fn render_benchmark() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../bench/files");
        // Load syntaxes up front, as the app does on a background thread.
        let t = Instant::now();
        super::syntaxes();
        println!("syntax set load: {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
        for name in ["readme-20k.md", "large-1mb.md", "code-heavy-500k.md", "huge-5mb.md"] {
            let text = std::fs::read_to_string(dir.join(name)).expect("run `node bench/gen.mjs` first");
            let mut times: Vec<f64> = (0..7)
                .map(|_| {
                    super::clear_cache();
                    let t = Instant::now();
                    std::hint::black_box(super::render(&text, false));
                    t.elapsed().as_secs_f64() * 1000.0
                })
                .collect();
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let t = Instant::now();
            std::hint::black_box(super::render(&text, false));
            let warm = t.elapsed().as_secs_f64() * 1000.0;
            println!("{name:>22}: cold median {:7.2} ms  min {:7.2} ms  warm cache {:7.2} ms", times[3], times[0], warm);
        }
    }
}

