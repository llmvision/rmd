use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use std::ops::Range;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnAlign {
    None,
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BlockKind {
    Heading { level: u8, setext: bool },
    Paragraph,
    CodeBlock { language: String, fenced: bool },
    BlockQuote,
    Callout { kind: String },
    BulletList { marker: char },
    OrderedList { start: u64 },
    TaskList,
    Table { alignments: Vec<ColumnAlign> },
    MathBlock,
    MermaidBlock,
    ThematicBreak,
    FrontMatter,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockDescriptor {
    pub id: Uuid,
    pub kind: BlockKind,
    pub byte_range: Range<usize>,
    pub line_range: Range<usize>,
    pub estimated_height_px: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InlineStyleKind {
    Bold,
    Italic,
    Strikethrough,
    InlineCode,
    Link,
    Image,
    InlineMath,
}

/// Represents a rich inline span inside a visible block, separating `full_range` (including `**` or `` ` ``)
/// from `content_range` so GPUI can hide syntax delimiters when unfocused and reveal them when the
/// caret enters `full_range` (`PRD Section 5.3`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InlineSpan {
    pub style: InlineStyleKind,
    pub full_range: Range<usize>,
    pub content_range: Range<usize>,
    pub destination_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineEntry {
    pub block_index: usize,
    pub level: u8,
    pub text: String,
    pub byte_offset: usize,
    pub y_offset_px: f32,
}

pub fn cmark_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
}

pub fn parse_block_window(rope: &Rope, slice_text: &str, base_byte: usize) -> Vec<BlockDescriptor> {
    let mut raw_blocks: Vec<BlockDescriptor> = Vec::new();
    let mut depth = 0usize;

    for (event, rel_range) in Parser::new_ext(slice_text, cmark_options()).into_offset_iter() {
        let abs_range = (base_byte + rel_range.start)..(base_byte + rel_range.end);
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    let raw_block = &slice_text[rel_range];
                    let kind = classify_top_tag(&tag, raw_block);
                    let start_line = rope.byte_to_line(abs_range.start.min(rope.len_bytes()));
                    let end_line = rope.byte_to_line(abs_range.end.min(rope.len_bytes()));
                    let lines = end_line.saturating_sub(start_line) + 1;
                    raw_blocks.push(BlockDescriptor {
                        id: Uuid::new_v4(),
                        estimated_height_px: estimate_height(&kind, lines),
                        kind,
                        byte_range: abs_range,
                        line_range: start_line..(end_line + 1),
                    });
                }
                depth += 1;
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
            }
            Event::Rule if depth == 0 => {
                let start_line = rope.byte_to_line(abs_range.start.min(rope.len_bytes()));
                raw_blocks.push(BlockDescriptor {
                    id: Uuid::new_v4(),
                    kind: BlockKind::ThematicBreak,
                    byte_range: abs_range,
                    line_range: start_line..(start_line + 1),
                    estimated_height_px: 28.0,
                });
            }
            _ => {}
        }
    }

    if raw_blocks.is_empty() {
        let abs_end = base_byte + slice_text.len();
        let start_line = rope.byte_to_line(base_byte.min(rope.len_bytes()));
        return vec![BlockDescriptor {
            id: Uuid::new_v4(),
            kind: BlockKind::Paragraph,
            byte_range: base_byte..abs_end,
            line_range: start_line..(start_line + 1),
            estimated_height_px: 36.0,
        }];
    }

    let mut out = Vec::with_capacity(raw_blocks.len() + 2);

    // 1. Preserve leading blank editable line if present before the first block
    let first_rel_start = raw_blocks[0].byte_range.start.saturating_sub(base_byte);
    if first_rel_start > 0 {
        let lead = &slice_text[..first_rel_start];
        let nl_count = lead.as_bytes().iter().filter(|&&b| b == b'\n').count();
        if nl_count >= 1 {
            let sep_len = if lead.ends_with("\r\n") { 2 } else { 1 };
            let empty_end = base_byte + first_rel_start.saturating_sub(sep_len);
            let start_line = rope.byte_to_line(base_byte.min(rope.len_bytes()));
            out.push(BlockDescriptor {
                id: Uuid::new_v4(),
                kind: BlockKind::Paragraph,
                byte_range: base_byte..empty_end,
                line_range: start_line..(start_line + 1),
                estimated_height_px: 34.0,
            });
        }
    }

    // 2. Interleave blocks and preserve intentional blank editable paragraphs (>= 3 newlines after content)
    for idx in 0..raw_blocks.len() {
        if idx > 0 {
            if let Some(prev) = out.last_mut() {
                let prev_content_end = trimmed_content_end_rel(slice_text, prev, base_byte);
                let next_rel_start = raw_blocks[idx]
                    .byte_range
                    .start
                    .saturating_sub(base_byte)
                    .min(slice_text.len());
                if next_rel_start > prev_content_end {
                    let gap = &slice_text[prev_content_end..next_rel_start];
                    let nl_count = gap.as_bytes().iter().filter(|&&b| b == b'\n').count();
                    if nl_count >= 3 {
                        let first_nl_end = nth_newline_end(gap, 1).unwrap_or(0);
                        let second_nl_end = nth_newline_end(gap, 2).unwrap_or(first_nl_end);
                        prev.byte_range.end = prev
                            .byte_range
                            .end
                            .min(base_byte + prev_content_end + first_nl_end);

                        let trailing_sep_start = if nl_count >= 4 {
                            // Leave final `\n\n` before next block
                            nth_newline_end(gap, nl_count - 2).unwrap_or(second_nl_end)
                        } else {
                            second_nl_end
                        };
                        let abs_gap_start = base_byte + prev_content_end + second_nl_end;
                        let abs_gap_end = (base_byte + prev_content_end + trailing_sep_start)
                            .max(abs_gap_start);
                        let line_ix = rope.byte_to_line(abs_gap_start.min(rope.len_bytes()));
                        out.push(BlockDescriptor {
                            id: Uuid::new_v4(),
                            kind: BlockKind::Paragraph,
                            byte_range: abs_gap_start..abs_gap_end,
                            line_range: line_ix..(line_ix + 1),
                            estimated_height_px: 34.0,
                        });
                    }
                }
            }
        }
        out.push(raw_blocks[idx].clone());
    }

    // 3. Preserve trailing blank paragraph at EOF (`\n\n` after last block's content)
    let trailing_blank = if let Some(last_block) = out.last_mut() {
        let is_unclosed_fence = matches!(
            last_block.kind,
            BlockKind::CodeBlock { fenced: true, .. }
                | BlockKind::MermaidBlock
                | BlockKind::MathBlock
        ) && {
            let r_s = last_block
                .byte_range
                .start
                .saturating_sub(base_byte)
                .min(slice_text.len());
            let r_e = last_block
                .byte_range
                .end
                .saturating_sub(base_byte)
                .min(slice_text.len());
            let trimmed = slice_text[r_s..r_e].trim_end_matches(&['\r', '\n', ' ', '\t'][..]);
            trimmed.lines().count() <= 1
                || (!trimmed.ends_with("```")
                    && !trimmed.ends_with("~~~")
                    && !trimmed.ends_with("$$"))
        };

        if !is_unclosed_fence {
            let last_content_end = trimmed_content_end_rel(slice_text, last_block, base_byte);
            let tail = &slice_text[last_content_end..];
            let tail_nls = tail.as_bytes().iter().filter(|&&b| b == b'\n').count();
            if tail_nls >= 2 {
                let first_nl_end = nth_newline_end(tail, 1).unwrap_or(0);
                let second_nl_end = nth_newline_end(tail, 2).unwrap_or(tail.len());
                last_block.byte_range.end = last_block
                    .byte_range
                    .end
                    .min(base_byte + last_content_end + first_nl_end);
                let abs_tail_start = base_byte + last_content_end + second_nl_end;
                let abs_tail_end = base_byte + slice_text.len();
                let line_ix = rope.byte_to_line(abs_tail_start.min(rope.len_bytes()));
                Some(BlockDescriptor {
                    id: Uuid::new_v4(),
                    kind: BlockKind::Paragraph,
                    byte_range: abs_tail_start..abs_tail_end,
                    line_range: line_ix..(line_ix + 1),
                    estimated_height_px: 36.0,
                })
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    if let Some(tail_desc) = trailing_blank {
        out.push(tail_desc);
    }

    out
}

fn trimmed_content_end_rel(slice_text: &str, block: &BlockDescriptor, base_byte: usize) -> usize {
    let rel_start = block
        .byte_range
        .start
        .saturating_sub(base_byte)
        .min(slice_text.len());
    let rel_end = block
        .byte_range
        .end
        .saturating_sub(base_byte)
        .min(slice_text.len())
        .max(rel_start);
    let trimmed_len = slice_text[rel_start..rel_end]
        .trim_end_matches(&['\r', '\n'][..])
        .len();
    rel_start + trimmed_len
}

fn nth_newline_end(s: &str, target_n: usize) -> Option<usize> {
    if target_n == 0 {
        return Some(0);
    }
    let mut seen = 0usize;
    for (idx, b) in s.bytes().enumerate() {
        if b == b'\n' {
            seen += 1;
            if seen == target_n {
                return Some(idx + 1);
            }
        }
    }
    None
}

pub fn parse_inline_spans(block_text: &str) -> Vec<InlineSpan> {
    let mut spans = Vec::new();
    let mut stack: Vec<(InlineStyleKind, usize, Option<String>)> = Vec::new();

    for (event, range) in Parser::new_ext(block_text, cmark_options()).into_offset_iter() {
        match event {
            Event::Start(Tag::Strong) => stack.push((InlineStyleKind::Bold, range.start, None)),
            Event::Start(Tag::Emphasis) => stack.push((InlineStyleKind::Italic, range.start, None)),
            Event::Start(Tag::Strikethrough) => {
                stack.push((InlineStyleKind::Strikethrough, range.start, None))
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                stack.push((InlineStyleKind::Link, range.start, Some(dest_url.to_string())))
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                stack.push((InlineStyleKind::Image, range.start, Some(dest_url.to_string())))
            }
            Event::End(tag_end) => {
                let matched = matches!(
                    tag_end,
                    pulldown_cmark::TagEnd::Strong
                        | pulldown_cmark::TagEnd::Emphasis
                        | pulldown_cmark::TagEnd::Strikethrough
                        | pulldown_cmark::TagEnd::Link
                        | pulldown_cmark::TagEnd::Image
                );
                if matched {
                    if let Some((style, start, dest)) = stack.pop() {
                        let delim_len = match style {
                            InlineStyleKind::Bold | InlineStyleKind::Strikethrough => 2,
                            InlineStyleKind::Italic => 1,
                            _ => 1,
                        };
                        let content_start = (start + delim_len).min(range.end);
                        let content_end = range.end.saturating_sub(delim_len).max(content_start);
                        spans.push(InlineSpan {
                            style,
                            full_range: start..range.end,
                            content_range: content_start..content_end,
                            destination_url: dest,
                        });
                    }
                }
            }
            Event::Code(_) => {
                let content_start = (range.start + 1).min(range.end);
                let content_end = range.end.saturating_sub(1).max(content_start);
                spans.push(InlineSpan {
                    style: InlineStyleKind::InlineCode,
                    full_range: range,
                    content_range: content_start..content_end,
                    destination_url: None,
                });
            }
            Event::InlineMath(_) => {
                let content_start = (range.start + 1).min(range.end);
                let content_end = range.end.saturating_sub(1).max(content_start);
                spans.push(InlineSpan {
                    style: InlineStyleKind::InlineMath,
                    full_range: range,
                    content_range: content_start..content_end,
                    destination_url: None,
                });
            }
            _ => {}
        }
    }

    spans
}

fn classify_top_tag(tag: &Tag<'_>, raw: &str) -> BlockKind {
    match tag {
        Tag::Heading { level, .. } => {
            let lvl = match level {
                HeadingLevel::H1 => 1,
                HeadingLevel::H2 => 2,
                HeadingLevel::H3 => 3,
                HeadingLevel::H4 => 4,
                HeadingLevel::H5 => 5,
                HeadingLevel::H6 => 6,
            };
            BlockKind::Heading {
                level: lvl,
                setext: !raw.trim_start().starts_with('#'),
            }
        }
        Tag::CodeBlock(kind) => match kind {
            CodeBlockKind::Fenced(info) => {
                let lang = info.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if lang == "mermaid" {
                    BlockKind::MermaidBlock
                } else if lang == "math" || lang == "latex" {
                    BlockKind::MathBlock
                } else {
                    BlockKind::CodeBlock {
                        language: lang,
                        fenced: true,
                    }
                }
            }
            CodeBlockKind::Indented => BlockKind::CodeBlock {
                language: String::new(),
                fenced: false,
            },
        },
        Tag::BlockQuote(_) => {
            let first_line = raw.lines().next().unwrap_or("").trim_start_matches('>').trim();
            if let Some(after_bang) = first_line.strip_prefix("[!") {
                if let Some(close_ix) = after_bang.find(']') {
                    return BlockKind::Callout {
                        kind: after_bang[..close_ix].to_ascii_uppercase(),
                    };
                }
            }
            BlockKind::BlockQuote
        }
        Tag::List(start_num) => {
            let trimmed = raw.trim_start();
            if trimmed.starts_with("- [ ]")
                || trimmed.starts_with("- [x]")
                || trimmed.starts_with("- [X]")
                || trimmed.starts_with("* [ ]")
                || trimmed.starts_with("* [x]")
            {
                BlockKind::TaskList
            } else if let Some(n) = start_num {
                BlockKind::OrderedList { start: *n }
            } else {
                let marker = trimmed.chars().next().unwrap_or('-');
                BlockKind::BulletList { marker }
            }
        }
        Tag::Table(aligns) => BlockKind::Table {
            alignments: aligns
                .iter()
                .map(|a| match a {
                    Alignment::None => ColumnAlign::None,
                    Alignment::Left => ColumnAlign::Left,
                    Alignment::Center => ColumnAlign::Center,
                    Alignment::Right => ColumnAlign::Right,
                })
                .collect(),
        },
        Tag::MetadataBlock(_) => BlockKind::FrontMatter,
        _ => {
            if raw.trim_start().starts_with("$$") {
                BlockKind::MathBlock
            } else {
                BlockKind::Paragraph
            }
        }
    }
}

fn estimate_height(kind: &BlockKind, line_count: usize) -> f32 {
    match kind {
        BlockKind::Heading { level: 1, .. } => 56.0,
        BlockKind::Heading { level: 2, .. } => 48.0,
        BlockKind::Heading { .. } => 40.0,
        BlockKind::CodeBlock { .. } => 40.0 + (line_count as f32 * 21.0),
        BlockKind::Table { .. } => 48.0 + (line_count as f32 * 36.0),
        BlockKind::MermaidBlock => 220.0,
        BlockKind::MathBlock => 76.0,
        BlockKind::ThematicBreak => 28.0,
        _ => (line_count.max(1) as f32 * 27.0) + 12.0,
    }
}
