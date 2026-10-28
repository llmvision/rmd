//! Native GPU-Accelerated Kanban Board View (`crates/vellum-gpui/src/kanban_board.rs`).
//!
//! Renders Markdown GFM Checkbox lists (`- [ ]` / `- [x]`) directly on the GPU via `gpui`
//! (Metal on macOS, Vulkan on Linux, DirectX 12 on Windows — zero WebView / zero DOM).
//! Dragging a card between the "待办" (`Todo`) and "已完成" (`Done`) lanes mutates the exact
//! state byte inside `vellum_core::RopeDocument` in `O(log N)` time with full `Cmd/Ctrl + Z` undo.

use crate::theme::VellumTheme;
use crate::wysiwyg_surface::WysiwygEditorSurface;
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement,
    IntoElement, MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Window, div, prelude::FluentBuilder, px, rgb, rgba,
};
use std::rc::Rc;
use vellum_core::KanbanTaskCard;

/// Typed GPUI drag-and-drop payload carried when dragging a Kanban task card across columns.
#[derive(Clone)]
pub struct DraggedKanbanCard {
    pub state_byte_offset: usize,
    pub block_index: usize,
    pub line_number: usize,
    pub completed: bool,
    pub display_text: SharedString,
    pub section_heading: SharedString,
}

/// Floating GPU preview view rendered directly under the cursor while a task card is being dragged.
pub struct KanbanDragGhost {
    pub payload: DraggedKanbanCard,
    pub is_dark: bool,
}

impl Render for KanbanDragGhost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = if self.is_dark {
            VellumTheme::dark()
        } else {
            VellumTheme::light()
        };

        div()
            .w(px(340.0))
            .px_3p5()
            .py_2p5()
            .rounded_lg()
            .border_1()
            .border_color(theme.accent_primary)
            .bg(theme.surface_elevated)
            .text_color(theme.text_primary)
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(self.payload.display_text.clone()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(SharedString::from(format!(
                        "{} · 第 {} 行 · 松开鼠标切换状态",
                        self.payload.section_heading, self.payload.line_number
                    ))),
            )
    }
}

pub struct KanbanBoardView {
    pub editor: Entity<WysiwygEditorSurface>,
    pub selected_section: Option<String>,
    pub on_jump_to_block: Option<Rc<dyn Fn(usize, usize, &mut Window, &mut App)>>,
    pub on_after_mutate: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    new_task_counter: usize,
    focus_handle: FocusHandle,
}

