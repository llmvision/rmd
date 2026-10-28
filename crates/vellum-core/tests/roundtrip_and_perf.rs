use vellum_core::{ColumnAlign, GfmTableModel, RopeDocument};

#[test]
fn test_lossless_roundtrip_preserves_mixed_list_markers_and_crlf() {
    let original = "# Title\r\n\r\n* Star bullet\r\n- Dash bullet\r\n+ Plus bullet\r\n";
    let doc = RopeDocument::from_markdown_str("doc-1", "Test", original);
    assert_eq!(doc.to_lossless_markdown(), original);
}

#[test]
fn test_two_step_input_rule_undo_restores_typed_syntax_first() {
    let mut doc = RopeDocument::from_markdown_str("doc-2", "Undo Rule", "[ ]");
    // User types trailing space -> InputRuleEngine expands `[ ] ` into `- [ ] `
    let after_cursor = doc.edit_byte_range(3..3, " ", true).expect("edit ok");
    assert_eq!(doc.to_lossless_markdown(), "- [ ] ");
    assert_eq!(after_cursor, 6);

    // PRD 5.2: First undo MUST restore literal `[ ] ` before undoing user's space!
    let _ = doc.undo();
    assert_eq!(doc.to_lossless_markdown(), "[ ] ");

    // Second undo reverts the space insertion back to `[ ]`
    let _ = doc.undo();
    assert_eq!(doc.to_lossless_markdown(), "[ ]");
}

#[test]
fn test_fenwick_virtualization_150k_words_lookup() {
    let mut big = String::with_capacity(600_000);
    for i in 0..5_000 {
        big.push_str(&format!(
            "## Section {}\n\nParagraph content with **bold** and `code` block {}.\n\n",
            i, i
        ));
    }
    let doc = RopeDocument::from_markdown_str("bench", "150k Bench", &big);
    assert!(doc.blocks().len() >= 10_000);

    let win = doc.visible_blocks(48_000.0, 900.0, 4);
    assert!(win.start_index < win.end_index);
    assert!((win.end_index - win.start_index) < 60);
}

#[test]
fn test_gfm_table_alignment_roundtrip() {
    let raw = "| Name | Score | Latency |\n| :--- | :---: | ---: |\n| Rope | 99 | 0.12ms |\n";
    let mut table = GfmTableModel::parse(raw).expect("valid table");
    assert_eq!(table.alignments[0], ColumnAlign::Left);
    assert_eq!(table.alignments[1], ColumnAlign::Center);
    assert_eq!(table.alignments[2], ColumnAlign::Right);

    table.set_column_align(0, ColumnAlign::Center);
    let out = table.to_gfm_markdown();
    assert!(out.contains("| :---: | :---: | ---: |"));
}

#[test]
fn test_bidirectional_links_transclusions_and_rename_refactor() {
    use vellum_core::{KnowledgeGraphIndex, ReferenceKind};

    let doc_a = RopeDocument::from_markdown_str(
        "arch",
        "系统架构",
        "# 系统架构\n\n底层采用 [[Ropey 缓冲树#零拷贝切片|Rope 内核]]，并嵌入 ![[CRDT 同步协议]]。\n",
    );
    let doc_b = RopeDocument::from_markdown_str(
        "ropey",
        "Ropey 缓冲树",
        "# Ropey 缓冲树\n\n参见上层 [[系统架构]] 设计。\n",
    );

    let mut graph = KnowledgeGraphIndex::new();
    graph.upsert_document(&doc_a);
    graph.upsert_document(&doc_b);

    let rope_backlinks = graph.backlinks_for("ropey");
    assert_eq!(rope_backlinks.len(), 1);
    assert_eq!(rope_backlinks[0].source_doc_id, "arch");
    assert_eq!(
        rope_backlinks[0].heading_anchor.as_deref(),
        Some("零拷贝切片")
    );

    let snap = graph.snapshot();
    assert_eq!(snap.resolved_doc_count, 2);
    // `CRDT 同步协议` is automatically indexed as an unresolved phantom node!
    assert_eq!(snap.unresolved_node_count, 1);
    assert!(snap
        .edges
        .iter()
        .any(|e| e.kind == ReferenceKind::EmbedTransclusion));

    let (rewritten, count) = KnowledgeGraphIndex::rewrite_links_on_rename(
        &doc_a.to_lossless_markdown(),
        "Ropey 缓冲树",
        "Rope B-Tree 内核",
    );
    assert_eq!(count, 1);
    assert!(rewritten.contains("[[Rope B-Tree 内核#零拷贝切片|Rope 内核]]"));
}

