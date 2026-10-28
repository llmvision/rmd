use crate::graph_canvas::KnowledgeGraphView;
use crate::kanban_board::KanbanBoardView;
use crate::theme::{PageWidthPreset, VellumTheme};
use crate::wysiwyg_surface::{EditorMode, WysiwygEditorSurface};
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement,
    IntoElement, MouseButton, MouseMoveEvent, ParentElement, Pixels, Point, Render, SharedString,
    StatefulInteractiveElement, Styled, Window, actions, div, prelude::FluentBuilder, px, rgb,
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
        NewWorkspaceDocument,
        SaveCurrentDocument,
        ExportFormalPdf,
        CycleFormalPdfPreset,
        ToggleSourceMode,
        ToggleSplitMode,
        ToggleKanbanBoard,
        ToggleKnowledgeGraph,
        ToggleOutlineSidebar,
        ToggleFocusMode,
        ToggleTypewriterMode,
        ToggleDarkTheme,
        ToggleSoftwareCursor,
        AppendAtDocumentEnd,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarTab {
    Files,
    Outline,
    Links,
}

#[derive(Debug, Clone)]
pub struct WorkspaceDocMeta {
    pub id: String,
    pub title: String,
    pub path: PathBuf,
    pub word_count: usize,
    pub block_count: usize,
}

pub struct VellumWorkspace {
    pub workspace_dir: PathBuf,
    pub workspace_docs: Vec<WorkspaceDocMeta>,
    pub editor: Entity<WysiwygEditorSurface>,
    pub kanban_view: Entity<KanbanBoardView>,
    pub graph_view: Entity<KnowledgeGraphView>,
    pub graph_index: KnowledgeGraphIndex,
    pub active_surface: WorkspaceSurface,
    pub sidebar_tab: SidebarTab,
    pub pdf_preset: FormalPdfPreset,
    pub show_sidebar: bool,
    pub is_dark: bool,
    pub width_preset: PageWidthPreset,
    pub software_cursor_enabled: bool,
    pub last_mouse_pos: Option<Point<Pixels>>,
    pub local_axum_url: String,
    pub status_notice: String,
    new_doc_seq: usize,
    focus_handle: FocusHandle,
}

impl VellumWorkspace {
    pub fn new(
        workspace_dir: PathBuf,
        initial_doc: RopeDocument,
        axum_port: u16,
        default_sw_cursor: bool,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut graph_index = KnowledgeGraphIndex::new();
        let mut workspace_docs = scan_workspace_directory(&workspace_dir, &mut graph_index);
        graph_index.upsert_document(&initial_doc);
        upsert_doc_meta(&mut workspace_docs, &initial_doc, &workspace_dir);

        let initial_snap = graph_index.snapshot();
        let graph_view = cx.new(|cx| KnowledgeGraphView::new(initial_snap, cx));
        let editor = cx.new(|cx| WysiwygEditorSurface::new(initial_doc, cx));

        // Wire WikiLink navigation callback (`[[Target#Heading]]` click or phantom note creation)
        let ws_for_wiki = cx.weak_entity();
        let on_wiki_nav: Rc<dyn Fn(String, Option<String>, &mut Window, &mut App)> =
            Rc::new(move |target, heading, window, cx| {
                let _ = ws_for_wiki.update(cx, |ws, cx| {
                    ws.navigate_or_create_wikilink(&target, heading.as_deref(), window, cx);
                });
            });

        // Wire live document change callback so Outline / Graph / Doc stats stay in sync
        let ws_for_doc_change = cx.weak_entity();
        let on_doc_changed: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |_window, cx| {
            let _ = ws_for_doc_change.update(cx, |ws, cx| {
                ws.sync_active_doc_into_graph(cx);
                cx.notify();
            });
        });

        editor.update(cx, |ed, _| {
            ed.on_navigate_wikilink = Some(on_wiki_nav);
            ed.on_doc_changed = Some(on_doc_changed);
        });

        // Wire Kanban jump-to-block callback
        let ws_for_jump = cx.weak_entity();
        let editor_for_jump = editor.clone();
        let on_jump: Rc<dyn Fn(usize, usize, &mut Window, &mut App)> =
            Rc::new(move |block_ix, byte_pos, window, cx| {
                editor_for_jump.update(cx, |ed, cx| {
                    ed.cursor_byte = byte_pos;
                    ed.selection_bytes = byte_pos..byte_pos;
                    ed.list_state.scroll_to_reveal_item(block_ix);
                    window.focus(&ed.focus_handle);
                    cx.notify();
                });
                let _ = ws_for_jump.update(cx, |ws, cx| {
                    ws.active_surface = WorkspaceSurface::Editor;
                    ws.status_notice = format!("已定位至原文第 {} 块", block_ix + 1);
                    cx.notify();
                });
            });

