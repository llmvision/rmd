use crate::graph_canvas::KnowledgeGraphView;
use crate::kanban_board::KanbanBoardView;
use crate::theme::VellumTheme;
use crate::wysiwyg_surface::{EditorMode, WysiwygEditorSurface};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window, actions, div,
    prelude::FluentBuilder, px,
};
use std::path::PathBuf;
use std::rc::Rc;
use vellum_core::{
    FormalPdfOptions, FormalPdfPreset, KnowledgeGraphIndex, PaperSize, RopeDocument,
};

actions!(
    vellum_workspace,
    [
        OpenLocalMarkdownFile,
        SaveCurrentDocument,
        ExportFormalPdf,
        CycleFormalPdfPreset,
        ToggleSourceMode,
        ToggleKanbanBoard,
        ToggleKnowledgeGraph,
        ToggleOutlineSidebar,
        ToggleFocusMode,
        ToggleTypewriterMode,
        FormatBold,
        FormatItalic,
        FormatInlineCode,
        UndoEdit,
        RedoEdit,
    ]
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceSurface {
    Editor,
    KanbanBoard,
    KnowledgeGraph,
}

pub struct VellumWorkspace {
    pub editor: Entity<WysiwygEditorSurface>,
    pub kanban_view: Entity<KanbanBoardView>,
    pub graph_view: Entity<KnowledgeGraphView>,
    pub graph_index: KnowledgeGraphIndex,
    pub active_surface: WorkspaceSurface,
    pub pdf_preset: FormalPdfPreset,
    pub show_sidebar: bool,
    pub theme: VellumTheme,
    pub local_axum_url: String,
    pub status_notice: String,
    focus_handle: FocusHandle,
}

impl VellumWorkspace {
    pub fn new(initial_doc: RopeDocument, axum_port: u16, cx: &mut Context<Self>) -> Self {
        let mut graph_index = KnowledgeGraphIndex::new();
        graph_index.upsert_document(&initial_doc);
        let initial_snap = graph_index.snapshot();

        let graph_view = cx.new(|cx| KnowledgeGraphView::new(initial_snap, cx));
        let editor = cx.new(|cx| WysiwygEditorSurface::new(initial_doc, cx));

        let ws_for_jump = cx.weak_entity();
        let editor_for_jump = editor.clone();
        let on_jump: Rc<dyn Fn(usize, usize, &mut Window, &mut App)> =
            Rc::new(move |block_ix, byte_pos, _window, cx| {
                editor_for_jump.update(cx, |ed, cx| {
                    ed.cursor_byte = byte_pos;
                    ed.list_state.scroll_to_reveal_item(block_ix);
                    cx.notify();
                });
                let _ = ws_for_jump.update(cx, |ws, cx| {
                    ws.active_surface = WorkspaceSurface::Editor;
                    ws.status_notice = format!("已跳转至原文第 {} 块", block_ix + 1);
                    cx.notify();
                });
            });

        let ws_for_mutate = cx.weak_entity();
        let on_mutate: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |_window, cx| {
            let _ = ws_for_mutate.update(cx, |ws, cx| {
                ws.status_notice = "看板拖拽状态已同步至 Rope 缓冲并原子写盘".to_string();
                ws.save_active_document(cx);
                cx.notify();
            });
        });

        let editor_for_kanban = editor.clone();
        let kanban_view =
            cx.new(|cx| KanbanBoardView::new(editor_for_kanban, Some(on_jump), Some(on_mutate), cx));

        Self {
            editor,
            kanban_view,
            graph_view,
            graph_index,
            active_surface: WorkspaceSurface::Editor,
            pdf_preset: FormalPdfPreset::TechnicalSpec,
            show_sidebar: true,
            theme: VellumTheme::light(),
            local_axum_url: format!("http://127.0.0.1:{}/api/v1", axum_port),
            status_notice: "已就绪 · GPUI 原生本地优先模式".to_string(),
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn sync_active_doc_into_graph(&mut self, cx: &mut Context<Self>) {
        {
            let surface = self.editor.read(cx);
            self.graph_index.upsert_document(&surface.doc);
        }
        let snap = self.graph_index.snapshot();
        self.graph_view.update(cx, |gv, cx| {
            gv.refresh_snapshot(snap, cx);
        });
    }

    /// Streams a large `.md` file from native OS File Dialog (`rfd`) via 64 KiB `Rope` reader.
    pub fn prompt_open_file(&mut self, cx: &mut Context<Self>) {
        let editor_entity = self.editor.clone();
        cx.spawn(async move |this, cx| {
            let picked = rfd::AsyncFileDialog::new()
                .add_filter("Markdown 文档", &["md", "markdown", "txt"])
                .pick_file()
                .await;

            if let Some(handle) = picked {
                let path: PathBuf = handle.path().to_path_buf();
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("local-doc")
                    .to_string();

                if let Ok(loaded) = RopeDocument::open_streaming(id, &path) {
                    let _ = editor_entity.update(cx, |surface, cx| {
                        surface.replace_document(loaded, cx);
                    });
                    let _ = this.update(cx, |ws, cx| {
                        ws.sync_active_doc_into_graph(cx);
                        ws.status_notice = format!("已流式加载 {}", path.display());
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    /// Saves atomically to local `.md` file and notifies embedded Axum REST service (`PUT /api/v1/documents/{id}`).
    pub fn save_active_document(&mut self, cx: &mut Context<Self>) {
        let (doc_id, title, content, file_path) = {
            let surface = self.editor.read(cx);
            (
                surface.doc.id.clone(),
                surface.doc.title.clone(),
                surface.doc.to_lossless_markdown(),
                surface.doc.file_path.clone(),
            )
        };
        let endpoint = format!("{}/documents/{}", self.local_axum_url, doc_id);

        cx.spawn(async move |this, cx| {
            if let Some(path) = file_path {
                let tmp = path.with_extension("md.tmp");
                if tokio::fs::write(&tmp, content.as_bytes()).await.is_ok() {
                    let _ = tokio::fs::rename(&tmp, &path).await;
                }
            }

            let client = reqwest::Client::new();
            let _ = client
                .put(&endpoint)
                .json(&serde_json::json!({
                    "title": title,
                    "content": content,
                }))
                .send()
                .await;

            let _ = this.update(cx, |ws, cx| {
                ws.status_notice = "已原子保存至本地磁盘".to_string();
                cx.notify();
            });
        })
        .detach();
    }

    pub fn cycle_pdf_preset(&mut self, cx: &mut Context<Self>) {
        self.pdf_preset = match self.pdf_preset {
            FormalPdfPreset::TechnicalSpec => FormalPdfPreset::OfficialReport,
            FormalPdfPreset::OfficialReport => FormalPdfPreset::AcademicPaper,
            FormalPdfPreset::AcademicPaper => FormalPdfPreset::TechnicalSpec,
        };
        let label = match self.pdf_preset {
            FormalPdfPreset::TechnicalSpec => "技术规范白皮书",
            FormalPdfPreset::OfficialReport => "企事业正式公文",
            FormalPdfPreset::AcademicPaper => "学术单栏手稿",
        };
        self.status_notice = format!("PDF 正式版式已切换为：{}", label);
        cx.notify();
    }

    /// Exports current RopeDocument directly to vector PDF 1.7 via pure-Rust `krilla` (zero WebView/Chromium).
    pub fn export_formal_pdf_dialog(&mut self, cx: &mut Context<Self>) {
        let (doc_id, title, revision, content) = {
            let surface = self.editor.read(cx);
            (
                surface.doc.id.clone(),
                surface.doc.title.clone(),
                surface.doc.revision,
                surface.doc.to_lossless_markdown(),
            )
        };
        let preset = self.pdf_preset;
        let bg = cx.background_executor().clone();

        cx.spawn(async move |this, cx| {
            let safe_stem: String = title
                .chars()
                .map(|c| {
                    if c == '/' || c == '\\' || c == ':' {
                        '-'
                    } else {
                        c
                    }
                })
                .collect();

            let target = rfd::AsyncFileDialog::new()
                .set_file_name(format!("{}.pdf", safe_stem.trim()))
                .add_filter("PDF 正式排版文档", &["pdf"])
                .save_file()
                .await;

            if let Some(file_handle) = target {
                let out_path: PathBuf = file_handle.path().to_path_buf();
                let opts = FormalPdfOptions {
                    preset,
                    paper_size: PaperSize::A4,
                    margin_mm: 25.4,
                    include_cover_meta: true,
                    include_toc: true,
                    auto_number_headings: true,
                    include_header_footer: true,
                    document_code: Some(format!("VN-{}-R{}", doc_id.to_uppercase(), revision)),
                    organization: Some("Vellum Native Formal Publishing".to_string()),
                };

                let rendered = bg
                    .spawn(async move {
                        let mut snap_doc = RopeDocument::from_markdown_str(&doc_id, &title, &content);
                        snap_doc.revision = revision;
                        snap_doc.export_formal_pdf(&opts, None)
                    })
                    .await;

                match rendered {
                    Ok(pdf_bytes) => {
                        if tokio::fs::write(&out_path, &pdf_bytes).await.is_ok() {
                            let _ = this.update(cx, |ws, cx| {
                                ws.status_notice = format!(
                                    "已导出正式矢量 PDF ({:.1} KB) → {}",
                                    pdf_bytes.len() as f64 / 1024.0,
                                    out_path.display()
                                );
                                cx.notify();
                            });
                        }
                    }
                    Err(err) => {
                        let _ = this.update(cx, |ws, cx| {
                            ws.status_notice = format!("PDF 导出失败: {}", err);
                            cx.notify();
                        });
                    }
                }
            }
        })
        .detach();
    }
}

impl Focusable for VellumWorkspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for VellumWorkspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let pdf_preset = self.pdf_preset;
        let (doc_title, metrics, outline, current_mode, focus_on, typewriter_on) = {
            let surface = self.editor.read(cx);
            (
                surface.doc.title.clone(),
                surface.doc.metrics(),
                surface.doc.outline(),
                surface.mode,
                surface.focus_mode,
                surface.typewriter_mode,
            )
        };

        let ws_entity = cx.entity().clone();
        let editor_for_mode = self.editor.clone();
        let editor_for_focus = self.editor.clone();
        let editor_for_tw = self.editor.clone();
        let editor_for_toc = self.editor.clone();

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.canvas_bg)
            .text_color(theme.text_primary)
            .on_action(cx.listener(|this, _: &OpenLocalMarkdownFile, _, cx| {
                this.prompt_open_file(cx);
            }))
            .on_action(cx.listener(|this, _: &SaveCurrentDocument, _, cx| {
                this.save_active_document(cx);
            }))
            .on_action(cx.listener(|this, _: &ExportFormalPdf, _, cx| {
                this.export_formal_pdf_dialog(cx);
            }))
            .on_action(cx.listener(|this, _: &CycleFormalPdfPreset, _, cx| {
                this.cycle_pdf_preset(cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleOutlineSidebar, _, cx| {
                this.show_sidebar = !this.show_sidebar;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleFocusMode, _, cx| {
                this.editor.update(cx, |ed, cx| {
                    ed.focus_mode = !ed.focus_mode;
                    cx.notify();
                });
            }))
            .on_action(cx.listener(|this, _: &ToggleTypewriterMode, _, cx| {
                this.editor.update(cx, |ed, cx| {
                    ed.typewriter_mode = !ed.typewriter_mode;
                    cx.notify();
                });
            }))
            .on_action(cx.listener(|this, _: &ToggleSourceMode, _, cx| {
                this.active_surface = WorkspaceSurface::Editor;
                this.editor.update(cx, |ed, cx| {
                    ed.mode = match ed.mode {
                        EditorMode::InstantWysiwyg => EditorMode::SourceCode,
                        EditorMode::SourceCode => EditorMode::InstantWysiwyg,
                        EditorMode::SplitPreview => EditorMode::InstantWysiwyg,
                    };
                    cx.notify();
                });
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleKanbanBoard, _, cx| {
                this.active_surface = if this.active_surface == WorkspaceSurface::KanbanBoard {
                    WorkspaceSurface::Editor
                } else {
                    WorkspaceSurface::KanbanBoard
                };
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleKnowledgeGraph, _, cx| {
                this.sync_active_doc_into_graph(cx);
                this.active_surface = if this.active_surface == WorkspaceSurface::KnowledgeGraph {
                    WorkspaceSurface::Editor
                } else {
                    WorkspaceSurface::KnowledgeGraph
                };
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &FormatBold, _, cx| {
                this.editor.update(cx, |ed, cx| ed.toggle_inline_delimiter("**", cx));
            }))
            .on_action(cx.listener(|this, _: &FormatItalic, _, cx| {
                this.editor.update(cx, |ed, cx| ed.toggle_inline_delimiter("*", cx));
            }))
            .on_action(cx.listener(|this, _: &FormatInlineCode, _, cx| {
                this.editor.update(cx, |ed, cx| ed.toggle_inline_delimiter("`", cx));
            }))
            .on_action(cx.listener(|this, _: &UndoEdit, _, cx| {
                this.editor.update(cx, |ed, cx| {
                    if let Some(pos) = ed.doc.undo() {
                        ed.cursor_byte = pos;
                        cx.notify();
                    }
                });
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &RedoEdit, _, cx| {
                this.editor.update(cx, |ed, cx| {
                    if let Some(pos) = ed.doc.redo() {
                        ed.cursor_byte = pos;
                        cx.notify();
                    }
                });
                cx.notify();
            }))
            // Native Workspace Top Toolbar
            .child(
                div()
                    .h(px(46.0))
                    .px_5()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(theme.border_hairline)
                    .bg(theme.surface_elevated)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_4()
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::BOLD)
                                    .child(SharedString::from(doc_title)),
                            )
                            .child(
                                div()
                                    .id("btn-open-md")
                                    .cursor_pointer()
                                    .text_xs()
                                    .text_color(theme.text_secondary)
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| this.prompt_open_file(cx));
                                        }
                                    })
                                    .child("打开本地文件"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .text_xs()
                            // Native GPUI Kanban Board Switch (`Cmd/Ctrl + Shift + K`)
                            .child(
                                div()
                                    .id("btn-toggle-kanban")
                                    .cursor_pointer()
                                    .px_2p5()
                                    .py_1()
                                    .rounded_md()
                                    .bg(if self.active_surface == WorkspaceSurface::KanbanBoard {
                                        theme.accent_primary
                                    } else {
                                        theme.sidebar_bg
                                    })
                                    .text_color(
                                        if self.active_surface == WorkspaceSurface::KanbanBoard {
                                            gpui::rgb(0xffffff)
                                        } else {
                                            theme.text_primary
                                        },
                                    )
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| {
                                                this.active_surface = if this.active_surface
                                                    == WorkspaceSurface::KanbanBoard
                                                {
                                                    WorkspaceSurface::Editor
                                                } else {
                                                    WorkspaceSurface::KanbanBoard
                                                };
                                                cx.notify();
                                            });
                                        }
                                    })
                                    .child(if self.active_surface == WorkspaceSurface::KanbanBoard {
                                        "返回编辑区"
                                    } else {
                                        "任务看板"
                                    }),
                            )
                            // Native GPUI Knowledge Graph Switch (`Cmd/Ctrl + Shift + G`)
                            .child(
                                div()
                                    .id("btn-toggle-graph")
                                    .cursor_pointer()
                                    .px_2p5()
                                    .py_1()
                                    .rounded_md()
                                    .bg(if self.active_surface == WorkspaceSurface::KnowledgeGraph {
                                        theme.accent_primary
                                    } else {
                                        theme.sidebar_bg
                                    })
                                    .text_color(
                                        if self.active_surface == WorkspaceSurface::KnowledgeGraph {
                                            gpui::rgb(0xffffff)
                                        } else {
                                            theme.text_primary
                                        },
                                    )
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| {
                                                this.sync_active_doc_into_graph(cx);
                                                this.active_surface = if this.active_surface
                                                    == WorkspaceSurface::KnowledgeGraph
                                                {
                                                    WorkspaceSurface::Editor
                                                } else {
                                                    WorkspaceSurface::KnowledgeGraph
                                                };
                                                cx.notify();
                                            });
                                        }
                                    })
                                    .child(
                                        if self.active_surface == WorkspaceSurface::KnowledgeGraph {
                                            "返回编辑区"
                                        } else {
                                            "知识图谱"
                                        },
                                    ),
                            )
                            .child(
                                div()
                                    .id("btn-toggle-mode")
                                    .cursor_pointer()
                                    .px_2p5()
                                    .py_1()
                                    .rounded_md()
                                    .bg(theme.sidebar_bg)
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| {
                                                this.active_surface = WorkspaceSurface::Editor;
                                                cx.notify();
                                            });
                                            editor_for_mode.update(cx, |ed, cx| {
                                                ed.mode = match ed.mode {
                                                    EditorMode::InstantWysiwyg => {
                                                        EditorMode::SourceCode
                                                    }
                                                    _ => EditorMode::InstantWysiwyg,
                                                };
                                                cx.notify();
                                            });
                                        }
                                    })
                                    .child(match current_mode {
                                        EditorMode::InstantWysiwyg => "即时渲染 (WYSIWYG)",
                                        EditorMode::SourceCode => "源码模式",
                                        EditorMode::SplitPreview => "分栏视图",
                                    }),
                            )
                            .child(
                                div()
                                    .id("btn-focus-mode")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .text_color(if focus_on {
                                        theme.accent_primary
                                    } else {
                                        theme.text_muted
                                    })
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        editor_for_focus.update(cx, |ed, cx| {
                                            ed.focus_mode = !ed.focus_mode;
                                            cx.notify();
                                        });
                                    })
                                    .child("专注"),
                            )
                            .child(
                                div()
                                    .id("btn-tw-mode")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .text_color(if typewriter_on {
                                        theme.accent_primary
                                    } else {
                                        theme.text_muted
                                    })
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        editor_for_tw.update(cx, |ed, cx| {
                                            ed.typewriter_mode = !ed.typewriter_mode;
                                            cx.notify();
                                        });
                                    })
                                    .child("打字机"),
                            )
                            .child(
                                div()
                                    .id("btn-pdf-preset")
                                    .cursor_pointer()
                                    .px_2p5()
                                    .py_1()
                                    .rounded_md()
                                    .bg(theme.sidebar_bg)
                                    .text_color(theme.text_secondary)
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| this.cycle_pdf_preset(cx));
                                        }
                                    })
                                    .child(match pdf_preset {
                                        FormalPdfPreset::TechnicalSpec => "版式: 技术白皮书",
                                        FormalPdfPreset::OfficialReport => "版式: 正式公文",
                                        FormalPdfPreset::AcademicPaper => "版式: 学术手稿",
                                    }),
                            )
                            .child(
                                div()
                                    .id("btn-export-pdf")
                                    .cursor_pointer()
                                    .px_2p5()
                                    .py_1()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(theme.border_hairline)
                                    .bg(theme.surface_elevated)
                                    .text_color(theme.text_primary)
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| {
                                                this.export_formal_pdf_dialog(cx)
                                            });
                                        }
                                    })
                                    .child("导出 PDF"),
                            )
                            .child(
                                div()
                                    .id("btn-save-md")
                                    .cursor_pointer()
                                    .px_3()
                                    .py_1()
                                    .rounded_md()
                                    .bg(theme.accent_primary)
                                    .text_color(gpui::rgb(0xffffff))
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        ws_entity
                                            .update(cx, |this, cx| this.save_active_document(cx));
                                    })
                                    .child("保存"),
                            ),
                    ),
            )
            // Main Body: Native GPUI Kanban Board OR Knowledge Graph OR Virtualized WYSIWYG Editor
            .child(match self.active_surface {
                WorkspaceSurface::KanbanBoard => div()
                    .flex_1()
                    .overflow_hidden()
                    .child(self.kanban_view.clone()),
                WorkspaceSurface::KnowledgeGraph => div()
                    .flex_1()
                    .overflow_hidden()
                    .child(self.graph_view.clone()),
                WorkspaceSurface::Editor => div()
                    .flex_1()
                    .flex()
                    .overflow_hidden()
                    .when(self.show_sidebar, |body| {
                        body.child(
                            div()
                                .w(px(248.0))
                                .h_full()
                                .p_4()
                                .bg(theme.sidebar_bg)
                                .border_r_1()
                                .border_color(theme.border_hairline)
                                .flex()
                                .flex_col()
                                .gap_1p5()
                                .child(
                                    div()
                                        .pb_2()
                                        .text_xs()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(theme.text_muted)
                                        .child("文档大纲"),
                                )
                                .children(outline.into_iter().take(60).map(move |entry| {
                                    let target_ed = editor_for_toc.clone();
                                    let indent = ((entry.level.saturating_sub(1)) as f32) * 10.0;
                                    div()
                                        .id(("toc-item", entry.block_index))
                                        .pl(px(indent))
                                        .py_1()
                                        .text_xs()
                                        .text_color(theme.text_secondary)
                                        .cursor_pointer()
                                        .hover(|s| s.text_color(theme.accent_primary))
                                        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                            target_ed.update(cx, |ed, cx| {
                                                ed.cursor_byte = entry.byte_offset;
                                                ed.list_state
                                                    .scroll_to_reveal_item(entry.block_index);
                                                cx.notify();
                                            });
                                        })
                                        .child(SharedString::from(entry.text))
                                })),
                        )
                    })
                    .child(
                        div()
                            .flex_1()
                            .h_full()
                            .flex()
                            .justify_center()
                            .px_8()
                            .py_6()
                            .child(
                                div()
                                    .w_full()
                                    .max_w(theme.width_preset.max_width_px())
                                    .h_full()
                                    .child(self.editor.clone()),
                            ),
                    ),
            })
            // Quiet Document Metrics Bar
            .child(
                div()
                    .h(px(28.0))
                    .px_5()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_color(theme.border_hairline)
                    .bg(theme.surface_elevated)
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(SharedString::from(format!(
                        "{} 字 · {} 块 · 预计阅读 {} 分钟 · Rope 内存 {:.1} KB",
                        metrics.word_count,
                        metrics.block_count,
                        metrics.reading_minutes,
                        metrics.estimated_ram_bytes as f64 / 1024.0
                    )))
                    .child(SharedString::from(self.status_notice.clone())),
            )
    }
}
