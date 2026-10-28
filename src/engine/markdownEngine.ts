export type BlockType =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'mermaid'
  | 'math'
  | 'table'
  | 'blockquote'
  | 'callout'
  | 'ul'
  | 'ol'
  | 'task'
  | 'hr'
  | 'image'
  | 'embed';

export type ColumnAlign = 'none' | 'left' | 'center' | 'right';

export interface ParsedWikiReference {
  target: string;
  heading?: string;
  alias?: string;
  displayLabel: string;
}

export function parseWikiLinkSpec(inner: string): ParsedWikiReference {
  const pipeIdx = inner.indexOf('|');
  const targetAndAnchor = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
  const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() || undefined : undefined;
  const hashIdx = targetAndAnchor.indexOf('#');

  if (hashIdx >= 0) {
    const target = targetAndAnchor.slice(0, hashIdx).trim();
    const heading = targetAndAnchor.slice(hashIdx + 1).trim() || undefined;
    const displayLabel = alias || (heading ? `${target} § ${heading}` : target);
    return { target, heading, alias, displayLabel };
  }

  return {
    target: targetAndAnchor,
    alias,
    displayLabel: alias || targetAndAnchor,
  };
}

export interface BlockRecord {
  id: string;
  type: BlockType;
  /** Exact raw Markdown text of this block (preserves original markers & line endings for round-trip fidelity) */
  raw: string;
  level?: number;
  setext?: boolean;
  language?: string;
  calloutKind?: string;
  orderedStart?: number;
  listMarker?: string;
  estimatedHeight: number;
  startLine: number;
  endLine: number;
}

export interface OutlineNode {
  blockIndex: number;
  blockId: string;
  level: number;
  text: string;
}

export interface ParsedTable {
  headers: string[];
  alignments: ColumnAlign[];
  rows: string[][];
}

