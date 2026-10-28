use crate::code_highlighter::BoundedCodeHighlighter;
use crate::slash_palette::{SlashCommandSpec, filter_slash_commands};
use crate::theme::VellumTheme;
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, ElementInputHandler, Entity,
    EntityInputHandler, FocusHandle, Focusable, FontStyle, FontWeight, HighlightStyle,
    InteractiveElement, IntoElement, ListAlignment, ListState, MouseButton, MouseDownEvent,
    ParentElement, Pixels, Point, Render, SharedString, StatefulInteractiveElement,
    StrikethroughStyle, Styled, StyledText, UTF16Selection, UnderlineStyle, Window, actions,
    canvas, div, list, prelude::FluentBuilder, px, rgb, rgba,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use vellum_core::{BlockKind, ColumnAlign, GfmTableModel, RopeDocument};

actions!(
    vellum_editor,
    [
        EditorBackspace,
        EditorDeleteForward,
        EditorEnter,
        EditorSoftNewline,
        EditorIndent,
        EditorOutdent,
        EditorMoveLeft,
        EditorMoveRight,
        EditorMoveUp,
        EditorMoveDown,
        EditorMoveLineStart,
        EditorMoveLineEnd,
        EditorMoveDocStart,
        EditorMoveDocEnd,
        EditorSelectLeft,
        EditorSelectRight,
        EditorSelectAll,
        EditorCopy,
        EditorCut,
        EditorPaste,
        EditorEscape,
    ]
);

const CARET_GLYPH: &str = "\u{258F}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorMode {
    InstantWysiwyg,
    SourceCode,
    SplitPreview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntaxMarkerVisibility {
    /// PRD 5.3 Default: Reveal syntax markers (`#`, `**`, `` ` ``) only on the block under cursor.
    ActiveBlockOnly,
    AlwaysHidden,
    AlwaysVisible,
}

/// Core GPUI Editor Surface Entity (`Render` + `Focusable` + `EntityInputHandler`).
///
/// Key UX & performance guarantees:
/// 1. **True WYSIWYG Rendering**: Unfocused blocks hide raw Markdown delimiters while preserving
///    full GPU `StyledText` inline typography (bold, italic, inline code pills, strikethrough,
///    highlights, links, `[[WikiLinks]]`, Callout cards, GFM tables, checklists, Mermaid diagrams).
/// 2. **Visible Native Caret & Accurate Click-to-Cursor**: Renders a high-contrast accent caret
///    at the exact UTF-8 byte offset, maps mouse clicks across wrapped CJK/Latin lines, and
///    includes an interactive `+1` bottom canvas tail item so users can always click or press
///    `Enter` to continue writing at the end of any document.
/// 3. **Native CJK IME Composition Protection (`PRD ED-03`)**: Tracks `ime_marked_utf8` and
///    suppresses Input Rule auto-conversions until `unmark_text()` commits the final phrase.
pub struct WysiwygEditorSurface {
    pub doc: RopeDocument,
    pub mode: EditorMode,
    pub marker_visibility: SyntaxMarkerVisibility,
    pub focus_mode: bool,
    pub typewriter_mode: bool,
    pub theme_override_dark: Option<bool>,
    pub focus_handle: FocusHandle,
    pub list_state: ListState,
    pub cursor_byte: usize,
    pub selection_bytes: Range<usize>,
    pub ime_marked_utf8: Option<Range<usize>>,
    pub slash_query: Option<String>,
    pub editing_structured_block: Option<usize>,
    pub on_navigate_wikilink: Option<Rc<dyn Fn(String, Option<String>, &mut Window, &mut App)>>,
    pub on_doc_changed: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    pub highlighter: BoundedCodeHighlighter,
    painted_block_bounds: Rc<RefCell<HashMap<usize, Bounds<Pixels>>>>,
}

impl WysiwygEditorSurface {
    pub fn new(doc: RopeDocument, cx: &mut Context<Self>) -> Self {
        // `+ 1` reserves the interactive bottom canvas tail zone below the last block
        let item_count = doc.blocks().len().max(1) + 1;
        let list_state = ListState::new(item_count, ListAlignment::Top, px(420.0));
        let mut surface = Self {
            doc,
            mode: EditorMode::InstantWysiwyg,
            marker_visibility: SyntaxMarkerVisibility::ActiveBlockOnly,
            focus_mode: false,
            typewriter_mode: false,
            theme_override_dark: None,
            focus_handle: cx.focus_handle(),
            list_state,
            cursor_byte: 0,
            selection_bytes: 0..0,
            ime_marked_utf8: None,
            slash_query: None,
            editing_structured_block: None,
            on_navigate_wikilink: None,
            on_doc_changed: None,
            highlighter: BoundedCodeHighlighter::new(),
            painted_block_bounds: Rc::new(RefCell::new(HashMap::new())),
        };
        let initial_cursor = surface.max_editable_cursor_byte();
        surface.cursor_byte = initial_cursor;
        surface.selection_bytes = initial_cursor..initial_cursor;
        surface
    }

    pub fn refresh_list_state(&mut self) {
        let item_count = self.doc.blocks().len().max(1) + 1;
        self.list_state.reset(item_count);
    }

    pub fn replace_document(&mut self, next_doc: RopeDocument, cx: &mut Context<Self>) {
        self.doc = next_doc;
        self.cursor_byte = 0;
        self.selection_bytes = 0..0;
        self.ime_marked_utf8 = None;
        self.slash_query = None;
        self.editing_structured_block = None;
        self.painted_block_bounds.borrow_mut().clear();
        self.refresh_list_state();
        cx.notify();
    }

    pub fn active_block_index(&self) -> usize {
        if self.doc.blocks().is_empty() {
            return 0;
        }
        let clamped_cursor = self.cursor_byte.min(self.doc.len_bytes());
        self.doc
            .blocks()
            .partition_point(|b| b.byte_range.end < clamped_cursor)
            .min(self.doc.blocks().len() - 1)
    }

    /// Returns the maximum valid editable cursor byte, avoiding landing after a single POSIX
    /// trailing newline (`"text\n"` -> before `\n`), while allowing `len_bytes()` when an explicit
    /// trailing blank paragraph (`"\n\n"`) exists at EOF.
    pub fn max_editable_cursor_byte(&self) -> usize {
        let len = self.doc.len_bytes();
        if len == 0 {
            return 0;
        }
        let n_chars = self.doc.rope().len_chars();
        if n_chars == 0 {
            return 0;
        }
        let last_ch = self.doc.rope().char(n_chars - 1);
        if last_ch != '\n' {
            return len;
        }
        if n_chars == 1 {
            return len;
        }
        let prev_ch = self.doc.rope().char(n_chars - 2);
        if prev_ch == '\n' {
            return len;
        }
        if prev_ch == '\r' {
            if n_chars >= 3 && self.doc.rope().char(n_chars - 3) == '\n' {
                return len;
            }
            return len.saturating_sub(2);
        }
        len.saturating_sub(1)
    }

    fn clamp_doc_char_boundary(&self, byte_pos: usize) -> usize {
        let clamped = byte_pos.min(self.doc.len_bytes());
        let char_ix = self.doc.rope().byte_to_char(clamped);
        self.doc.rope().char_to_byte(char_ix)
    }

    fn prev_char_byte(&self, byte_pos: usize) -> usize {
        let clamped = byte_pos.min(self.doc.len_bytes());
        let char_ix = self.doc.rope().byte_to_char(clamped);
        if char_ix == 0 {
            0
        } else {
            self.doc.rope().char_to_byte(char_ix - 1)
        }
    }

    fn next_char_byte(&self, byte_pos: usize) -> usize {
        let clamped = byte_pos.min(self.doc.len_bytes());
        let char_ix = self.doc.rope().byte_to_char(clamped);
        if char_ix >= self.doc.rope().len_chars() {
            self.doc.len_bytes()
        } else {
            self.doc.rope().char_to_byte(char_ix + 1)
        }
    }

    fn notify_doc_mutated(&mut self, prev_block_count: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_list_count(prev_block_count);
        if let Some( editing_ix ) = self.editing_structured_block {
            if editing_ix != self.active_block_index() {
                self.editing_structured_block = None;
            }
        }
        if let Some(cb) = self.on_doc_changed.clone() {
            cb(window, cx);
        }
        cx.notify();
    }

    /// Ensures an editable blank paragraph exists at the very end of the document, places the
    /// cursor at `doc.len_bytes()`, focuses the editor, and scrolls the tail into view.
    pub fn append_or_focus_document_end(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let prev_blocks = self.doc.blocks().len();
        let full = self.doc.to_lossless_markdown();

        if !full.is_empty() {
            let needs_double_nl = !full.ends_with("\n\n") && !full.ends_with("\r\n\r\n");
            if needs_double_nl {
                let suffix = if full.ends_with('\n') { "\n" } else { "\n\n" };
                let eof = self.doc.len_bytes();
                let _ = self.doc.edit_byte_range(eof..eof, suffix, false);
            }
        }

        let end_pos = self.doc.len_bytes();
        self.cursor_byte = end_pos;
        self.selection_bytes = end_pos..end_pos;
        self.editing_structured_block = None;
        self.update_slash_state();
        self.sync_list_count(prev_blocks);

        let last_block_ix = self.doc.blocks().len().saturating_sub(1);
        self.list_state.scroll_to_reveal_item(last_block_ix);
        window.focus(&self.focus_handle);
        if let Some(cb) = self.on_doc_changed.clone() {
            cb(window, cx);
        }
        cx.notify();
    }

