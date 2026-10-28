//! `vellum`: Native GPU-accelerated local WYSIWYG Markdown desktop application.
//!
//! Architecture:
//! - UI & 120 FPS Text Shaping: `gpui` (Metal on macOS, DirectX on Windows, Vulkan/Blade on Linux)
//! - Document Buffer & Incremental AST: `vellum-core` (`ropey::Rope` + `pulldown-cmark` SIMD)
//! - Local Persistence & Sync-Ready API: `vellum-server` (`axum` embedded on `127.0.0.1:4120`)

mod code_highlighter;
mod graph_canvas;
mod kanban_board;
mod slash_palette;
mod theme;
mod workspace;
mod wysiwyg_surface;

use gpui::{
    App, AppContext, Application, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions,
    px, size,
};
use std::{net::SocketAddr, path::PathBuf};
use vellum_core::RopeDocument;
use workspace::{
    AppendAtDocumentEnd, CycleFormalPdfPreset, ExportFormalPdf, FormatBold, FormatInlineCode,
    FormatItalic, NewWorkspaceDocument, OpenLocalMarkdownFile, RedoEdit, SaveCurrentDocument,
    ToggleDarkTheme, ToggleFocusMode, ToggleKanbanBoard, ToggleKnowledgeGraph,
    ToggleOutlineSidebar, ToggleSoftwareCursor, ToggleSourceMode, ToggleSplitMode,
    ToggleTypewriterMode, UndoEdit, VellumWorkspace,
};
use wysiwyg_surface::{
    EditorBackspace, EditorCopy, EditorCut, EditorDeleteForward, EditorEnter, EditorEscape,
    EditorIndent, EditorMoveDocEnd, EditorMoveDocStart, EditorMoveDown, EditorMoveLeft,
    EditorMoveLineEnd, EditorMoveLineStart, EditorMoveRight, EditorMoveUp, EditorOutdent,
    EditorPaste, EditorSelectAll, EditorSelectLeft, EditorSelectRight, EditorSoftNewline,
};

const SEED_PLAYGROUND_MD: &str = r#"# 快速上手与所见即所得演练场