export interface SlashCommandItem {
  id: string;
  label: string;
  description: string;
  hint: string;
  keywords: string[];
  insert: string;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: 'h1',
    label: '一级标题',
    description: '文档主章节大标题',
    hint: '# ',
    keywords: ['h1', 'heading1', 'biaoti', 'bt1', '一级标题'],
    insert: '# ',
  },
  {
    id: 'h2',
    label: '二级标题',
    description: '核心小节标题',
    hint: '## ',
    keywords: ['h2', 'heading2', 'biaoti', 'bt2', '二级标题'],
    insert: '## ',
  },
  {
    id: 'h3',
    label: '三级标题',
    description: '子段落标题',
    hint: '### ',
    keywords: ['h3', 'heading3', 'biaoti', 'bt3', '三级标题'],
    insert: '### ',
  },
  {
    id: 'task',
    label: '任务列表',
    description: '可点击勾选的 GFM 待办事项',
    hint: '- [ ]',
    keywords: ['task', 'todo', 'renwu', 'rw', '任务', '待办'],
    insert: '- [ ] 新建待办事项',
  },
  {
    id: 'ul',
    label: '无序列表',
    description: '项目符号条目列表',
    hint: '- ',
    keywords: ['ul', 'list', 'liebiao', 'lb', '无序列表'],
    insert: '- 列表项内容',
  },
  {
    id: 'ol',
    label: '有序列表',
    description: '自动编号顺序列表',
    hint: '1. ',
    keywords: ['ol', 'number', 'youxu', 'yx', '有序列表'],
    insert: '1. 第一项内容',
  },
  {
    id: 'table',
    label: 'GFM 数据表格',
    description: '支持单元格 Tab 切换与列对齐',
    hint: '| a | b |',
    keywords: ['table', 'biaoge', 'bg', '表格'],
    insert: '| 模块名称 | 数据结构 | 单次耗时 |\n| :--- | :---: | ---: |\n| Rope 缓冲 | B-Tree Chunks | 0.12 ms |\n| 视口树 | Fenwick BIT | 0.04 ms |',
  },
  {
    id: 'code',
    label: '语法高亮代码块',
    description: '支持 Rust / TS / Python 等语法着色',
    hint: '```rust',
    keywords: ['code', 'daima', 'dm', 'rust', '代码块'],
    insert: '```rust\npub fn fast_slice(rope: &ropey::Rope, range: std::ops::Range<usize>) -> usize {\n    range.len()\n}\n```',
  },
  {
    id: 'math',
    label: 'LaTeX 块级公式',
    description: '使用 KaTeX 即时排版数学公式',
    hint: '$$...$$',
    keywords: ['math', 'latex', 'gongshi', 'gs', '公式'],
    insert: '$$\nT_{\\text{render}}(N) = \\mathcal{O}(\\log_2 N) \\le 8.33\\text{ ms}\n$$',
  },
  {
    id: 'mermaid',
    label: 'Mermaid 流程图',
    description: '轻量级零依赖 SVG 架构流程图',
    hint: '```mermaid',
    keywords: ['mermaid', 'graph', 'flow', 'liuchengtu', 'lct', '图表', '流程图'],
    insert: '```mermaid\ngraph LR\n  A[Markdown 源码] --> B[Rope 分块索引]\n  B --> C[GPUI 视口虚拟化]\n  C --> D[120 FPS 即时渲染]\n```',
  },
  {
    id: 'callout',
    label: '高亮提示块',
    description: 'NOTE / TIP / IMPORTANT 提示容器',
    hint: '> [!NOTE]',
    keywords: ['callout', 'note', 'tip', 'tishi', 'ts', '提示块'],
    insert: '> [!NOTE]\n> 在此记录关键架构约束或注意事项。',
  },
  {
    id: 'quote',
    label: '块引用',
    description: '引述段落或文献摘录',
    hint: '> ',
    keywords: ['quote', 'yinyong', 'yy', '引用'],
    insert: '> 让用户用 Markdown 的键盘效率写作，同时实时看到最终排版效果。',
  },
  {
    id: 'wikilink',
    label: '双向链接引用',
    description: '建立跨文档或章节的双向连接 [[文档#章节]]',
    hint: '[[文档]]',
    keywords: ['wikilink', 'link', 'shuanglian', 'sl', '双链', '双向链接', '引用文档'],
    insert: '请参考 [[Ropey 零拷贝文本树原理#核心复杂度保证]] 的相关设计。',
  },
  {
    id: 'embed',
    label: '嵌入文档块 (Transclusion)',
    description: '实时嵌入另一篇文档或指定章节内容',
    hint: '![[文档#章节]]',
    keywords: ['embed', 'transclude', 'qianru', 'yyk', '嵌入', '引用块'],
    insert: '![[Ropey 零拷贝文本树原理#核心复杂度保证]]',
  },
  {
    id: 'hr',
    label: '水平分隔线',
    description: '章节视觉分割线',
    hint: '---',
    keywords: ['hr', 'divider', 'fengexian', 'fgx', '分隔线'],
    insert: '---',
  },
];

let blockUidSeed = 1;
export function nextBlockId(): string {
  blockUidSeed += 1;
  return `blk_${blockUidSeed.toString(36)}`;
}

/**
 * Splits a full Markdown document into top-level `BlockRecord` items while preserving
 * exact raw substrings so unmodified blocks serialize with 100% round-trip byte fidelity.
 */