    /// Inserts a Markdown block snippet (such as H1/H2/Table/Code/Quote/Task) at cursor or new line.
    pub fn insert_block_template(
        &mut self,
        template: &str,
        backtrack_bytes: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prev_blocks = self.doc.blocks().len();
        let pos = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(pos);
        let line_start = self.doc.rope().line_to_byte(line_idx);
        let line_str = self.doc.rope().line(line_idx).to_string();
        let line_trimmed = line_str.trim();

        let (range, payload) = if line_trimmed.is_empty() {
            (line_start..pos, template.to_string())
        } else {
            let prefix = if pos > 0 { "\n\n" } else { "" };
            (pos..pos, format!("{}{}", prefix, template))
        };

        if let Ok(end_byte) = self.doc.edit_byte_range(range, &payload, false) {
            let next_pos = end_byte.saturating_sub(backtrack_bytes);
            self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.update_slash_state();
            let active = self.active_block_index();
            self.list_state.scroll_to_reveal_item(active);
            window.focus(&self.focus_handle);
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    /// Wraps current selection in symmetric or asymmetric Markdown delimiters (e.g. `**`/`**` or `[[`/`]]`)
    /// inside a single undoable edit transaction and notifies workspace observers.
    pub fn wrap_selection_pair(
        &mut self,
        open_delim: &str,
        close_delim: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = if self.selection_bytes.is_empty() {
            let p = self
                .clamp_doc_char_boundary(self.cursor_byte)
                .min(self.max_editable_cursor_byte());
            p..p
        } else {
            self.clamp_doc_char_boundary(self.selection_bytes.start)
                ..self.clamp_doc_char_boundary(self.selection_bytes.end)
        };
        let cs = self.doc.rope().byte_to_char(range.start);
        let ce = self.doc.rope().byte_to_char(range.end);
        let selected = self.doc.rope().slice(cs..ce).to_string();
        let wrapped = format!("{}{}{}", open_delim, selected, close_delim);

        let prev_count = self.doc.blocks().len();
        if let Ok(after) = self.doc.edit_byte_range(range, &wrapped, false) {
            self.cursor_byte =
                self.clamp_doc_char_boundary(after.saturating_sub(close_delim.len()));
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            window.focus(&self.focus_handle);
            self.notify_doc_mutated(prev_count, window, cx);
        }
    }

    /// Wraps current selection in symmetric Markdown inline markers (`**`, `*`, `` ` ``).
    pub fn toggle_inline_delimiter(&mut self, delimiter: &str, cx: &mut Context<Self>) {
        let range = if self.selection_bytes.is_empty() {
            let p = self
                .clamp_doc_char_boundary(self.cursor_byte)
                .min(self.max_editable_cursor_byte());
            p..p
        } else {
            self.clamp_doc_char_boundary(self.selection_bytes.start)
                ..self.clamp_doc_char_boundary(self.selection_bytes.end)
        };
        let cs = self.doc.rope().byte_to_char(range.start);
        let ce = self.doc.rope().byte_to_char(range.end);
        let selected = self.doc.rope().slice(cs..ce).to_string();
        let wrapped = format!("{}{}{}", delimiter, selected, delimiter);

        let prev_count = self.doc.blocks().len();
        if let Ok(after) = self.doc.edit_byte_range(range, &wrapped, false) {
            self.cursor_byte = self.clamp_doc_char_boundary(after.saturating_sub(delimiter.len()));
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.sync_list_count(prev_count);
            cx.notify();
        }
    }

    /// Toggles a GFM task item `- [ ]` <-> `- [x]` directly inside `RopeDocument` (`PRD Section 4.1`).
    pub fn toggle_task_checkbox(
        &mut self,
        block_ix: usize,
        line_idx_in_block: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(desc) = self.doc.blocks().get(block_ix).cloned() else {
            return;
        };
        let Some(raw) = self.doc.slice_block_str(block_ix) else {
            return;
        };

        let prev_count = self.doc.blocks().len();
        let mut offset_in_block = 0usize;
        for (idx, line) in raw.split_inclusive('\n').enumerate() {
            if idx == line_idx_in_block {
                if let Some(rel) = line.find("[ ]") {
                    let abs = desc.byte_range.start + offset_in_block + rel;
                    let _ = self.doc.edit_byte_range(abs..(abs + 3), "[x]", false);
                } else if let Some(rel) = line.find("[x]").or_else(|| line.find("[X]")) {
                    let abs = desc.byte_range.start + offset_in_block + rel;
                    let _ = self.doc.edit_byte_range(abs..(abs + 3), "[ ]", false);
                }
                self.notify_doc_mutated(prev_count, window, cx);
                break;
            }
            offset_in_block += line.len();
        }
    }

    pub fn mutate_gfm_table(
        &mut self,
        block_ix: usize,
        add_col: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(desc) = self.doc.blocks().get(block_ix).cloned() else {
            return;
        };
        let Some(raw) = self.doc.slice_block_str(block_ix) else {
            return;
        };
        let Some(mut table) = GfmTableModel::parse(&raw) else {
            return;
        };
        if add_col {
            table.add_column();
        } else {
            table.add_row();
        }
        let serialized = table.to_gfm_markdown();
        let prev_count = self.doc.blocks().len();
        if let Ok(end_pos) = self
            .doc
            .edit_byte_range(desc.byte_range.clone(), &serialized, false)
        {
            self.cursor_byte = self.clamp_doc_char_boundary(end_pos);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.notify_doc_mutated(prev_count, window, cx);
        }
    }

    pub fn apply_slash_command(
        &mut self,
        cmd: &SlashCommandSpec,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let query_len = self.slash_query.as_ref().map(|q| q.len()).unwrap_or(1);
        let replace_start = self
            .clamp_doc_char_boundary(self.cursor_byte.saturating_sub(query_len));
        let replace_end = self.clamp_doc_char_boundary(self.cursor_byte);
        let prev_count = self.doc.blocks().len();
        if let Ok(end_byte) = self
            .doc
            .edit_byte_range(replace_start..replace_end, cmd.template, false)
        {
            self.cursor_byte =
                self.clamp_doc_char_boundary(end_byte.saturating_sub(cmd.cursor_backtrack_bytes));
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.slash_query = None;
            window.focus(&self.focus_handle);
            self.notify_doc_mutated(prev_count, window, cx);
        }
    }

    // --- Keyboard Action Handlers (`vellum_editor`) ---

    fn handle_backspace(&mut self, _: &EditorBackspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.ime_marked_utf8.is_some() {
            return;
        }
        let prev_blocks = self.doc.blocks().len();
        let range = if !self.selection_bytes.is_empty() {
            self.clamp_doc_char_boundary(self.selection_bytes.start)
                ..self.clamp_doc_char_boundary(self.selection_bytes.end)
        } else if self.cursor_byte > 0 {
            let cur = self.clamp_doc_char_boundary(self.cursor_byte);
            let prev = self.prev_char_byte(cur);
            prev..cur
        } else {
            return;
        };

        if let Ok(next_pos) = self.doc.edit_byte_range(range, "", false) {
            self.cursor_byte = self
                .clamp_doc_char_boundary(next_pos)
                .min(self.max_editable_cursor_byte());
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.update_slash_state();
            let active = self.active_block_index();
            self.list_state.scroll_to_reveal_item(active);
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn handle_delete_forward(
        &mut self,
        _: &EditorDeleteForward,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.ime_marked_utf8.is_some() {
            return;
        }
        let prev_blocks = self.doc.blocks().len();
        let range = if !self.selection_bytes.is_empty() {
            self.clamp_doc_char_boundary(self.selection_bytes.start)
                ..self.clamp_doc_char_boundary(self.selection_bytes.end)
        } else if self.cursor_byte < self.doc.len_bytes() {
            let cur = self.clamp_doc_char_boundary(self.cursor_byte);
            let nxt = self.next_char_byte(cur);
            cur..nxt
        } else {
            return;
        };

        if let Ok(next_pos) = self.doc.edit_byte_range(range, "", false) {
            self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.update_slash_state();
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn handle_enter(&mut self, _: &EditorEnter, window: &mut Window, cx: &mut Context<Self>) {
        if self.ime_marked_utf8.is_some() {
            return;
        }

        // 1. If Slash Command Palette is open, execute top matching command
        if let Some(q) = self.slash_query.clone() {
            let candidates = filter_slash_commands(&q);
            if let Some(first_cmd) = candidates.first() {
                let spec = (*first_cmd).clone();
                self.apply_slash_command(&spec, window, cx);
                return;
            }
        }

        let prev_blocks = self.doc.blocks().len();
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let active_ix = self.active_block_index();
        let active_kind = self.doc.blocks().get(active_ix).map(|b| b.kind.clone());

        // Inside Fenced Code / Math / Mermaid / SourceCode mode -> insert single literal `\n`
        if self.mode == EditorMode::SourceCode
            || self.editing_structured_block.is_some()
            || matches!(
                active_kind,
                Some(BlockKind::CodeBlock { .. } | BlockKind::MathBlock | BlockKind::MermaidBlock)
            )
        {
            if let Ok(next_pos) = self.doc.edit_byte_range(cur..cur, "\n", true) {
                self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
                self.selection_bytes = self.cursor_byte..self.cursor_byte;
                self.notify_doc_mutated(prev_blocks, window, cx);
            }
            return;
        }

        // Check current line for list continuation or empty-list-item exit (`PRD ED-04`)
        let line_idx = self.doc.rope().byte_to_line(cur);
        let line_start = self.doc.rope().line_to_byte(line_idx);
        let line_full = self.doc.rope().line(line_idx).to_string();
        let rel_col = (cur - line_start).min(line_full.len());
        let line_before_cursor = &line_full[..rel_col];

        if let Some(list_action) = analyze_list_enter(line_before_cursor) {
            match list_action {
                ListEnterAction::ExitEmptyItem => {
                    // Strip the empty `- ` / `- [ ] ` / `1. ` line and open a clean paragraph below
                    let line_end_with_nl = line_start + line_full.len();
                    let replacement = if line_end_with_nl >= self.doc.len_bytes() {
                        "\n"
                    } else {
                        "\n\n"
                    };
                    if let Ok(_) =
                        self.doc
                            .edit_byte_range(line_start..line_end_with_nl, replacement, false)
                    {
                        self.cursor_byte = self.clamp_doc_char_boundary(line_start + 1);
                        self.selection_bytes = self.cursor_byte..self.cursor_byte;
                        let active = self.active_block_index();
                        self.list_state.scroll_to_reveal_item(active);
                        self.notify_doc_mutated(prev_blocks, window, cx);
                    }
                    return;
                }
                ListEnterAction::ContinueWithPrefix(next_prefix) => {
                    let insert_str = format!("\n{}", next_prefix);
                    if let Ok(next_pos) = self.doc.edit_byte_range(cur..cur, &insert_str, false) {
                        self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
                        self.selection_bytes = self.cursor_byte..self.cursor_byte;
                        let active = self.active_block_index();
                        self.list_state.scroll_to_reveal_item(active);
                        self.notify_doc_mutated(prev_blocks, window, cx);
                    }
                    return;
                }
            }
        }

        // Check if user typed ` ```lang ` or `---` before pressing Enter -> trigger InputRuleEngine with `\n`
        let trimmed_before = line_before_cursor.trim();
        if trimmed_before.starts_with("```") || trimmed_before == "---" || trimmed_before == "***" {
            if let Ok(next_pos) = self.doc.edit_byte_range(cur..cur, "\n", true) {
                self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
                self.selection_bytes = self.cursor_byte..self.cursor_byte;
                let active = self.active_block_index();
                self.list_state.scroll_to_reveal_item(active);
                self.notify_doc_mutated(prev_blocks, window, cx);
            }
            return;
        }

        // Standard WYSIWYG Enter: split into a new Markdown paragraph (`\n\n`).
        // Handle single trailing newline at EOF cleanly whether cursor is right before or after it.
        let doc_len = self.doc.len_bytes();
        let next_byte_is_eof_nl = cur + 1 == doc_len
            && self.doc.rope().char(self.doc.rope().byte_to_char(cur)) == '\n';
        let at_eof_after_single_nl =
            cur == doc_len && doc_len > 0 && self.max_editable_cursor_byte() < doc_len;

        let (edit_range, inserted) = if next_byte_is_eof_nl {
            (cur..(cur + 1), "\n\n")
        } else if at_eof_after_single_nl {
            (cur..cur, "\n")
        } else {
            (cur..cur, "\n\n")
        };

        if let Ok(next_pos) = self.doc.edit_byte_range(edit_range, inserted, false) {
            self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.update_slash_state();
            let active = self.active_block_index();
            self.list_state.scroll_to_reveal_item(active);
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn handle_soft_newline(
        &mut self,
        _: &EditorSoftNewline,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.ime_marked_utf8.is_some() {
            return;
        }
        let prev_blocks = self.doc.blocks().len();
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        if let Ok(next_pos) = self.doc.edit_byte_range(cur..cur, "\n", false) {
            self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn handle_indent(&mut self, _: &EditorIndent, window: &mut Window, cx: &mut Context<Self>) {
        let prev_blocks = self.doc.blocks().len();
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        let line_start = self.doc.rope().line_to_byte(line_idx);
        if let Ok(_) = self.doc.edit_byte_range(line_start..line_start, "  ", false) {
            self.cursor_byte = self.clamp_doc_char_boundary(cur + 2);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn handle_outdent(&mut self, _: &EditorOutdent, window: &mut Window, cx: &mut Context<Self>) {
        let prev_blocks = self.doc.blocks().len();
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        let line_start = self.doc.rope().line_to_byte(line_idx);
        let line_str = self.doc.rope().line(line_idx).to_string();
        if line_str.starts_with("  ") {
            if let Ok(_) = self
                .doc
                .edit_byte_range(line_start..(line_start + 2), "", false)
            {
                self.cursor_byte = self.clamp_doc_char_boundary(cur.saturating_sub(2).max(line_start));
                self.selection_bytes = self.cursor_byte..self.cursor_byte;
                self.notify_doc_mutated(prev_blocks, window, cx);
            }
        }
    }

    fn handle_move_left(&mut self, _: &EditorMoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection_bytes.is_empty() {
            self.cursor_byte = self.clamp_doc_char_boundary(self.selection_bytes.start);
        } else {
            self.cursor_byte = self.prev_char_byte(self.cursor_byte);
        }
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        self.update_slash_state();
        self.list_state.scroll_to_reveal_item(self.active_block_index());
        cx.notify();
    }

    fn handle_move_right(&mut self, _: &EditorMoveRight, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection_bytes.is_empty() {
            self.cursor_byte = self.clamp_doc_char_boundary(self.selection_bytes.end);
        } else {
            self.cursor_byte = self.next_char_byte(self.cursor_byte);
        }
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        self.update_slash_state();
        self.list_state.scroll_to_reveal_item(self.active_block_index());
        cx.notify();
    }

    fn handle_select_left(&mut self, _: &EditorSelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        let next = self.prev_char_byte(self.cursor_byte);
        let anchor = if self.cursor_byte == self.selection_bytes.start {
            self.selection_bytes.end
        } else {
            self.selection_bytes.start
        };
        self.cursor_byte = next;
        self.selection_bytes = next.min(anchor)..next.max(anchor);
        cx.notify();
    }

    fn handle_select_right(&mut self, _: &EditorSelectRight, _: &mut Window, cx: &mut Context<Self>) {
        let next = self.next_char_byte(self.cursor_byte);
        let anchor = if self.cursor_byte == self.selection_bytes.end {
            self.selection_bytes.start
        } else {
            self.selection_bytes.end
        };
        self.cursor_byte = next;
        self.selection_bytes = next.min(anchor)..next.max(anchor);
        cx.notify();
    }

    fn handle_move_up(&mut self, _: &EditorMoveUp, _: &mut Window, cx: &mut Context<Self>) {
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        if line_idx == 0 {
            self.cursor_byte = 0;
        } else {
            let line_start = self.doc.rope().line_to_byte(line_idx);
            let char_col = self.doc.rope().byte_to_char(cur) - self.doc.rope().byte_to_char(line_start);
            let prev_line_idx = line_idx - 1;
            let prev_start_byte = self.doc.rope().line_to_byte(prev_line_idx);
            let prev_line_str = self.doc.rope().line(prev_line_idx).to_string();
            let clean_prev = prev_line_str.trim_end_matches(&['\r', '\n'][..]);
            let target_byte_in_prev = byte_offset_for_char_col(clean_prev, char_col);
            self.cursor_byte = prev_start_byte + target_byte_in_prev;
        }
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        self.slash_query = None;
        self.list_state.scroll_to_reveal_item(self.active_block_index());
        cx.notify();
    }

    fn handle_move_down(&mut self, _: &EditorMoveDown, _: &mut Window, cx: &mut Context<Self>) {
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        let total_lines = self.doc.rope().len_lines();
        let max_cur = self.max_editable_cursor_byte();
        if line_idx + 1 >= total_lines {
            self.cursor_byte = max_cur;
        } else {
            let line_start = self.doc.rope().line_to_byte(line_idx);
            let char_col =
                self.doc.rope().byte_to_char(cur) - self.doc.rope().byte_to_char(line_start);
            let next_line_idx = line_idx + 1;
            let next_start_byte = self.doc.rope().line_to_byte(next_line_idx);
            let next_line_str = self.doc.rope().line(next_line_idx).to_string();
            let clean_next = next_line_str.trim_end_matches(&['\r', '\n'][..]);
            let target_byte_in_next = byte_offset_for_char_col(clean_next, char_col);
            self.cursor_byte = (next_start_byte + target_byte_in_next).min(max_cur);
        }
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        self.slash_query = None;
        self.list_state.scroll_to_reveal_item(self.active_block_index());
        cx.notify();
    }

    fn handle_move_line_start(
        &mut self,
        _: &EditorMoveLineStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        self.cursor_byte = self.doc.rope().line_to_byte(line_idx);
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        cx.notify();
    }

    fn handle_move_line_end(&mut self, _: &EditorMoveLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        let line_start = self.doc.rope().line_to_byte(line_idx);
        let line_str = self.doc.rope().line(line_idx).to_string();
        let clean = line_str.trim_end_matches(&['\r', '\n'][..]);
        self.cursor_byte = line_start + clean.len();
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        cx.notify();
    }

    fn handle_move_doc_start(
        &mut self,
        _: &EditorMoveDocStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cursor_byte = 0;
        self.selection_bytes = 0..0;
        self.list_state.scroll_to_reveal_item(0);
        cx.notify();
    }

    fn handle_move_doc_end(&mut self, _: &EditorMoveDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        let end = self.max_editable_cursor_byte();
        self.cursor_byte = end;
        self.selection_bytes = end..end;
        let last = self.doc.blocks().len().saturating_sub(1);
        self.list_state.scroll_to_reveal_item(last);
        cx.notify();
    }

    fn handle_select_all(&mut self, _: &EditorSelectAll, _: &mut Window, cx: &mut Context<Self>) {
        let end = self.doc.len_bytes();
        self.cursor_byte = end;
        self.selection_bytes = 0..end;
        cx.notify();
    }

    fn handle_copy(&mut self, _: &EditorCopy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection_bytes.is_empty() {
            let s = self.clamp_doc_char_boundary(self.selection_bytes.start);
            let e = self.clamp_doc_char_boundary(self.selection_bytes.end);
            let cs = self.doc.rope().byte_to_char(s);
            let ce = self.doc.rope().byte_to_char(e);
            let selected = self.doc.rope().slice(cs..ce).to_string();
            cx.write_to_clipboard(ClipboardItem::new_string(selected));
        }
    }

    fn handle_cut(&mut self, _: &EditorCut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selection_bytes.is_empty() {
            let s = self.clamp_doc_char_boundary(self.selection_bytes.start);
            let e = self.clamp_doc_char_boundary(self.selection_bytes.end);
            let cs = self.doc.rope().byte_to_char(s);
            let ce = self.doc.rope().byte_to_char(e);
            let selected = self.doc.rope().slice(cs..ce).to_string();
            cx.write_to_clipboard(ClipboardItem::new_string(selected));

            let prev_blocks = self.doc.blocks().len();
            if let Ok(next_pos) = self.doc.edit_byte_range(s..e, "", false) {
                self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
                self.selection_bytes = self.cursor_byte..self.cursor_byte;
                self.notify_doc_mutated(prev_blocks, window, cx);
            }
        }
    }

    fn handle_paste(&mut self, _: &EditorPaste, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        let Some(pasted) = item.text() else {
            return;
        };
        if pasted.is_empty() {
            return;
        }
        let target = if !self.selection_bytes.is_empty() {
            self.clamp_doc_char_boundary(self.selection_bytes.start)
                ..self.clamp_doc_char_boundary(self.selection_bytes.end)
        } else {
            let cur = self.clamp_doc_char_boundary(self.cursor_byte);
            cur..cur
        };
        let prev_blocks = self.doc.blocks().len();
        if let Ok(next_pos) = self.doc.edit_byte_range(target, &pasted, false) {
            self.cursor_byte = self.clamp_doc_char_boundary(next_pos);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.update_slash_state();
            self.list_state.scroll_to_reveal_item(self.active_block_index());
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn handle_escape(&mut self, _: &EditorEscape, _: &mut Window, cx: &mut Context<Self>) {
        self.slash_query = None;
        self.editing_structured_block = None;
        self.selection_bytes = self.cursor_byte..self.cursor_byte;
        cx.notify();
    }

    fn sync_list_count(&mut self, prev_count: usize) {
        let next = self.doc.blocks().len().max(1);
        if next != prev_count {
            self.refresh_list_state();
        }
        if self.typewriter_mode {
            let active = self.active_block_index();
            self.list_state.scroll_to_reveal_item(active);
        }
    }

    fn update_slash_state(&mut self) {
        if self.ime_marked_utf8.is_some() {
            return;
        }
        let cur = self.clamp_doc_char_boundary(self.cursor_byte);
        let line_idx = self.doc.rope().byte_to_line(cur);
        let line_start = self.doc.rope().line_to_byte(line_idx);
        let line_str = self.doc.rope().line(line_idx).to_string();
        let col_bytes = clamp_str_char_boundary(&line_str, cur.saturating_sub(line_start));
        let prefix = line_str[..col_bytes].trim_start();

        if prefix.starts_with('/') && !prefix.contains(' ') && prefix.len() <= 24 {
            self.slash_query = Some(prefix.to_string());
        } else {
            self.slash_query = None;
        }
    }

    /// Renders the interactive `+1` bottom canvas tail area below the last block so clicking
    /// anywhere below the document immediately focuses/appends a clean paragraph at EOF.
    fn render_bottom_tail_zone(&self, theme: VellumTheme, entity: Entity<Self>) -> AnyElement {
        div()
            .id("editor-eof-tail-zone")
            .w_full()
            .min_h(px(260.0))
            .pt_4()
            .pb_16()
            .px_3()
            .cursor_text()
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                entity.update(cx, |this, cx| {
                    this.append_or_focus_document_end(window, cx);
                });
            })
            .child(
                div()
                    .py_2()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .hover(|s| s.text_color(theme.accent_primary))
                    .child("点击此处空白区域或按 Enter 在文档末尾继续写作 · 输入 / 唤起命令面板"),
            )
            .into_any_element()
    }

    /// Renders a single virtualized block at index `ix` with true WYSIWYG GPUI styling.
    pub fn render_block_row(
        &mut self,
        ix: usize,
        active_ix: usize,
        is_window_focused: bool,
        force_pure_preview: bool,
        theme: VellumTheme,
        entity: Entity<Self>,
    ) -> AnyElement {
        if !force_pure_preview && ix >= self.doc.blocks().len() {
            return self.render_bottom_tail_zone(theme, entity);
        }

        let Some(desc) = self.doc.blocks().get(ix).cloned() else {
            return div().into_any_element();
        };
        let raw_text = self.doc.slice_block_str(ix).unwrap_or_default();
        let is_active = !force_pure_preview && ix == active_ix;
        let is_editing_structured =
            !force_pure_preview && self.editing_structured_block == Some(ix);

        let show_syntax = if force_pure_preview {
            false
        } else {
            match self.marker_visibility {
                SyntaxMarkerVisibility::AlwaysVisible => true,
                SyntaxMarkerVisibility::AlwaysHidden => false,
                SyntaxMarkerVisibility::ActiveBlockOnly => is_active,
            } || self.mode == EditorMode::SourceCode
                || is_editing_structured
        };

        let show_caret = is_active && (is_window_focused || self.selection_bytes.is_empty());
        let dimmed_alpha = if self.focus_mode && !is_active && !force_pure_preview {
            0.34
        } else {
            1.0
        };

        // Source-mode or explicit structured-block source editor (`编辑源码`)
        if !force_pure_preview && (self.mode == EditorMode::SourceCode || is_editing_structured) {
            return self.render_source_block_editor(
                ix,
                &desc.byte_range,
                &raw_text,
                is_active,
                show_caret,
                is_editing_structured,
                theme,
                entity,
            );
        }

        let mut click_font_px = theme.body_font_px;
        let mut click_line_h_px = theme.body_font_px * 1.72;
        let click_pad_left = 12.0f32;
        let mut click_pad_top = 6.0f32;

        let row_content: AnyElement = match &desc.kind {
            BlockKind::Heading { level, .. } => {
                let size_px = match level {
                    1 => theme.body_font_px * 1.88,
                    2 => theme.body_font_px * 1.48,
                    3 => theme.body_font_px * 1.24,
                    _ => theme.body_font_px * 1.08,
                };
                click_font_px = size_px;
                click_line_h_px = size_px * 1.38;
                click_pad_top = 14.0;

                if show_syntax {
                    let clean_raw = strip_single_trailing_newline(&raw_text);
                    let (txt, hl) = self.build_active_styled_text(
                        desc.byte_range.start,
                        clean_raw,
                        show_caret,
                        true,
                        theme,
                        "输入标题文字…",
                    );
                    div()
                        .pt_3p5()
                        .pb_2()
                        .when(*level == 2, |d| {
                            d.border_b_1().border_color(theme.border_hairline)
                        })
                        .text_size(px(size_px))
                        .line_height(px(size_px * 1.38))
                        .font_weight(FontWeight::BOLD)
                        .text_color(theme.text_primary)
                        .child(StyledText::new(SharedString::from(txt)).with_highlights(hl))
                        .into_any_element()
                } else {
                    let heading_body = strip_single_trailing_newline(&raw_text)
                        .trim_start_matches('#')
                        .trim_start();
                    let (txt, hl, wikilinks) = format_inline_markdown(heading_body, false, theme);
                    let nav_row = self.wrap_with_wikilink_pills(wikilinks, theme, entity.clone());
                    div()
                        .pt_3p5()
                        .pb_2()
                        .when(*level == 2, |d| {
                            d.border_b_1().border_color(theme.border_hairline)
                        })
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(size_px))
                                .line_height(px(size_px * 1.38))
                                .font_weight(FontWeight::BOLD)
                                .text_color(theme.text_primary)
                                .child(StyledText::new(SharedString::from(txt)).with_highlights(hl)),
                        )
                        .children(nav_row)
                        .into_any_element()
                }
            }

            BlockKind::Callout { kind } if !is_active => {
                let kind_upper = kind.to_ascii_uppercase();
                let (badge_label, border_col, bg_col, title_col) = match kind_upper.as_str() {
                    "TIP" => (
                        "写作技巧 (TIP)",
                        if theme.is_dark { rgb(0x10b981) } else { rgb(0x059669) },
                        if theme.is_dark { rgba(0x10b9811c) } else { rgba(0xecfdf5cc) },
                        if theme.is_dark { rgb(0x6ee7b7) } else { rgb(0x047857) },
                    ),
                    "IMPORTANT" => (
                        "关键约束 (IMPORTANT)",
                        if theme.is_dark { rgb(0x8b5cf6) } else { rgb(0x7c3aed) },
                        if theme.is_dark { rgba(0x8b5cf61c) } else { rgba(0xf5f3ffcc) },
                        if theme.is_dark { rgb(0xc4b5fd) } else { rgb(0x6d28d9) },
                    ),
                    "WARNING" | "CAUTION" => (
                        "注意事项 (WARNING)",
                        if theme.is_dark { rgb(0xf59e0b) } else { rgb(0xd97706) },
                        if theme.is_dark { rgba(0xf59e0b1c) } else { rgba(0xfffbebcc) },
                        if theme.is_dark { rgb(0xfcd34d) } else { rgb(0xb45309) },
                    ),
                    _ => (
                        "说明标注 (NOTE)",
                        theme.accent_primary,
                        if theme.is_dark { rgba(0x3b82f61c) } else { rgba(0xeff6ffcc) },
                        theme.accent_primary,
                    ),
                };

                let body_lines: Vec<String> = raw_text
                    .lines()
                    .skip(1)
                    .map(|l| l.trim_start_matches('>').trim_start().to_string())
                    .collect();

                let mut body_col = div().flex().flex_col().gap_1();
                let mut collected_links = Vec::new();
                for ln in body_lines {
                    let (txt, hl, links) = format_inline_markdown(&ln, false, theme);
                    collected_links.extend(links);
                    body_col = body_col.child(
                        div()
                            .text_size(px(theme.body_font_px * 0.96))
                            .line_height(px(theme.body_font_px * 1.65))
                            .text_color(theme.text_secondary)
                            .child(StyledText::new(SharedString::from(txt)).with_highlights(hl)),
                    );
                }
                let nav_row = self.wrap_with_wikilink_pills(collected_links, theme, entity.clone());

                div()
                    .my_2p5()
                    .px_4()
                    .py_3()
                    .rounded_xl()
                    .border_1()
                    .border_l_4()
                    .border_color(border_col)
                    .bg(bg_col)
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::BOLD)
                            .text_color(title_col)
                            .child(badge_label),
                    )
                    .child(body_col)
                    .children(nav_row)
                    .into_any_element()
            }

            BlockKind::BlockQuote if !is_active => {
                let mut quote_col = div().flex().flex_col().gap_1();
                let mut collected_links = Vec::new();
                for ln in raw_text.lines() {
                    let clean = ln.trim_start_matches('>').trim_start();
                    let (txt, hl, links) = format_inline_markdown(clean, false, theme);
                    collected_links.extend(links);
                    quote_col = quote_col.child(
                        div()
                            .text_size(px(theme.body_font_px * 0.96))
                            .line_height(px(theme.body_font_px * 1.65))
                            .text_color(theme.text_secondary)
                            .child(StyledText::new(SharedString::from(txt)).with_highlights(hl)),
                    );
                }
                let nav_row = self.wrap_with_wikilink_pills(collected_links, theme, entity.clone());

                div()
                    .my_2()
                    .px_4()
                    .py_2p5()
                    .rounded_r_lg()
                    .border_l_4()
                    .border_color(theme.accent_primary)
                    .bg(theme.sidebar_bg)
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .child(quote_col)
                    .children(nav_row)
                    .into_any_element()
            }

            BlockKind::BulletList { .. } | BlockKind::OrderedList { .. } if !is_active => {
                let mut list_col = div().py_1().flex().flex_col().gap_1p5();
                let mut collected_links = Vec::new();

                for line in raw_text.lines() {
                    let (indent_lvl, marker_display, item_body) = split_list_item_line(line);
                    let (txt, hl, links) = format_inline_markdown(item_body, false, theme);
                    collected_links.extend(links);

                    list_col = list_col.child(
                        div()
                            .pl(px((indent_lvl as f32) * 18.0))
                            .flex()
                            .items_start()
                            .gap_2p5()
                            .child(
                                div()
                                    .w(px(20.0))
                                    .pt(px(2.0))
                                    .text_xs()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.accent_primary)
                                    .child(SharedString::from(marker_display)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(theme.body_font_px))
                                    .line_height(px(theme.body_font_px * 1.66))
                                    .text_color(theme.text_primary)
                                    .child(
                                        StyledText::new(SharedString::from(txt))
                                            .with_highlights(hl),
                                    ),
                            ),
                    );
                }
                if let Some(pills) = self.wrap_with_wikilink_pills(collected_links, theme, entity.clone()) {
                    list_col = list_col.child(pills);
                }
                list_col.into_any_element()
            }

            BlockKind::TaskList if !is_active => {
                let mut list_container = div().py_1().flex().flex_col().gap_1p5();
                let mut line_byte_offset = desc.byte_range.start;

                for (line_idx, line_with_nl) in raw_text.split_inclusive('\n').enumerate() {
                    let line = line_with_nl.trim_end_matches(&['\r', '\n'][..]);
                    let line_end_byte = line_byte_offset + line.len();
                    let leading_spaces = line.len() - line.trim_start().len();
                    let indent_lvl = (leading_spaces / 2).min(6);
                    let trimmed = line.trim_start();
                    let checked = trimmed.contains("[x]") || trimmed.contains("[X]");
                    let label = trimmed
                        .trim_start_matches(&['-', '*', '+'][..])
                        .trim_start()
                        .trim_start_matches("[ ]")
                        .trim_start_matches("[x]")
                        .trim_start_matches("[X]")
                        .trim_start()
                        .to_string();

                    let (txt, mut hl, _) = format_inline_markdown(&label, false, theme);
                    if checked && !txt.is_empty() {
                        hl.push((
                            0..txt.len(),
                            HighlightStyle {
                                color: Some(theme.text_muted.into()),
                                strikethrough: Some(StrikethroughStyle {
                                    thickness: px(1.2),
                                    color: Some(theme.text_muted.into()),
                                }),
                                ..Default::default()
                            },
                        ));
                    }

                    let ent_chk = entity.clone();
                    let ent_edit = entity.clone();
                    list_container = list_container.child(
                        div()
                            .id(("task-row", ix * 200 + line_idx))
                            .pl(px((indent_lvl as f32) * 18.0))
                            .flex()
                            .items_start()
                            .gap_2p5()
                            // Checkbox square: toggles `[ ]` <-> `[x]` without entering raw edit mode
                            .child(
                                div()
                                    .id(("task-chk", ix * 200 + line_idx))
                                    .mt(px(4.5))
                                    .w(px(16.0))
                                    .h(px(16.0))
                                    .rounded(px(4.0))
                                    .border_1()
                                    .cursor_pointer()
                                    .border_color(if checked {
                                        theme.accent_primary
                                    } else {
                                        theme.syntax_delimiter
                                    })
                                    .bg(if checked {
                                        theme.accent_primary
                                    } else {
                                        theme.surface_elevated
                                    })
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_xs()
                                    .text_color(rgb(0xffffff))
                                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                        cx.stop_propagation();
                                        ent_chk.update(cx, |this, cx| {
                                            this.toggle_task_checkbox(ix, line_idx, window, cx);
                                        });
                                    })
                                    .child(if checked { "✓" } else { "" }),
                            )
                            // Task label: clicking focuses editor right at the end of this task item!
                            .child(
                                div()
                                    .id(("task-txt", ix * 200 + line_idx))
                                    .flex_1()
                                    .cursor_text()
                                    .text_size(px(theme.body_font_px))
                                    .line_height(px(theme.body_font_px * 1.66))
                                    .text_color(if checked {
                                        theme.text_muted
                                    } else {
                                        theme.text_primary
                                    })
                                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                        cx.stop_propagation();
                                        ent_edit.update(cx, |this, cx| {
                                            this.cursor_byte = line_end_byte;
                                            this.selection_bytes = line_end_byte..line_end_byte;
                                            window.focus(&this.focus_handle);
                                            cx.notify();
                                        });
                                    })
                                    .child(
                                        StyledText::new(SharedString::from(txt))
                                            .with_highlights(hl),
                                    ),
                            ),
                    );
                    line_byte_offset += line_with_nl.len();
                }
                list_container.into_any_element()
            }

            BlockKind::CodeBlock { language, .. } => {
                let raw_lines: Vec<&str> = raw_text.lines().collect();
                let has_open_fence = raw_lines
                    .first()
                    .map(|l| l.trim_start().starts_with("```") || l.trim_start().starts_with("~~~"))
                    .unwrap_or(false);
                let has_close_fence = raw_lines.len() >= 2
                    && raw_lines
                        .last()
                        .map(|l| l.trim_start().starts_with("```") || l.trim_start().starts_with("~~~"))
                        .unwrap_or(false);

                let inner_slice = if has_open_fence {
                    let end_ix = if has_close_fence {
                        raw_lines.len() - 1
                    } else {
                        raw_lines.len()
                    };
                    &raw_lines[1..end_ix]
                } else {
                    &raw_lines[..]
                };
                let inner_code = inner_slice.join("\n");
                let line_nums = (1..=inner_slice.len().max(1))
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join("\n");

                let code_for_copy = inner_code.clone();
                let hl_spans = self
                    .highlighter
                    .highlight_code(language, &inner_code, theme.is_dark);
                let ent_edit_code = entity.clone();
                let block_end_for_edit = desc.byte_range.end.saturating_sub(if has_close_fence { 4 } else { 0 });

                div()
                    .my_3()
                    .rounded_xl()
                    .bg(theme.code_bg)
                    .border_1()
                    .border_color(theme.border_hairline)
                    .overflow_hidden()
                    .child(
                        div()
                            .px_4()
                            .py_1p5()
                            .flex()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(theme.border_hairline)
                            .bg(theme.sidebar_bg)
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(format!(
                                "{} · {} 行",
                                if language.is_empty() {
                                    "text"
                                } else {
                                    language.as_str()
                                },
                                inner_slice.len().max(1)
                            )))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_3()
                                    .child(
                                        div()
                                            .id(("edit-code", ix))
                                            .cursor_pointer()
                                            .px_2()
                                            .py_0p5()
                                            .rounded_sm()
                                            .hover(|s| s.text_color(theme.accent_primary))
                                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                                cx.stop_propagation();
                                                ent_edit_code.update(cx, |this, cx| {
                                                    this.editing_structured_block = Some(ix);
                                                    this.cursor_byte = this
                                                        .clamp_doc_char_boundary(block_end_for_edit);
                                                    this.selection_bytes =
                                                        this.cursor_byte..this.cursor_byte;
                                                    window.focus(&this.focus_handle);
                                                    cx.notify();
                                                });
                                            })
                                            .child("编辑代码"),
                                    )
                                    .child(
                                        div()
                                            .id(("copy-code", ix))
                                            .cursor_pointer()
                                            .px_2()
                                            .py_0p5()
                                            .rounded_sm()
                                            .hover(|s| s.text_color(theme.text_primary))
                                            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                                cx.stop_propagation();
                                                cx.write_to_clipboard(ClipboardItem::new_string(
                                                    code_for_copy.clone(),
                                                ));
                                            })
                                            .child("复制"),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .p_4()
                            .flex()
                            .gap_4()
                            .text_size(px(13.5))
                            .line_height(px(21.0))
                            .child(
                                div()
                                    .text_color(theme.syntax_delimiter)
                                    .child(SharedString::from(line_nums)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .text_color(theme.text_primary)
                                    .child(
                                        StyledText::new(SharedString::from(inner_code))
                                            .with_highlights(hl_spans),
                                    ),
                            ),
                    )
                    .into_any_element()
            }

            BlockKind::Table { .. } => {
                if let Some(table) = GfmTableModel::parse(&raw_text) {
                    let ent_add_row = entity.clone();
                    let ent_add_col = entity.clone();
                    let ent_edit_tbl = entity.clone();
                    let tbl_start = desc.byte_range.start;

                    let mut grid = div()
                        .my_3()
                        .rounded_xl()
                        .border_1()
                        .border_color(theme.border_hairline)
                        .bg(theme.surface_elevated)
                        .overflow_hidden()
                        .flex()
                        .flex_col();

                    let mut header_row = div()
                        .flex()
                        .bg(theme.sidebar_bg)
                        .border_b_1()
                        .border_color(theme.border_hairline);
                    for (col_ix, h) in table.headers.iter().enumerate() {
                        let align = table.alignments.get(col_ix).copied().unwrap_or(ColumnAlign::None);
                        let (cell_txt, cell_hl, _) = format_inline_markdown(h, false, theme);
                        header_row = header_row.child(
                            div()
                                .flex_1()
                                .px_3p5()
                                .py_2()
                                .flex()
                                .when(align == ColumnAlign::Center, |d| d.justify_center())
                                .when(align == ColumnAlign::Right, |d| d.justify_end())
                                .text_xs()
                                .font_weight(FontWeight::BOLD)
                                .text_color(theme.text_primary)
                                .child(
                                    StyledText::new(SharedString::from(cell_txt))
                                        .with_highlights(cell_hl),
                                ),
                        );
                    }
                    grid = grid.child(header_row);

                    for r in &table.rows {
                        let mut tr = div()
                            .flex()
                            .border_b_1()
                            .border_color(theme.border_hairline);
                        for (col_ix, cell) in r.iter().enumerate() {
                            let align =
                                table.alignments.get(col_ix).copied().unwrap_or(ColumnAlign::None);
                            let (cell_txt, cell_hl, _) = format_inline_markdown(cell, false, theme);
                            tr = tr.child(
                                div()
                                    .flex_1()
                                    .px_3p5()
                                    .py_2()
                                    .flex()
                                    .when(align == ColumnAlign::Center, |d| d.justify_center())
                                    .when(align == ColumnAlign::Right, |d| d.justify_end())
                                    .text_sm()
                                    .text_color(theme.text_secondary)
                                    .child(
                                        StyledText::new(SharedString::from(cell_txt))
                                            .with_highlights(cell_hl),
                                    ),
                            );
                        }
                        grid = grid.child(tr);
                    }

                    // Table quick action footer (`+ 新增行` · `+ 新增列` · `编辑源码`)
                    if !force_pure_preview {
                        grid = grid.child(
                            div()
                                .px_3p5()
                                .py_1p5()
                                .bg(theme.sidebar_bg)
                                .flex()
                                .items_center()
                                .justify_between()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap_3()
                                        .child(
                                            div()
                                                .id(("tbl-add-row", ix))
                                                .cursor_pointer()
                                                .hover(|s| s.text_color(theme.accent_primary))
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, window, cx| {
                                                        cx.stop_propagation();
                                                        ent_add_row.update(cx, |this, cx| {
                                                            this.mutate_gfm_table(
                                                                ix, false, window, cx,
                                                            );
                                                        });
                                                    },
                                                )
                                                .child("+ 新增行"),
                                        )
                                        .child(
                                            div()
                                                .id(("tbl-add-col", ix))
                                                .cursor_pointer()
                                                .hover(|s| s.text_color(theme.accent_primary))
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, window, cx| {
                                                        cx.stop_propagation();
                                                        ent_add_col.update(cx, |this, cx| {
                                                            this.mutate_gfm_table(
                                                                ix, true, window, cx,
                                                            );
                                                        });
                                                    },
                                                )
                                                .child("+ 新增列"),
                                        ),
                                )
                                .child(
                                    div()
                                        .id(("tbl-edit-src", ix))
                                        .cursor_pointer()
                                        .hover(|s| s.text_color(theme.accent_primary))
                                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                            cx.stop_propagation();
                                            ent_edit_tbl.update(cx, |this, cx| {
                                                this.editing_structured_block = Some(ix);
                                                this.cursor_byte = tbl_start;
                                                this.selection_bytes = tbl_start..tbl_start;
                                                window.focus(&this.focus_handle);
                                                cx.notify();
                                            });
                                        })
                                        .child("编辑表格源码"),
                                ),
                        );
                    }
                    grid.into_any_element()
                } else {
                    div().child(SharedString::from(raw_text)).into_any_element()
                }
            }

            BlockKind::MermaidBlock => {
                let ent_edit = entity.clone();
                let blk_start = desc.byte_range.start;
                let steps = extract_mermaid_nodes(&raw_text);

                div()
                    .my_3()
                    .p_4()
                    .rounded_xl()
                    .border_1()
                    .border_color(theme.border_hairline)
                    .bg(theme.surface_elevated)
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child("架构流程图 (GPUI Native Mermaid 图元)")
                            .when(!force_pure_preview, |hdr| {
                                hdr.child(
                                    div()
                                        .id(("edit-mermaid", ix))
                                        .cursor_pointer()
                                        .hover(|s| s.text_color(theme.accent_primary))
                                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                            cx.stop_propagation();
                                            ent_edit.update(cx, |this, cx| {
                                                this.editing_structured_block = Some(ix);
                                                this.cursor_byte = blk_start;
                                                this.selection_bytes = blk_start..blk_start;
                                                window.focus(&this.focus_handle);
                                                cx.notify();
                                            });
                                        })
                                        .child("编辑图表源码"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .py_2()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_2()
                            .children(steps.into_iter().enumerate().map(|(s_ix, label)| {
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .when(s_ix > 0, |d| {
                                        d.child(
                                            div()
                                                .text_xs()
                                                .text_color(theme.syntax_delimiter)
                                                .child("──▶"),
                                        )
                                    })
                                    .child(
                                        div()
                                            .px_3()
                                            .py_1p5()
                                            .rounded_lg()
                                            .border_1()
                                            .border_color(theme.accent_primary)
                                            .bg(theme.sidebar_bg)
                                            .text_xs()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child(SharedString::from(label)),
                                    )
                            })),
                    )
                    .into_any_element()
            }

            BlockKind::MathBlock => {
                let ent_edit = entity.clone();
                let blk_start = desc.byte_range.start;
                let expr = raw_text
                    .trim()
                    .trim_start_matches("```math")
                    .trim_start_matches("```latex")
                    .trim_start_matches("$$")
                    .trim_end_matches("```")
                    .trim_end_matches("$$")
                    .trim()
                    .to_string();

                div()
                    .my_3()
                    .px_5()
                    .py_3p5()
                    .rounded_xl()
                    .border_1()
                    .border_color(theme.border_hairline)
                    .bg(theme.sidebar_bg)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .justify_center()
                            .text_size(px(theme.body_font_px * 1.08))
                            .text_color(theme.text_primary)
                            .child(SharedString::from(expr)),
                    )
                    .when(!force_pure_preview, |row| {
                        row.child(
                            div()
                                .id(("edit-math", ix))
                                .cursor_pointer()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .hover(|s| s.text_color(theme.accent_primary))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    cx.stop_propagation();
                                    ent_edit.update(cx, |this, cx| {
                                        this.editing_structured_block = Some(ix);
                                        this.cursor_byte = blk_start;
                                        this.selection_bytes = blk_start..blk_start;
                                        window.focus(&this.focus_handle);
                                        cx.notify();
                                    });
                                })
                                .child("编辑公式"),
                        )
                    })
                    .into_any_element()
            }

            BlockKind::FrontMatter => {
                let ent_edit = entity.clone();
                let blk_start = desc.byte_range.start;
                let kv_pairs: Vec<(String, String)> = raw_text
                    .lines()
                    .filter(|l| {
                        let t = l.trim();
                        t != "---" && t != "..." && t.contains(':')
                    })
                    .filter_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        Some((k.trim().to_string(), v.trim().to_string()))
                    })
                    .collect();

                div()
                    .my_2()
                    .px_4()
                    .py_2p5()
                    .rounded_xl()
                    .border_1()
                    .border_color(theme.border_hairline)
                    .bg(theme.sidebar_bg)
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_3()
                            .text_xs()
                            .children(kv_pairs.into_iter().map(|(k, v)| {
                                div()
                                    .px_2()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(theme.surface_elevated)
                                    .border_1()
                                    .border_color(theme.border_hairline)
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(format!("{}: {}", k, v)))
                            })),
                    )
                    .when(!force_pure_preview, |row| {
                        row.child(
                            div()
                                .id(("edit-fm", ix))
                                .cursor_pointer()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .hover(|s| s.text_color(theme.accent_primary))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    cx.stop_propagation();
                                    ent_edit.update(cx, |this, cx| {
                                        this.editing_structured_block = Some(ix);
                                        this.cursor_byte = blk_start;
                                        this.selection_bytes = blk_start..blk_start;
                                        window.focus(&this.focus_handle);
                                        cx.notify();
                                    });
                                })
                                .child("编辑属性"),
                        )
                    })
                    .into_any_element()
            }

            BlockKind::ThematicBreak if !is_active => div()
                .py_4()
                .child(div().h(px(1.5)).w_full().bg(theme.border_hairline))
                .into_any_element(),

            _ => {
                // Standalone `![[Target#Heading]]` transclusion card when unfocused
                let trimmed_para = raw_text.trim();
                if !show_syntax
                    && trimmed_para.starts_with("![[")
                    && trimmed_para.ends_with("]]")
                    && !trimmed_para.contains('\n')
                {
                    let inner = &trimmed_para[3..trimmed_para.len() - 2];
                    let (target, section, display_label) = parse_wikilink_inner(inner);
                    let ent_nav = entity.clone();
                    let ent_edit = entity.clone();
                    let blk_start = desc.byte_range.start;

                    div()
                        .my_2p5()
                        .px_4()
                        .py_3()
                        .rounded_xl()
                        .border_1()
                        .border_color(theme.border_hairline)
                        .bg(theme.sidebar_bg)
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_0p5()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.accent_primary)
                                        .child(SharedString::from(format!(
                                            "嵌入引用 · 《{}》",
                                            display_label
                                        ))),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.text_muted)
                                        .child("点击右侧「跳转源文档」打开对应知识节点，或点击「编辑语法」修改引用"),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_3()
                                .text_xs()
                                .child(
                                    div()
                                        .id(("edit-embed", ix))
                                        .cursor_pointer()
                                        .text_color(theme.text_muted)
                                        .hover(|s| s.text_color(theme.text_primary))
                                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                            cx.stop_propagation();
                                            ent_edit.update(cx, |this, cx| {
                                                this.cursor_byte = blk_start;
                                                this.selection_bytes = blk_start..blk_start;
                                                window.focus(&this.focus_handle);
                                                cx.notify();
                                            });
                                        })
                                        .child("编辑语法"),
                                )
                                .child(
                                    div()
                                        .id(("jump-embed", ix))
                                        .cursor_pointer()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.accent_primary)
                                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                            cx.stop_propagation();
                                            let tgt = target.clone();
                                            let sec = section.clone();
                                            let cb = ent_nav.read(cx).on_navigate_wikilink.clone();
                                            if let Some(nav) = cb {
                                                nav(tgt, sec, window, cx);
                                            }
                                        })
                                        .child("跳转源文档 ↗"),
                                ),
                        )
                        .into_any_element()
                } else if show_syntax {
                    let clean_raw = strip_single_trailing_newline(&raw_text);
                    let placeholder = if ix == 0 && self.doc.len_bytes() == 0 {
                        "输入文字开始写作，或键入 / 唤起命令面板…"
                    } else {
                        "输入文字，或键入 / 唤起命令面板…"
                    };
                    let (txt, hl) = self.build_active_styled_text(
                        desc.byte_range.start,
                        clean_raw,
                        show_caret,
                        false,
                        theme,
                        placeholder,
                    );
                    div()
                        .py_1p5()
                        .text_size(px(theme.body_font_px))
                        .line_height(px(theme.body_font_px * 1.72))
                        .text_color(theme.text_primary)
                        .child(StyledText::new(SharedString::from(txt)).with_highlights(hl))
                        .into_any_element()
                } else {
                    let clean_raw = strip_single_trailing_newline(&raw_text);
                    let (rendered_text, highlights, wikilinks) =
                        format_inline_markdown(clean_raw, false, theme);
                    let nav_row = self.wrap_with_wikilink_pills(wikilinks, theme, entity.clone());

                    div()
                        .py_1p5()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(theme.body_font_px))
                                .line_height(px(theme.body_font_px * 1.72))
                                .text_color(theme.text_primary)
                                .child(
                                    StyledText::new(SharedString::from(rendered_text))
                                        .with_highlights(highlights),
                                ),
                        )
                        .children(nav_row)
                        .into_any_element()
                }
            }
        };

        if force_pure_preview {
            return div()
                .w_full()
                .px_3()
                .child(row_content)
                .into_any_element();
        }

        let bounds_store_paint = self.painted_block_bounds.clone();
        let bounds_store_click = self.painted_block_bounds.clone();
        let block_start = desc.byte_range.start;
        let raw_for_click = raw_text;
        let click_entity = entity;

        let active_bg = if theme.is_dark {
            rgba(0x3b82f614)
        } else {
            rgba(0x2563eb0c)
        };

        div()
            .id(("md-block", ix))
            .w_full()
            .relative()
            .px_3()
            .rounded_lg()
            .cursor_text()
            .opacity(dimmed_alpha)
            .when(is_active, |d| {
                d.bg(active_bg)
                    .border_l_2()
                    .border_color(theme.accent_primary)
            })
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), _window, _cx| {
                        bounds_store_paint.borrow_mut().insert(ix, bounds);
                    },
                )
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .size_full(),
            )
            .on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, window, cx| {
                let maybe_bounds = bounds_store_click.borrow().get(&ix).copied();
                click_entity.update(cx, |this, cx| {
                    let target_byte = if let Some(b) = maybe_bounds {
                        estimate_byte_offset_from_click(
                            &raw_for_click,
                            block_start,
                            b,
                            event.position,
                            click_font_px,
                            click_line_h_px,
                            click_pad_left,
                            click_pad_top,
                        )
                    } else {
                        let clean = strip_single_trailing_newline(&raw_for_click);
                        block_start + clean.len()
                    };
                    let safe_pos = this.clamp_doc_char_boundary(target_byte);
                    this.cursor_byte = safe_pos;
                    this.selection_bytes = safe_pos..safe_pos;
                    this.update_slash_state();
                    window.focus(&this.focus_handle);
                    cx.notify();
                });
            })
            .child(row_content)
            .into_any_element()
    }

    fn render_source_block_editor(
        &self,
        ix: usize,
        byte_range: &Range<usize>,
        raw_text: &str,
        is_active: bool,
        show_caret: bool,
        is_structured_override: bool,
        theme: VellumTheme,
        entity: Entity<Self>,
    ) -> AnyElement {
        let clean_raw = strip_single_trailing_newline(raw_text);
        let (txt, hl) = self.build_active_styled_text(
            byte_range.start,
            clean_raw,
            is_active && show_caret,
            false,
            theme,
            "输入 Markdown 源码…",
        );

        let bounds_store_paint = self.painted_block_bounds.clone();
        let bounds_store_click = self.painted_block_bounds.clone();
        let block_start = byte_range.start;
        let raw_for_click = raw_text.to_string();
        let ent_done = entity.clone();

        div()
            .id(("src-block", ix))
            .w_full()
            .my_1()
            .p_3()
            .relative()
            .rounded_lg()
            .border_1()
            .border_color(if is_active {
                theme.accent_primary
            } else {
                theme.border_hairline
            })
            .bg(theme.code_bg)
            .cursor_text()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), _window, _cx| {
                        bounds_store_paint.borrow_mut().insert(ix, bounds);
                    },
                )
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .size_full(),
            )
            .on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, window, cx| {
                let maybe_bounds = bounds_store_click.borrow().get(&ix).copied();
                entity.update(cx, |this, cx| {
                    let target_byte = if let Some(b) = maybe_bounds {
                        estimate_byte_offset_from_click(
                            &raw_for_click,
                            block_start,
                            b,
                            event.position,
                            14.0,
                            22.0,
                            12.0,
                            12.0,
                        )
                    } else {
                        block_start + strip_single_trailing_newline(&raw_for_click).len()
                    };
                    let safe = this.clamp_doc_char_boundary(target_byte);
                    this.cursor_byte = safe;
                    this.selection_bytes = safe..safe;
                    window.focus(&this.focus_handle);
                    cx.notify();
                });
            })
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_size(px(14.0))
                    .line_height(px(22.0))
                    .text_color(theme.text_primary)
                    .child(StyledText::new(SharedString::from(txt)).with_highlights(hl)),
            )
            .when(is_structured_override, |card| {
                card.child(
                    div()
                        .flex()
                        .justify_end()
                        .child(
                            div()
                                .id(("done-src-edit", ix))
                                .cursor_pointer()
                                .px_2p5()
                                .py_1()
                                .rounded_md()
                                .bg(theme.accent_primary)
                                .text_xs()
                                .text_color(rgb(0xffffff))
                                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                    cx.stop_propagation();
                                    ent_done.update(cx, |this, cx| {
                                        this.editing_structured_block = None;
                                        cx.notify();
                                    });
                                })
                                .child("完成源码编辑 (Esc)"),
                        ),
                )
            })
            .into_any_element()
    }

    fn wrap_with_wikilink_pills(
        &self,
        wikilinks: Vec<(String, Option<String>, String)>,
        theme: VellumTheme,
        entity: Entity<Self>,
    ) -> Option<AnyElement> {
        if wikilinks.is_empty() {
            return None;
        }
        Some(
            div()
                .pt_0p5()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_1p5()
                .children(wikilinks.into_iter().enumerate().map(
                    move |(l_ix, (target, section, label))| {
                        let ent = entity.clone();
                        div()
                            .id(("inline-wiki-pill", l_ix))
                            .cursor_pointer()
                            .px_2()
                            .py_0p5()
                            .rounded_md()
                            .border_1()
                            .border_color(theme.border_hairline)
                            .bg(theme.sidebar_bg)
                            .text_xs()
                            .text_color(theme.accent_primary)
                            .hover(|s| s.border_color(theme.accent_primary))
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                cx.stop_propagation();
                                let tgt = target.clone();
                                let sec = section.clone();
                                let cb = ent.read(cx).on_navigate_wikilink.clone();
                                if let Some(nav) = cb {
                                    nav(tgt, sec, window, cx);
                                }
                            })
                            .child(SharedString::from(format!("↗ {}", label)))
                    },
                ))
                .into_any_element(),
        )
    }

    /// Builds `StyledText` for an active editable block, preserving live inline highlights,
    /// muted syntax delimiters, selection highlight, and injecting a crisp accent caret `▏`.
    fn build_active_styled_text(
        &self,
        block_start_byte: usize,
        raw_no_trailing_nl: &str,
        show_caret: bool,
        is_heading: bool,
        theme: VellumTheme,
        empty_placeholder: &str,
    ) -> (String, Vec<(Range<usize>, HighlightStyle)>) {
        if raw_no_trailing_nl.is_empty() {
            if show_caret {
                let text = format!("{} {}", CARET_GLYPH, empty_placeholder);
                let c_len = CARET_GLYPH.len();
                return (
                    text.clone(),
                    vec![
                        (
                            0..c_len,
                            HighlightStyle {
                                color: Some(theme.accent_primary.into()),
                                font_weight: Some(FontWeight::BOLD),
                                ..Default::default()
                            },
                        ),
                        (
                            c_len..text.len(),
                            HighlightStyle {
                                color: Some(theme.text_muted.into()),
                                font_weight: Some(FontWeight::NORMAL),
                                ..Default::default()
                            },
                        ),
                    ],
                );
            }
            return (
                empty_placeholder.to_string(),
                vec![(
                    0..empty_placeholder.len(),
                    HighlightStyle {
                        color: Some(theme.text_muted.into()),
                        ..Default::default()
                    },
                )],
            );
        }

        let (base_text, mut spans, _) = format_inline_markdown(raw_no_trailing_nl, true, theme);

        if is_heading {
            let hash_len = base_text.len() - base_text.trim_start_matches('#').len();
            if hash_len > 0 && hash_len <= base_text.len() {
                spans.push((
                    0..hash_len,
                    HighlightStyle {
                        color: Some(theme.syntax_delimiter.into()),
                        font_weight: Some(FontWeight::NORMAL),
                        ..Default::default()
                    },
                ));
            }
        }

        // Highlight selection if intersecting this block
        if !self.selection_bytes.is_empty() {
            let sel_s = clamp_str_char_boundary(
                &base_text,
                self.selection_bytes.start.saturating_sub(block_start_byte),
            );
            let sel_e = clamp_str_char_boundary(
                &base_text,
                self.selection_bytes.end.saturating_sub(block_start_byte),
            );
            if sel_s < sel_e {
                spans.push((
                    sel_s..sel_e,
                    HighlightStyle {
                        background_color: Some(theme.selection_bg.into()),
                        ..Default::default()
                    },
                ));
            }
        }

        if !show_caret {
            spans.sort_by_key(|(r, _)| r.start);
            return (base_text, spans);
        }

        let rel_cursor = clamp_str_char_boundary(
            &base_text,
            self.cursor_byte.saturating_sub(block_start_byte),
        );
        let c_len = CARET_GLYPH.len();

        let mut with_caret = String::with_capacity(base_text.len() + c_len);
        with_caret.push_str(&base_text[..rel_cursor]);
        with_caret.push_str(CARET_GLYPH);
        with_caret.push_str(&base_text[rel_cursor..]);

        let mut shifted_spans = Vec::with_capacity(spans.len() + 2);
        for (range, style) in spans {
            if range.end <= rel_cursor {
                shifted_spans.push((range, style));
            } else if range.start >= rel_cursor {
                shifted_spans.push(((range.start + c_len)..(range.end + c_len), style));
            } else {
                // Split span cleanly around caret so caret retains its own vivid accent color
                if range.start < rel_cursor {
                    shifted_spans.push((range.start..rel_cursor, style));
                }
                if rel_cursor < range.end {
                    shifted_spans.push(((rel_cursor + c_len)..(range.end + c_len), style));
                }
            }
        }

        shifted_spans.push((
            rel_cursor..(rel_cursor + c_len),
            HighlightStyle {
                color: Some(theme.accent_primary.into()),
                background_color: Some(
                    if theme.is_dark {
                        rgba(0x3b82f638)
                    } else {
                        rgba(0x2563eb22)
                    }
                    .into(),
                ),
                font_weight: Some(FontWeight::BOLD),
                ..Default::default()
            },
        ));
        shifted_spans.sort_by_key(|(r, _)| r.start);

        (with_caret, shifted_spans)
    }
}

