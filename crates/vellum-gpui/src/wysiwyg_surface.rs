use crate::code_highlighter::BoundedCodeHighlighter;
use crate::slash_palette::{SlashCommandSpec, filter_slash_commands};
use crate::theme::VellumTheme;
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, Entity, EntityInputHandler, FocusHandle,
    Focusable, FontStyle, FontWeight, HighlightStyle, InteractiveElement, IntoElement,
    ListAlignment, ListState, MouseButton, ParentElement, Pixels, Point, Render, SharedString,
    StrikethroughStyle, Styled, StyledText, UTF16Selection, UnderlineStyle, Window, div, list, px,
};
use std::ops::Range;
use vellum_core::{
    BlockKind, GfmTableModel, InlineStyleKind, RopeDocument,
};

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
/// Key performance & UX guarantees:
/// 1. **Virtualized Block Rendering (`gpui::list`)**: Only visible blocks in the window viewport
///    are converted into GPUI elements and shaped on the GPU.
/// 2. **Native CJK IME Composition Protection (`PRD ED-03`)**: Tracks `ime_marked_utf8` and
///    suppresses Input Rule auto-conversions until `unmark_text()` commits the phrase.
/// 3. **Zero-Jitter Syntax Marker Reveal (`PRD 5.3`)**: Uses `StyledText` inline highlights
///    on active blocks while stripping outer syntax delimiters on inactive blocks.
pub struct WysiwygEditorSurface {
    pub doc: RopeDocument,
    pub mode: EditorMode,
    pub marker_visibility: SyntaxMarkerVisibility,
    pub focus_mode: bool,
    pub typewriter_mode: bool,
    pub focus_handle: FocusHandle,
    pub list_state: ListState,
    pub cursor_byte: usize,
    pub selection_bytes: Range<usize>,
    pub ime_marked_utf8: Option<Range<usize>>,
    pub slash_query: Option<String>,
    pub highlighter: BoundedCodeHighlighter,
}

impl WysiwygEditorSurface {
    pub fn new(doc: RopeDocument, cx: &mut Context<Self>) -> Self {
        let count = doc.blocks().len().max(1);
        let list_state = ListState::new(count, ListAlignment::Top, px(360.0));
        Self {
            doc,
            mode: EditorMode::InstantWysiwyg,
            marker_visibility: SyntaxMarkerVisibility::ActiveBlockOnly,
            focus_mode: false,
            typewriter_mode: false,
            focus_handle: cx.focus_handle(),
            list_state,
            cursor_byte: 0,
            selection_bytes: 0..0,
            ime_marked_utf8: None,
            slash_query: None,
            highlighter: BoundedCodeHighlighter::new(),
        }
    }

    pub fn replace_document(&mut self, next_doc: RopeDocument, cx: &mut Context<Self>) {
        let block_count = next_doc.blocks().len().max(1);
        self.doc = next_doc;
        self.cursor_byte = 0;
        self.selection_bytes = 0..0;
        self.ime_marked_utf8 = None;
        self.slash_query = None;
        self.list_state.reset(block_count);
        cx.notify();
    }

    pub fn active_block_index(&self) -> usize {
        if self.doc.blocks().is_empty() {
            return 0;
        }
        self.doc
            .blocks()
            .partition_point(|b| b.byte_range.end < self.cursor_byte)
            .min(self.doc.blocks().len() - 1)
    }

    /// Wraps current selection in Markdown inline markers (`**` for Cmd+B, `*` for Cmd+I, `` ` `` for Cmd+E).
    pub fn toggle_inline_delimiter(&mut self, delimiter: &str, cx: &mut Context<Self>) {
        let range = if self.selection_bytes.is_empty() {
            self.cursor_byte..self.cursor_byte
        } else {
            self.selection_bytes.clone()
        };
        let cs = self.doc.rope().byte_to_char(range.start);
        let ce = self.doc.rope().byte_to_char(range.end);
        let selected = self.doc.rope().slice(cs..ce).to_string();
        let wrapped = format!("{}{}{}", delimiter, selected, delimiter);

        let prev_count = self.doc.blocks().len();
        if let Ok(after) = self.doc.edit_byte_range(range, &wrapped, false) {
            self.cursor_byte = after.saturating_sub(delimiter.len());
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.sync_list_count(prev_count);
            cx.notify();
        }
    }

