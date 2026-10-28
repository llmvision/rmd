//! `vellum-core`: Low-memory, zero-copy Rope & Incremental CommonMark/GFM WYSIWYG Kernel.
//!
//! Designed for sub-millisecond keystroke latency and minimal resident memory on 100k–1M+ word
//! Markdown files, powering both the native `vellum-gpui` desktop app and `vellum-server` (Axum).

pub mod fenwick_viewport;
pub mod incremental_ast;
pub mod input_rules;
pub mod kanban;
pub mod knowledge_graph;
pub mod pdf_export;
pub mod rope_doc;
pub mod sync_protocol;
pub mod table_model;

pub use fenwick_viewport::{FenwickHeightIndex, VisibleBlockRange};
pub use incremental_ast::{
    BlockDescriptor, BlockKind, ColumnAlign, InlineSpan, InlineStyleKind, OutlineEntry,
};
pub use input_rules::{InputRuleMatch, UndoEntry, UndoKind};
pub use kanban::{KanbanBoardModel, KanbanColumn, KanbanTaskCard};
pub use knowledge_graph::{
    BacklinkEntry, GraphEdge, GraphNode, KnowledgeGraphIndex, KnowledgeGraphSnapshot,
    OutgoingLink, ReferenceKind, UnlinkedMention,
};
pub use pdf_export::{FontBundle, FormalPdfOptions, FormalPdfPreset, PaperSize};
pub use rope_doc::{DocumentMetrics, LineEnding, RopeDocument, SearchMatch};
pub use sync_protocol::{BlockDeltaPatch, SyncStateVector, SyncTransport};
pub use table_model::GfmTableModel;