impl Focusable for WysiwygEditorSurface {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EntityInputHandler for WysiwygEditorSurface {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _adjusted_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let sb = self.doc.utf16_to_byte_offset(range_utf16.start);
        let eb = self.doc.utf16_to_byte_offset(range_utf16.end);
        let cs = self.doc.rope().byte_to_char(sb);
        let ce = self.doc.rope().byte_to_char(eb);
        Some(self.doc.rope().slice(cs..ce).to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let start_u16 = self.doc.byte_to_utf16_offset(self.selection_bytes.start);
        let end_u16 = self.doc.byte_to_utf16_offset(self.selection_bytes.end);
        Some(UTF16Selection {
            range: start_u16..end_u16,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        let utf8 = self.ime_marked_utf8.as_ref()?;
        Some(
            self.doc.byte_to_utf16_offset(utf8.start)
                ..self.doc.byte_to_utf16_offset(utf8.end),
        )
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.ime_marked_utf8 = None;
        self.update_slash_state();
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target_bytes = if let Some(r16) = range_utf16 {
            self.doc.utf16_to_byte_offset(r16.start)..self.doc.utf16_to_byte_offset(r16.end)
        } else if let Some(marked) = self.ime_marked_utf8.take() {
            marked
        } else if !self.selection_bytes.is_empty() {
            self.clamp_doc_char_boundary(self.selection_bytes.start)
                ..self.clamp_doc_char_boundary(self.selection_bytes.end)
        } else {
            let cur = self.clamp_doc_char_boundary(self.cursor_byte);
            cur..cur
        };

        let prev_blocks = self.doc.blocks().len();
        // Safe to trigger PRD 5.2 Input Rules here because IME committed final phrase!
        if let Ok(next_cursor) = self.doc.edit_byte_range(target_bytes, text, true) {
            self.cursor_byte = self.clamp_doc_char_boundary(next_cursor);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.ime_marked_utf8 = None;
            self.update_slash_state();
            self.list_state.scroll_to_reveal_item(self.active_block_index());
            self.notify_doc_mutated(prev_blocks, window, cx);
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target_bytes = if let Some(r16) = range_utf16 {
            self.doc.utf16_to_byte_offset(r16.start)..self.doc.utf16_to_byte_offset(r16.end)
        } else if let Some(marked) = self.ime_marked_utf8.take() {
            marked
        } else {
            let cur = self.clamp_doc_char_boundary(self.cursor_byte);
            cur..cur
        };

        let prev_blocks = self.doc.blocks().len();
        // CRITICAL (`PRD ED-03`): `allow_input_rules = false` during active Pinyin/CJK IME preedit!
        if let Ok(end_byte) = self.doc.edit_byte_range(target_bytes.clone(), new_text, false) {
            let safe_end = self.clamp_doc_char_boundary(end_byte);
            self.ime_marked_utf8 = Some(target_bytes.start..safe_end);
            self.cursor_byte = safe_end;
            self.selection_bytes = safe_end..safe_end;
            self.sync_list_count(prev_blocks);
            cx.notify();
        }
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let active_ix = self.active_block_index();
        if let Some(blk_bounds) = self.painted_block_bounds.borrow().get(&active_ix).copied() {
            return Some(Bounds {
                origin: Point {
                    x: blk_bounds.origin.x + px(24.0),
                    y: blk_bounds.origin.y + px(24.0),
                },
                size: gpui::size(px(2.0), px(22.0)),
            });
        }
        Some(Bounds {
            origin: Point {
                x: element_bounds.origin.x + px(48.0),
                y: element_bounds.origin.y + px(64.0),
            },
            size: gpui::size(px(2.0), px(22.0)),
        })
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.doc.byte_to_utf16_offset(self.cursor_byte))
    }
}

impl Render for WysiwygEditorSurface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let is_dark = self
            .theme_override_dark
            .unwrap_or_else(|| window.appearance() == gpui::WindowAppearance::Dark);
        let theme = if is_dark {
            VellumTheme::dark()
        } else {
            VellumTheme::light()
        };

        let is_focused = self.focus_handle.is_focused(window);
        let active_ix = self.active_block_index();
        let entity = cx.entity().clone();
        let slash_candidates = self
            .slash_query
            .as_deref()
            .map(filter_slash_commands)
            .unwrap_or_default();

        let focus_for_ime = self.focus_handle.clone();
        let entity_for_ime = entity.clone();

        let main_view: AnyElement = if self.mode == EditorMode::SplitPreview {
            let ent_left = entity.clone();
            let ent_right = entity.clone();
            let block_count = self.doc.blocks().len();

            div()
                .size_full()
                .flex()
                .gap_6()
                // Left Pane: Live Editable Source List
                .child(
                    div()
                        .flex_1()
                        .h_full()
                        .pr_3()
                        .border_r_1()
                        .border_color(theme.border_hairline)
                        .child(
                            list(self.list_state.clone(), move |ix, _win, cx| {
                                let ent = ent_left.clone();
                                ent.update(cx, |this, _cx| {
                                    if ix >= this.doc.blocks().len() {
                                        return this.render_bottom_tail_zone(theme, ent.clone());
                                    }
                                    let Some(desc) = this.doc.blocks().get(ix).cloned() else {
                                        return div().into_any_element();
                                    };
                                    let raw = this.doc.slice_block_str(ix).unwrap_or_default();
                                    this.render_source_block_editor(
                                        ix,
                                        &desc.byte_range,
                                        &raw,
                                        ix == active_ix,
                                        ix == active_ix && is_focused,
                                        false,
                                        theme,
                                        ent.clone(),
                                    )
                                })
                            })
                            .size_full(),
                        ),
                )
                // Right Pane: Pure WYSIWYG Preview
                .child(
                    div()
                        .id("split-wysiwyg-preview-pane")
                        .flex_1()
                        .h_full()
                        .overflow_y_scroll()
                        .pb_16()
                        .flex()
                        .flex_col()
                        .children((0..block_count).map(move |b_ix| {
                            let ent = ent_right.clone();
                            ent.update(cx, |this, _cx| {
                                this.render_block_row(
                                    b_ix,
                                    active_ix,
                                    false,
                                    true,
                                    theme,
                                    ent.clone(),
                                )
                            })
                        })),
                )
                .into_any_element()
        } else {
            list(self.list_state.clone(), move |ix, _win, cx| {
                let ent = entity.clone();
                ent.update(cx, |this, _cx| {
                    this.render_block_row(ix, active_ix, is_focused, false, theme, ent.clone())
                })
            })
            .size_full()
            .into_any_element()
        };

        div()
            .id("wysiwyg-editor-root")
            .key_context("WysiwygEditor")
            .size_full()
            .relative()
            .cursor_text()
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::handle_backspace))
            .on_action(cx.listener(Self::handle_delete_forward))
            .on_action(cx.listener(Self::handle_enter))
            .on_action(cx.listener(Self::handle_soft_newline))
            .on_action(cx.listener(Self::handle_indent))
            .on_action(cx.listener(Self::handle_outdent))
            .on_action(cx.listener(Self::handle_move_left))
            .on_action(cx.listener(Self::handle_move_right))
            .on_action(cx.listener(Self::handle_select_left))
            .on_action(cx.listener(Self::handle_select_right))
            .on_action(cx.listener(Self::handle_move_up))
            .on_action(cx.listener(Self::handle_move_down))
            .on_action(cx.listener(Self::handle_move_line_start))
            .on_action(cx.listener(Self::handle_move_line_end))
            .on_action(cx.listener(Self::handle_move_doc_start))
            .on_action(cx.listener(Self::handle_move_doc_end))
            .on_action(cx.listener(Self::handle_select_all))
            .on_action(cx.listener(Self::handle_copy))
            .on_action(cx.listener(Self::handle_cut))
            .on_action(cx.listener(Self::handle_paste))
            .on_action(cx.listener(Self::handle_escape))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, cx| {
                        window.handle_input(
                            &focus_for_ime,
                            ElementInputHandler::new(bounds, entity_for_ime),
                            cx,
                        );
                    },
                )
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .size_full(),
            )
            .child(main_view)
            .when(!slash_candidates.is_empty(), |container| {
                let ent_for_menu = cx.entity().clone();
                container.child(
                    div()
                        .absolute()
                        .top(px(48.0))
                        .left(px(32.0))
                        .w(px(300.0))
                        .p_1p5()
                        .rounded_xl()
                        .bg(theme.surface_elevated)
                        .border_1()
                        .border_color(theme.accent_primary)
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .child(
                            div()
                                .px_2p5()
                                .py_1()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child("斜杠块命令（按 Enter 插入首项）"),
                        )
                        .children(slash_candidates.into_iter().take(7).map(|spec| {
                            let cmd_clone = spec.clone();
                            let target = ent_for_menu.clone();
                            div()
                                .id(spec.id)
                                .px_2p5()
                                .py_1p5()
                                .rounded_md()
                                .cursor_pointer()
                                .flex()
                                .items_center()
                                .justify_between()
                                .hover(|s| s.bg(theme.sidebar_bg))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    cx.stop_propagation();
                                    target.update(cx, |this, cx| {
                                        this.apply_slash_command(&cmd_clone, window, cx);
                                    });
                                })
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(theme.text_primary)
                                        .child(spec.label),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.text_muted)
                                        .child(spec.shortcut_hint),
                                )
                        })),
                )
            })
    }
}

