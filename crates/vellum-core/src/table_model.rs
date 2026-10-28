use crate::incremental_ast::ColumnAlign;
use serde::{Deserialize, Serialize};

/// Structured GFM Table model (`PRD Section 6.2`: TB-01 .. TB-05)
/// Supports in-cell editing, `Tab`/`Shift+Tab` traversal, alignment toggling (`:---:`),
/// and deterministic GFM pipe-table serialization back into `RopeDocument`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GfmTableModel {
    pub headers: Vec<String>,
    pub alignments: Vec<ColumnAlign>,
    pub rows: Vec<Vec<String>>,
}

impl GfmTableModel {
    pub fn parse(raw_block: &str) -> Option<Self> {
        let lines: Vec<&str> = raw_block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if lines.len() < 2 {
            return None;
        }

        let headers = split_pipe_row(lines[0]);
        if headers.is_empty() {
            return None;
        }

        let delim_cells = split_pipe_row(lines[1]);
        let col_count = headers.len();
        let mut alignments = Vec::with_capacity(col_count);

        for i in 0..col_count {
            let spec = delim_cells.get(i).map(|s| s.as_str()).unwrap_or("---");
            let left = spec.starts_with(':');
            let right = spec.ends_with(':');
            let align = match (left, right) {
                (true, true) => ColumnAlign::Center,
                (true, false) => ColumnAlign::Left,
                (false, true) => ColumnAlign::Right,
                (false, false) => ColumnAlign::None,
            };
            alignments.push(align);
        }

        let mut rows = Vec::with_capacity(lines.len().saturating_sub(2));
        for row_line in &lines[2..] {
            let mut cells = split_pipe_row(row_line);
            cells.resize(col_count, String::new());
            rows.push(cells);
        }

        Some(Self {
            headers,
            alignments,
            rows,
        })
    }

    pub fn add_row(&mut self) {
        self.rows.push(vec![String::new(); self.headers.len()]);
    }

    pub fn add_column(&mut self) {
        self.headers.push(format!("列 {}", self.headers.len() + 1));
        self.alignments.push(ColumnAlign::None);
        for row in &mut self.rows {
            row.push(String::new());
        }
    }

    pub fn set_column_align(&mut self, col_ix: usize, align: ColumnAlign) {
        if let Some(slot) = self.alignments.get_mut(col_ix) {
            *slot = align;
        }
    }

    pub fn to_gfm_markdown(&self) -> String {
        let mut out = String::new();
        out.push('|');
        for h in &self.headers {
            out.push(' ');
            out.push_str(&h.replace('\n', "<br>"));
            out.push_str(" |");
        }
        out.push('\n');

        out.push('|');
        for align in &self.alignments {
            let marker = match align {
                ColumnAlign::None => " --- |",
                ColumnAlign::Left => " :--- |",
                ColumnAlign::Center => " :---: |",
                ColumnAlign::Right => " ---: |",
            };
            out.push_str(marker);
        }
        out.push('\n');

        for row in &self.rows {
            out.push('|');
            for col_ix in 0..self.headers.len() {
                let val = row.get(col_ix).map(String::as_str).unwrap_or("");
                out.push(' ');
                out.push_str(&val.replace('\n', "<br>"));
                out.push_str(" |");
            }
            out.push('\n');
        }
        out
    }
}

fn split_pipe_row(line: &str) -> Vec<String> {
    let trimmed = line.trim().trim_start_matches('|').trim_end_matches('|');
    trimmed.split('|').map(|c| c.trim().to_string()).collect()
}