        // Wire Kanban drag-and-drop mutation persistence callback
        let ws_for_mutate = cx.weak_entity();
        let on_mutate: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |_window, cx| {
            let _ = ws_for_mutate.update(cx, |ws, cx| {
                ws.sync_active_doc_into_graph(cx);
                ws.status_notice = "看板拖拽状态已同步至 Rope 缓冲并原子写盘".to_string();
                ws.save_active_document(cx);
                cx.notify();
            });
        });

        let editor_for_kanban = editor.clone();
        let kanban_view =
            cx.new(|cx| KanbanBoardView::new(editor_for_kanban, Some(on_jump), Some(on_mutate), cx));

        let next_seq = workspace_docs.len() + 1;

        Self {
            workspace_dir,
            workspace_docs,
            editor,
            kanban_view,
            graph_view,
            graph_index,
            active_surface: WorkspaceSurface::Editor,
            sidebar_tab: SidebarTab::Files,
            pdf_preset: FormalPdfPreset::TechnicalSpec,
            show_sidebar: true,
            is_dark: false,
            width_preset: PageWidthPreset::Standard,
            software_cursor_enabled: default_sw_cursor,
            last_mouse_pos: None,
            local_axum_url: format!("http://127.0.0.1:{}/api/v1", axum_port),
            status_notice: "已就绪 · 点击任意段落或底部空白处即可所见即所得编辑".to_string(),
            new_doc_seq: next_seq,
            focus_handle: cx.focus_handle(),
        }
    }

    fn current_theme(&self) -> VellumTheme {
        let mut t = if self.is_dark {
            VellumTheme::dark()
        } else {
            VellumTheme::light()
        };
        t.width_preset = self.width_preset;
        t
    }

    pub fn sync_active_doc_into_graph(&mut self, cx: &mut Context<Self>) {
        {
            let surface = self.editor.read(cx);
            self.graph_index.upsert_document(&surface.doc);
            upsert_doc_meta(&mut self.workspace_docs, &surface.doc, &self.workspace_dir);
        }
        let snap = self.graph_index.snapshot();
        self.graph_view.update(cx, |gv, cx| {
            gv.refresh_snapshot(snap, cx);
        });
    }

    /// Switches active document in workspace (auto-persisting current dirty document first).
    pub fn select_workspace_document(
        &mut self,
        doc_id: &str,
        heading_anchor: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.editor.read(cx).doc.dirty_disk {
            self.save_active_document_sync(cx);
        }

        let target_meta = self.workspace_docs.iter().find(|d| d.id == doc_id).cloned();
        let Some(meta) = target_meta else {
            return;
        };

        if let Ok(loaded) = RopeDocument::open_streaming(&meta.id, &meta.path) {
            let title_copy = loaded.title.clone();
            self.editor.update(cx, |surface, cx| {
                surface.replace_document(loaded, cx);
                if let Some(sec) = heading_anchor {
                    let target_norm = sec.trim().to_lowercase();
                    if let Some(entry) = surface
                        .doc
                        .outline()
                        .into_iter()
                        .find(|o| o.text.trim().to_lowercase().contains(&target_norm))
                    {
                        surface.cursor_byte = entry.byte_offset;
                        surface.selection_bytes = entry.byte_offset..entry.byte_offset;
                        surface.list_state.scroll_to_reveal_item(entry.block_index);
                    }
                }
                window.focus(&surface.focus_handle);
            });
            self.active_surface = WorkspaceSurface::Editor;
            self.sync_active_doc_into_graph(cx);
            self.status_notice = format!("已切换至《{}》", title_copy);
            cx.notify();
        }
    }

    /// Navigates to an existing `[[WikiLink]]` target by title/id, or creates a new `.md` file if unresolved.
    pub fn navigate_or_create_wikilink(
        &mut self,
        target_name: &str,
        heading_anchor: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let norm = target_name.trim().to_lowercase();
        if let Some(found) = self
            .workspace_docs
            .iter()
            .find(|d| d.title.trim().to_lowercase() == norm || d.id.to_lowercase() == norm)
            .cloned()
        {
            self.select_workspace_document(&found.id, heading_anchor, window, cx);
            return;
        }

        // Create unresolved phantom document on disk immediately
        let slug: String = target_name
            .trim()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || ('\u{4E00}'..='\u{9FFF}').contains(&c) {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let doc_id = if slug.trim_matches('-').is_empty() {
            format!("note-{}", self.new_doc_seq)
        } else {
            slug.trim_matches('-').to_lowercase()
        };
        self.new_doc_seq += 1;

        let path = self.workspace_dir.join(format!("{}.md", doc_id));
        let initial_md = format!("# {}\n\n", target_name.trim());
        let _ = std::fs::create_dir_all(&self.workspace_dir);
        let _ = std::fs::write(&path, initial_md.as_bytes());

        let mut new_doc = RopeDocument::from_markdown_str(&doc_id, target_name.trim(), &initial_md);
        new_doc.file_path = Some(path);
        let eof = new_doc.len_bytes();

        self.editor.update(cx, |surface, cx| {
            surface.replace_document(new_doc, cx);
            surface.cursor_byte = eof;
            surface.selection_bytes = eof..eof;
            window.focus(&surface.focus_handle);
        });
        self.active_surface = WorkspaceSurface::Editor;
        self.sync_active_doc_into_graph(cx);
        self.status_notice = format!("已新建并关联知识节点《{}》", target_name.trim());
        cx.notify();
    }

    pub fn create_blank_document(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editor.read(cx).doc.dirty_disk {
            self.save_active_document_sync(cx);
        }

        let seq = self.new_doc_seq;
        self.new_doc_seq += 1;
        let doc_id = format!("note-{}", seq);
        let title = format!("未命名笔记 {}", seq);
        let content = format!("# {}\n\n", title);
        let path = self.workspace_dir.join(format!("{}.md", doc_id));

        let _ = std::fs::create_dir_all(&self.workspace_dir);
        let _ = std::fs::write(&path, content.as_bytes());

        let mut doc = RopeDocument::from_markdown_str(&doc_id, &title, &content);
        doc.file_path = Some(path);
        let eof = doc.len_bytes();

        self.editor.update(cx, |surface, cx| {
            surface.replace_document(doc, cx);
            surface.cursor_byte = eof;
            surface.selection_bytes = eof..eof;
            window.focus(&surface.focus_handle);
        });
        self.active_surface = WorkspaceSurface::Editor;
        self.sidebar_tab = SidebarTab::Files;
        self.sync_active_doc_into_graph(cx);
        self.status_notice = format!("已新建《{}》，可直接输入正文", title);
        cx.notify();
    }

    fn save_active_document_sync(&self, cx: &App) {
        let surface = self.editor.read(cx);
        let content = surface.doc.to_lossless_markdown();
        let target_path = surface
            .doc
            .file_path
            .clone()
            .unwrap_or_else(|| self.workspace_dir.join(format!("{}.md", surface.doc.id)));
        let _ = std::fs::create_dir_all(&self.workspace_dir);
        let tmp = target_path.with_extension("md.tmp");
        if std::fs::write(&tmp, content.as_bytes()).is_ok() {
            let _ = std::fs::rename(&tmp, &target_path);
        }
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
                        ws.active_surface = WorkspaceSurface::Editor;
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
            let mut_doc_path = self.workspace_dir.clone();
            let surface = self.editor.read(cx);
            let resolved_path = surface
                .doc
                .file_path
                .clone()
                .unwrap_or_else(|| mut_doc_path.join(format!("{}.md", surface.doc.id)));
            (
                surface.doc.id.clone(),
                surface.doc.title.clone(),
                surface.doc.to_lossless_markdown(),
                resolved_path,
            )
        };

        self.editor.update(cx, |surface, _| {
            if surface.doc.file_path.is_none() {
                surface.doc.file_path = Some(file_path.clone());
            }
            surface.doc.dirty_disk = false;
        });

        let endpoint = format!("{}/documents/{}", self.local_axum_url, doc_id);
        let bg = cx.background_executor().clone();

        cx.spawn(async move |this, cx| {
            let content_for_disk = content.clone();
            let path_for_disk = file_path.clone();
            bg.spawn(async move {
                if let Some(parent) = path_for_disk.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let tmp = path_for_disk.with_extension("md.tmp");
                if std::fs::write(&tmp, content_for_disk.as_bytes()).is_ok() {
                    let _ = std::fs::rename(&tmp, &path_for_disk);
                }
            })
            .await;

            // Dispatch Tokio-based `reqwest` call onto the background Tokio runtime handle
            if let Some(rt_handle) = crate::tokio_handle() {
                rt_handle.spawn(async move {
                    let client = reqwest::Client::new();
                    let _ = client
                        .put(&endpoint)
                        .json(&serde_json::json!({
                            "title": title,
                            "content": content,
                        }))
                        .send()
                        .await;
                });
            }

            let _ = this.update(cx, |ws, cx| {
                ws.sync_active_doc_into_graph(cx);
                ws.status_notice = format!("已原子保存 → {}", file_path.display());
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
                let write_path = out_path.clone();
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
                        let bytes = snap_doc.export_formal_pdf(&opts, None)?;
                        std::fs::write(&write_path, &bytes)?;
                        Ok::<usize, anyhow::Error>(bytes.len())
                    })
                    .await;

                match rendered {
                    Ok(byte_len) => {
                        let _ = this.update(cx, |ws, cx| {
                            ws.status_notice = format!(
                                "已导出正式矢量 PDF ({:.1} KB) → {}",
                                byte_len as f64 / 1024.0,
                                out_path.display()
                            );
                            cx.notify();
                        });
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

    fn render_formatting_bar(&self, theme: VellumTheme, cx: &mut Context<Self>) -> impl IntoElement {
        let ed_h1 = self.editor.clone();
        let ed_h2 = self.editor.clone();
        let ed_h3 = self.editor.clone();
        let ed_b = self.editor.clone();
        let ed_i = self.editor.clone();
        let ed_s = self.editor.clone();
        let ed_mk = self.editor.clone();
        let ed_code = self.editor.clone();
        let ed_ul = self.editor.clone();
        let ed_ol = self.editor.clone();
        let ed_task = self.editor.clone();
        let ed_quote = self.editor.clone();
        let ed_tbl = self.editor.clone();
        let ed_fence = self.editor.clone();
        let ed_wiki = self.editor.clone();
        let ed_eof = self.editor.clone();
        let ed_focus = self.editor.clone();
        let ed_tw = self.editor.clone();
        let ws_width = cx.entity().clone();

        let (focus_on, typewriter_on) = {
            let s = self.editor.read(cx);
            (s.focus_mode, s.typewriter_mode)
        };

        let fmt_btn = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .cursor_pointer()
                .px_2()
                .py_1()
                .rounded_md()
                .text_xs()
                .text_color(theme.text_secondary)
                .hover(|s| s.bg(theme.sidebar_bg).text_color(theme.text_primary))
                .child(label)
        };

        div()
            .h(px(38.0))
            .px_4()
            .flex()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(theme.border_hairline)
            .bg(theme.canvas_bg)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(fmt_btn("fmt-h1", "H1").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_h1.update(cx, |ed, cx| ed.insert_block_template("# ", 0, window, cx));
                        },
                    ))
                    .child(fmt_btn("fmt-h2", "H2").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_h2.update(cx, |ed, cx| ed.insert_block_template("## ", 0, window, cx));
                        },
                    ))
                    .child(fmt_btn("fmt-h3", "H3").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_h3.update(cx, |ed, cx| ed.insert_block_template("### ", 0, window, cx));
                        },
                    ))
                    .child(div().w(px(1.0)).h(px(14.0)).mx_1().bg(theme.border_hairline))
                    .child(fmt_btn("fmt-bold", "B 加粗").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_b.update(cx, |ed, cx| {
                                ed.wrap_selection_pair("**", "**", window, cx);
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-italic", "I 斜体").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_i.update(cx, |ed, cx| {
                                ed.wrap_selection_pair("*", "*", window, cx);
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-strike", "S 删除线").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_s.update(cx, |ed, cx| {
                                ed.wrap_selection_pair("~~", "~~", window, cx);
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-mark", "==高亮==").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_mk.update(cx, |ed, cx| {
                                ed.wrap_selection_pair("==", "==", window, cx);
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-code", "<> 行内代码").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_code.update(cx, |ed, cx| {
                                ed.wrap_selection_pair("`", "`", window, cx);
                            });
                        },
                    ))
                    .child(div().w(px(1.0)).h(px(14.0)).mx_1().bg(theme.border_hairline))
                    .child(fmt_btn("fmt-ul", "• 列表").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_ul.update(cx, |ed, cx| ed.insert_block_template("- ", 0, window, cx));
                        },
                    ))
                    .child(fmt_btn("fmt-ol", "1. 编号").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_ol.update(cx, |ed, cx| ed.insert_block_template("1. ", 0, window, cx));
                        },
                    ))
                    .child(fmt_btn("fmt-task", "☑ 待办").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_task.update(cx, |ed, cx| {
                                ed.insert_block_template("- [ ] ", 0, window, cx)
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-quote", "❝ 提示块").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_quote.update(cx, |ed, cx| {
                                ed.insert_block_template("> [!NOTE]\n> ", 0, window, cx)
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-table", "⊞ 表格").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_tbl.update(cx, |ed, cx| {
                                ed.insert_block_template(
                                    "| 列标题 A | 列标题 B | 列标题 C |\n| :--- | :---: | ---: |\n| 内容 1 | 内容 2 | 100 |\n",
                                    0,
                                    window,
                                    cx,
                                );
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-fence", "{ } 代码块").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_fence.update(cx, |ed, cx| {
                                ed.insert_block_template("```rust\n\n```", 4, window, cx)
                            });
                        },
                    ))
                    .child(fmt_btn("fmt-wiki", "[[ 双链").on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            ed_wiki.update(cx, |ed, cx| {
                                ed.wrap_selection_pair("[[", "]]", window, cx);
                            });
                        },
                    )),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .child(
                        div()
                            .id("btn-width-preset")
                            .cursor_pointer()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .text_color(theme.text_muted)
                            .hover(|s| s.text_color(theme.text_primary))
                            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                ws_width.update(cx, |this, cx| {
                                    this.width_preset = this.width_preset.next();
                                    cx.notify();
                                });
                            })
                            .child(self.width_preset.label()),
                    )
                    .child(
                        div()
                            .id("btn-focus-mode")
                            .cursor_pointer()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .text_color(if focus_on {
                                theme.accent_primary
                            } else {
                                theme.text_muted
                            })
                            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                ed_focus.update(cx, |ed, cx| {
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
                            .rounded_md()
                            .text_color(if typewriter_on {
                                theme.accent_primary
                            } else {
                                theme.text_muted
                            })
                            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                ed_tw.update(cx, |ed, cx| {
                                    ed.typewriter_mode = !ed.typewriter_mode;
                                    cx.notify();
                                });
                            })
                            .child("打字机"),
                    )
                    .child(
                        div()
                            .id("btn-append-eof")
                            .cursor_pointer()
                            .px_2p5()
                            .py_1()
                            .rounded_md()
                            .border_1()
                            .border_color(theme.accent_primary)
                            .bg(theme.surface_elevated)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.accent_primary)
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                ed_eof.update(cx, |ed, cx| {
                                    ed.append_or_focus_document_end(window, cx);
                                });
                            })
                            .child("+ 在文末续写"),
                    ),
            )
    }

    fn render_sidebar(&self, theme: VellumTheme, cx: &mut Context<Self>) -> impl IntoElement {
        let ws_tab_files = cx.entity().clone();
        let ws_tab_outline = cx.entity().clone();
        let ws_tab_links = cx.entity().clone();
        let ws_new_doc = cx.entity().clone();
        let ws_select_doc = cx.entity().clone();
        let ws_link_nav = cx.entity().clone();
        let editor_for_toc = self.editor.clone();

        let (active_doc_id, outline, active_block_ix) = {
            let s = self.editor.read(cx);
            (
                s.doc.id.clone(),
                s.doc.outline(),
                s.active_block_index(),
            )
        };

        let backlinks = self.graph_index.backlinks_for(&active_doc_id);
        let outgoing = self.graph_index.outgoing_links(&active_doc_id);
        let tab = self.sidebar_tab;

        let tab_pill = |id: &'static str, label: String, active: bool| {
            div()
                .id(id)
                .flex_1()
                .py_1()
                .rounded_md()
                .cursor_pointer()
                .flex()
                .justify_center()
                .bg(if active {
                    theme.surface_elevated
                } else {
                    theme.sidebar_bg
                })
                .text_xs()
                .font_weight(if active {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::NORMAL
                })
                .text_color(if active {
                    theme.accent_primary
                } else {
                    theme.text_muted
                })
                .child(SharedString::from(label))
        };

        div()
            .w(px(268.0))
            .h_full()
            .p_3()
            .bg(theme.sidebar_bg)
            .border_r_1()
            .border_color(theme.border_hairline)
            .flex()
            .flex_col()
            .gap_2p5()
            // 3-Tab Switcher (`文件库` | `大纲` | `双链`)
            .child(
                div()
                    .p_1()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.border_hairline)
                    .flex()
                    .gap_1()
                    .child(
                        tab_pill(
                            "tab-files",
                            format!("文件 ({})", self.workspace_docs.len()),
                            tab == SidebarTab::Files,
                        )
                        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                            ws_tab_files.update(cx, |this, cx| {
                                this.sidebar_tab = SidebarTab::Files;
                                cx.notify();
                            });
                        }),
                    )
                    .child(
                        tab_pill(
                            "tab-outline",
                            format!("大纲 ({})", outline.len()),
                            tab == SidebarTab::Outline,
                        )
                        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                            ws_tab_outline.update(cx, |this, cx| {
                                this.sidebar_tab = SidebarTab::Outline;
                                cx.notify();
                            });
                        }),
                    )
                    .child(
                        tab_pill(
                            "tab-links",
                            format!("双链 ({})", backlinks.len() + outgoing.len()),
                            tab == SidebarTab::Links,
                        )
                        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                            ws_tab_links.update(cx, |this, cx| {
                                this.sidebar_tab = SidebarTab::Links;
                                cx.notify();
                            });
                        }),
                    ),
            )
            // Scrollable Sidebar Body
            .child(
                div()
                    .id("workspace-sidebar-scroll")
                    .flex_1()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .when(tab == SidebarTab::Files, |body| {
                        let docs = self.workspace_docs.clone();
                        body.child(
                            div()
                                .id("sidebar-btn-new-doc")
                                .mb_1()
                                .px_3()
                                .py_1p5()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border_hairline)
                                .bg(theme.surface_elevated)
                                .cursor_pointer()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.accent_primary)
                                .hover(|s| s.border_color(theme.accent_primary))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    ws_new_doc.update(cx, |this, cx| {
                                        this.create_blank_document(window, cx);
                                    });
                                })
                                .child("+ 新建空白笔记"),
                        )
                        .children(docs.into_iter().enumerate().map(move |(d_ix, meta)| {
                            let is_cur = meta.id == active_doc_id;
                            let doc_id_click = meta.id.clone();
                            let ws = ws_select_doc.clone();
                            div()
                                .id(("ws-doc-item", d_ix))
                                .px_2p5()
                                .py_2()
                                .rounded_lg()
                                .cursor_pointer()
                                .border_1()
                                .border_color(if is_cur {
                                    theme.accent_primary
                                } else {
                                    theme.sidebar_bg
                                })
                                .bg(if is_cur {
                                    theme.surface_elevated
                                } else {
                                    theme.sidebar_bg
                                })
                                .hover(|s| s.bg(theme.surface_elevated))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    let target_id = doc_id_click.clone();
                                    ws.update(cx, |this, cx| {
                                        this.select_workspace_document(&target_id, None, window, cx);
                                    });
                                })
                                .flex()
                                .flex_col()
                                .gap_0p5()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(if is_cur {
                                            FontWeight::BOLD
                                        } else {
                                            FontWeight::MEDIUM
                                        })
                                        .text_color(if is_cur {
                                            theme.accent_primary
                                        } else {
                                            theme.text_primary
                                        })
                                        .child(SharedString::from(meta.title)),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.text_muted)
                                        .child(SharedString::from(format!(
                                            "{} 字 · {} 块",
                                            meta.word_count, meta.block_count
                                        ))),
                                )
                        }))
                    })
                    .when(tab == SidebarTab::Outline, |body| {
                        body.when(outline.is_empty(), |b| {
                            b.child(
                                div()
                                    .p_3()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child("当前文档暂无标题章节（输入 # 一级标题 自动生成大纲）"),
                            )
                        })
                        .children(outline.into_iter().take(80).map(move |entry| {
                            let target_ed = editor_for_toc.clone();
                            let indent = ((entry.level.saturating_sub(1)) as f32) * 12.0;
                            let is_near = entry.block_index == active_block_ix;
                            div()
                                .id(("toc-item", entry.block_index))
                                .pl(px(8.0 + indent))
                                .pr_2()
                                .py_1p5()
                                .rounded_md()
                                .text_xs()
                                .font_weight(if entry.level == 1 {
                                    FontWeight::SEMIBOLD
                                } else {
                                    FontWeight::NORMAL
                                })
                                .text_color(if is_near {
                                    theme.accent_primary
                                } else {
                                    theme.text_secondary
                                })
                                .cursor_pointer()
                                .hover(|s| s.bg(theme.surface_elevated).text_color(theme.accent_primary))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    target_ed.update(cx, |ed, cx| {
                                        ed.cursor_byte = entry.byte_offset;
                                        ed.selection_bytes = entry.byte_offset..entry.byte_offset;
                                        ed.list_state.scroll_to_reveal_item(entry.block_index);
                                        window.focus(&ed.focus_handle);
                                        cx.notify();
                                    });
                                })
                                .child(SharedString::from(entry.text))
                        }))
                    })
                    .when(tab == SidebarTab::Links, |body| {
                        let ws_back = ws_link_nav.clone();
                        let ws_out = ws_link_nav.clone();
                        body.child(
                            div()
                                .pt_1()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_muted)
                                .child(SharedString::from(format!(
                                    "反向链接 ({})",
                                    backlinks.len()
                                ))),
                        )
                        .when(backlinks.is_empty(), |b| {
                            b.child(
                                div()
                                    .py_1()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child("暂无其他笔记引用本文档"),
                            )
                        })
                        .children(backlinks.into_iter().enumerate().map(move |(b_ix, bl)| {
                            let src_id = bl.source_doc_id.clone();
                            let ws = ws_back.clone();
                            div()
                                .id(("backlink-item", b_ix))
                                .p_2()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border_hairline)
                                .bg(theme.surface_elevated)
                                .cursor_pointer()
                                .hover(|s| s.border_color(theme.accent_primary))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    let id_cl = src_id.clone();
                                    ws.update(cx, |this, cx| {
                                        this.select_workspace_document(&id_cl, None, window, cx);
                                    });
                                })
                                .flex()
                                .flex_col()
                                .gap_0p5()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.accent_primary)
                                        .child(SharedString::from(format!("← {}", bl.source_title))),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.text_muted)
                                        .child(SharedString::from(bl.context_snippet)),
                                )
                        }))
                        .child(
                            div()
                                .pt_3()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_muted)
                                .child(SharedString::from(format!(
                                    "本文出链引用 ({})",
                                    outgoing.len()
                                ))),
                        )
                        .children(outgoing.into_iter().enumerate().map(move |(o_ix, ol)| {
                            let tgt = ol.target_title.clone();
                            let sec = ol.heading_anchor.clone();
                            let ws = ws_out.clone();
                            div()
                                .id(("outlink-item", o_ix))
                                .p_2()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border_hairline)
                                .bg(theme.surface_elevated)
                                .cursor_pointer()
                                .hover(|s| s.border_color(theme.accent_primary))
                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                    let t = tgt.clone();
                                    let s = sec.clone();
                                    ws.update(cx, |this, cx| {
                                        this.navigate_or_create_wikilink(
                                            &t,
                                            s.as_deref(),
                                            window,
                                            cx,
                                        );
                                    });
                                })
                                .text_xs()
                                .text_color(theme.accent_primary)
                                .child(SharedString::from(format!("↗ 《{}》", ol.target_title)))
                        }))
                    }),
            )
    }
}