// ============================================================================
// Pure UTF-8 WYSIWYG Inline Markdown Formatter & Hit-Testing Helpers
// ============================================================================

enum ListEnterAction {
    ExitEmptyItem,
    ContinueWithPrefix(String),
}

fn analyze_list_enter(line_before_cursor: &str) -> Option<ListEnterAction> {
    let leading_ws_len = line_before_cursor.len() - line_before_cursor.trim_start().len();
    let indent = &line_before_cursor[..leading_ws_len];
    let rest = &line_before_cursor[leading_ws_len..];

    // 1. Task list item: `- [ ] `, `- [x] `, `* [ ] `
    for bullet in ['-', '*', '+'] {
        if let Some(after_b) = rest.strip_prefix(bullet) {
            if let Some(after_sp) = after_b.strip_prefix(' ') {
                for chk in ["[ ]", "[x]", "[X]"] {
                    if let Some(body) = after_sp.strip_prefix(chk) {
                        if body.is_empty() || body.starts_with(' ') {
                            if body.trim().is_empty() {
                                return Some(ListEnterAction::ExitEmptyItem);
                            }
                            return Some(ListEnterAction::ContinueWithPrefix(format!(
                                "{}{} [ ] ",
                                indent, bullet
                            )));
                        }
                    }
                }
                // 2. Unordered bullet list item: `- `, `* `, `+ `
                if after_sp.trim().is_empty() {
                    return Some(ListEnterAction::ExitEmptyItem);
                }
                return Some(ListEnterAction::ContinueWithPrefix(format!(
                    "{}{} ",
                    indent, bullet
                )));
            }
        }
    }

    // 3. Ordered list item: `1. `, `2. `
    let digit_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digit_len > 0 {
        if let Some(after_dot) = rest[digit_len..].strip_prefix(". ") {
            if after_dot.trim().is_empty() {
                return Some(ListEnterAction::ExitEmptyItem);
            }
            let num: u64 = rest[..digit_len].parse().unwrap_or(1);
            return Some(ListEnterAction::ContinueWithPrefix(format!(
                "{}{}. ",
                indent,
                num + 1
            )));
        }
    }

    None
}

