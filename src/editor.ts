// The markdown editor. Loaded with a dynamic import the first time someone
// presses Ctrl+E, so viewing never pays for CodeMirror.

import { EditorState, Text, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, dropCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

export interface EditorCallbacks {
  onChange(): void;
  onScroll(topLine: number): void;
}

const highlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--hl-heading)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600", color: "var(--fg-strong)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, color: "var(--hl-string)" },
  { tag: t.quote, color: "var(--fg-muted)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--fg-muted)" },
  { tag: t.comment, color: "var(--hl-comment)" },
  { tag: [t.labelName, t.atom], color: "var(--hl-attr)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    fontSize: "calc(var(--font-size, 16px) * 0.875)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--code-font)", lineHeight: "1.6", fontVariantLigatures: "none" },
  ".cm-content": { padding: "24px 0 50vh", caretColor: "var(--fg-strong)" },
  ".cm-line": { padding: "0 24px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg-strong)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection) !important" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-subtle) 70%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "var(--mark)", outline: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--bg-chrome)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button": { font: "inherit", color: "var(--fg)" },
  ".cm-textfield": { backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: "4px" },
});

export class Editor {
  readonly view: EditorView;
  private readonly extensions: Extension[];

  constructor(parent: HTMLElement, cb: EditorCallbacks) {
    this.extensions = [
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(highlight),
      theme,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb.onChange();
      }),
    ];
    this.view = new EditorView({ parent, state: this.createState("") });
    const view = this.view;
    view.scrollDOM.addEventListener(
      "scroll",
      () => {
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
        cb.onScroll(view.state.doc.lineAt(block.from).number);
      },
      { passive: true },
    );
  }

  createState(text: string): EditorState {
    return EditorState.create({ doc: text, extensions: this.extensions });
  }

  focus() {
    this.view.focus();
  }
}

/**
 * The smallest change that turns `doc` into `text`, so replacing the content
 * after an outside edit keeps the cursor and scroll position where they were.
 */
export function minimalChange(doc: Text, text: string) {
  const old = doc.toString();
  let start = 0;
  const max = Math.min(old.length, text.length);
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let endOld = old.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: text.slice(start, endNew) };
}

export { EditorState, Text };
