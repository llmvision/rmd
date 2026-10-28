/// Slash Command Registry (`PRD Section 5.5`):
/// Supports Chinese keywords, Pinyin initials, and English Markdown command triggers.
#[derive(Debug, Clone)]
pub struct SlashCommandSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub shortcut_hint: &'static str,
    pub keywords: &'static [&'static str],
    pub template: &'static str,
    pub cursor_backtrack_bytes: usize,
}

pub const SLASH_COMMANDS: &[SlashCommandSpec] = &[
    SlashCommandSpec {
        id: "h1",
        label: "一级标题",
        shortcut_hint: "# + 空格",
        keywords: &["h1", "heading1", "biaoti", "bt1", "一级标题"],
        template: "# ",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "h2",
        label: "二级标题",
        shortcut_hint: "## + 空格",
        keywords: &["h2", "heading2", "biaoti", "bt2", "二级标题"],
        template: "## ",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "h3",
        label: "三级标题",
        shortcut_hint: "### + 空格",
        keywords: &["h3", "heading3", "biaoti", "bt3", "三级标题"],
        template: "### ",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "task",
        label: "任务清单",
        shortcut_hint: "- [ ]",
        keywords: &["task", "todo", "renwu", "rw", "清单", "任务"],
        template: "- [ ] ",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "table",
        label: "GFM 数据表格 (3×3)",
        shortcut_hint: "| a | b |",
        keywords: &["table", "biaoge", "bg", "表格"],
        template: "| 列标题 A | 列标题 B | 列标题 C |\n| :--- | :---: | ---: |\n| 内容 1 | 内容 2 | 100 |\n",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "code",
        label: "语法高亮代码块",
        shortcut_hint: "```rust",
        keywords: &["code", "daima", "dm", "rust", "代码"],
        template: "```rust\n\n```",
        cursor_backtrack_bytes: 4,
    },
    SlashCommandSpec {
        id: "math",
        label: "LaTeX 块级公式",
        shortcut_hint: "$$...$$",
        keywords: &["math", "latex", "gongshi", "gs", "公式"],
        template: "$$\nE = mc^2\n$$",
        cursor_backtrack_bytes: 3,
    },
    SlashCommandSpec {
        id: "mermaid",
        label: "Mermaid 流程图",
        shortcut_hint: "```mermaid",
        keywords: &["mermaid", "diagram", "liuchengtu", "lct", "图表", "流程图"],
        template: "```mermaid\ngraph LR\n  A[输入 Markdown] --> B[Rope 增量解析]\n  B --> C[GPUI 即时渲染]\n```",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "callout",
        label: "高亮提示块 (Callout)",
        shortcut_hint: "> [!NOTE]",
        keywords: &["callout", "note", "tip", "tishi", "ts", "提示"],
        template: "> [!NOTE]\n> 在此输入关键提示说明\n",
        cursor_backtrack_bytes: 0,
    },
    SlashCommandSpec {
        id: "wikilink",
        label: "双向页面链接 [[...]]",
        shortcut_hint: "[[页面名]]",
        keywords: &["link", "wiki", "backlink", "shuanglian", "sl", "双向链接", "引用"],
        template: "[[]]",
        cursor_backtrack_bytes: 2,
    },
    SlashCommandSpec {
        id: "embed",
        label: "嵌入文档/章节引用 ![[...]]",
        shortcut_hint: "![[页面#章节]]",
        keywords: &["embed", "transclude", "qianru", "qr", "yyk", "嵌入引用"],
        template: "![[]]",
        cursor_backtrack_bytes: 2,
    },
    SlashCommandSpec {
        id: "hr",
        label: "水平分隔线",
        shortcut_hint: "---",
        keywords: &["hr", "divider", "fengexian", "fgx", "分隔线"],
        template: "---\n\n",
        cursor_backtrack_bytes: 0,
    },
];

pub fn filter_slash_commands(query: &str) -> Vec<&'static SlashCommandSpec> {
    let q = query.trim().trim_start_matches('/').to_ascii_lowercase();
    if q.is_empty() {
        return SLASH_COMMANDS.iter().collect();
    }
    SLASH_COMMANDS
        .iter()
        .filter(|spec| {
            spec.label.to_lowercase().contains(&q)
                || spec.keywords.iter().any(|k| k.contains(&q))
        })
        .collect()
}