fn split_list_item_line(line: &str) -> (usize, String, &str) {
    let leading_ws = line.len() - line.trim_start().len();
    let indent_lvl = (leading_ws / 2).min(6);
    let trimmed = line.trim_start();

    for bullet in ['-', '*', '+'] {
        if let Some(after_b) = trimmed.strip_prefix(bullet) {
            if let Some(body) = after_b.strip_prefix(' ') {
                return (indent_lvl, "•".to_string(), body.trim_start());
            }
        }
    }

    let digit_len = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digit_len > 0 {
        if let Some(body) = trimmed[digit_len..].strip_prefix('.') {
            return (
                indent_lvl,
                format!("{}.", &trimmed[..digit_len]),
                body.trim_start(),
            );
        }
    }

    (indent_lvl, "•".to_string(), trimmed)
}

fn strip_single_trailing_newline(s: &str) -> &str {
    if let Some(stripped) = s.strip_suffix("\r\n") {
        stripped
    } else if let Some(stripped) = s.strip_suffix('\n') {
        stripped
    } else {
        s
    }
}

fn clamp_str_char_boundary(s: &str, byte_pos: usize) -> usize {
    let mut p = byte_pos.min(s.len());
    while p > 0 && !s.is_char_boundary(p) {
        p -= 1;
    }
    p
}