export function parseMarkdownToBlocks(markdown: string): BlockRecord[] {
  if (!markdown) {
    return [
      {
        id: nextBlockId(),
        type: 'paragraph',
        raw: '',
        estimatedHeight: 40,
        startLine: 1,
        endLine: 1,
      },
    ];
  }

  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks: BlockRecord[] = [];
  let i = 0;
  const totalLines = lines.length;

  // Check YAML Front Matter at line 0
  if (lines[0]?.trim() === '---') {
    let endYaml = -1;
    for (let j = 1; j < Math.min(totalLines, 60); j++) {
      if (lines[j].trim() === '---' || lines[j].trim() === '...') {
        endYaml = j;
        break;
      }
    }
    if (endYaml > 0) {
      const raw = lines.slice(0, endYaml + 1).join('\n');
      blocks.push({
        id: nextBlockId(),
        type: 'frontmatter',
        raw,
        estimatedHeight: 96,
        startLine: 1,
        endLine: endYaml + 1,
      });
      i = endYaml + 1;
    }
  }

  while (i < totalLines) {
    // Skip blank separator lines between blocks
    if (lines[i].trim() === '') {
      i++;
      continue;
    }

    const startLine = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Fenced Code / Mermaid / Math block (``` or ~~~)
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fenceChars = fenceMatch[1];
      const info = fenceMatch[2].trim().toLowerCase();
      let endIdx = i + 1;
      while (endIdx < totalLines && !lines[endIdx].trim().startsWith(fenceChars)) {
        endIdx++;
      }
      if (endIdx < totalLines) endIdx++;
      const sliceLines = lines.slice(i, endIdx);
      const raw = sliceLines.join('\n');
      const blockType: BlockType =
        info === 'mermaid' ? 'mermaid' : info === 'math' || info === 'latex' ? 'math' : 'code';
      blocks.push({
        id: nextBlockId(),
        type: blockType,
        raw,
        language: info || 'text',
        estimatedHeight:
          blockType === 'mermaid' ? 220 : blockType === 'math' ? 88 : 48 + sliceLines.length * 22,
        startLine,
        endLine: endIdx,
      });
      i = endIdx;
      continue;
    }

    // 2. Display Math Block ($$ ... $$)
    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        blocks.push({
          id: nextBlockId(),
          type: 'math',
          raw: line,
          estimatedHeight: 84,
          startLine,
          endLine: i + 1,
        });
        i++;
        continue;
      }
      let endIdx = i + 1;
      while (endIdx < totalLines && !lines[endIdx].trim().endsWith('$$')) {
        endIdx++;
      }
      if (endIdx < totalLines) endIdx++;
      const raw = lines.slice(i, endIdx).join('\n');
      blocks.push({
        id: nextBlockId(),
        type: 'math',
        raw,
        estimatedHeight: 92,
        startLine,
        endLine: endIdx,
      });
      i = endIdx;
      continue;
    }

    // 3. ATX Heading (# ~ ######)
    const atxMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (atxMatch) {
      const level = atxMatch[1].length;
      blocks.push({
        id: nextBlockId(),
        type: 'heading',
        level,
        setext: false,
        raw: line,
        estimatedHeight: level === 1 ? 60 : level === 2 ? 52 : 44,
        startLine,
        endLine: i + 1,
      });
      i++;
      continue;
    }

    // 4. Horizontal Rule (---, ***, ___)
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      blocks.push({
        id: nextBlockId(),
        type: 'hr',
        raw: line,
        estimatedHeight: 36,
        startLine,
        endLine: i + 1,
      });
      i++;
      continue;
    }

    // 5. GFM Pipe Table
    if (
      trimmed.includes('|') &&
      i + 1 < totalLines &&
      /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i + 1])
    ) {
      let endIdx = i + 2;
      while (endIdx < totalLines && lines[endIdx].trim().includes('|') && lines[endIdx].trim() !== '') {
        endIdx++;
      }
      const raw = lines.slice(i, endIdx).join('\n');
      blocks.push({
        id: nextBlockId(),
        type: 'table',
        raw,
        estimatedHeight: 54 + (endIdx - i) * 38,
        startLine,
        endLine: endIdx,
      });
      i = endIdx;
      continue;
    }

    // 6. Blockquote / Callout (> [!NOTE])
    if (trimmed.startsWith('>')) {
      let endIdx = i + 1;
      while (endIdx < totalLines && lines[endIdx].trim().startsWith('>')) {
        endIdx++;
      }
      const raw = lines.slice(i, endIdx).join('\n');
      const calloutMatch = trimmed.match(/^>\s*\[!([A-Za-z]+)\]/);
      blocks.push({
        id: nextBlockId(),
        type: calloutMatch ? 'callout' : 'blockquote',
        calloutKind: calloutMatch ? calloutMatch[1].toUpperCase() : undefined,
        raw,
        estimatedHeight: 36 + (endIdx - i) * 28,
        startLine,
        endLine: endIdx,
      });
      i = endIdx;
      continue;
    }

    // 7. Task List / Bullet List / Ordered List
    const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+/);
    const ulMatch = !taskMatch ? line.match(/^\s*([-*+])\s+/) : null;
    const olMatch = line.match(/^\s*(\d+)\.\s+/);

    if (taskMatch || ulMatch || olMatch) {
      const listType: BlockType = taskMatch ? 'task' : olMatch ? 'ol' : 'ul';
      let endIdx = i + 1;
      while (endIdx < totalLines) {
        const nextLine = lines[endIdx];
        if (nextLine.trim() === '') break;
        const isNextTask = /^\s*[-*+]\s+\[[ xX]\]\s+/.test(nextLine);
        const isNextUl = !isNextTask && /^\s*[-*+]\s+/.test(nextLine);
        const isNextOl = /^\s*\d+\.\s+/.test(nextLine);
        const isIndentedCont = /^\s{2,}\S/.test(nextLine);
        if (
          (listType === 'task' && (isNextTask || isIndentedCont)) ||
          (listType === 'ul' && (isNextUl || isIndentedCont)) ||
          (listType === 'ol' && (isNextOl || isIndentedCont))
        ) {
          endIdx++;
        } else {
          break;
        }
      }
      const raw = lines.slice(i, endIdx).join('\n');
      blocks.push({
        id: nextBlockId(),
        type: listType,
        orderedStart: olMatch ? Number(olMatch[1]) : undefined,
        listMarker: ulMatch ? ulMatch[1] : undefined,
        raw,
        estimatedHeight: 16 + (endIdx - i) * 30,
        startLine,
        endLine: endIdx,
      });
      i = endIdx;
      continue;
    }

    // 8. Standalone Document/Section Transclusion Embed (![[Target#Heading|Alias]])
    if (/^!\[\[([^\][\n]+)\]\]\s*$/.test(trimmed)) {
      blocks.push({
        id: nextBlockId(),
        type: 'embed',
        raw: line,
        estimatedHeight: 168,
        startLine,
        endLine: i + 1,
      });
      i++;
      continue;
    }

    // 9. Standalone Image block (![alt](url "title"))
    if (/^!\[([^\]]*)\]\(([^)]+)\)\s*$/.test(trimmed)) {
      blocks.push({
        id: nextBlockId(),
        type: 'image',
        raw: line,
        estimatedHeight: 240,
        startLine,
        endLine: i + 1,
      });
      i++;
      continue;
    }

    // 10. Setext Heading (Text followed by === or ---)
    if (i + 1 < totalLines && /^(?:={3,}|-{3,})\s*$/.test(lines[i + 1].trim())) {
      const isH1 = lines[i + 1].trim().startsWith('=');
      const raw = `${line}\n${lines[i + 1]}`;
      blocks.push({
        id: nextBlockId(),
        type: 'heading',
        level: isH1 ? 1 : 2,
        setext: true,
        raw,
        estimatedHeight: isH1 ? 60 : 52,
        startLine,
        endLine: i + 2,
      });
      i += 2;
      continue;
    }

    // 11. Standard Paragraph (collect contiguous lines until blank line or block starter)
    let endIdx = i + 1;
    while (endIdx < totalLines) {
      const nl = lines[endIdx];
      const nt = nl.trim();
      if (
        nt === '' ||
        nt.startsWith('#') ||
        nt.startsWith('```') ||
        nt.startsWith('~~~') ||
        nt.startsWith('>') ||
        nt.startsWith('$$') ||
        /^!\[\[([^\][\n]+)\]\]\s*$/.test(nt) ||
        /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(nt) ||
        /^\s*(?:[-*+]|\d+\.)\s+/.test(nl)
      ) {
        break;
      }
      endIdx++;
    }
    const raw = lines.slice(i, endIdx).join('\n');
    const charEst = raw.length;
    blocks.push({
      id: nextBlockId(),
      type: 'paragraph',
      raw,
      estimatedHeight: Math.max(38, Math.ceil(charEst / 46) * 28 + 12),
      startLine,
      endLine: endIdx,
    });
    i = endIdx;
  }

  if (blocks.length === 0) {
    blocks.push({
      id: nextBlockId(),
      type: 'paragraph',
      raw: '',
      estimatedHeight: 40,
      startLine: 1,
      endLine: 1,
    });
  }

  return blocks;
}

