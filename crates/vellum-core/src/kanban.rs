//! Lossless Markdown Checkbox (`- [ ]` / `- [x]`) parser and `O(log N)` Rope mutator
//! powering the native GPUI `KanbanBoardView` (`crates/vellum-gpui/src/kanban_board.rs`).

use crate::incremental_ast::BlockKind;
use crate::rope_doc::RopeDocument;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KanbanColumn {
    Todo,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanTaskCard {
    pub task_index: usize,
    pub block_index: usize,
    /// 1-based line number inside the `ropey::Rope` buffer
    pub line_number: usize,
    /// Exact UTF-8 byte offset of the `' '` or `'x'`/`'X'` character inside `[ ]` / `[x]`
    pub state_byte_offset: usize,
    /// Exact UTF-8 byte range of this task line inside `ropey::Rope` (excluding trailing `\r`/`\n`)
    pub line_byte_range: Range<usize>,
    pub completed: bool,
    pub column: KanbanColumn,
    pub raw_text: String,
    pub display_text: String,
    pub section_heading: String,
    pub indent_level: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanBoardModel {
    pub doc_id: String,
    pub doc_title: String,
    pub todo: Vec<KanbanTaskCard>,
    pub done: Vec<KanbanTaskCard>,
    pub total_count: usize,
    pub completed_count: usize,
}

/// Parses a single Markdown line to detect GFM Checkbox syntax (`- [ ] ...`, `* [x] ...`, `> - [ ] ...`).
/// Returns `(state_char_offset_in_line, completed, indent_spaces, raw_task_body)`.
fn parse_task_line(line: &str) -> Option<(usize, bool, usize, &str)> {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut indent_spaces = 0usize;

    // 1. Optional leading indentation and blockquote `>` prefixes
    loop {
        while i < len && (bytes[i] == b' ' || bytes[i] == b'\t') {
            indent_spaces += if bytes[i] == b'\t' { 4 } else { 1 };
            i += 1;
        }
        if i < len && bytes[i] == b'>' {
            i += 1;
            continue;
        }
        break;
    }

    // 2. Unordered list bullet marker (`-`, `*`, or `+`) followed by >= 1 space/tab
    if i >= len || (bytes[i] != b'-' && bytes[i] != b'*' && bytes[i] != b'+') {
        return None;
    }
    i += 1;
    if i >= len || (bytes[i] != b' ' && bytes[i] != b'\t') {
        return None;
    }
    while i < len && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }

    // 3. Checkbox `[ ]`, `[x]`, or `[X]` followed by >= 1 space/tab
    if i + 3 >= len || bytes[i] != b'[' || bytes[i + 2] != b']' {
        return None;
    }
    let state_byte = bytes[i + 1];
    let completed = match state_byte {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    let state_offset_in_line = i + 1;
    i += 3;

    if i >= len || (bytes[i] != b' ' && bytes[i] != b'\t') {
        return None;
    }
    while i < len && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }

    let body = line[i..].trim_end_matches(&['\r', '\n'][..]).trim();
    Some((state_offset_in_line, completed, indent_spaces, body))
}

/// Strips inline Markdown formatting delimiters (`**`, `*`, `` ` ``, `[[Target|Alias]]`) for clean
/// GPU text shaping on compact Kanban cards while keeping `raw_text` intact.
pub fn clean_task_display_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let n = chars.len();
    let mut i = 0;

    while i < n {
        // Handle `[[Target#Heading|Alias]]` or `[[Target]]`
        if i + 1 < n && chars[i] == '[' && chars[i + 1] == '[' {
            if let Some(rel_close) = raw[char_byte_pos(&chars, i + 2)..].find("]]") {
                let start_b = char_byte_pos(&chars, i + 2);
                let inner = &raw[start_b..start_b + rel_close];
                let label = if let Some((_, alias)) = inner.split_once('|') {
                    alias.trim()
                } else if let Some((doc, heading)) = inner.split_once('#') {
                    if heading.trim().is_empty() {
                        doc.trim()
                    } else {
                        out.push_str(doc.trim());
                        out.push_str(" § ");
                        heading.trim()
                    }
                } else {
                    inner.trim()
                };
                out.push_str(label);
                let end_b = start_b + rel_close + 2;
                while i < n && char_byte_pos(&chars, i) < end_b {
                    i += 1;
                }
                continue;
            }
        }

        // Skip common emphasis / inline code markers
        let ch = chars[i];
        if ch == '*' || ch == '`' || ch == '~' {
            i += 1;
            continue;
        }
        out.push(ch);
        i += 1;
    }

    out.replace("<kbd>", "[").replace("</kbd>", "]")
}

fn char_byte_pos(chars: &[char], char_idx: usize) -> usize {
    chars[..char_idx.min(chars.len())]
        .iter()
        .map(|c| c.len_utf8())
        .sum()
}