impl Focusable for VellumWorkspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for VellumWorkspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.current_theme();
        let pdf_preset = self.pdf_preset;
        let (doc_title, metrics, current_mode, cursor_line) = {
            let surface = self.editor.read(cx);
            let clamped = surface.cursor_byte.min(surface.doc.len_bytes());
            let ln = surface.doc.rope().byte_to_line(clamped) + 1;
            (
                surface.doc.title.clone(),
                surface.doc.metrics(),
                surface.mode,
                ln,
            )
        };

        let ws_entity = cx.entity().clone();
        let ws_sidebar_btn = ws_entity.clone();
        let ws_new_btn = ws_entity.clone();
        let ws_theme_btn = ws_entity.clone();
        let ws_sw_cursor_btn = ws_entity.clone();
        let editor_for_mode = self.editor.clone();

        let container_max_w = if current_mode == EditorMode::SplitPreview {
            px(1380.0)
        } else {
            theme.width_preset.max_width_px()
        };

        div()
            .id("vellum-workspace-root")
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(theme.canvas_bg)
            .text_color(theme.text_primary)
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                this.last_mouse_pos = Some(event.position);
                if this.software_cursor_enabled {
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &OpenLocalMarkdownFile, _, cx| {
                this.prompt_open_file(cx);
            }))
            .on_action(cx.listener(|this, _: &NewWorkspaceDocument, window, cx| {
                this.create_blank_document(window, cx);
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
            .on_action(cx.listener(|this, _: &ToggleDarkTheme, _, cx| {
                this.is_dark = !this.is_dark;
                let dark = this.is_dark;
                this.editor.update(cx, |ed, cx| {
                    ed.theme_override_dark = Some(dark);
                    cx.notify();
                });
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleSoftwareCursor, _, cx| {
                this.software_cursor_enabled = !this.software_cursor_enabled;
                this.status_notice = if this.software_cursor_enabled {
                    "已开启 GPU 原生鼠标指针兜底渲染（解决部分 Linux Wayland 驱动隐藏硬件光标问题）".to_string()
                } else {
                    "已切换回系统硬件鼠标指针".to_string()
                };
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &AppendAtDocumentEnd, window, cx| {
                this.active_surface = WorkspaceSurface::Editor;
                this.editor.update(cx, |ed, cx| {
                    ed.append_or_focus_document_end(window, cx);
                });
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
            .on_action(cx.listener(|this, _: &ToggleSplitMode, _, cx| {
                this.active_surface = WorkspaceSurface::Editor;
                this.editor.update(cx, |ed, cx| {
                    ed.mode = if ed.mode == EditorMode::SplitPreview {
                        EditorMode::InstantWysiwyg
                    } else {
                        EditorMode::SplitPreview
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
                this.editor
                    .update(cx, |ed, cx| ed.toggle_inline_delimiter("**", cx));
            }))
            .on_action(cx.listener(|this, _: &FormatItalic, _, cx| {
                this.editor
                    .update(cx, |ed, cx| ed.toggle_inline_delimiter("*", cx));
            }))
            .on_action(cx.listener(|this, _: &FormatInlineCode, _, cx| {
                this.editor
                    .update(cx, |ed, cx| ed.toggle_inline_delimiter("`", cx));
            }))
            .on_action(cx.listener(|this, _: &UndoEdit, _, cx| {
                this.editor.update(cx, |ed, cx| {
                    if let Some(pos) = ed.doc.undo() {
                        ed.cursor_byte = pos;
                        ed.selection_bytes = pos..pos;
                        ed.refresh_list_state();
                        cx.notify();
                    }
                });
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &RedoEdit, _, cx| {
                this.editor.update(cx, |ed, cx| {
                    if let Some(pos) = ed.doc.redo() {
                        ed.cursor_byte = pos;
                        ed.selection_bytes = pos..pos;
                        ed.refresh_list_state();
                        cx.notify();
                    }
                });
                cx.notify();
            }))
            // Row 1: Primary Native Workspace Header Bar
            .child(
                div()
                    .h(px(46.0))
                    .px_4()
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
                            .gap_3()
                            .child(
                                div()
                                    .id("btn-toggle-sidebar")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .bg(theme.sidebar_bg)
                                    .text_xs()
                                    .text_color(theme.text_secondary)
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        ws_sidebar_btn.update(cx, |this, cx| {
                                            this.show_sidebar = !this.show_sidebar;
                                            cx.notify();
                                        });
                                    })
                                    .child(if self.show_sidebar { "收起侧栏" } else { "展开侧栏" }),
                            )
                            .child(
                                div()
                                    .font_weight(FontWeight::BOLD)
                                    .child(SharedString::from(doc_title)),
                            )
                            .child(
                                div()
                                    .id("btn-new-md")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .text_xs()
                                    .text_color(theme.accent_primary)
                                    .hover(|s| s.bg(theme.sidebar_bg))
                                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                        ws_new_btn.update(cx, |this, cx| {
                                            this.create_blank_document(window, cx);
                                        });
                                    })
                                    .child("+ 新建"),
                            )
                            .child(
                                div()
                                    .id("btn-open-md")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .text_xs()
                                    .text_color(theme.text_secondary)
                                    .hover(|s| s.bg(theme.sidebar_bg))
                                    .on_mouse_down(MouseButton::Left, {
                                        let ws = ws_entity.clone();
                                        move |_, _, cx| {
                                            ws.update(cx, |this, cx| this.prompt_open_file(cx));
                                        }
                                    })
                                    .child("打开文件"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            // Surface Switcher: Kanban & Graph
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
                                            rgb(0xffffff)
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
                                        "返回编辑"
                                    } else {
                                        "任务看板"
                                    }),
                            )
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
                                            rgb(0xffffff)
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
                                            "返回编辑"
                                        } else {
                                            "知识图谱"
                                        },
                                    ),
                            )
                            // 3-Mode Editor Switcher (`即时渲染` · `分栏` · `源码`)
                            .child(
                                div()
                                    .p_0p5()
                                    .rounded_md()
                                    .border_1()
                                    .border_color(theme.border_hairline)
                                    .bg(theme.sidebar_bg)
                                    .flex()
                                    .items_center()
                                    .gap_0p5()
                                    .children(
                                        [
                                            ("mode-wysiwyg", "即时渲染", EditorMode::InstantWysiwyg),
                                            ("mode-split", "分栏对比", EditorMode::SplitPreview),
                                            ("mode-source", "源码", EditorMode::SourceCode),
                                        ]
                                        .into_iter()
                                        .map(|(m_id, m_label, target_m)| {
                                            let is_m = self.active_surface
                                                == WorkspaceSurface::Editor
                                                && current_mode == target_m;
                                            let ws = ws_entity.clone();
                                            let ed = editor_for_mode.clone();
                                            div()
                                                .id(m_id)
                                                .cursor_pointer()
                                                .px_2()
                                                .py_0p5()
                                                .rounded_sm()
                                                .bg(if is_m {
                                                    theme.surface_elevated
                                                } else {
                                                    theme.sidebar_bg
                                                })
                                                .font_weight(if is_m {
                                                    FontWeight::SEMIBOLD
                                                } else {
                                                    FontWeight::NORMAL
                                                })
                                                .text_color(if is_m {
                                                    theme.accent_primary
                                                } else {
                                                    theme.text_secondary
                                                })
                                                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                                    ws.update(cx, |this, cx| {
                                                        this.active_surface = WorkspaceSurface::Editor;
                                                        cx.notify();
                                                    });
                                                    ed.update(cx, |surface, cx| {
                                                        surface.mode = target_m;
                                                        window.focus(&surface.focus_handle);
                                                        cx.notify();
                                                    });
                                                })
                                                .child(m_label)
                                        }),
                                    ),
                            )
                            // Theme Toggle (`浅色` / `深色`)
                            .child(
                                div()
                                    .id("btn-theme-toggle")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .bg(theme.sidebar_bg)
                                    .text_color(theme.text_secondary)
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        ws_theme_btn.update(cx, |this, cx| {
                                            this.is_dark = !this.is_dark;
                                            let dark = this.is_dark;
                                            this.editor.update(cx, |ed, cx| {
                                                ed.theme_override_dark = Some(dark);
                                                cx.notify();
                                            });
                                            cx.notify();
                                        });
                                    })
                                    .child(if self.is_dark { "浅色" } else { "深色" }),
                            )
                            // PDF Preset & Export
                            .child(
                                div()
                                    .id("btn-pdf-preset")
                                    .cursor_pointer()
                                    .px_2()
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
                                        FormalPdfPreset::TechnicalSpec => "版式: 白皮书",
                                        FormalPdfPreset::OfficialReport => "版式: 公文",
                                        FormalPdfPreset::AcademicPaper => "版式: 学术",
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
                                    .text_color(rgb(0xffffff))
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        ws_entity
                                            .update(cx, |this, cx| this.save_active_document(cx));
                                    })
                                    .child("保存"),
                            ),
                    ),
            )
            // Row 2: Rich WYSIWYG Formatting Toolbar (shown when Editor surface is active)
            .when(self.active_surface == WorkspaceSurface::Editor, |root| {
                root.child(self.render_formatting_bar(theme, cx))
            })
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
                        body.child(self.render_sidebar(theme, cx))
                    })
                    .child(
                        div()
                            .flex_1()
                            .h_full()
                            .flex()
                            .justify_center()
                            .px_8()
                            .pt_5()
                            .child(
                                div()
                                    .w_full()
                                    .max_w(container_max_w)
                                    .h_full()
                                    .child(self.editor.clone()),
                            ),
                    ),
            })
            // Quiet Document Metrics & Cursor Diagnostics Bar
            .child(
                div()
                    .h(px(28.0))
                    .px_4()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_color(theme.border_hairline)
                    .bg(theme.surface_elevated)
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(SharedString::from(format!(
                        "第 {} 行 · {} 字 · {} 块 · 预计阅读 {} 分钟 · Rope 内存 {:.1} KB",
                        cursor_line,
                        metrics.word_count,
                        metrics.block_count,
                        metrics.reading_minutes,
                        metrics.estimated_ram_bytes as f64 / 1024.0
                    )))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_4()
                            .child(SharedString::from(self.status_notice.clone()))
                            .child(
                                div()
                                    .id("btn-sw-cursor")
                                    .cursor_pointer()
                                    .hover(|s| s.text_color(theme.accent_primary))
                                    .text_color(if self.software_cursor_enabled {
                                        theme.accent_primary
                                    } else {
                                        theme.text_muted
                                    })
                                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                                        ws_sw_cursor_btn.update(cx, |this, cx| {
                                            this.software_cursor_enabled =
                                                !this.software_cursor_enabled;
                                            cx.notify();
                                        });
                                    })
                                    .child(if self.software_cursor_enabled {
                                        "指针: GPU兜底 (已开启)"
                                    } else {
                                        "看不到系统鼠标? 点此开启GPU指针 (Ctrl+Alt+M)"
                                    }),
                            ),
                    ),
            )
            // Optional GPU Software Mouse Pointer Overlay (for Wayland/NVIDIA drivers with broken hw cursor planes)
            .when(self.software_cursor_enabled, |root| {
                if let Some(pos) = self.last_mouse_pos {
                    root.child(
                        div()
                            .absolute()
                            .left(pos.x + px(3.0))
                            .top(pos.y + px(3.0))
                            .px_1()
                            .rounded_sm()
                            .bg(theme.accent_primary)
                            .border_1()
                            .border_color(rgb(0xffffff))
                            .text_xs()
                            .font_weight(FontWeight::BOLD)
                            .text_color(rgb(0xffffff))
                            .child("↖"),
                    )
                } else {
                    root
                }
            })
    }
}