/**
 * Serializes `BlockRecord[]` back to clean Markdown while preserving untouched raw block syntax.
 */
export function serializeBlocksLossless(blocks: BlockRecord[], lineEnding: 'lf' | 'crlf' = 'lf'): string {
  const joined = blocks.map((b) => b.raw).join('\n\n');
  return lineEnding === 'crlf' ? joined.replace(/\n/g, '\r\n') : joined;
}

/**
 * Fenwick Tree (Binary Indexed Tree) for O(log N) scroll-offset virtualization.
 * Mirrors `crates/vellum-core/src/fenwick_viewport.rs`.
 */
export class FenwickHeightTree {
  private heights: number[];
  private tree: Float64Array;
  public totalHeight: number;

  constructor(initialHeights: number[]) {
    const n = initialHeights.length;
    this.heights = initialHeights.slice();
    this.tree = new Float64Array(n + 1);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const h = initialHeights[i];
      sum += h;
      let idx = i + 1;
      while (idx <= n) {
        this.tree[idx] += h;
        idx += idx & -idx;
      }
    }
    this.totalHeight = sum;
  }

  update(index: number, nextHeight: number): boolean {
    if (index < 0 || index >= this.heights.length) return false;
    const prev = this.heights[index];
    if (Math.abs(prev - nextHeight) < 1) return false;
    const delta = nextHeight - prev;
    this.heights[index] = nextHeight;
    this.totalHeight += delta;
    const n = this.heights.length;
    let idx = index + 1;
    while (idx <= n) {
      this.tree[idx] += delta;
      idx += idx & -idx;
    }
    return true;
  }

  prefixSum(count: number): number {
    let idx = Math.max(0, Math.min(count, this.heights.length));
    let sum = 0;
    while (idx > 0) {
      sum += this.tree[idx];
      idx -= idx & -idx;
    }
    return sum;
  }

  findBlockAtOffset(scrollTop: number): number {
    const n = this.heights.length;
    if (n === 0 || scrollTop <= 0) return 0;
    let idx = 0;
    let acc = 0;
    let bit = 1;
    while (bit << 1 <= n) bit <<= 1;
    while (bit > 0) {
      const next = idx + bit;
      if (next <= n && acc + this.tree[next] < scrollTop) {
        idx = next;
        acc += this.tree[next];
      }
      bit >>= 1;
    }
    return Math.min(idx, n - 1);
  }
}