fn byte_offset_for_char_col(line_no_nl: &str, target_chars: usize) -> usize {
    for (c_ix, (b_ix, _)) in line_no_nl.char_indices().enumerate() {
        if c_ix == target_chars {
            return b_ix;
        }
    }
    line_no_nl.len()
}

fn parse_wikilink_inner(inner: &str) -> (String, Option<String>, String) {
    let (target_and_sec, alias) = if let Some((lhs, rhs)) = inner.split_once('|') {
        (lhs.trim(), Some(rhs.trim().to_string()))
    } else {
        (inner.trim(), None)
    };

    let (target, section) = if let Some((t, sec)) = target_and_sec.split_once('#') {
        (t.trim().to_string(), Some(sec.trim().to_string()))
    } else {
        (target_and_sec.to_string(), None)
    };

    let display = if let Some(a) = alias {
        a
    } else if let Some(ref sec) = section {
        format!("{} · §{}", target, sec)
    } else {
        target.clone()
    };

    (target, section, display)
}

/// Converts inline Markdown (`**bold**`, `*italic*`, `` `code` ``, `~~del~~`, `==mark==`,
/// `$math$`, `[[WikiLink]]`, `[label](url)`) into `(display_string, gpui_highlights, extracted_wikilinks)`.
///
/// - When `show_syntax == false`: strips outer Markdown delimiters while computing exact UTF-8
///   ranges for `StyledText` highlights so inactive blocks render true WYSIWYG typography.
/// - When `show_syntax == true`: preserves raw Markdown characters (`out.len() == raw.len()`),
///   coloring delimiters in `theme.syntax_delimiter` and inner text with rich styles.
fn format_inline_markdown(
    raw: &str,
    show_syntax: bool,
    theme: VellumTheme,
) -> (
    String,
    Vec<(Range<usize>, HighlightStyle)>,
    Vec<(String, Option<String>, String)>,
) {
    let mut out = String::with_capacity(raw.len());
    let mut spans: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let mut wikilinks: Vec<(String, Option<String>, String)> = Vec::new();

    let delim_style = HighlightStyle {
        color: Some(theme.syntax_delimiter.into()),
        font_weight: Some(FontWeight::NORMAL),
        ..Default::default()
    };
    let link_style = HighlightStyle {
        color: Some(theme.accent_primary.into()),
        font_weight: Some(FontWeight::MEDIUM),
        underline: Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(theme.accent_primary.into()),
            wavy: false,
        }),
        ..Default::default()
    };

    let mut i = 0usize;
    while i < raw.len() {
        let rest = &raw[i..];

        // 1. Inline Embed `![[...]]` or WikiLink `[[...]]`
        let wiki_prefix_len = if rest.starts_with("![[") {
            Some(3usize)
        } else if rest.starts_with("[[") {
            Some(2usize)
        } else {
            None
        };
        if let Some(p_len) = wiki_prefix_len {
            let after_open = &rest[p_len..];
            if let Some(close_rel) = after_open.find("]]") {
                let inner = &after_open[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let (target, section, display) = parse_wikilink_inner(inner);
                    wikilinks.push((target, section, display.clone()));

                    if show_syntax {
                        let s = out.len();
                        let open_str = &rest[..p_len];
                        out.push_str(open_str);
                        spans.push((s..(s + p_len), delim_style));

                        let mid_s = out.len();
                        out.push_str(inner);
                        spans.push((mid_s..out.len(), link_style));

                        let end_s = out.len();
                        out.push_str("]]");
                        spans.push((end_s..out.len(), delim_style));
                    } else {
                        let s = out.len();
                        out.push_str("《");
                        out.push_str(&display);
                        out.push_str("》");
                        spans.push((s..out.len(), link_style));
                    }
                    i += p_len + close_rel + 2;
                    continue;
                }
            }
        }

        // 2. Inline Code `` `...` ``
        if rest.starts_with('`') && !rest.starts_with("``") {
            let after = &rest[1..];
            if let Some(close_rel) = after.find('`') {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let code_style = HighlightStyle {
                        background_color: Some(theme.code_bg.into()),
                        color: Some(theme.accent_primary.into()),
                        ..Default::default()
                    };
                    if show_syntax {
                        let s = out.len();
                        out.push('`');
                        spans.push((s..(s + 1), delim_style));
                        let m = out.len();
                        out.push_str(inner);
                        spans.push((m..out.len(), code_style));
                        let e = out.len();
                        out.push('`');
                        spans.push((e..(e + 1), delim_style));
                    } else {
                        let s = out.len();
                        out.push_str(inner);
                        spans.push((s..out.len(), code_style));
                    }
                    i += 1 + close_rel + 1;
                    continue;
                }
            }
        }

        // 3. Bold + Italic `***...***`
        if rest.starts_with("***") {
            let after = &rest[3..];
            if let Some(close_rel) = after.find("***") {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let bi_style = HighlightStyle {
                        font_weight: Some(FontWeight::BOLD),
                        font_style: Some(FontStyle::Italic),
                        ..Default::default()
                    };
                    push_delimited_span(
                        &mut out,
                        &mut spans,
                        "***",
                        inner,
                        show_syntax,
                        delim_style,
                        bi_style,
                    );
                    i += 3 + close_rel + 3;
                    continue;
                }
            }
        }

        // 4. Bold `**...**`
        if rest.starts_with("**") {
            let after = &rest[2..];
            if let Some(close_rel) = after.find("**") {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let b_style = HighlightStyle {
                        font_weight: Some(FontWeight::BOLD),
                        color: Some(theme.text_primary.into()),
                        ..Default::default()
                    };
                    push_delimited_span(
                        &mut out,
                        &mut spans,
                        "**",
                        inner,
                        show_syntax,
                        delim_style,
                        b_style,
                    );
                    i += 2 + close_rel + 2;
                    continue;
                }
            }
        }

        // 5. Italic `*...*`
        if rest.starts_with('*') && !rest.starts_with("**") && !rest.starts_with("* ") {
            let after = &rest[1..];
            if let Some(close_rel) = after.find('*') {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let it_style = HighlightStyle {
                        font_style: Some(FontStyle::Italic),
                        ..Default::default()
                    };
                    push_delimited_span(
                        &mut out,
                        &mut spans,
                        "*",
                        inner,
                        show_syntax,
                        delim_style,
                        it_style,
                    );
                    i += 1 + close_rel + 1;
                    continue;
                }
            }
        }

        // 6. Strikethrough `~~...~~`
        if rest.starts_with("~~") {
            let after = &rest[2..];
            if let Some(close_rel) = after.find("~~") {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let st_style = HighlightStyle {
                        color: Some(theme.text_muted.into()),
                        strikethrough: Some(StrikethroughStyle {
                            thickness: px(1.5),
                            color: Some(theme.text_muted.into()),
                        }),
                        ..Default::default()
                    };
                    push_delimited_span(
                        &mut out,
                        &mut spans,
                        "~~",
                        inner,
                        show_syntax,
                        delim_style,
                        st_style,
                    );
                    i += 2 + close_rel + 2;
                    continue;
                }
            }
        }

        // 7. Highlight `==...==`
        if rest.starts_with("==") {
            let after = &rest[2..];
            if let Some(close_rel) = after.find("==") {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let mk_style = HighlightStyle {
                        background_color: Some(
                            if theme.is_dark {
                                rgba(0xf59e0b38)
                            } else {
                                rgba(0xfde68a99)
                            }
                            .into(),
                        ),
                        color: Some(theme.text_primary.into()),
                        ..Default::default()
                    };
                    push_delimited_span(
                        &mut out,
                        &mut spans,
                        "==",
                        inner,
                        show_syntax,
                        delim_style,
                        mk_style,
                    );
                    i += 2 + close_rel + 2;
                    continue;
                }
            }
        }

        // 8. Inline Math `$...$`
        if rest.starts_with('$') && !rest.starts_with("$$") {
            let after = &rest[1..];
            if let Some(close_rel) = after.find('$') {
                let inner = &after[..close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    let math_style = HighlightStyle {
                        color: Some(
                            if theme.is_dark {
                                rgb(0xc4b5fd)
                            } else {
                                rgb(0x6d28d9)
                            }
                            .into(),
                        ),
                        font_style: Some(FontStyle::Italic),
                        ..Default::default()
                    };
                    push_delimited_span(
                        &mut out,
                        &mut spans,
                        "$",
                        inner,
                        show_syntax,
                        delim_style,
                        math_style,
                    );
                    i += 1 + close_rel + 1;
                    continue;
                }
            }
        }

        // 9. Standard Markdown Link `[label](url)`
        if rest.starts_with('[') && !rest.starts_with("[[") {
            let after_bracket = &rest[1..];
            if let Some(mid_rel) = after_bracket.find("](") {
                let label = &after_bracket[..mid_rel];
                let after_paren = &after_bracket[mid_rel + 2..];
                if !label.contains('\n') {
                    if let Some(close_paren) = after_paren.find(')') {
                        let url = &after_paren[..close_paren];
                        if !url.contains('\n') {
                            if show_syntax {
                                let s1 = out.len();
                                out.push('[');
                                spans.push((s1..(s1 + 1), delim_style));

                                let s2 = out.len();
                                out.push_str(label);
                                spans.push((s2..out.len(), link_style));

                                let s3 = out.len();
                                out.push_str("](");
                                out.push_str(url);
                                out.push(')');
                                spans.push((s3..out.len(), delim_style));
                            } else {
                                let s = out.len();
                                out.push_str(label);
                                spans.push((s..out.len(), link_style));
                            }
                            i += 1 + mid_rel + 2 + close_paren + 1;
                            continue;
                        }
                    }
                }
            }
        }

        // Default: advance by 1 Unicode scalar
        if let Some(ch) = rest.chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }

    (out, spans, wikilinks)
}