impl RopeDocument {
    /// Scans indexed blocks in `RopeDocument` (skipping fenced code, math, mermaid, and front matter)
    /// and partitions all GFM Checkbox items into `Todo` and `Done` columns with exact `Rope` byte offsets.
    pub fn extract_kanban_board(&self) -> KanbanBoardModel {
        let mut todo = Vec::new();
        let mut done = Vec::new();
        let mut current_section = String::from("文档导言");
        let mut seq_idx = 0usize;

        for (block_ix, block) in self.blocks().iter().enumerate() {
            match &block.kind {
                BlockKind::Heading { .. } => {
                    if let Some(raw_heading) = self.slice_block_str(block_ix) {
                        let clean = raw_heading
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim_start_matches('#')
                            .trim();
                        if !clean.is_empty() {
                            current_section = clean.to_string();
                        }
                    }
                    continue;
                }
                BlockKind::CodeBlock { .. }
                | BlockKind::MathBlock
                | BlockKind::MermaidBlock
                | BlockKind::FrontMatter => {
                    continue;
                }
                _ => {}
            }

            let Some(block_str) = self.slice_block_str(block_ix) else {
                continue;
            };

            let mut byte_cursor_in_block = 0usize;
            for raw_line_with_nl in block_str.split_inclusive('\n') {
                let line_start_byte = block.byte_range.start + byte_cursor_in_block;
                let trimmed_no_nl = raw_line_with_nl.trim_end_matches(&['\r', '\n'][..]);
                let line_end_byte = line_start_byte + trimmed_no_nl.len();

                if let Some((state_rel, completed, indent_spaces, body)) =
                    parse_task_line(trimmed_no_nl)
                {
                    let state_byte_offset = line_start_byte + state_rel;
                    let line_number = self.rope().byte_to_line(line_start_byte) + 1;
                    let card = KanbanTaskCard {
                        task_index: seq_idx,
                        block_index: block_ix,
                        line_number,
                        state_byte_offset,
                        line_byte_range: line_start_byte..line_end_byte,
                        completed,
                        column: if completed {
                            KanbanColumn::Done
                        } else {
                            KanbanColumn::Todo
                        },
                        raw_text: body.to_string(),
                        display_text: clean_task_display_text(body),
                        section_heading: current_section.clone(),
                        indent_level: indent_spaces / 2,
                    };
                    seq_idx += 1;
                    if completed {
                        done.push(card);
                    } else {
                        todo.push(card);
                    }
                }

                byte_cursor_in_block += raw_line_with_nl.len();
            }
        }

        let completed_count = done.len();
        let total_count = todo.len() + completed_count;

        KanbanBoardModel {
            doc_id: self.id.clone(),
            doc_title: self.title.clone(),
            todo,
            done,
            total_count,
            completed_count,
        }
    }

    /// Mutates a single Checkbox state character (`[ ]` <-> `[x]`) directly inside `ropey::Rope`
    /// in `O(log N)` time (1-byte edit), recording a full `UndoEntry` for `Cmd/Ctrl + Z`!
    pub fn set_kanban_task_completed(
        &mut self,
        state_byte_offset: usize,
        completed: bool,
    ) -> Result<usize> {
        let total_bytes = self.len_bytes();
        if state_byte_offset == 0 || state_byte_offset + 1 >= total_bytes {
            bail!("Invalid checkbox byte offset {}", state_byte_offset);
        }

        let open_ch = self.rope().byte(state_byte_offset - 1);
        let cur_ch = self.rope().byte(state_byte_offset);
        let close_ch = self.rope().byte(state_byte_offset + 1);

        if open_ch != b'[' || close_ch != b']' || !matches!(cur_ch, b' ' | b'x' | b'X') {
            bail!("Byte offset {} does not point to a valid GFM checkbox marker", state_byte_offset);
        }

        let target_byte = if completed { b'x' } else { b' ' };
        if (completed && (cur_ch == b'x' || cur_ch == b'X')) || (!completed && cur_ch == b' ') {
            return Ok(state_byte_offset);
        }

        let replacement = if target_byte == b'x' { "x" } else { " " };
        self.edit_byte_range(state_byte_offset..(state_byte_offset + 1), replacement, false)
    }

    /// Appends a new `- [ ] ...` or `- [x] ...` task to the last `TaskList` block in the document
    /// (or creates a new task section at EOF if none exists yet).
    pub fn append_kanban_task(&mut self, task_markdown: &str, completed: bool) -> Result<usize> {
        let clean = task_markdown.trim();
        if clean.is_empty() {
            bail!("Task text cannot be empty");
        }
        let marker = if completed { "x" } else { " " };

        if let Some(last_task_blk) = self
            .blocks()
            .iter()
            .rev()
            .find(|b| matches!(b.kind, BlockKind::TaskList))
        {
            let insert_pos = last_task_blk.byte_range.end.min(self.len_bytes());
            let prefix_nl = if insert_pos > 0 && self.rope().byte(insert_pos - 1) == b'\n' {
                ""
            } else {
                "\n"
            };
            let line = format!("{}- [{}] {}", prefix_nl, marker, clean);
            return self.edit_byte_range(insert_pos..insert_pos, &line, false);
        }

        let eof = self.len_bytes();
        let section = if eof == 0 {
            format!("## 任务看板清单\n\n- [{}] {}\n", marker, clean)
        } else {
            format!("\n\n## 任务看板清单\n\n- [{}] {}\n", marker, clean)
        };
        self.edit_byte_range(eof..eof, &section, false)
    }
}