    /// Toggles a GFM task item `- [ ]` <-> `- [x]` directly inside `RopeDocument` (`PRD Section 4.1`).
    pub fn toggle_task_checkbox(&mut self, block_ix: usize, line_idx_in_block: usize, cx: &mut Context<Self>) {
        let Some(desc) = self.doc.blocks().get(block_ix).cloned() else {
            return;
        };
        let Some(raw) = self.doc.slice_block_str(block_ix) else {
            return;
        };

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
                cx.notify();
                break;
            }
            offset_in_block += line.len();
        }
    }

    pub fn apply_slash_command(&mut self, cmd: &SlashCommandSpec, cx: &mut Context<Self>) {
        let query_len = self.slash_query.as_ref().map(|q| q.len()).unwrap_or(1);
        let replace_start = self.cursor_byte.saturating_sub(query_len);
        let prev_count = self.doc.blocks().len();
        if let Ok(end_byte) = self
            .doc
            .edit_byte_range(replace_start..self.cursor_byte, cmd.template, false)
        {
            self.cursor_byte = end_byte.saturating_sub(cmd.cursor_backtrack_bytes);
            self.selection_bytes = self.cursor_byte..self.cursor_byte;
            self.slash_query = None;
            self.sync_list_count(prev_count);
            cx.notify();
        }
    }

    fn sync_list_count(&mut self, prev_count: usize) {
        let next = self.doc.blocks().len().max(1);
        if next != prev_count {
            self.list_state.reset(next);
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
        let line_idx = self.doc.rope().byte_to_line(self.cursor_byte.min(self.doc.len_bytes()));
        let line_start = self.doc.rope().line_to_byte(line_idx);
        let line_str = self.doc.rope().line(line_idx).to_string();
        let col_bytes = (self.cursor_byte - line_start).min(line_str.len());
        let prefix = line_str[..col_bytes].trim_start();

        if prefix.starts_with('/') && !prefix.contains(' ') && prefix.len() <= 24 {
            self.slash_query = Some(prefix.to_string());
        } else {
            self.slash_query = None;
        }
    }

    /// Renders a single virtualized block at index `ix` with GPUI primitives.
    pub fn render_block_row(
        &mut self,
        ix: usize,
        active_ix: usize,
        theme: VellumTheme,
        entity: Entity<Self>,
    ) -> AnyElement {
        let Some(desc) = self.doc.blocks().get(ix).cloned() else {
            return div().into_any_element();
        };
        let raw_text = self.doc.slice_block_str(ix).unwrap_or_default();
        let is_active = ix == active_ix;
        let show_syntax = match self.marker_visibility {
            SyntaxMarkerVisibility::AlwaysVisible => true,
            SyntaxMarkerVisibility::AlwaysHidden => false,
            SyntaxMarkerVisibility::ActiveBlockOnly => is_active,
        } || self.mode == EditorMode::SourceCode;

        let dimmed_alpha = if self.focus_mode && !is_active { 0.34 } else { 1.0 };

        let row_content: AnyElement = match &desc.kind {
            BlockKind::Heading { level, .. } => {
                let size_px = match level {
                    1 => theme.body_font_px * 1.9,
                    2 => theme.body_font_px * 1.5,
                    3 => theme.body_font_px * 1.25,
                    _ => theme.body_font_px * 1.1,
                };
                let display = if show_syntax {
                    raw_text.trim_end().to_string()
                } else {
                    raw_text
                        .trim_end()
                        .trim_start_matches('#')
                        .trim_start()
                        .to_string()
                };
                let mut highlights = Vec::new();
                if show_syntax {
                    let hash_len = raw_text.len() - raw_text.trim_start_matches('#').len();
                    if hash_len > 0 && hash_len <= display.len() {
                        highlights.push((
                            0..hash_len,
                            HighlightStyle {
                                color: Some(theme.syntax_delimiter.into()),
                                font_weight: Some(FontWeight::NORMAL),
                                ..Default::default()
                            },
                        ));
                    }
                }
                div()
                    .pt_4()
                    .pb_2()
                    .text_size(px(size_px))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme.text_primary)
                    .child(StyledText::new(SharedString::from(display)).with_highlights(highlights))
                    .into_any_element()
            }

            BlockKind::CodeBlock { language, .. } => {
                let lines: Vec<&str> = raw_text.lines().collect();
                let inner_code = if !show_syntax && lines.len() >= 2 && raw_text.trim_start().starts_with("```") {
                    lines[1..lines.len().saturating_sub(1)].join("\n")
                } else {
                    raw_text.trim_end().to_string()
                };
                let code_for_copy = inner_code.clone();
                let hl_spans = self
                    .highlighter
                    .highlight_code(language, &inner_code, theme.is_dark);

                div()
                    .my_3()
                    .rounded_lg()
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
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(if language.is_empty() {
                                "plain text".to_string()
                            } else {
                                language.clone()
                            }))
                            .child(
                                div()
                                    .id(("copy-code", ix))
                                    .cursor_pointer()
                                    .px_2()
                                    .py_0p5()
                                    .rounded_sm()
                                    .hover(|s| s.text_color(theme.text_primary))
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            code_for_copy.clone(),
                                        ));
                                    })
                                    .child("复制代码"),
                            ),
                    )
                    .child(
                        div()
                            .p_4()
                            .font_family("JetBrains Mono")
                            .text_size(px(13.5))
                            .line_height(px(21.0))
                            .text_color(theme.text_primary)
                            .child(
                                StyledText::new(SharedString::from(inner_code))
                                    .with_highlights(hl_spans),
                            ),
                    )
                    .into_any_element()
            }

            BlockKind::TaskList => {
                let mut list_container = div().py_1().flex().flex_col().gap_1p5();
                for (line_idx, line) in raw_text.lines().enumerate() {
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

                    let ent = entity.clone();
                    list_container = list_container.child(
                        div()
                            .id(("task-row", ix * 100 + line_idx))
                            .flex()
                            .items_center()
                            .gap_2p5()
                            .cursor_pointer()
                            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                ent.update(cx, |this, cx| {
                                    this.toggle_task_checkbox(ix, line_idx, cx);
                                });
                            })
                            .child(
                                div()
                                    .w(px(16.0))
                                    .h(px(16.0))
                                    .rounded_sm()
                                    .border_1()
                                    .border_color(if checked {
                                        theme.accent_primary
                                    } else {
                                        theme.border_hairline
                                    })
                                    .bg(if checked {
                                        theme.accent_primary
                                    } else {
                                        theme.surface_elevated
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(theme.body_font_px))
                                    .text_color(if checked {
                                        theme.text_muted
                                    } else {
                                        theme.text_primary
                                    })
                                    .child(SharedString::from(label)),
                            ),
                    );
                }
                list_container.into_any_element()
            }

            BlockKind::Table { .. } if !show_syntax => {
                if let Some(table) = GfmTableModel::parse(&raw_text) {
                    let mut grid = div()
                        .my_3()
                        .rounded_lg()
                        .border_1()
                        .border_color(theme.border_hairline)
                        .overflow_hidden()
                        .flex()
                        .flex_col();

                    let mut header_row = div()
                        .flex()
                        .bg(theme.sidebar_bg)
                        .border_b_1()
                        .border_color(theme.border_hairline);
                    for h in &table.headers {
                        header_row = header_row.child(
                            div()
                                .flex_1()
                                .px_3()
                                .py_2()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child(SharedString::from(h.clone())),
                        );
                    }
                    grid = grid.child(header_row);

                    for r in &table.rows {
                        let mut tr = div()
                            .flex()
                            .border_b_1()
                            .border_color(theme.border_hairline);
                        for cell in r {
                            tr = tr.child(
                                div()
                                    .flex_1()
                                    .px_3()
                                    .py_2()
                                    .text_sm()
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(cell.clone())),
                            );
                        }
                        grid = grid.child(tr);
                    }
                    grid.into_any_element()
                } else {
                    div().child(SharedString::from(raw_text)).into_any_element()
                }
            }

            BlockKind::BlockQuote | BlockKind::Callout { .. } => {
                let clean = if show_syntax {
                    raw_text.trim_end().to_string()
                } else {
                    raw_text
                        .lines()
                        .map(|l| l.trim_start_matches('>').trim_start())
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                div()
                    .my_2p5()
                    .p_4()
                    .rounded_lg()
                    .bg(theme.sidebar_bg)
                    .border_1()
                    .border_color(theme.border_hairline)
                    .text_size(px(theme.body_font_px * 0.96))
                    .text_color(theme.text_secondary)
                    .child(SharedString::from(clean))
                    .into_any_element()
            }

            BlockKind::ThematicBreak => div()
                .py_4()
                .child(div().h(px(1.0)).w_full().bg(theme.border_hairline))
                .into_any_element(),

            _ => {
                let (rendered_text, highlights) =
                    self.build_inline_styled_text(ix, &raw_text, show_syntax, theme);
                div()
                    .py_1p5()
                    .text_size(px(theme.body_font_px))
                    .line_height(px(theme.body_font_px * 1.68))
                    .text_color(theme.text_primary)
                    .child(StyledText::new(SharedString::from(rendered_text)).with_highlights(highlights))
                    .into_any_element()
            }
        };

        let click_byte = desc.byte_range.start;
        let click_entity = entity;

        div()
            .id(("md-block", ix))
            .w_full()
            .opacity(dimmed_alpha)
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                click_entity.update(cx, |this, cx| {
                    this.cursor_byte = click_byte;
                    this.selection_bytes = click_byte..click_byte;
                    window.focus(&this.focus_handle);
                    cx.notify();
                });
            })
            .child(row_content)
            .into_any_element()
    }

    fn build_inline_styled_text(
        &self,
        block_ix: usize,
        raw: &str,
        show_syntax: bool,
        theme: VellumTheme,
    ) -> (String, Vec<(Range<usize>, HighlightStyle)>) {
        let trimmed = raw.trim_end();
        if !show_syntax {
            let stripped = trimmed
                .replace("**", "")
                .replace("~~", "")
                .replace('`', "");
            return (stripped, Vec::new());
        }

        let spans = self.doc.visible_block_inline_spans(block_ix);
        let mut highlights = Vec::with_capacity(spans.len() * 2);

        for sp in spans {
            let end_clamped = sp.full_range.end.min(trimmed.len());
            if sp.full_range.start >= end_clamped {
                continue;
            }
            let style = match sp.style {
                InlineStyleKind::Bold => HighlightStyle {
                    font_weight: Some(FontWeight::BOLD),
                    ..Default::default()
                },
                InlineStyleKind::Italic => HighlightStyle {
                    font_style: Some(FontStyle::Italic),
                    ..Default::default()
                },
                InlineStyleKind::Strikethrough => HighlightStyle {
                    strikethrough: Some(StrikethroughStyle {
                        thickness: px(1.5),
                        color: Some(theme.text_muted.into()),
                    }),
                    ..Default::default()
                },
                InlineStyleKind::InlineCode | InlineStyleKind::InlineMath => HighlightStyle {
                    background_color: Some(theme.code_bg.into()),
                    color: Some(theme.accent_primary.into()),
                    ..Default::default()
                },
                InlineStyleKind::Link | InlineStyleKind::Image => HighlightStyle {
                    color: Some(theme.accent_primary.into()),
                    underline: Some(UnderlineStyle {
                        thickness: px(1.0),
                        color: Some(theme.accent_primary.into()),
                        wavy: false,
                    }),
                    ..Default::default()
                },
            };
            highlights.push((sp.full_range.start..end_clamped, style));
        }

        (trimmed.to_string(), highlights)
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
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target_bytes = if let Some(r16) = range_utf16 {
            self.doc.utf16_to_byte_offset(r16.start)..self.doc.utf16_to_byte_offset(r16.end)
        } else if let Some(marked) = self.ime_marked_utf8.take() {
            marked
        } else if !self.selection_bytes.is_empty() {
            self.selection_bytes.clone()
        } else {
            self.cursor_byte..self.cursor_byte
        };

        let prev_blocks = self.doc.blocks().len();
        // Safe to trigger PRD 5.2 Input Rules here because IME committed final phrase!
        if let Ok(next_cursor) = self.doc.edit_byte_range(target_bytes, text, true) {
            self.cursor_byte = next_cursor;
            self.selection_bytes = next_cursor..next_cursor;
            self.ime_marked_utf8 = None;
            self.update_slash_state();
            self.sync_list_count(prev_blocks);
            cx.notify();
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
            self.cursor_byte..self.cursor_byte
        };

        let prev_blocks = self.doc.blocks().len();
        // CRITICAL (`PRD ED-03`): `allow_input_rules = false` during active Pinyin/CJK IME preedit!
        if let Ok(end_byte) = self.doc.edit_byte_range(target_bytes.clone(), new_text, false) {
            self.ime_marked_utf8 = Some(target_bytes.start..end_byte);
            self.cursor_byte = end_byte;
            self.selection_bytes = end_byte..end_byte;
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
        // Anchors macOS/Windows native IME candidate window cleanly inside active viewport
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
        let theme = if window.appearance() == gpui::WindowAppearance::Dark {
            VellumTheme::dark()
        } else {
            VellumTheme::light()
        };
        let active_ix = self.active_block_index();
        let entity = cx.entity().clone();
        let slash_candidates = self
            .slash_query
            .as_deref()
            .map(filter_slash_commands)
            .unwrap_or_default();

        div()
            .size_full()
            .relative()
            .track_focus(&self.focus_handle)
            .child(
                list(self.list_state.clone(), move |ix, _win, cx| {
                    let ent = entity.clone();
                    ent.update(cx, |this, _cx| {
                        this.render_block_row(ix, active_ix, theme, ent.clone())
                    })
                })
                .size_full(),
            )
            .when(!slash_candidates.is_empty(), |container| {
                let ent_for_menu = cx.entity().clone();
                container.child(
                    div()
                        .absolute()
                        .top(px(48.0))
                        .left(px(32.0))
                        .w(px(280.0))
                        .p_1p5()
                        .rounded_lg()
                        .bg(theme.surface_elevated)
                        .border_1()
                        .border_color(theme.border_hairline)
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .children(slash_candidates.into_iter().take(6).map(|spec| {
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
                                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                    target.update(cx, |this, cx| {
                                        this.apply_slash_command(&cmd_clone, cx);
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
                                        .font_family("JetBrains Mono")
                                        .text_color(theme.text_muted)
                                        .child(spec.shortcut_hint),
                                )
                        })),
                )
            })
    }
}