impl KanbanBoardView {
    pub fn new(
        editor: Entity<WysiwygEditorSurface>,
        on_jump_to_block: Option<Rc<dyn Fn(usize, usize, &mut Window, &mut App)>>,
        on_after_mutate: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            editor,
            selected_section: None,
            on_jump_to_block,
            on_after_mutate,
            new_task_counter: 1,
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn set_task_state(
        &mut self,
        state_byte_offset: usize,
        target_completed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut changed = false;
        self.editor.update(cx, |surface, cx| {
            if surface
                .doc
                .set_kanban_task_completed(state_byte_offset, target_completed)
                .is_ok()
            {
                changed = true;
                cx.notify();
            }
        });

        if changed {
            if let Some(cb) = self.on_after_mutate.clone() {
                cb(window, cx);
            }
            cx.notify();
        }
    }

    pub fn quick_append_task(
        &mut self,
        completed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let idx = self.new_task_counter;
        self.new_task_counter += 1;
        let label = if completed {
            format!("已完成事项 #{}", idx)
        } else {
            format!("新建待办任务 #{}（回编辑区可精细编辑文本）", idx)
        };

        self.editor.update(cx, |surface, cx| {
            if surface.doc.append_kanban_task(&label, completed).is_ok() {
                let next_count = surface.doc.blocks().len().max(1);
                surface.list_state.reset(next_count);
                cx.notify();
            }
        });

        if let Some(cb) = self.on_after_mutate.clone() {
            cb(window, cx);
        }
        cx.notify();
    }

    fn render_lane(
        &self,
        lane_id: &'static str,
        title: &'static str,
        target_completed: bool,
        cards: Vec<KanbanTaskCard>,
        theme: VellumTheme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let board_entity = cx.entity().clone();
        let board_for_add = cx.entity().clone();
        let is_dark = theme.is_dark;

        let drop_border = if target_completed {
            rgb(0x16a34a)
        } else {
            theme.accent_primary
        };
        let drop_bg = if target_completed {
            if is_dark {
                rgba(0x16a34a24)
            } else {
                rgba(0x16a34a14)
            }
        } else if is_dark {
            rgba(0x3b82f624)
        } else {
            rgba(0x2563eb12)
        };

        div()
            .id(lane_id)
            .flex_1()
            .h_full()
            .p_4()
            .rounded_xl()
            .border_1()
            .border_color(theme.border_hairline)
            .bg(theme.sidebar_bg)
            .flex()
            .flex_col()
            .gap_3()
            // Native GPUI drag-over styling when a Kanban card hovers over this column
            .drag_over::<DraggedKanbanCard>(move |style, _payload, _window, _cx| {
                style.border_color(drop_border).bg(drop_bg)
            })
            // Native GPUI drop handler: mutates `[ ]` <-> `[x]` in `RopeDocument` in O(log N)
            .on_drop({
                let board = board_entity.clone();
                move |payload: &DraggedKanbanCard, window, cx| {
                    board.update(cx, |this, cx| {
                        this.set_task_state(payload.state_byte_offset, target_completed, window, cx);
                    });
                }
            })
            // Column Header
            .child(
                div()
                    .pb_2p5()
                    .border_b_1()
                    .border_color(theme.border_hairline)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(theme.text_primary)
                                    .child(title),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(format!("· {} 项", cards.len()))),
                            ),
                    )
                    .child(
                        div()
                            .id((lane_id, 999_999usize))
                            .cursor_pointer()
                            .px_2p5()
                            .py_1()
                            .rounded_md()
                            .bg(theme.surface_elevated)
                            .border_1()
                            .border_color(theme.border_hairline)
                            .text_xs()
                            .text_color(theme.text_secondary)
                            .hover(|s| s.text_color(theme.text_primary))
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                board_for_add.update(cx, |this, cx| {
                                    this.quick_append_task(target_completed, window, cx);
                                });
                            })
                            .child("+ 新增任务"),
                    ),
            )
            // Scrollable Cards Container
            .child(
                div()
                    .id((lane_id, 888_888usize))
                    .flex_1()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_2p5()
                    .when(cards.is_empty(), |col| {
                        col.child(
                            div()
                                .py_10()
                                .px_4()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border_hairline)
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child(if target_completed {
                                    "暂无已完成项 · 可将左侧「待办」卡片直接拖拽至此栏自动写回 - [x]"
                                } else {
                                    "暂无待办项 · 可将右侧「已完成」卡片拖回此栏自动写回 - [ ]"
                                }),
                        )
                    })
                    .children(cards.into_iter().map(move |card| {
                        let drag_payload = DraggedKanbanCard {
                            state_byte_offset: card.state_byte_offset,
                            block_index: card.block_index,
                            line_number: card.line_number,
                            completed: card.completed,
                            display_text: SharedString::from(card.display_text.clone()),
                            section_heading: SharedString::from(card.section_heading.clone()),
                        };
                        let board_toggle = board_entity.clone();
                        let board_jump = board_entity.clone();
                        let state_offset = card.state_byte_offset;
                        let current_done = card.completed;
                        let jump_block_ix = card.block_index;
                        let jump_byte = card.line_byte_range.start;

                        div()
                            .id(("kanban-card", card.task_index))
                            .p_3p5()
                            .rounded_lg()
                            .border_1()
                            .border_color(theme.border_hairline)
                            .bg(theme.surface_elevated)
                            .cursor_pointer()
                            .hover(|s| s.border_color(theme.accent_primary))
                            // Initiate GPU-native drag gesture with floating `KanbanDragGhost` view
                            .on_drag(
                                drag_payload,
                                move |payload: &DraggedKanbanCard, _offset, _window, cx| {
                                    cx.new(|_| KanbanDragGhost {
                                        payload: payload.clone(),
                                        is_dark,
                                    })
                                },
                            )
                            .flex()
                            .items_start()
                            .gap_2p5()
                            // Interactive Checkbox Square
                            .child(
                                div()
                                    .id(("kanban-chk", card.task_index))
                                    .mt(px(2.0))
                                    .w(px(16.0))
                                    .h(px(16.0))
                                    .rounded(px(4.0))
                                    .border_1()
                                    .border_color(if current_done {
                                        rgb(0x16a34a)
                                    } else {
                                        theme.syntax_delimiter
                                    })
                                    .bg(if current_done {
                                        rgb(0x16a34a)
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
                                        board_toggle.update(cx, |this, cx| {
                                            this.set_task_state(
                                                state_offset,
                                                !current_done,
                                                window,
                                                cx,
                                            );
                                        });
                                    })
                                    .child(if current_done { "✓" } else { "" }),
                            )
                            // Card Text & Section/Line Metadata
                            .child(
                                div()
                                    .flex_1()
                                    .flex()
                                    .flex_col()
                                    .gap_1p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(if current_done {
                                                theme.text_muted
                                            } else {
                                                theme.text_primary
                                            })
                                            .child(SharedString::from(card.display_text)),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .text_xs()
                                            .text_color(theme.text_muted)
                                            .child(SharedString::from(format!(
                                                "{} · 第 {} 行",
                                                card.section_heading, card.line_number
                                            )))
                                            .child(
                                                div()
                                                    .id(("kanban-jump", card.task_index))
                                                    .cursor_pointer()
                                                    .text_color(theme.accent_primary)
                                                    .on_mouse_down(
                                                        MouseButton::Left,
                                                        move |_, window, cx| {
                                                            cx.stop_propagation();
                                                            let jump_cb = board_jump
                                                                .read(cx)
                                                                .on_jump_to_block
                                                                .clone();
                                                            if let Some(cb) = jump_cb {
                                                                cb(
                                                                    jump_block_ix,
                                                                    jump_byte,
                                                                    window,
                                                                    cx,
                                                                );
                                                            }
                                                        },
                                                    )
                                                    .child("定位原文 ↗"),
                                            ),
                                    ),
                            )
                    })),
            )
    }
}