#[test]
fn test_kanban_board_extraction_and_one_byte_rope_toggle() {
    let raw = "\
# 迭代路线\n\
\n\
## 核心渲染管线\n\
\n\
- [ ] 实现 **GPUI** 原生拖拽看板与 [[Ropey 缓冲树|Rope 内核]] 同步\n\
* [x] 完成 `gpui::list` 视口虚拟化\n\
\n\
```markdown\n\
- [ ] 代码块内的伪造任务绝不能被解析为看板卡片\n\
```\n";

    let mut doc = RopeDocument::from_markdown_str("kanban-spec", "迭代路线", raw);
    let board = doc.extract_kanban_board();
    assert_eq!(board.total_count, 2);
    assert_eq!(board.todo.len(), 1);
    assert_eq!(board.done.len(), 1);
    assert_eq!(board.todo[0].section_heading, "核心渲染管线");
    assert!(board.todo[0].display_text.contains("Rope 内核"));

    // Simulate GPUI `on_drop` dragging the Todo card into the Done lane
    let state_offset = board.todo[0].state_byte_offset;
    doc.set_kanban_task_completed(state_offset, true)
        .expect("1-byte Rope checkbox mutation should succeed");

    let after_drop = doc.extract_kanban_board();
    assert_eq!(after_drop.todo.len(), 0);
    assert_eq!(after_drop.done.len(), 2);
    assert!(doc
        .to_lossless_markdown()
        .contains("- [x] 实现 **GPUI** 原生拖拽看板"));

    // Pressing Cmd/Ctrl + Z undoes the Kanban drag back to exact original bytes
    let _ = doc.undo();
    assert_eq!(doc.to_lossless_markdown(), raw);
}

#[test]
fn test_formal_pdf_export_generates_valid_pdf_header() {
    use vellum_core::{FormalPdfOptions, FormalPdfPreset, PaperSize};

    let sample = "\
# 系统总体技术规范\n\
\n\
## 架构设计目标\n\
\n\
基于 `ropey::Rope` 与 `krilla` 矢量排版管线，直接生成正式公文与技术白皮书标准 PDF。\n\
\n\
| 指标 | 目标值 | 实测表现 |\n\
| :--- | :---: | ---: |\n\
| 内存占用 | <= 30 MB | 22.8 MB |\n\
| 导出耗时 | <= 120 ms | 38 ms |\n";

    let doc = RopeDocument::from_markdown_str("spec-01", "系统总体技术规范", sample);
    if vellum_core::pdf_export::load_system_cjk_fonts(None).is_ok() {
        let opts = FormalPdfOptions {
            preset: FormalPdfPreset::TechnicalSpec,
            paper_size: PaperSize::A4,
            margin_mm: 25.4,
            include_cover_meta: true,
            include_toc: true,
            auto_number_headings: true,
            include_header_footer: true,
            document_code: Some("VN-SPEC-2026-01".to_string()),
            organization: Some("Vellum Native Architecture Group".to_string()),
        };
        let pdf_bytes = doc
            .export_formal_pdf(&opts, None)
            .expect("Formal PDF generation should succeed");
        assert!(pdf_bytes.starts_with(b"%PDF-1."));
        assert!(pdf_bytes.len() > 1024);
    }
}

#[test]
fn test_eof_and_inter_block_blank_paragraph_indexing() {
    // 1. Empty document still has 1 addressable Paragraph block
    let empty_doc = RopeDocument::from_markdown_str("empty", "Empty", "");
    assert_eq!(empty_doc.blocks().len(), 1);
    assert_eq!(empty_doc.blocks()[0].byte_range, 0..0);

    // 2. Single trailing newline (`# Title\n`) is 1 block (no phantom trailing block)
    let single_nl = RopeDocument::from_markdown_str("s1", "Single", "# Title\n");
    assert_eq!(single_nl.blocks().len(), 1);

    // 3. Double trailing newline (`# Title\n\n`) exposes addressable EOF blank paragraph at `len..len`
    let double_nl = RopeDocument::from_markdown_str("s2", "Double", "# Title\n\n");
    assert_eq!(double_nl.blocks().len(), 2);
    assert_eq!(
        double_nl.blocks()[1].byte_range,
        double_nl.len_bytes()..double_nl.len_bytes()
    );

    // 4. Standard paragraph separator (`a\n\nb`) has 2 blocks; intentional blank line (`a\n\n\n\nb`) has 3 blocks
    let normal_two = RopeDocument::from_markdown_str("p2", "Two", "Para A\n\nPara B\n");
    assert_eq!(normal_two.blocks().len(), 2);

    let blank_mid = RopeDocument::from_markdown_str("p3", "Three", "Para A\n\n\n\nPara B\n");
    assert_eq!(blank_mid.blocks().len(), 3);
}