fn push_delimited_span(
    out: &mut String,
    spans: &mut Vec<(Range<usize>, HighlightStyle)>,
    delim: &str,
    inner: &str,
    show_syntax: bool,
    delim_style: HighlightStyle,
    content_style: HighlightStyle,
) {
    if show_syntax {
        let s1 = out.len();
        out.push_str(delim);
        spans.push((s1..out.len(), delim_style));

        let s2 = out.len();
        out.push_str(inner);
        spans.push((s2..out.len(), content_style));

        let s3 = out.len();
        out.push_str(delim);
        spans.push((s3..out.len(), delim_style));
    } else {
        let s = out.len();
        out.push_str(inner);
        spans.push((s..out.len(), content_style));
    }
}

fn extract_mermaid_nodes(raw: &str) -> Vec<String> {
    let mut nodes = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty()
            || t.starts_with("```")
            || t.starts_with("graph ")
            || t.starts_with("flowchart ")
        {
            continue;
        }
        for part in t.split("-->") {
            let seg = part.trim();
            let label = if let Some(b_start) = seg.find('[') {
                if let Some(b_end) = seg[b_start + 1..].find(']') {
                    seg[b_start + 1..b_start + 1 + b_end].trim()
                } else {
                    seg
                }
            } else if let Some(p_start) = seg.find('(') {
                if let Some(p_end) = seg[p_start + 1..].find(')') {
                    seg[p_start + 1..p_start + 1 + p_end].trim()
                } else {
                    seg
                }
            } else {
                seg
            };
            if !label.is_empty() && nodes.last().map(String::as_str) != Some(label) {
                nodes.push(label.to_string());
            }
        }
    }
    if nodes.is_empty() {
        nodes.push("流程图节点".to_string());
    }
    nodes
}