impl Focusable for KanbanBoardView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for KanbanBoardView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = if window.appearance() == gpui::WindowAppearance::Dark {
            VellumTheme::dark()
        } else {
            VellumTheme::light()
        };

        let model = self.editor.read(cx).doc.extract_kanban_board();
        let active_sec = self.selected_section.clone();

        let mut sections: Vec<String> = Vec::new();
        for c in model.todo.iter().chain(model.done.iter()) {
            if !sections.contains(&c.section_heading) {
                sections.push(c.section_heading.clone());
            }
        }

        let filtered_todo: Vec<KanbanTaskCard> = model
            .todo
            .into_iter()
            .filter(|c| {
                active_sec
                    .as_deref()
                    .map(|s| s == c.section_heading.as_str())
                    .unwrap_or(true)
            })
            .collect();

        let filtered_done: Vec<KanbanTaskCard> = model
            .done
            .into_iter()
            .filter(|c| {
                active_sec
                    .as_deref()
                    .map(|s| s == c.section_heading.as_str())
                    .unwrap_or(true)
            })
            .collect();

        let completion_pct = if model.total_count > 0 {
            (model.completed_count * 100) / model.total_count
        } else {
            0
        };

        let board_for_all = cx.entity().clone();

        div()
            .size_full()
            .p_6()
            .bg(theme.canvas_bg)
            .text_color(theme.text_primary)
            .flex()
            .flex_col()
            .gap_4()
            // Top Header & Metrics Bar
            .child(
                div()
                    .pb_3()
                    .border_b_1()
                    .border_color(theme.border_hairline)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::BOLD)
                                    .child(SharedString::from(format!(
                                        "{} — 任务看板 (GPUI Native)",
                                        model.doc_title
                                    ))),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child("直接拖拽卡片在「待办」与「已完成」间流转，底层 Ropey B-Tree 执行 O(log N) 单字节无损修改"),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_secondary)
                            .child(SharedString::from(format!(
                                "待办 {} · 已完成 {} · 完成率 {}%",
                                model.total_count.saturating_sub(model.completed_count),
                                model.completed_count,
                                completion_pct
                            ))),
                    ),
            )
            // Optional Section Filter Strip
            .when(sections.len() > 1, |root| {
                let board_sec = cx.entity().clone();
                root.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .text_xs()
                        .child(
                            div()
                                .id("sec-filter-all")
                                .cursor_pointer()
                                .px_2p5()
                                .py_1()
                                .rounded_md()
                                .bg(if active_sec.is_none() {
                                    theme.accent_primary
                                } else {
                                    theme.sidebar_bg
                                })
                                .text_color(if active_sec.is_none() {
                                    rgb(0xffffff)
                                } else {
                                    theme.text_secondary
                                })
                                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                    board_for_all.update(cx, |this, cx| {
                                        this.selected_section = None;
                                        cx.notify();
                                    });
                                })
                                .child("全部章节"),
                        )
                        .children(sections.into_iter().enumerate().map(|(ix, sec_name)| {
                            let is_cur = active_sec.as_deref() == Some(sec_name.as_str());
                            let b = board_sec.clone();
                            let target = sec_name.clone();
                            div()
                                .id(("sec-filter", ix))
                                .cursor_pointer()
                                .px_2p5()
                                .py_1()
                                .rounded_md()
                                .bg(if is_cur {
                                    theme.accent_primary
                                } else {
                                    theme.sidebar_bg
                                })
                                .text_color(if is_cur {
                                    rgb(0xffffff)
                                } else {
                                    theme.text_secondary
                                })
                                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                    let chosen = target.clone();
                                    b.update(cx, |this, cx| {
                                        this.selected_section = Some(chosen);
                                        cx.notify();
                                    });
                                })
                                .child(SharedString::from(sec_name))
                        })),
                )
            })
            // Two-Lane Native GPU Kanban Columns: 待办 (Todo) | 已完成 (Done)
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .flex()
                    .gap_5()
                    .child(self.render_lane("lane-todo", "待办", false, filtered_todo, theme, cx))
                    .child(self.render_lane("lane-done", "已完成", true, filtered_done, theme, cx)),
            )
    }
}
