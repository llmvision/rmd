use ropey::Rope;
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum UndoKind {
    UserEdit,
    /// PRD Section 5.2: First undo after an Input Rule restores the user's literal characters.
    InputRuleAutoFormat { rule_name: &'static str },
}

#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub byte_offset: usize,
    pub removed_text: String,
    pub inserted_text: String,
    pub kind: UndoKind,
    pub cursor_before: usize,
    pub cursor_after: usize,
}

#[derive(Debug, Clone)]
pub struct InputRuleMatch {
    pub rule_name: &'static str,
    pub replace_bytes: Range<usize>,
    pub normalized_markdown: String,
    pub cursor_offset_in_normalized: usize,
}

pub struct InputRuleEngine;

impl InputRuleEngine {
    /// Evaluates PRD Section 5.2 block-start & newline triggers after user text insertion.
    /// Must ONLY be called when CJK IME composition is inactive (`marked_text_range().is_none()`).
    pub fn check_after_insert(
        rope: &Rope,
        cursor_byte: usize,
        just_inserted: &str,
    ) -> Option<InputRuleMatch> {
        let line_idx = rope.byte_to_line(cursor_byte.min(rope.len_bytes()));

        // Case 1: Space-triggered block prefixes (`[ ] ` -> `- [ ] `)
        if just_inserted == " " {
            let line_start_byte = rope.line_to_byte(line_idx);
            let line_str = rope.line(line_idx).to_string();
            let prefix = &line_str[..(cursor_byte - line_start_byte).min(line_str.len())];

            if prefix == "[ ] " || prefix == "[] " {
                return Some(InputRuleMatch {
                    rule_name: "task_list_shorthand",
                    replace_bytes: line_start_byte..cursor_byte,
                    normalized_markdown: "- [ ] ".to_string(),
                    cursor_offset_in_normalized: 6,
                });
            }
            if prefix == "[x] " || prefix == "[X] " {
                return Some(InputRuleMatch {
                    rule_name: "task_list_checked_shorthand",
                    replace_bytes: line_start_byte..cursor_byte,
                    normalized_markdown: "- [x] ".to_string(),
                    cursor_offset_in_normalized: 6,
                });
            }
        }

        // Case 2: Enter-triggered fenced code block auto-closing (` ```rust\n ` -> ` ```rust\n\n``` `)
        if just_inserted == "\n" && line_idx > 0 {
            let prev_line_idx = line_idx - 1;
            let prev_start_byte = rope.line_to_byte(prev_line_idx);
            let prev_line = rope.line(prev_line_idx).to_string();
            let trimmed = prev_line.trim_end_matches(&['\r', '\n'][..]);

            if let Some(lang) = trimmed.strip_prefix("```") {
                if !lang.contains('`') {
                    let expanded = format!("```{}\n\n```", lang.trim());
                    let cursor_inside = 3 + lang.trim().len() + 1;
                    return Some(InputRuleMatch {
                        rule_name: "fenced_code_auto_close",
                        replace_bytes: prev_start_byte..cursor_byte,
                        normalized_markdown: expanded,
                        cursor_offset_in_normalized: cursor_inside,
                    });
                }
            }

            if trimmed == "---" || trimmed == "***" {
                let expanded = "---\n\n".to_string();
                return Some(InputRuleMatch {
                    rule_name: "thematic_break",
                    replace_bytes: prev_start_byte..cursor_byte,
                    normalized_markdown: expanded.clone(),
                    cursor_offset_in_normalized: expanded.len(),
                });
            }
        }

        None
    }
}