fn scan_workspace_directory(
    workspace_dir: &PathBuf,
    graph_index: &mut KnowledgeGraphIndex,
) -> Vec<WorkspaceDocMeta> {
    let mut entries = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(workspace_dir) else {
        return entries;
    };

    for item in read_dir.flatten() {
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let id = stem.to_string();
                if let Ok(doc) = RopeDocument::open_streaming(&id, &path) {
                    let m = doc.metrics();
                    graph_index.upsert_document(&doc);
                    entries.push(WorkspaceDocMeta {
                        id,
                        title: doc.title,
                        path,
                        word_count: m.word_count,
                        block_count: m.block_count,
                    });
                }
            }
        }
    }

    entries.sort_by(|a, b| a.id.cmp(&b.id));
    entries
}

fn upsert_doc_meta(
    list: &mut Vec<WorkspaceDocMeta>,
    doc: &RopeDocument,
    workspace_dir: &PathBuf,
) {
    let m = doc.metrics();
    let path = doc
        .file_path
        .clone()
        .unwrap_or_else(|| workspace_dir.join(format!("{}.md", doc.id)));

    if let Some(existing) = list.iter_mut().find(|d| d.id == doc.id) {
        existing.title = doc.title.clone();
        existing.path = path;
        existing.word_count = m.word_count;
        existing.block_count = m.block_count;
    } else {
        list.push(WorkspaceDocMeta {
            id: doc.id.clone(),
            title: doc.title.clone(),
            path,
            word_count: m.word_count,
            block_count: m.block_count,
        });
    }
}