> [!NOTE]
> 欢迎体验 **Vellum Native** 本地所见即所得 Markdown 编辑器。直接点击任意段落即可在光标处（蓝色竖线 `▏`）实时输入，移开光标后自动隐藏 `**`、`` ` ``、`[[` 等语法噪音；点击**文档最下方空白区**或顶部「**+ 在文末续写**」即可随时在文末追加内容。

## 1. 所见即所得行内与块级排版演示

- **即时富文本样式**：支持 **粗体强调**、*斜体术语*、~~已完成删除线~~、==重点荧光高亮==、行内代码 `ropey::Rope` 与行内公式 $O(\log N)$。
- **双向知识网络**：支持直接点击跳转 [[Rust + Axum + GPUI 高性能架构白皮书]]，或在侧栏「双链」面板查看所有反向引用。
- **输入规则与斜杠面板**：在空行输入 `/` 即可唤起中文/拼音斜杠菜单（如 `/bg` 插入表格、`/dm` 插入代码块），按 `Enter` 立即插入。

![[Rust + Axum + GPUI 高性能架构白皮书#核心架构分层]]

> [!TIP]
> 在任务清单或普通列表中按一次 `Enter` 会自动续写下一项；在空白列表项上再按一次 `Enter` 即可退回普通正文段落！

| 常用操作 | Linux / Windows | macOS |
| :--- | :--- | :--- |
| 即时渲染 / 源码模式切换 | `Ctrl + /` | `Cmd + /` |
| 分栏实时对比视图 | `Ctrl + Shift + \` | `Cmd + Shift + \` |
| 原生拖拽任务看板 | `Ctrl + Shift + K` | `Cmd + Shift + K` |
| 正式文档版式矢量 PDF 导出 | `Ctrl + Shift + E` | `Cmd + Shift + E` |
| 跳至文末续写新段落 | `Ctrl + Shift + Enter` | `Cmd + Shift + Enter` |

## 2. 交互式待办清单（点击方框切换状态，点击文字直接编辑）

- [x] `ropey::Rope` 64 KiB 分块流式加载与零拷贝保真写盘
- [x] 原生所见即所得富文本排版（标题、提示块、三线表格、代码块、双链卡片）
- [x] Linux Wayland `XCURSOR_THEME` 自动探测与 GPU 软件指针兜底（`Ctrl + Alt + M`）
- [ ] 点击本行末尾并按两次 `Enter`，或直接在下方光标处开始续写新段落

"#;

const SEED_ARCH_WHITE_PAPER_MD: &str = r#"---
doc_code: VN-ARCH-2026
status: Production
engine: GPUI 0.2.2 + Ropey + Krilla
---

# Rust + Axum + GPUI 高性能架构白皮书

> [!IMPORTANT]
> 本系统完全摒弃 Electron / WebView / HTML DOM，采用 **GPUI 原生 GPU 着色管线 + Ropey B-Tree 文本绳 + Krilla 纯 Rust 矢量 PDF 引擎** 构建。

## 核心架构分层

```mermaid
graph LR
  A[Markdown 磁盘流] --> B[Ropey B-Tree 缓冲]
  B --> C[Pulldown-Cmark 增量索引]
  C --> D[GPUI 120FPS 视口渲染]
  B --> E[Krilla 正式矢量 PDF]
```

1. **缓冲与增量索引层 (`vellum-core`)**：所有编辑操作以 $O(\log N)$ 字节范围直写 `Rope`，仅重解析脏块邻域。
2. **原生 GPU 视图层 (`vellum-gpui`)**：按视口懒加载渲染活动块语法标记与非活动块纯净排版，参考 [[快速上手与所见即所得演练场]]。
3. **本地守护服务层 (`vellum-server`)**：嵌入式 `Axum` 监听 `127.0.0.1:4120`，通过临时文件原子重命名保障断电零损坏。

```rust
pub fn append_at_eof(doc: &mut RopeDocument, text: &str) -> anyhow::Result<usize> {
    let eof = doc.len_bytes();
    doc.edit_byte_range(eof..eof, text, true)
}
```
"#;

const BUILTIN_BUILD_DOC: &str = include_str!("../../../docs/BUILD_AND_DEPLOYMENT.md");
const BUILTIN_API_DOC: &str = include_str!("../../../docs/ARCHITECTURE_AND_API.md");

static TOKIO_RUNTIME_HANDLE: std::sync::OnceLock<tokio::runtime::Handle> =
    std::sync::OnceLock::new();

pub fn tokio_handle() -> Option<&'static tokio::runtime::Handle> {
    TOKIO_RUNTIME_HANDLE.get()
}

/// Ensures Linux Wayland/X11 sessions always have valid `XCURSOR_THEME`, `XCURSOR_SIZE`, and
/// `XCURSOR_PATH` environment variables BEFORE GPUI initializes its Wayland/X11 display connection.
///
/// Must be called at the very start of `main()` while the process is strictly single-threaded.
/// Returns `true` if a valid system cursor theme directory was found on disk (so software cursor
/// fallback stays off by default), or `false` if no cursor theme exists on disk.
fn configure_linux_cursor_environment() -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("VELLUM_FORCE_X11").ok().as_deref() == Some("1") {
            // SAFETY: Single-threaded startup prior to spawning Tokio or GPUI threads.
            unsafe {
                std::env::remove_var("WAYLAND_DISPLAY");
            }
        }

        if std::env::var("VELLUM_SW_CURSOR").ok().as_deref() == Some("1") {
            return false;
        }

        if std::env::var_os("XCURSOR_SIZE").is_none() {
            // SAFETY: Called at line 1 of `main()` before any background threads are spawned.
            unsafe {
                std::env::set_var("XCURSOR_SIZE", "24");
            }
        }

        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        let search_dirs = [
            PathBuf::from("/usr/share/icons"),
            PathBuf::from("/usr/local/share/icons"),
            PathBuf::from("/usr/share/pixmaps"),
            PathBuf::from(format!("{}/.local/share/icons", home)),
            PathBuf::from(format!("{}/.icons", home)),
        ];

        if std::env::var_os("XCURSOR_PATH").is_none() {
            let joined = search_dirs
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(":");
            // SAFETY: Single-threaded startup prior to spawning Tokio or GPUI threads.
            unsafe {
                std::env::set_var("XCURSOR_PATH", joined);
            }
        }

        let has_pointer_bitmaps = |c_dir: &std::path::Path| -> bool {
            c_dir.is_dir() && (c_dir.join("left_ptr").exists() || c_dir.join("default").exists())
        };

        let has_valid_cursor_theme = |theme_name: &str| -> bool {
            search_dirs
                .iter()
                .any(|base| has_pointer_bitmaps(&base.join(theme_name).join("cursors")))
        };

        if let Ok(existing_theme) = std::env::var("XCURSOR_THEME") {
            if !existing_theme.trim().is_empty() && has_valid_cursor_theme(existing_theme.trim()) {
                return true;
            }
        }

        // Probe common Ubuntu / GNOME / KDE / Debian / Arch cursor themes in priority order
        let preferred_themes = [
            "Adwaita",
            "Yaru",
            "DMZ-White",
            "breeze_cursors",
            "Breeze_Light",
            "Bibata-Modern-Classic",
            "DMZ-Black",
            "Oxygen_White",
            "whiteglass",
            "handhelds",
            "default",
        ];

        for candidate in preferred_themes {
            if has_valid_cursor_theme(candidate) {
                // SAFETY: Single-threaded startup prior to spawning Tokio or GPUI threads.
                unsafe {
                    std::env::set_var("XCURSOR_THEME", candidate);
                }
                return true;
            }
        }

        // Fallback scan: pick any installed icon pack directory that contains valid pointer bitmaps
        for base in &search_dirs {
            if let Ok(entries) = std::fs::read_dir(base) {
                for entry in entries.flatten() {
                    if has_pointer_bitmaps(&entry.path().join("cursors")) {
                        if let Some(name) = entry.file_name().to_str() {
                            // SAFETY: Single-threaded startup prior to spawning Tokio or GPUI threads.
                            unsafe {
                                std::env::set_var("XCURSOR_THEME", name);
                            }
                            return true;
                        }
                    }
                }
            }
        }

        false
    }

    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Seeds `./workspace-docs` with rich interconnected showcase & engineering docs on first launch
/// so local GPUI runs match the multi-document WYSIWYG workspace out of the box.
fn ensure_local_workspace_seeded(workspace_dir: &PathBuf) {
    let _ = std::fs::create_dir_all(workspace_dir);
    let seed_files = [
        ("01-interactive-playground.md", SEED_PLAYGROUND_MD),
        ("02-rust-axum-gpui-arch.md", SEED_ARCH_WHITE_PAPER_MD),
        ("03-build-and-deployment.md", BUILTIN_BUILD_DOC),
        ("04-architecture-and-api.md", BUILTIN_API_DOC),
    ];

    for (filename, content) in seed_files {
        let target = workspace_dir.join(filename);
        if !target.exists() {
            let _ = std::fs::write(&target, content.as_bytes());
        }
    }
}

fn spawn_background_axum_daemon(workspace_dir: PathBuf, port: u16) {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("Failed to initialize background Tokio runtime for Axum");

        let _ = TOKIO_RUNTIME_HANDLE.set(rt.handle().clone());
        let _ = ready_tx.send(());

        rt.block_on(async move {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            if let Err(err) = vellum_server::run_axum_server(workspace_dir, addr).await {
                tracing::warn!("Embedded Axum server exited: {}", err);
            }
        });
    });
    let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(2));
}

fn main() {
    // 1. Must run BEFORE any threads spawn so Wayland/X11 cursor env vars are visible to GPUI
    let found_system_cursor_theme = configure_linux_cursor_environment();

    tracing_subscriber::fmt()
        .with_env_filter("vellum=info,vellum_server=info")
        .init();

    let workspace_dir = std::env::var("VELLUM_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./workspace-docs"));
    ensure_local_workspace_seeded(&workspace_dir);

    let axum_port: u16 = 4120;
    spawn_background_axum_daemon(workspace_dir.clone(), axum_port);

    let default_sw_cursor = !found_system_cursor_theme;

    Application::new().run(move |cx: &mut App| {
        cx.bind_keys([
            // Core Editor Navigation & Text Mutation Keys (`WysiwygEditor` context)
            KeyBinding::new("backspace", EditorBackspace, Some("WysiwygEditor")),
            KeyBinding::new("shift-backspace", EditorBackspace, Some("WysiwygEditor")),
            KeyBinding::new("delete", EditorDeleteForward, Some("WysiwygEditor")),
            KeyBinding::new("enter", EditorEnter, Some("WysiwygEditor")),
            KeyBinding::new("shift-enter", EditorSoftNewline, Some("WysiwygEditor")),
            KeyBinding::new("tab", EditorIndent, Some("WysiwygEditor")),
            KeyBinding::new("shift-tab", EditorOutdent, Some("WysiwygEditor")),
            KeyBinding::new("left", EditorMoveLeft, Some("WysiwygEditor")),
            KeyBinding::new("right", EditorMoveRight, Some("WysiwygEditor")),
            KeyBinding::new("shift-left", EditorSelectLeft, Some("WysiwygEditor")),
            KeyBinding::new("shift-right", EditorSelectRight, Some("WysiwygEditor")),
            KeyBinding::new("up", EditorMoveUp, Some("WysiwygEditor")),
            KeyBinding::new("down", EditorMoveDown, Some("WysiwygEditor")),
            KeyBinding::new("home", EditorMoveLineStart, Some("WysiwygEditor")),
            KeyBinding::new("end", EditorMoveLineEnd, Some("WysiwygEditor")),
            KeyBinding::new("cmd-left", EditorMoveLineStart, Some("WysiwygEditor")),
            KeyBinding::new("cmd-right", EditorMoveLineEnd, Some("WysiwygEditor")),
            KeyBinding::new("ctrl-home", EditorMoveDocStart, Some("WysiwygEditor")),
            KeyBinding::new("ctrl-end", EditorMoveDocEnd, Some("WysiwygEditor")),
            KeyBinding::new("cmd-up", EditorMoveDocStart, Some("WysiwygEditor")),
            KeyBinding::new("cmd-down", EditorMoveDocEnd, Some("WysiwygEditor")),
            KeyBinding::new("cmd-a", EditorSelectAll, Some("WysiwygEditor")),
            KeyBinding::new("ctrl-a", EditorSelectAll, Some("WysiwygEditor")),
            KeyBinding::new("cmd-c", EditorCopy, Some("WysiwygEditor")),
            KeyBinding::new("ctrl-c", EditorCopy, Some("WysiwygEditor")),
            KeyBinding::new("cmd-x", EditorCut, Some("WysiwygEditor")),
            KeyBinding::new("ctrl-x", EditorCut, Some("WysiwygEditor")),
            KeyBinding::new("cmd-v", EditorPaste, Some("WysiwygEditor")),
            KeyBinding::new("ctrl-v", EditorPaste, Some("WysiwygEditor")),
            KeyBinding::new("escape", EditorEscape, Some("WysiwygEditor")),
            // Global Workspace Shortcuts
            KeyBinding::new("cmd-n", NewWorkspaceDocument, None),
            KeyBinding::new("ctrl-n", NewWorkspaceDocument, None),
            KeyBinding::new("cmd-o", OpenLocalMarkdownFile, None),
            KeyBinding::new("ctrl-o", OpenLocalMarkdownFile, None),
            KeyBinding::new("cmd-s", SaveCurrentDocument, None),
            KeyBinding::new("ctrl-s", SaveCurrentDocument, None),
            KeyBinding::new("cmd-shift-e", ExportFormalPdf, None),
            KeyBinding::new("ctrl-shift-e", ExportFormalPdf, None),
            KeyBinding::new("cmd-alt-p", CycleFormalPdfPreset, None),
            KeyBinding::new("ctrl-alt-p", CycleFormalPdfPreset, None),
            KeyBinding::new("cmd-/", ToggleSourceMode, None),
            KeyBinding::new("ctrl-/", ToggleSourceMode, None),
            KeyBinding::new("cmd-shift-\\", ToggleSplitMode, None),
            KeyBinding::new("ctrl-shift-\\", ToggleSplitMode, None),
            KeyBinding::new("cmd-shift-k", ToggleKanbanBoard, None),
            KeyBinding::new("ctrl-shift-k", ToggleKanbanBoard, None),
            KeyBinding::new("cmd-shift-g", ToggleKnowledgeGraph, None),
            KeyBinding::new("ctrl-shift-g", ToggleKnowledgeGraph, None),
            KeyBinding::new("cmd-\\", ToggleOutlineSidebar, None),
            KeyBinding::new("ctrl-\\", ToggleOutlineSidebar, None),
            KeyBinding::new("cmd-shift-d", ToggleDarkTheme, None),
            KeyBinding::new("ctrl-shift-d", ToggleDarkTheme, None),
            KeyBinding::new("ctrl-alt-m", ToggleSoftwareCursor, None),
            KeyBinding::new("cmd-shift-enter", AppendAtDocumentEnd, None),
            KeyBinding::new("ctrl-shift-enter", AppendAtDocumentEnd, None),
            KeyBinding::new("cmd-b", FormatBold, None),
            KeyBinding::new("ctrl-b", FormatBold, None),
            KeyBinding::new("cmd-i", FormatItalic, None),
            KeyBinding::new("ctrl-i", FormatItalic, None),
            KeyBinding::new("cmd-e", FormatInlineCode, None),
            KeyBinding::new("ctrl-e", FormatInlineCode, None),
            KeyBinding::new("cmd-z", UndoEdit, None),
            KeyBinding::new("ctrl-z", UndoEdit, None),
            KeyBinding::new("cmd-shift-z", RedoEdit, None),
            KeyBinding::new("ctrl-y", RedoEdit, None),
            KeyBinding::new("ctrl-shift-f", ToggleFocusMode, None),
            KeyBinding::new("ctrl-shift-t", ToggleTypewriterMode, None),
        ]);

        let default_playground_path = workspace_dir.join("01-interactive-playground.md");
        let initial_doc = if let Some(cli_path) = std::env::args().nth(1) {
            RopeDocument::open_streaming("cli-file", &cli_path).unwrap_or_else(|_| {
                RopeDocument::from_markdown_str(
                    "01-interactive-playground",
                    "快速上手与所见即所得演练场",
                    SEED_PLAYGROUND_MD,
                )
            })
        } else {
            RopeDocument::open_streaming("01-interactive-playground", &default_playground_path)
                .unwrap_or_else(|_| {
                    RopeDocument::from_markdown_str(
                        "01-interactive-playground",
                        "快速上手与所见即所得演练场",
                        SEED_PLAYGROUND_MD,
                    )
                })
        };

        let ws_dir_for_window = workspace_dir.clone();
        let bounds = Bounds::centered(None, size(px(1400.0), px(880.0)), cx);
        let _ = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                app_id: Some("dev.vellum.markdown".to_string()),
                titlebar: Some(TitlebarOptions {
                    title: Some("Vellum Native — 本地所见即所得 Markdown 工作台".into()),
                    appears_transparent: cfg!(target_os = "macos"),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |window, cx| {
                let ws = cx.new(|cx| {
                    VellumWorkspace::new(
                        ws_dir_for_window,
                        initial_doc,
                        axum_port,
                        default_sw_cursor,
                        cx,
                    )
                });
                let editor_focus = ws.read(cx).editor.read(cx).focus_handle.clone();
                window.focus(&editor_focus);
                ws
            },
        );
    });
}