export function extractOutline(blocks: BlockRecord[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'heading') {
      const firstLine = b.raw.split('\n')[0] || '';
      const clean = firstLine
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*|~~|`/g, '')
        .trim();
      if (clean) {
        nodes.push({
          blockIndex: i,
          blockId: b.id,
          level: b.level || 1,
          text: clean,
        });
      }
    }
  }
  return nodes;
}

export function parseGfmTable(raw: string): ParsedTable | null {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const splitRow = (line: string): string[] => {
    const stripped = line.replace(/^\|/, '').replace(/\|$/, '');
    return stripped.split('|').map((cell) => cell.trim());
  };

  const headers = splitRow(lines[0]);
  if (headers.length === 0) return null;
  const colCount = headers.length;
  const alignSpec = splitRow(lines[1]);

  const alignments: ColumnAlign[] = headers.map((_, idx) => {
    const spec = (alignSpec[idx] || '---').trim();
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return 'none';
  });

  const rows: string[][] = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    while (cells.length < colCount) cells.push('');
    return cells.slice(0, colCount);
  });

  return { headers, alignments, rows };
}

export function serializeGfmTable(table: ParsedTable): string {
  const headerLine = `| ${table.headers.map((h) => h.replace(/\n/g, '<br>')).join(' | ')} |`;
  const delimLine = `| ${table.alignments
    .map((a) => (a === 'left' ? ':---' : a === 'center' ? ':---:' : a === 'right' ? '---:' : '---'))
    .join(' | ')} |`;
  const bodyLines = table.rows.map(
    (row) => `| ${table.headers.map((_, i) => (row[i] ?? '').replace(/\n/g, '<br>')).join(' | ')} |`
  );
  return [headerLine, delimLine, ...bodyLines].join('\n');
}

/**
 * Converts pasted rich HTML (from web pages, Word, Feishu, Notion, Excel) into clean GFM Markdown (`PRD IO-01`).
 */
export function convertHtmlToCleanMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const inner = Array.from(el.childNodes).map(walk).join('');

    switch (tag) {
      case 'h1':
        return `\n# ${inner.trim()}\n\n`;
      case 'h2':
        return `\n## ${inner.trim()}\n\n`;
      case 'h3':
        return `\n### ${inner.trim()}\n\n`;
      case 'h4':
        return `\n#### ${inner.trim()}\n\n`;
      case 'h5':
        return `\n##### ${inner.trim()}\n\n`;
      case 'h6':
        return `\n###### ${inner.trim()}\n\n`;
      case 'strong':
      case 'b':
        return inner.trim() ? `**${inner.trim()}**` : '';
      case 'em':
      case 'i':
        return inner.trim() ? `*${inner.trim()}*` : '';
      case 'del':
      case 's':
        return inner.trim() ? `~~${inner.trim()}~~` : '';
      case 'mark':
        return inner.trim() ? `==${inner.trim()}==` : '';
      case 'code':
        if (el.parentElement?.tagName.toLowerCase() === 'pre') return inner;
        return `\`${inner}\``;
      case 'pre': {
        const codeEl = el.querySelector('code');
        const langMatch = codeEl?.className.match(/language-([a-z0-9_-]+)/i);
        const lang = langMatch ? langMatch[1] : '';
        return `\n\`\`\`${lang}\n${(codeEl?.textContent || el.textContent || '').trim()}\n\`\`\`\n\n`;
      }
      case 'a': {
        const href = el.getAttribute('href') || '';
        if (!href || href.startsWith('javascript:')) return inner;
        return `[${inner.trim() || href}](${href})`;
      }
      case 'img': {
        const src = el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || 'image';
        return src ? `![${alt}](${src})` : '';
      }
      case 'blockquote':
        return (
          '\n' +
          inner
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n') +
          '\n\n'
        );
      case 'ul': {
        const items = Array.from(el.children)
          .filter((c) => c.tagName.toLowerCase() === 'li')
          .map((li) => `- ${walk(li).trim()}`)
          .join('\n');
        return `\n${items}\n\n`;
      }
      case 'ol': {
        const items = Array.from(el.children)
          .filter((c) => c.tagName.toLowerCase() === 'li')
          .map((li, idx) => `${idx + 1}. ${walk(li).trim()}`)
          .join('\n');
        return `\n${items}\n\n`;
      }
      case 'table': {
        const trs = Array.from(el.querySelectorAll('tr'));
        if (trs.length === 0) return inner;
        const matrix = trs.map((tr) =>
          Array.from(tr.querySelectorAll('th, td')).map((cell) =>
            (cell.textContent || '').trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
          )
        );
        const cols = Math.max(...matrix.map((r) => r.length), 1);
        const head = matrix[0] || Array(cols).fill('');
        while (head.length < cols) head.push('');
        const parsed: ParsedTable = {
          headers: head,
          alignments: Array(cols).fill('none'),
          rows: matrix.slice(1).map((r) => {
            const copy = r.slice(0, cols);
            while (copy.length < cols) copy.push('');
            return copy;
          }),
        };
        return `\n${serializeGfmTable(parsed)}\n\n`;
      }
      case 'hr':
        return `\n---\n\n`;
      case 'br':
        return '\n';
      case 'p':
      case 'div':
        return inner.trim() ? `${inner.trim()}\n\n` : '';
      case 'script':
      case 'style':
        return '';
      default:
        return inner;
    }
  };

  return walk(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MermaidDiagramGraph {
  direction: 'LR' | 'TD';
  nodes: Array<{ id: string; label: string; shape: 'rect' | 'round' | 'diamond' }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  error?: string;
}

/**
 * Lightweight zero-dependency Mermaid flowchart parser (`PRD CD-04`) for instant <0.3ms SVG rendering.
 */
export function parseMermaidFlowchart(rawBlock: string): MermaidDiagramGraph {
  const lines = rawBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('```') && !l.startsWith('%%'));

  if (lines.length === 0) {
    return { direction: 'LR', nodes: [], edges: [], error: '图表内容为空' };
  }

  const header = lines[0];
  const headerMatch = header.match(/^(?:graph|flowchart)\s+(LR|RL|TD|TB|BT)?/i);
  if (!headerMatch) {
    return {
      direction: 'LR',
      nodes: [],
      edges: [],
      error: `第 1 行语法提示：请以 "graph LR" 或 "flowchart TD" 开头（当前："${header}"）`,
    };
  }

  const dirRaw = (headerMatch[1] || 'LR').toUpperCase();
  const direction: 'LR' | 'TD' = dirRaw === 'LR' || dirRaw === 'RL' ? 'LR' : 'TD';
  const nodeMap = new Map<string, { id: string; label: string; shape: 'rect' | 'round' | 'diamond' }>();
  const edges: Array<{ from: string; to: string; label?: string }> = [];

  const registerNode = (token: string): string => {
    const trimmed = token.trim();
    const rectMatch = trimmed.match(/^([A-Za-z0-9_-]+)\[([^\]]+)\]$/);
    if (rectMatch) {
      nodeMap.set(rectMatch[1], { id: rectMatch[1], label: rectMatch[2], shape: 'rect' });
      return rectMatch[1];
    }
    const roundMatch = trimmed.match(/^([A-Za-z0-9_-]+)\(([^)]+)\)$/);
    if (roundMatch) {
      nodeMap.set(roundMatch[1], { id: roundMatch[1], label: roundMatch[2], shape: 'round' });
      return roundMatch[1];
    }
    const diamondMatch = trimmed.match(/^([A-Za-z0-9_-]+)\{([^}]+)\}$/);
    if (diamondMatch) {
      nodeMap.set(diamondMatch[1], { id: diamondMatch[1], label: diamondMatch[2], shape: 'diamond' });
      return diamondMatch[1];
    }
    const bareId = trimmed.replace(/[^A-Za-z0-9_-]/g, '') || 'Node';
    if (!nodeMap.has(bareId)) {
      nodeMap.set(bareId, { id: bareId, label: bareId, shape: 'rect' });
    }
    return bareId;
  };

  for (let idx = 1; idx < lines.length; idx++) {
    const stmt = lines[idx];
    const edgeMatch = stmt.match(/^(.+?)\s*--+(?:\|([^|]+)\|)?\s*>+\s*(.+)$/);
    if (edgeMatch) {
      const fromId = registerNode(edgeMatch[1]);
      const toId = registerNode(edgeMatch[3]);
      edges.push({
        from: fromId,
        to: toId,
        label: edgeMatch[2]?.trim(),
      });
    } else {
      registerNode(stmt);
    }
  }

  return {
    direction,
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}

export function computeClientMetrics(markdown: string, blockCount: number) {
  const byteLen = new TextEncoder().encode(markdown).length;
  let wordCount = 0;
  let inLatin = false;
  for (let i = 0; i < markdown.length; i++) {
    const c = markdown.charCodeAt(i);
    const isCjk =
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3040 && c <= 0x30ff);
    const isAlpha =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (isCjk) {
      wordCount++;
      inLatin = false;
    } else if (isAlpha) {
      if (!inLatin) {
        wordCount++;
        inLatin = true;
      }
    } else {
      inLatin = false;
    }
  }
  const lineCount = markdown ? markdown.split(/\r?\n/).length : 1;
  const estimatedRopeKb = Math.max(4, Math.round((byteLen * 1.12 + blockCount * 64) / 1024));
  return {
    byteLen,
    wordCount,
    lineCount,
    blockCount,
    readingMinutes: Math.max(1, Math.round(wordCount / 450)),
    estimatedRopeKb,
  };
}