/// Maps a mouse click `Point<Pixels>` inside a painted block `Bounds<Pixels>` to the closest
/// UTF-8 byte offset using pure strongly-typed `Pixels` comparisons.
fn estimate_byte_offset_from_click(
    block_raw: &str,
    block_start_byte: usize,
    bounds: Bounds<Pixels>,
    click_pos: Point<Pixels>,
    font_px: f32,
    line_height_px: f32,
    pad_left_px: f32,
    pad_top_px: f32,
) -> usize {
    let clean = strip_single_trailing_newline(block_raw);
    if clean.is_empty() {
        return block_start_byte;
    }

    let rel_x: Pixels = click_pos.x - bounds.origin.x - px(pad_left_px);
    let rel_y: Pixels = click_pos.y - bounds.origin.y - px(pad_top_px);
    let avail_w: Pixels = bounds.size.width - px(pad_left_px * 2.0);
    let can_wrap = avail_w > px(120.0);

    // Build visual wrapped line segments `(byte_start_in_clean, byte_end_in_clean)`
    let mut visual_rows: Vec<Range<usize>> = Vec::new();
    let mut seg_start = 0usize;
    let mut row_w = px(0.0);

    for (b_ix, ch) in clean.char_indices() {
        if ch == '\n' {
            visual_rows.push(seg_start..b_ix);
            seg_start = b_ix + 1;
            row_w = px(0.0);
            continue;
        }
        let ch_w = px(if ch.is_ascii() {
            font_px * 0.56
        } else {
            font_px * 1.02
        });
        if can_wrap && b_ix > seg_start && (row_w + ch_w) > avail_w {
            visual_rows.push(seg_start..b_ix);
            seg_start = b_ix;
            row_w = ch_w;
        } else {
            row_w = row_w + ch_w;
        }
    }
    visual_rows.push(seg_start..clean.len());

    // Pick visual row from `rel_y`
    let mut chosen_row_ix = visual_rows.len() - 1;
    if rel_y <= px(0.0) {
        chosen_row_ix = 0;
    } else {
        for r_ix in 0..visual_rows.len() {
            let row_bottom = px(((r_ix + 1) as f32) * line_height_px.max(18.0));
            if rel_y < row_bottom {
                chosen_row_ix = r_ix;
                break;
            }
        }
    }

    let row_range = &visual_rows[chosen_row_ix];
    let row_slice = &clean[row_range.clone()];
    if rel_x <= px(0.0) {
        return block_start_byte + row_range.start;
    }

    let mut acc_x = px(0.0);
    for (local_b, ch) in row_slice.char_indices() {
        if ch == '\r' {
            continue;
        }
        let adv = if ch.is_ascii() {
            font_px * 0.56
        } else {
            font_px * 1.02
        };
        if rel_x < (acc_x + px(adv * 0.5)) {
            return block_start_byte + row_range.start + local_b;
        }
        acc_x = acc_x + px(adv);
    }

    block_start_byte + row_range.end
}
