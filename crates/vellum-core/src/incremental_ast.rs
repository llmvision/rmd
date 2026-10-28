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
    let mut out = Vec::new();
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
                    out.push(BlockDescriptor {
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
                out.push(BlockDescriptor {
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

    if out.is_empty() && !slice_text.is_empty() {
        out.push(BlockDescriptor {
            id: Uuid::new_v4(),
            kind: BlockKind::Paragraph,
            byte_range: base_byte..(base_byte + slice_text.len()),
            line_range: 0..1,
            estimated_height_px: 34.0,
        });
    }

    out
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
            Event::End(TagEnd) => {
                let matched = matches!(
                    TagEnd,
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
