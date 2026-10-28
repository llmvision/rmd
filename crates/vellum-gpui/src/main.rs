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
    App, Application, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, px, size,
};
use std::{net::SocketAddr, path::PathBuf};
use vellum_core::RopeDocument;
use workspace::{
    CycleFormalPdfPreset, ExportFormalPdf, FormatBold, FormatInlineCode, FormatItalic,
    OpenLocalMarkdownFile, RedoEdit, SaveCurrentDocument, ToggleFocusMode, ToggleKanbanBoard,
    ToggleKnowledgeGraph, ToggleOutlineSidebar, ToggleSourceMode, ToggleTypewriterMode, UndoEdit,
    VellumWorkspace,
};

const DEFAULT_WELCOME_MD: &str = r#"# Vellum Native — 本地所见即所得 Markdown 编辑器

> [!NOTE]
> 基于 **Rust + GPUI + Ropey + Axum** 纯原生 GPU 管线构建（零 WebView、零 Electron、零 HTML DOM）。支持十万字级大型 Markdown 文档低内存流式加载与 120 FPS 视口虚拟化编辑。

## 核心交互快捷键

- 输入 `# ` ~ `###### ` 立即转化为对应级别标题，紧接着按退格或 `Cmd/Ctrl + Z` 还原原始字符
- 在空行输入 `/` 唤起命令面板（支持中文与拼音首字母，如 `/bg` 插入表格、`/dm` 插入代码块）
- 按 `Cmd/Ctrl + /` 在 **即时渲染（WYSIWYG）** 与 **源码模式** 之间无损切换
- 按 `Cmd/Ctrl + Shift + K` 切换至 **GPUI 原生任务看板**，拖拽卡片直接改写 `Rope` 中的 `[ ]` / `[x]`
- 按 `Cmd/Ctrl + Shift + E` 直接导出 **正式文档版式矢量 PDF**（支持技术规范白皮书、企事业公文、学术单栏手稿）

## 任务清单演示（可按 Cmd/Ctrl + Shift + K 进入原生看板拖拽）

- [x] `ropey::Rope` 64 KiB 分块流式加载与零拷贝往返保真序列化
- [x] `EntityInputHandler` 原生中文拼音 IME 组合态保护（选词期间不误触发输入规则）
- [x] 嵌入式 `Axum` 本地原子持久化服务（`127.0.0.1:4120/api/v1`）
- [x] `KnowledgeGraphIndex` 双向链接、章节引用与全库重命名重构
- [x] `krilla` 纯 Rust 离线矢量正式版式 PDF 引擎（双文头线、受控元信息表、目录、三线表与页眉页脚）
- [ ] Phase 2 基于 `Yrs (CRDT)` 的多端实时协同与增量云备份
- [ ] 原生 Wasm 插件权限沙箱体系
"#;

fn spawn_background_axum_daemon(port: u16) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("Failed to initialize background Tokio runtime for Axum");

        rt.block_on(async move {
            let workspace_dir = std::env::var("VELLUM_WORKSPACE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("./workspace-docs"));
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            if let Err(err) = vellum_server::run_axum_server(workspace_dir, addr).await {
                tracing::warn!("Embedded Axum server exited: {}", err);
            }
        });
    });
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("vellum=info,vellum_server=info")
        .init();

    let axum_port: u16 = 4120;
    spawn_background_axum_daemon(axum_port);

    Application::new().run(move |cx: &mut App| {
        cx.bind_keys([
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
            KeyBinding::new("cmd-shift-k", ToggleKanbanBoard, None),
            KeyBinding::new("ctrl-shift-k", ToggleKanbanBoard, None),
            KeyBinding::new("cmd-shift-g", ToggleKnowledgeGraph, None),
            KeyBinding::new("ctrl-shift-g", ToggleKnowledgeGraph, None),
            KeyBinding::new("cmd-\\", ToggleOutlineSidebar, None),
            KeyBinding::new("ctrl-\\", ToggleOutlineSidebar, None),
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

        let initial_doc = if let Some(cli_path) = std::env::args().nth(1) {
            RopeDocument::open_streaming("cli-file", &cli_path).unwrap_or_else(|_| {
                RopeDocument::from_markdown_str("welcome", "欢迎使用 Vellum", DEFAULT_WELCOME_MD)
            })
        } else {
            RopeDocument::from_markdown_str("welcome", "欢迎使用 Vellum", DEFAULT_WELCOME_MD)
        };

        let bounds = Bounds::centered(None, size(px(1360.0), px(860.0)), cx);
        let _ = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                app_id: Some("dev.vellum.markdown".to_string()),
                titlebar: Some(TitlebarOptions {
                    title: Some("Vellum — 本地所见即所得 Markdown 编辑器".into()),
                    appears_transparent: cfg!(target_os = "macos"),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |_, cx| cx.new(|cx| VellumWorkspace::new(initial_doc, axum_port, cx)),
        );
    });
}
