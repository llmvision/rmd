import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const WORKSPACE_DIR = path.resolve(__dirname, 'workspace-docs');
const ASSETS_DIR = path.join(WORKSPACE_DIR, 'assets');
const SNAPSHOTS_DIR = path.join(WORKSPACE_DIR, '.snapshots');
const INDEX_FILE = path.join(WORKSPACE_DIR, 'manifest.json');
const CRATES_DIR = path.resolve(__dirname, 'crates');

interface DocumentStats {
  byteLen: number;
  charCount: number;
  wordCount: number;
  lineCount: number;
  blockCount: number;
  readingMinutes: number;
  checksum: string;
  lineEnding: 'lf' | 'crlf';
}

interface DocumentMeta {
  id: string;
  title: string;
  filename: string;
  revision: number;
  updatedAt: number;
  createdAt: number;
  stats: DocumentStats;
}

interface SnapshotRecord {
  snapshotId: string;
  createdAt: number;
  label: string;
  revision: number;
  stats: DocumentStats;
  content: string;
}

function computeStats(content: string): DocumentStats {
  const byteLen = Buffer.byteLength(content, 'utf8');
  const charCount = Array.from(content).length;
  const lineEnding: 'lf' | 'crlf' = content.includes('\r\n') ? 'crlf' : 'lf';
  const lines = content.split(/\r?\n/);
  const lineCount = lines.length;

  // Estimate block count via blank-line / fenced-code / heading transitions
  let blockCount = 0;
  let inFence = false;
  let inParagraph = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inFence) {
        blockCount++;
        inFence = true;
      } else {
        inFence = false;
      }
      inParagraph = false;
      continue;
    }
    if (inFence) continue;
    if (trimmed.length === 0) {
      inParagraph = false;
    } else if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.+\||---+$|\*\*\*+$)/.test(trimmed)) {
      blockCount++;
      inParagraph = false;
    } else if (!inParagraph) {
      blockCount++;
      inParagraph = true;
    }
  }

  // Count CJK characters + contiguous alphanumeric words
  let wordCount = 0;
  let inAsciiWord = false;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff);
    const isAlphaNum =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    if (isCjk) {
      wordCount++;
      inAsciiWord = false;
    } else if (isAlphaNum) {
      if (!inAsciiWord) {
        wordCount++;
        inAsciiWord = true;
      }
    } else {
      inAsciiWord = false;
    }
  }

  const checksum = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  const readingMinutes = Math.max(1, Math.round(wordCount / 450));

  return {
    byteLen,
    charCount,
    wordCount,
    lineCount,
    blockCount: Math.max(1, blockCount),
    readingMinutes,
    checksum,
    lineEnding,
  };
}

async function atomicWriteFile(targetPath: string, data: string | Buffer): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, data);
  await fsp.rename(tmpPath, targetPath);
}

async function loadManifest(): Promise<DocumentMeta[]> {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    return JSON.parse(raw) as DocumentMeta[];
  } catch {
    return [];
  }
}

async function saveManifest(items: DocumentMeta[]): Promise<void> {
  await atomicWriteFile(INDEX_FILE, JSON.stringify(items, null, 2));
}

interface ExtractedWikiLink {
  rawToken: string;
  targetName: string;
  headingAnchor?: string;
  displayAlias?: string;
  kind: 'wikilink' | 'embed';
  lineNumber: number;
  contextExcerpt: string;
}

function normalizeNoteKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseInnerWikiSpec(inner: string): {
  targetName: string;
  headingAnchor?: string;
  displayAlias?: string;
} {
  const pipeIdx = inner.indexOf('|');
  const targetAndAnchor = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
  const displayAlias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() || undefined : undefined;
  const hashIdx = targetAndAnchor.indexOf('#');
  if (hashIdx >= 0) {
    const targetName = targetAndAnchor.slice(0, hashIdx).trim();
    const headingAnchor = targetAndAnchor.slice(hashIdx + 1).trim() || undefined;
    return { targetName, headingAnchor, displayAlias };
  }
  return { targetName: targetAndAnchor, displayAlias };
}

function extractWikiLinksFromMarkdown(markdown: string): ExtractedWikiLink[] {
  const results: ExtractedWikiLink[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Mask inline code spans with spaces of equal length so indices remain aligned
    const maskedLine = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    const re = /(!?)\[\[([^\][\n]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(maskedLine)) !== null) {
      const isEmbed = match[1] === '!';
      const rawInner = line.slice(match.index + (isEmbed ? 3 : 2), match.index + match[0].length - 2);
      const parsed = parseInnerWikiSpec(rawInner);
      if (!parsed.targetName) continue;

      const cleanExcerpt = line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .trim()
        .slice(0, 140);

      results.push({
        rawToken: line.slice(match.index, match.index + match[0].length),
        targetName: parsed.targetName,
        headingAnchor: parsed.headingAnchor,
        displayAlias: parsed.displayAlias,
        kind: isEmbed ? 'embed' : 'wikilink',
        lineNumber: i + 1,
        contextExcerpt: cleanExcerpt || parsed.targetName,
      });
    }
  }
  return results;
}

function extractSectionOrDocExcerpt(markdown: string, headingAnchor?: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let startIdx = 0;

  // Skip YAML Front Matter if present
  if (lines[0]?.trim() === '---') {
    for (let j = 1; j < Math.min(lines.length, 50); j++) {
      if (lines[j].trim() === '---' || lines[j].trim() === '...') {
        startIdx = j + 1;
        break;
      }
    }
  }

  if (headingAnchor && headingAnchor.trim()) {
    const targetNorm = normalizeNoteKey(headingAnchor.replace(/[`*~]/g, ''));
    let matchedStart = -1;
    let matchedLevel = 6;
    for (let i = startIdx; i < lines.length; i++) {
      const hm = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        const headingClean = normalizeNoteKey(hm[2].replace(/[`*~]/g, ''));
        if (headingClean === targetNorm || headingClean.includes(targetNorm)) {
          matchedStart = i;
          matchedLevel = hm[1].length;
          break;
        }
      }
    }
    if (matchedStart >= 0) {
      let endIdx = lines.length;
      for (let k = matchedStart + 1; k < lines.length; k++) {
        const nextHm = lines[k].match(/^(#{1,6})\s+/);
        if (nextHm && nextHm[1].length <= matchedLevel) {
          endIdx = k;
          break;
        }
      }
      return lines
        .slice(matchedStart, Math.min(endIdx, matchedStart + 18))
        .join('\n')
        .trim();
    }
  }

  // Otherwise return a concise body excerpt (skipping top H1 title and self-embeds to prevent loops)
  const bodyLines: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const t = lines[i].trim();
    if (bodyLines.length === 0 && (t === '' || /^#\s+/.test(t))) continue;
    if (/^!\[\[[^\]]+\]\]$/.test(t)) continue;
    bodyLines.push(lines[i]);
    if (bodyLines.length >= 10) break;
  }
  return bodyLines.join('\n').trim();
}

function rewriteWikiLinksForRename(
  markdown: string,
  oldTitle: string,
  newTitle: string
): { content: string; count: number } {
  const oldNorm = normalizeNoteKey(oldTitle);
  if (!oldNorm || oldNorm === normalizeNoteKey(newTitle)) {
    return { content: markdown, count: 0 };
  }
  let count = 0;
  const lines = markdown.split('\n');
  let inFence = false;
  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(/(!?)\[\[([^\][\n]+)\]\]/g, (full, bang: string, inner: string) => {
      const parsed = parseInnerWikiSpec(inner);
      if (normalizeNoteKey(parsed.targetName) !== oldNorm) {
        return full;
      }
      count++;
      const anchorPart = parsed.headingAnchor ? `#${parsed.headingAnchor}` : '';
      const aliasPart = parsed.displayAlias ? `|${parsed.displayAlias}` : '';
      return `${bang}[[${newTitle}${anchorPart}${aliasPart}]]`;
    });
  });

  return { content: updatedLines.join('\n'), count };
}

const ARCH_DOC_CONTENT = `---
title: Vellum (Rust + Axum + GPUI) 高性能架构与渲染设计
version: 0.2.0
engine: ropey + pulldown-cmark + Fenwick Virtualizer + KnowledgeGraphIndex
sync_reserve: yrs (CRDT Phase 2)
---

# Rust + Axum + GPUI 高性能架构白皮书

> [!NOTE]
> 本文档正在 **即时渲染（WYSIWYG）** 模式下运行，并已接入 **本地知识网络（双向链接 + 块级引用嵌入）**。点击正文中任意蓝色双向链接可直接跳转目标笔记或定位章节；点击底部或左侧「双链」面板可查看所有反向引用上下文。

## 1. 核心架构：为什么选择 Rust + Axum + GPUI

传统富文本编辑器在处理 **10 万字以上** 的大型 Markdown 技术手册时，往往因为全量构建重型 DOM 树导致内存飙升至数百 MB 且输入延迟超过 120 ms。Vellum 基于 [[Ropey 零拷贝文本树原理]] 与 [[Markdown 所见即所得编辑器 PRD (V1.0)|产品需求规范 V1.0]] 构建三层解耦的原生本地优先架构，并预留 [[CRDT 多端协同与增量同步设计#增量状态向量同步|Phase 2 多端协同协议]]：

\`\`\`mermaid
graph LR
  A[本地 .md 笔记库] --> B[vellum-core: Ropey 文本树]
  B --> C[KnowledgeGraph 双链图索引]
  B --> D[Fenwick 前缀和虚拟视口]
  D --> E[GPUI GPU 原生即时渲染]
  C --> F[Axum RESTful API 服务]
\`\`\`

### 1.1 关键子系统职责对比

| 模块层级 | Rust Crate / 实现 | 核心数据结构 | 复杂度与内存目标 |
| :--- | :--- | :---: | ---: |
| 文本缓冲与往返保真 | \`crates/vellum-core\` | \`ropey::Rope\` + \`Range<usize>\` | 内存开销 $< 1.15\\times$ 原始字节 |
| 双向链接与图谱引擎 | \`knowledge_graph.rs\` | 正反向邻接表 + 引用重写器 | 1,000 篇文档图谱构建 $< 4\\text{ ms}$ |
| 视口虚拟化引擎 | \`FenwickHeightTree\` | 树状数组高度前缀和 + 视口窗口 | 10 万字仅挂载 $\\sim 32$ 个可见块 |
| 本地与同步接口 | \`crates/vellum-server\` (Axum) | \`RwLock\` + POSIX 原子重命名写入 | 零文件损坏风险 · 预留 CRDT 增量流 |
| GPU 原生渲染层 | \`crates/vellum-gpui\` (GPUI) | \`gpui::list\` + \`KnowledgeGraphView\` | 120 FPS 渲染 · 完整中文输入法保护 |

### 1.2 跨文档实时嵌入预览（Transclusion）

下方卡片通过 \`![[Ropey 零拷贝文本树原理#核心复杂度保证]]\` 语法实时嵌入自另一篇笔记，源文档更新后此处自动同步：

![[Ropey 零拷贝文本树原理#核心复杂度保证]]

## 2. 视口虚拟化与编辑延迟数学模型

对于包含 $N$ 个块级节点（段落、表格、代码块）的超大文档，我们将每个块的预估与实测渲染高度 $h_i$ 维护在树状数组（Fenwick Tree）中。任意滚动纵坐标 $Y_{\\text{scroll}}$ 定位首屏可见块索引 $k$ 的查询复杂度严格收敛在：

$$k = \\min \\left\\{ m \\in [1, N] \\;\\middle|\\; \\sum_{i=1}^{m} h_i \\ge Y_{\\text{scroll}} \\right\\}, \\quad T_{\\text{lookup}} = \\mathcal{O}(\\log_2 N)$$

单次键盘输入的总帧耗时预算满足 $T_{\\text{frame}} = T_{\\text{rope}} + T_{\\text{dirty\\_parse}} + T_{\\text{paint}} \\le 8.33\\text{ ms}$，即使面对 ==50 万字超长文档== 也能保持丝滑跟手与极低内存占用[^1]。后续扩展体系还将引入 [[插件沙箱安全模型]] 以隔离第三方渲染器权限。

## 3. 当前阶段特性核验与迭代路线清单

- [x] **即时渲染与源码无损切换**：支持按 <kbd>Ctrl</kbd> + <kbd>/</kbd>（macOS 为 <kbd>Cmd</kbd> + <kbd>/</kbd>）保持光标与滚动位置切换
- [x] **文档引用与双向连接网络**：支持 \`[[文档#章节|别名]]\` 跳转、\`![[文档#章节]]\` 跨文档嵌入、反向链接上下文与未链接提及自动识别
- [x] **重命名全库引用重构**：修改文档标题时原子同步改写工作区内全部关联 \`[[WikiLink]]\`，杜绝死链
- [x] **中文 IME 组合输入保护**：拼音选词期间（\`compositionstart\` 至 \`compositionend\`）绝不误触发转换或吞字
- [x] **交互式 GFM 表格与斜杠菜单**：支持单元格内 <kbd>Tab</kbd> 跳转、列对齐写回及行首 \`/\` 拼音模糊命令检索
- [ ] **Phase 2 多端增量状态同步**：对接 [[CRDT 多端协同与增量同步设计]] 实现断网合并与协作者光标广播
- [ ] **Wasm 插件能力沙箱隔离**：落地 [[插件沙箱安全模型]] 中的白名单系统调用与无网络渲染器隔离
- [ ] **离线 PDF 矢量排版导出**：基于原生字体子集化引擎输出书签目录与矢量数学公式
- [ ] **Wayland 与 macOS Metal 帧率基准回归**：在 4K 120Hz 显示器上自动化验证 [[Ropey 零拷贝文本树原理#核心复杂度保证]] 滚动帧耗时

## 4. Axum 原子持久化与增量块补丁示例

\`\`\`rust
/// Crash-safe atomic persistence in crates/vellum-server/src/state.rs
async fn atomic_write_md(dir: &PathBuf, id: &str, content: &str) -> Result<(), String> {
    let tmp_path = dir.join(format!(".{}.md.tmp", id));
    let final_path = dir.join(format!("{}.md", id));
    tokio::fs::write(&tmp_path, content.as_bytes()).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp_path, &final_path).await.map_err(|e| e.to_string())?;
    Ok(())
}
\`\`\`

[^1]: 可点击顶部导航栏中的「大文件压测」一键生成 1 万字、10 万字或 30 万字真实结构化文档并实测解析耗时与挂载节点数。
`;

const ROPEY_NOTE_CONTENT = `# Ropey 零拷贝文本树原理

在 [[Rust + Axum + GPUI 高性能架构白皮书]] 中，编辑内核摒弃了传统的连续 \`String\` 数组与重型对象 AST，转而采用 \`ropey::Rope\`（基于 UTF-8 字节与字符双索引的 B-Tree 绳索结构）作为唯一运行时数据真源。

## 核心复杂度保证

- **任意位置插入与删除**：时间复杂度严格保持 $\\mathcal{O}(\\log N)$，即使在 30 万字文档头部连续输入也不会触发整块内存搬移。
- **零拷贝快照（Copy-on-Write）**：每次编辑或后台交给 Axum 落盘时，\`Rope::clone()\` 仅增加 B-Tree 根节点引用计数（耗时 $< 50\\text{ ns}$），完全不阻塞 GPUI 主线程渲染。
- **字节偏移与行号双向映射**：通过 \`byte_to_line\` 与 \`line_to_byte\` 直接对接 \`pulldown-cmark\` 的字节切片范围，实现未改动块 100% 原样写回。

## 与协同及安全模块的衔接

当本地文本切片发生变更时，增量字节区间可直接映射至 [[CRDT 多端协同与增量同步设计]] 中的逻辑时钟事务；同时自定义语法钩子运行于受限的 [[插件沙箱安全模型]] 之内，确保本地知识库零数据泄露。
`;

const CRDT_NOTE_CONTENT = `# CRDT 多端协同与增量同步设计

本设计对应 [[Markdown 所见即所得编辑器 PRD (V1.0)|PRD 需求文档]] 第 6.8 节与第 7.2 节的本地优先协同路线：客户端在离线断网状态下可无感编辑本地 \`.md\` 文件，网络恢复后与远端 \`vellum-server\` 自动合并冲突。

## 增量状态向量同步

1. **本地持久化优先**：每次保存优先通过 POSIX 原子替换更新本地 Markdown 文件，保证文件可随时用 Git 或任意纯文本工具打开。
2. **State Vector 差异交换**：连接服务端时仅上传缺失的二进制 Update 增量包，而非整篇重传大文档。
3. **双向知识图谱同步**：新增或重命名的 \`[[双向链接]]\` 会在服务端 \`KnowledgeGraphIndex\` 中实时触发增量拓扑更新。

## 关联底层存储依赖

底层字符偏移对齐直接建立在 [[Ropey 零拷贝文本树原理#核心复杂度保证]] 之上，同时遵循 Rust + Axum + GPUI 高性能架构白皮书 定义的帧预算指标（注：本句特意以纯文本提及白皮书标题，可在白皮书的「双链 → 潜在提及」中体验一键转为双向链接）。
`;

const PLAYGROUND_DOC_CONTENT = `# 快速上手与输入规则演练场

欢迎体验 **Vellum** 本地所见即所得 Markdown 编辑器。你可以直接在下方任意位置点击并开始写作，所有更改均通过 \`/api/v1/documents\` 接口原子保存至本地工作区文件，并实时编入顶部的「知识图谱」。

## 试试文档引用与双向链接

1. **键入 \`[[\` 自动补全知识节点**：在任意段落输入 \`[[\` 即可唤起工作区文档与 \`#章节\` 联想菜单，例如跳转到 [[Rust + Axum + GPUI 高性能架构白皮书]] 或 [[Ropey 零拷贝文本树原理]]。
2. **跨文档内容嵌入（Transclusion）**：独占一行输入 \`![[CRDT 多端协同与增量同步设计#增量状态向量同步]]\` 或通过 \`/embed\` 斜杠命令插入实时引用卡片：

![[CRDT 多端协同与增量同步设计#增量状态向量同步]]

3. **悬空节点一键创建**：点击尚未创建的虚线链接 [[插件沙箱安全模型]]，系统会自动新建对应文档并建立双向连接。
4. **斜杠命令面板**：新建空行并输入 \`/\`（支持拼音缩写，如 \`/sl\` 插入双链、\`/yyk\` 嵌入文档块、\`/bg\` 插入表格、\`/gs\` 插入公式）。

> [!TIP]
> 打开左侧边栏的「双链」标签页或滚动至文档底部，即可检视所有引用了当前文档的反向链接上下文，以及可一键关联的潜在未链接提及。

| 快捷功能 | Windows / Linux | macOS |
| :--- | :--- | :--- |
| 切换即时渲染 / 源码模式 | \`Ctrl + /\` | \`Cmd + /\` |
| 插入双向链接 \`[[文档]]\` | \`Ctrl + K\` | \`Cmd + K\` |
| 查找与正则替换 | \`Ctrl + F\` / \`Ctrl + H\` | \`Cmd + F\` / \`Cmd + Option + F\` |
| 创建本地版本快照 | \`Ctrl + S\` | \`Cmd + S\` |

## 演练场个人待办清单（可切换至「任务看板」拖拽状态）

- [ ] 尝试在正文中输入 \`[[\` 并关联一篇现有笔记
- [ ] 在顶部「任务看板」视图中将本卡片拖拽至「已完成」栏，观察 Markdown 源码同步变为 \`- [x]\`
- [x] 打开快速上手演练场并体验即时渲染排版
`;

async function ensureWorkspaceInitialized(): Promise<void> {
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  await fsp.mkdir(SNAPSHOTS_DIR, { recursive: true });

  let manifest = await loadManifest();
  const now = Date.now();

  if (manifest.length === 0) {
    const initialDocs: Array<{ id: string; title: string; content: string }> = [
      {
        id: 'rust-axum-gpui-arch',
        title: 'Rust + Axum + GPUI 高性能架构白皮书',
        content: ARCH_DOC_CONTENT,
      },
      {
        id: 'ropey-zero-copy-kernel',
        title: 'Ropey 零拷贝文本树原理',
        content: ROPEY_NOTE_CONTENT,
      },
      {
        id: 'crdt-sync-protocol',
        title: 'CRDT 多端协同与增量同步设计',
        content: CRDT_NOTE_CONTENT,
      },
    ];

    const prdPath = path.resolve(
      __dirname,
      'public/assets/aistudio/Markdown_______WYSIWYG___________PRD__dd8cd4fd.md'
    );
    if (fs.existsSync(prdPath)) {
      const prdContent = await fsp.readFile(prdPath, 'utf8');
      initialDocs.push({
        id: 'prd-wysiwyg-spec',
        title: 'Markdown 所见即所得编辑器 PRD (V1.0)',
        content: prdContent,
      });
    }

    initialDocs.push({
      id: 'interactive-playground',
      title: '快速上手与输入规则演练场',
      content: PLAYGROUND_DOC_CONTENT,
    });

    for (let i = 0; i < initialDocs.length; i++) {
      const item = initialDocs[i];
      const filePath = path.join(WORKSPACE_DIR, `${item.id}.md`);
      await atomicWriteFile(filePath, item.content);
      const stats = computeStats(item.content);
      manifest.push({
        id: item.id,
        title: item.title,
        filename: `${item.id}.md`,
        revision: 1,
        createdAt: now - (initialDocs.length - i) * 60_000,
        updatedAt: now - (initialDocs.length - i) * 60_000,
        stats,
      });

      const snap: SnapshotRecord[] = [
        {
          snapshotId: crypto.randomUUID(),
          createdAt: now,
          label: '初始版本 #1',
          revision: 1,
          stats,
          content: item.content,
        },
      ];
      await atomicWriteFile(path.join(SNAPSHOTS_DIR, `${item.id}.json`), JSON.stringify(snap));
    }

    await saveManifest(manifest);
    await atomicWriteFile(path.join(WORKSPACE_DIR, '.seed-kg-v4'), 'ok');
    return;
  }

  // Upgrade existing v1 workspace once to weave the interconnected Knowledge Network without losing user docs
  const kgMarker = path.join(WORKSPACE_DIR, '.seed-kg-v4');
  if (!fs.existsSync(kgMarker)) {
    const seedAdditions: Array<{ id: string; title: string; content: string }> = [
      {
        id: 'ropey-zero-copy-kernel',
        title: 'Ropey 零拷贝文本树原理',
        content: ROPEY_NOTE_CONTENT,
      },
      {
        id: 'crdt-sync-protocol',
        title: 'CRDT 多端协同与增量同步设计',
        content: CRDT_NOTE_CONTENT,
      },
    ];

    for (const extra of seedAdditions) {
      if (!manifest.some((d) => d.id === extra.id)) {
        await atomicWriteFile(path.join(WORKSPACE_DIR, `${extra.id}.md`), extra.content);
        const stats = computeStats(extra.content);
        manifest.push({
          id: extra.id,
          title: extra.title,
          filename: `${extra.id}.md`,
          revision: 1,
          createdAt: now - 30_000,
          updatedAt: now - 30_000,
          stats,
        });
        const snap: SnapshotRecord[] = [
          {
            snapshotId: crypto.randomUUID(),
            createdAt: now,
            label: '知识网络节点初始化 #1',
            revision: 1,
            stats,
            content: extra.content,
          },
        ];
        await atomicWriteFile(path.join(SNAPSHOTS_DIR, `${extra.id}.json`), JSON.stringify(snap));
      }
    }

    // Upgrade seed demo docs once so bidirectional links & transclusions work out of the box
    const upgradeTargets: Array<{ id: string; title: string; content: string }> = [
      {
        id: 'rust-axum-gpui-arch',
        title: 'Rust + Axum + GPUI 高性能架构白皮书',
        content: ARCH_DOC_CONTENT,
      },
      {
        id: 'interactive-playground',
        title: '快速上手与输入规则演练场',
        content: PLAYGROUND_DOC_CONTENT,
      },
    ];

    for (const up of upgradeTargets) {
      const mIdx = manifest.findIndex((d) => d.id === up.id);
      if (mIdx >= 0) {
        await atomicWriteFile(path.join(WORKSPACE_DIR, `${up.id}.md`), up.content);
        manifest[mIdx] = {
          ...manifest[mIdx],
          title: up.title,
          updatedAt: now,
          stats: computeStats(up.content),
        };
      }
    }

    await saveManifest(manifest);
    await atomicWriteFile(kgMarker, 'ok');
  }

  // Sync source-tree `docs/BUILD_AND_DEPLOYMENT.md` & `docs/ARCHITECTURE_AND_API.md` into workspace-docs
  const docsMarker = path.join(WORKSPACE_DIR, '.seed-docs-v10');
  if (!fs.existsSync(docsMarker)) {
    const repoDocs: Array<{ id: string; title: string; relPath: string }> = [
      {
        id: 'build-and-deployment',
        title: '本地编译与服务端部署完整指南',
        relPath: 'docs/BUILD_AND_DEPLOYMENT.md',
      },
      {
        id: 'architecture-and-api',
        title: '核心架构与 Axum RESTful API 手册',
        relPath: 'docs/ARCHITECTURE_AND_API.md',
      },
    ];

    for (const docSpec of repoDocs) {
      const fullDocPath = path.resolve(__dirname, docSpec.relPath);
      if (fs.existsSync(fullDocPath)) {
        const docContent = await fsp.readFile(fullDocPath, 'utf8');
        await atomicWriteFile(path.join(WORKSPACE_DIR, `${docSpec.id}.md`), docContent);
        const stats = computeStats(docContent);
        const existingIdx = manifest.findIndex((m) => m.id === docSpec.id);
        if (existingIdx >= 0) {
          manifest[existingIdx] = {
            ...manifest[existingIdx],
            title: docSpec.title,
            updatedAt: now,
            stats,
          };
        } else {
          manifest.unshift({
            id: docSpec.id,
            title: docSpec.title,
            filename: `${docSpec.id}.md`,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            stats,
          });
          const snap: SnapshotRecord[] = [
            {
              snapshotId: crypto.randomUUID(),
              createdAt: now,
              label: '源码内置工程文档 #1',
              revision: 1,
              stats,
              content: docContent,
            },
          ];
          await atomicWriteFile(
            path.join(SNAPSHOTS_DIR, `${docSpec.id}.json`),
            JSON.stringify(snap)
          );
        }
      }
    }

    await saveManifest(manifest);
    await atomicWriteFile(docsMarker, 'ok');
  }
}

function detectSourceLanguage(filename: string): string {
  if (filename.endsWith('.rs')) return 'rust';
  if (filename.endsWith('.toml')) return 'toml';
  if (filename.endsWith('.yml') || filename.endsWith('.yaml')) return 'yaml';
  if (filename.endsWith('.sh') || filename === 'Dockerfile' || filename.endsWith('.service')) {
    return 'bash';
  }
  return 'markdown';
}

async function collectRustWorkspaceFiles(
  dir: string,
  prefix = ''
): Promise<Array<{ path: string; language: string; bytes: number; content: string }>> {
  const results: Array<{ path: string; language: string; bytes: number; content: string }> = [];
  if (!fs.existsSync(dir)) return results;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectRustWorkspaceFiles(full, rel);
      results.push(...sub);
    } else {
      const content = await fsp.readFile(full, 'utf8');
      results.push({
        path: rel,
        language: detectSourceLanguage(entry.name),
        bytes: Buffer.byteLength(content, 'utf8'),
        content,
      });
    }
  }
  return results;
}

function generateLargeMarkdownCorpus(targetWords: number): string {
  const chunks: string[] = [
    `# 大规模文档流式解析与虚拟化渲染压测报告（目标规模：${targetWords.toLocaleString()} 字）\n\n`,
    `> [!IMPORTANT]\n> 本文件由后端服务实时生成，包含多级标题、GFM 表格、Rust 代码块、任务清单与数学公式，用于实测 **增量分块索引** 与 **Fenwick 视口虚拟化** 在超大文档下的首屏耗时、滚动帧率与内存占用。\n\n`,
  ];

  let currentWords = 95;
  let chapter = 1;

  while (currentWords < targetWords) {
    const sectionBlock = `## 第 ${chapter} 章：分布式存储块索引与零拷贝切片策略（Chunk #${chapter}）

在本地优先 Markdown 编辑内核中，第 ${chapter} 号测试分片验证当行内包含 **高密度强调文本**、*斜体术语*、\`rope.byte_to_line(${chapter * 128})\` 行内代码以及行内公式 $T_{${chapter}}(n) = \\mathcal{O}(\\log n)$ 时的排版稳定性。传统 DOM 全量挂载在节点数突破五千后会产生显著的重排抖动，而基于块偏移量的按需水合机制仅渲染当前可见窗口内的约三十个块节点。

- [x] 验证分片 #${chapter} 的 UTF-8 字节边界与行号二分查找一致性
- [ ] 压测高频滚轮跳转与目录大纲快速定位响应时间（目标 $\\le 16\\text{ ms}$）

| 批次编号 | 原始字节偏移 | 解析耗时 (ms) | 往返保真状态 |
| :--- | :---: | ---: | :--- |
| Batch-${chapter}-A | \`0x${(chapter * 4096).toString(16).toUpperCase()}\` | \`0.14\` | 100% 字节一致 |
| Batch-${chapter}-B | \`0x${(chapter * 8192).toString(16).toUpperCase()}\` | \`0.18\` | 保留原始换行符 |

\`\`\`rust
#[inline]
pub fn slice_chapter_${chapter}(rope: &ropey::Rope, start_byte: usize, end_byte: usize) -> ropey::RopeSlice<'_> {
    let char_start = rope.byte_to_char(start_byte);
    let char_end = rope.byte_to_char(end_byte.min(rope.len_bytes()));
    rope.slice(char_start..char_end)
}
\`\`\`

`;
    chunks.push(sectionBlock);
    currentWords += 245;
    chapter++;
  }

  return chunks.join('\n');
}

async function startServer() {
  await ensureWorkspaceInitialized();

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/workspace-assets', express.static(ASSETS_DIR));

  // GET /api/v1/documents
  app.get('/api/v1/documents', async (_req: Request, res: Response) => {
    try {
      const manifest = await loadManifest();
      manifest.sort((a, b) => b.updatedAt - a.updatedAt);
      res.json(manifest);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/documents
  app.post('/api/v1/documents', async (req: Request, res: Response) => {
    try {
      const rawTitle = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : '未命名文档';
      const content = typeof req.body?.content === 'string' ? req.body.content : `# ${rawTitle}\n\n`;
      const slugBase = rawTitle
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
      const id = `${slugBase || 'doc'}-${crypto.randomBytes(3).toString('hex')}`;
      const filePath = path.join(WORKSPACE_DIR, `${id}.md`);

      await atomicWriteFile(filePath, content);
      const stats = computeStats(content);
      const now = Date.now();
      const meta: DocumentMeta = {
        id,
        title: rawTitle,
        filename: `${id}.md`,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        stats,
      };

      const manifest = await loadManifest();
      manifest.unshift(meta);
      await saveManifest(manifest);

      const initialSnap: SnapshotRecord[] = [
        {
          snapshotId: crypto.randomUUID(),
          createdAt: now,
          label: '创建文档 #1',
          revision: 1,
          stats,
          content,
        },
      ];
      await atomicWriteFile(path.join(SNAPSHOTS_DIR, `${id}.json`), JSON.stringify(initialSnap));

      res.status(201).json({ ...meta, content });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v1/documents/:id
  app.get('/api/v1/documents/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const manifest = await loadManifest();
      const meta = manifest.find((d) => d.id === id);
      if (!meta) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const filePath = path.join(WORKSPACE_DIR, `${id}.md`);
      const content = await fsp.readFile(filePath, 'utf8');
      res.json({ ...meta, content });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/v1/documents/:id
  app.put('/api/v1/documents/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const manifest = await loadManifest();
      const idx = manifest.findIndex((d) => d.id === id);
      if (idx === -1) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const filePath = path.join(WORKSPACE_DIR, `${id}.md`);
      await atomicWriteFile(filePath, content);

      const stats = computeStats(content);
      const nextTitle =
        typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim()
          : manifest[idx].title;

      const updated: DocumentMeta = {
        ...manifest[idx],
        title: nextTitle,
        revision: manifest[idx].revision + 1,
        updatedAt: Date.now(),
        stats,
      };
      manifest[idx] = updated;
      await saveManifest(manifest);

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /api/v1/documents/:id/blocks (Incremental UTF-8 byte-span patch mirroring Axum Rope endpoint)
  app.patch('/api/v1/documents/:id/blocks', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const { startByte, endByte, replacement } = req.body as {
        startByte: number;
        endByte: number;
        replacement: string;
      };
      const manifest = await loadManifest();
      const idx = manifest.findIndex((d) => d.id === id);
      if (idx === -1) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const filePath = path.join(WORKSPACE_DIR, `${id}.md`);
      const buf = await fsp.readFile(filePath);
      if (startByte < 0 || endByte < startByte || endByte > buf.length) {
        res.status(400).json({ error: 'Byte range out of bounds' });
        return;
      }

      const prefix = buf.subarray(0, startByte);
      const suffix = buf.subarray(endByte);
      const repBuf = Buffer.from(replacement ?? '', 'utf8');
      const nextBuf = Buffer.concat([prefix, repBuf, suffix]);

      await atomicWriteFile(filePath, nextBuf);
      const nextStr = nextBuf.toString('utf8');
      const stats = computeStats(nextStr);

      manifest[idx] = {
        ...manifest[idx],
        revision: manifest[idx].revision + 1,
        updatedAt: Date.now(),
        stats,
      };
      await saveManifest(manifest);

      res.json(manifest[idx]);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/v1/documents/:id
  app.delete('/api/v1/documents/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const manifest = await loadManifest();
      const filtered = manifest.filter((d) => d.id !== id);
      await saveManifest(filtered);
      await fsp.rm(path.join(WORKSPACE_DIR, `${id}.md`), { force: true });
      await fsp.rm(path.join(SNAPSHOTS_DIR, `${id}.json`), { force: true });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v1/documents/:id/snapshots
  app.get('/api/v1/documents/:id/snapshots', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const snapPath = path.join(SNAPSHOTS_DIR, `${id}.json`);
      if (!fs.existsSync(snapPath)) {
        res.json([]);
        return;
      }
      const raw = await fsp.readFile(snapPath, 'utf8');
      res.json(JSON.parse(raw));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/documents/:id/snapshots
  app.post('/api/v1/documents/:id/snapshots', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const manifest = await loadManifest();
      const meta = manifest.find((d) => d.id === id);
      if (!meta) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const content =
        typeof req.body?.content === 'string'
          ? req.body.content
          : await fsp.readFile(path.join(WORKSPACE_DIR, `${id}.md`), 'utf8');

      const snapPath = path.join(SNAPSHOTS_DIR, `${id}.json`);
      let list: SnapshotRecord[] = [];
      if (fs.existsSync(snapPath)) {
        try {
          list = JSON.parse(await fsp.readFile(snapPath, 'utf8')) as SnapshotRecord[];
        } catch {
          list = [];
        }
      }

      const stats = computeStats(content);
      const label =
        typeof req.body?.label === 'string' && req.body.label.trim()
          ? req.body.label.trim()
          : `手动快照 #${meta.revision}`;

      const entry: SnapshotRecord = {
        snapshotId: crypto.randomUUID(),
        createdAt: Date.now(),
        label,
        revision: meta.revision,
        stats,
        content,
      };
      list.unshift(entry);
      if (list.length > 30) list = list.slice(0, 30);

      await atomicWriteFile(snapPath, JSON.stringify(list));
      res.status(201).json(entry);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/assets (Local image storage returning clean relative Markdown URL)
  app.post('/api/v1/assets', async (req: Request, res: Response) => {
    try {
      const { filename, base64 } = req.body as { filename?: string; base64?: string };
      if (!base64) {
        res.status(400).json({ error: 'Missing base64 image payload' });
        return;
      }
      const cleaned = base64.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleaned, 'base64');
      const rawExt = path.extname(filename || 'image.png').replace('.', '').toLowerCase();
      const safeExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(rawExt) ? rawExt : 'png';
      const digest = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      const assetName = `${digest}.${safeExt}`;
      const assetPath = path.join(ASSETS_DIR, assetName);

      await atomicWriteFile(assetPath, buf);
      res.status(201).json({
        markdownUrl: `/workspace-assets/${assetName}`,
        relativePath: `assets/${assetName}`,
        byteSize: buf.length,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/benchmark/generate (Generate realistic 10k / 100k / 300k word Markdown file)
  app.post('/api/v1/benchmark/generate', async (req: Request, res: Response) => {
    try {
      const targetWords = Math.min(500_000, Math.max(5_000, Number(req.body?.targetWords) || 100_000));
      const t0 = performance.now();
      const content = generateLargeMarkdownCorpus(targetWords);
      const stats = computeStats(content);
      const genMs = Number((performance.now() - t0).toFixed(2));
      res.json({
        title: `性能压测语料 (${Math.round(targetWords / 10000)}万字)`,
        genMs,
        stats,
        content,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v1/rust-source (Inspect root Rust Cargo workspace: Cargo.toml, README.md, docs/**, scripts/**, deploy/**, crates/**)
  app.get('/api/v1/rust-source', async (_req: Request, res: Response) => {
    try {
      const rootFiles: Array<{ path: string; language: string; bytes: number; content: string }> = [];
      for (const rootName of ['Cargo.toml', 'README.md']) {
        const full = path.resolve(__dirname, rootName);
        if (fs.existsSync(full)) {
          const content = await fsp.readFile(full, 'utf8');
          rootFiles.push({
            path: rootName,
            language: detectSourceLanguage(rootName),
            bytes: Buffer.byteLength(content, 'utf8'),
            content,
          });
        }
      }
      const docsFiles = await collectRustWorkspaceFiles(path.resolve(__dirname, 'docs'), 'docs');
      const scriptsFiles = await collectRustWorkspaceFiles(
        path.resolve(__dirname, 'scripts'),
        'scripts'
      );
      const deployFiles = await collectRustWorkspaceFiles(
        path.resolve(__dirname, 'deploy'),
        'deploy'
      );
      const crateFiles = await collectRustWorkspaceFiles(CRATES_DIR, 'crates');
      res.json({
        workspaceRoot: 'vellum-native',
        files: [...rootFiles, ...docsFiles, ...scriptsFiles, ...deployFiles, ...crateFiles],
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v1/sync/status (Phase 2 multi-device sync & realtime backup protocol stub)
  app.get('/api/v1/sync/status', (_req: Request, res: Response) => {
    res.json({
      mode: 'local_first',
      crdtProtocol: 'yrs_v1_reserved',
      realtimeBackupReady: true,
      pendingOperations: 0,
    });
  });

  // Helper to load all workspace documents with their raw Markdown & extracted headings
  async function loadAllWorkspaceContents() {
    const manifest = await loadManifest();
    const loaded: Array<{
      meta: DocumentMeta;
      content: string;
      headings: string[];
      links: ExtractedWikiLink[];
    }> = [];

    for (const meta of manifest) {
      const fp = path.join(WORKSPACE_DIR, `${meta.id}.md`);
      let content = '';
      try {
        content = await fsp.readFile(fp, 'utf8');
      } catch {
        content = '';
      }
      const headings: string[] = [];
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      let inFence = false;
      for (const l of lines) {
        if (l.trim().startsWith('```') || l.trim().startsWith('~~~')) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const hm = l.match(/^(#{1,6})\s+(.*)$/);
        if (hm) {
          const cleanH = hm[2].replace(/\*\*|~~|`/g, '').trim();
          if (cleanH) headings.push(cleanH);
        }
      }
      loaded.push({
        meta,
        content,
        headings,
        links: extractWikiLinksFromMarkdown(content),
      });
    }
    return loaded;
  }

  function resolveTargetDoc(
    targetName: string,
    docs: Array<{ meta: DocumentMeta; content: string; headings: string[] }>
  ) {
    const key = normalizeNoteKey(targetName);
    return docs.find(
      (d) =>
        normalizeNoteKey(d.meta.title) === key ||
        normalizeNoteKey(d.meta.id) === key ||
        normalizeNoteKey(d.meta.filename.replace(/\.md$/i, '')) === key
    );
  }

  // GET /api/v1/graph — Global Knowledge Network Snapshot (mirrors crates/vellum-server/src/routes.rs)
  app.get('/api/v1/graph', async (_req: Request, res: Response) => {
    try {
      const docs = await loadAllWorkspaceContents();

      interface GraphNodeDto {
        id: string;
        title: string;
        resolved: boolean;
        inDegree: number;
        outDegree: number;
        wordCount: number;
        headings: string[];
      }

      interface GraphEdgeDto {
        sourceId: string;
        sourceTitle: string;
        targetId: string;
        targetTitle: string;
        kind: 'wikilink' | 'embed';
        headingAnchor?: string;
        contextExcerpt: string;
      }

      const nodeMap = new Map<string, GraphNodeDto>();
      for (const d of docs) {
        nodeMap.set(d.meta.id, {
          id: d.meta.id,
          title: d.meta.title,
          resolved: true,
          inDegree: 0,
          outDegree: 0,
          wordCount: d.meta.stats.wordCount,
          headings: d.headings.slice(0, 20),
        });
      }

      const edges: GraphEdgeDto[] = [];
      for (const src of docs) {
        for (const link of src.links) {
          const targetDoc = resolveTargetDoc(link.targetName, docs);
          let targetNodeId: string;
          let targetNodeTitle: string;

          if (targetDoc) {
            targetNodeId = targetDoc.meta.id;
            targetNodeTitle = targetDoc.meta.title;
          } else {
            targetNodeId = `unresolved:${normalizeNoteKey(link.targetName)}`;
            targetNodeTitle = link.targetName.trim();
            if (!nodeMap.has(targetNodeId)) {
              nodeMap.set(targetNodeId, {
                id: targetNodeId,
                title: targetNodeTitle,
                resolved: false,
                inDegree: 0,
                outDegree: 0,
                wordCount: 0,
                headings: [],
              });
            }
          }

          if (targetNodeId === src.meta.id) continue;

          const srcNode = nodeMap.get(src.meta.id);
          const dstNode = nodeMap.get(targetNodeId);
          if (srcNode) srcNode.outDegree += 1;
          if (dstNode) dstNode.inDegree += 1;

          edges.push({
            sourceId: src.meta.id,
            sourceTitle: src.meta.title,
            targetId: targetNodeId,
            targetTitle: targetNodeTitle,
            kind: link.kind,
            headingAnchor: link.headingAnchor,
            contextExcerpt: link.contextExcerpt,
          });
        }
      }

      const nodes = Array.from(nodeMap.values());
      const resolvedDocCount = nodes.filter((n) => n.resolved).length;
      const unresolvedNodeCount = nodes.length - resolvedDocCount;

      res.json({
        nodes,
        edges,
        resolvedDocCount,
        unresolvedNodeCount,
        totalConnections: edges.length,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v1/documents/:id/links — Bidirectional Links + Outgoing + Unlinked Mentions
  app.get('/api/v1/documents/:id/links', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const docs = await loadAllWorkspaceContents();
      const current = docs.find((d) => d.meta.id === id);
      if (!current) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const outgoing = current.links.map((l) => {
        const resolved = resolveTargetDoc(l.targetName, docs);
        return {
          targetName: l.targetName,
          targetDocId: resolved ? resolved.meta.id : null,
          targetTitle: resolved ? resolved.meta.title : l.targetName,
          resolved: Boolean(resolved),
          headingAnchor: l.headingAnchor,
          displayAlias: l.displayAlias,
          kind: l.kind,
          lineNumber: l.lineNumber,
          contextExcerpt: l.contextExcerpt,
        };
      });

      const backlinks: Array<{
        sourceDocId: string;
        sourceTitle: string;
        kind: 'wikilink' | 'embed';
        headingAnchor?: string;
        lineNumber: number;
        contextExcerpt: string;
      }> = [];

      const unlinkedMentions: Array<{
        sourceDocId: string;
        sourceTitle: string;
        lineNumber: number;
        matchedText: string;
        contextExcerpt: string;
      }> = [];

      const titleTrimmed = current.meta.title.trim();
      const shortTitle = titleTrimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const candidateTerms = Array.from(
        new Set([titleTrimmed, shortTitle].filter((s) => s.length >= 4))
      );

      for (const other of docs) {
        if (other.meta.id === id) continue;

        let linksToCurrent = false;
        for (const l of other.links) {
          const targetDoc = resolveTargetDoc(l.targetName, docs);
          if (targetDoc && targetDoc.meta.id === id) {
            linksToCurrent = true;
            backlinks.push({
              sourceDocId: other.meta.id,
              sourceTitle: other.meta.title,
              kind: l.kind,
              headingAnchor: l.headingAnchor,
              lineNumber: l.lineNumber,
              contextExcerpt: l.contextExcerpt,
            });
          }
        }

        // Scan for plain-text unlinked mentions on lines without existing [[...]] around the term
        if (candidateTerms.length > 0) {
          const lines = other.content.replace(/\r\n/g, '\n').split('\n');
          let inFence = false;
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const rawLine = lines[lineIdx];
            const tr = rawLine.trim();
            if (tr.startsWith('```') || tr.startsWith('~~~')) {
              inFence = !inFence;
              continue;
            }
            if (inFence || !tr) continue;

            // Strip existing [[...]] and `...` before testing plain-text mention
            const stripped = rawLine
              .replace(/!?\[\[[^\][\n]+\]\]/g, ' ')
              .replace(/`[^`]*`/g, ' ');

            for (const term of candidateTerms) {
              if (stripped.toLowerCase().includes(term.toLowerCase())) {
                unlinkedMentions.push({
                  sourceDocId: other.meta.id,
                  sourceTitle: other.meta.title,
                  lineNumber: lineIdx + 1,
                  matchedText: term,
                  contextExcerpt: tr.slice(0, 140),
                });
                break;
              }
            }
          }
        }
        void linksToCurrent;
      }

      res.json({
        docId: current.meta.id,
        title: current.meta.title,
        outgoing,
        backlinks,
        unlinkedMentions,
        workspaceCatalog: docs.map((d) => ({
          id: d.meta.id,
          title: d.meta.title,
          headings: d.headings.slice(0, 24),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/v1/references/resolve?target=...&heading=... — Resolve `![[Doc#Heading]]` live transclusion & hover preview
  app.get('/api/v1/references/resolve', async (req: Request, res: Response) => {
    try {
      const target = typeof req.query.target === 'string' ? req.query.target.trim() : '';
      const heading = typeof req.query.heading === 'string' ? req.query.heading.trim() : undefined;
      if (!target) {
        res.status(400).json({ error: 'Missing target parameter' });
        return;
      }
      const docs = await loadAllWorkspaceContents();
      const found = resolveTargetDoc(target, docs);
      if (!found) {
        res.json({
          found: false,
          title: target,
          heading,
          excerptMarkdown: '',
        });
        return;
      }
      const excerptMarkdown = extractSectionOrDocExcerpt(found.content, heading);
      res.json({
        found: true,
        docId: found.meta.id,
        title: found.meta.title,
        heading,
        wordCount: found.meta.stats.wordCount,
        updatedAt: found.meta.updatedAt,
        excerptMarkdown,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/documents/:id/refactor-title — Rename document & rewrite all [[OldTitle]] references atomically
  app.post('/api/v1/documents/:id/refactor-title', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const newTitle = typeof req.body?.newTitle === 'string' ? req.body.newTitle.trim() : '';
      if (!newTitle) {
        res.status(400).json({ error: 'New title cannot be empty' });
        return;
      }

      const manifest = await loadManifest();
      const targetIdx = manifest.findIndex((d) => d.id === id);
      if (targetIdx === -1) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const oldTitle = manifest[targetIdx].title;
      let rewrittenFilesCount = 0;
      let rewrittenLinksCount = 0;
      const now = Date.now();

      for (let i = 0; i < manifest.length; i++) {
        const docMeta = manifest[i];
        const fp = path.join(WORKSPACE_DIR, `${docMeta.id}.md`);
        let raw = await fsp.readFile(fp, 'utf8');
        let changed = false;

        if (docMeta.id === id) {
          // Also sync first H1 heading if present
          const updatedH1 = raw.replace(/^#\s+.+$/m, `# ${newTitle}`);
          if (updatedH1 !== raw) {
            raw = updatedH1;
            changed = true;
          }
        }

        const rewritten = rewriteWikiLinksForRename(raw, oldTitle, newTitle);
        if (rewritten.count > 0) {
          raw = rewritten.content;
          rewrittenFilesCount += 1;
          rewrittenLinksCount += rewritten.count;
          changed = true;
        }

        if (changed || docMeta.id === id) {
          await atomicWriteFile(fp, raw);
          manifest[i] = {
            ...docMeta,
            title: docMeta.id === id ? newTitle : docMeta.title,
            revision: docMeta.revision + 1,
            updatedAt: now,
            stats: computeStats(raw),
          };
        }
      }

      await saveManifest(manifest);
      const updatedContent = await fsp.readFile(path.join(WORKSPACE_DIR, `${id}.md`), 'utf8');

      res.json({
        updatedDoc: manifest[targetIdx],
        content: updatedContent,
        oldTitle,
        newTitle,
        rewrittenFilesCount,
        rewrittenLinksCount,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/documents/:id/link-mention — Convert plain-text mention in sourceDocId into [[Title]]
  app.post('/api/v1/documents/:id/link-mention', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const sourceDocId = typeof req.body?.sourceDocId === 'string' ? req.body.sourceDocId : '';
      const lineNumber = Number(req.body?.lineNumber) || 0;
      const matchedText = typeof req.body?.matchedText === 'string' ? req.body.matchedText.trim() : '';

      const manifest = await loadManifest();
      const targetMeta = manifest.find((d) => d.id === id);
      const sourceIdx = manifest.findIndex((d) => d.id === sourceDocId);
      if (!targetMeta || sourceIdx === -1 || !matchedText) {
        res.status(404).json({ error: 'Target or source document not found' });
        return;
      }

      const sourceFp = path.join(WORKSPACE_DIR, `${sourceDocId}.md`);
      const raw = await fsp.readFile(sourceFp, 'utf8');
      const hasCrlf = raw.includes('\r\n');
      const lines = raw.replace(/\r\n/g, '\n').split('\n');

      const wikiReplacement =
        normalizeNoteKey(matchedText) === normalizeNoteKey(targetMeta.title)
          ? `[[${targetMeta.title}]]`
          : `[[${targetMeta.title}|${matchedText}]]`;

      const targetLineIdx = lineNumber - 1;
      if (targetLineIdx >= 0 && targetLineIdx < lines.length) {
        const escaped = matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Replace first occurrence not already inside [[...]]
        lines[targetLineIdx] = lines[targetLineIdx].replace(
          new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'i'),
          wikiReplacement
        );
      }

      const nextContent = hasCrlf ? lines.join('\r\n') : lines.join('\n');
      await atomicWriteFile(sourceFp, nextContent);
      manifest[sourceIdx] = {
        ...manifest[sourceIdx],
        revision: manifest[sourceIdx].revision + 1,
        updatedAt: Date.now(),
        stats: computeStats(nextContent),
      };
      await saveManifest(manifest);

      res.json({ ok: true, updatedSource: manifest[sourceIdx] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/v1/export/pdf — Formal Document Vector PDF Typesetting & Binary Stream
  app.post('/api/v1/export/pdf', async (req: Request, res: Response) => {
    try {
      const title =
        typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim()
          : '未命名正式文档';
      const docId =
        typeof req.body?.docId === 'string' && req.body.docId.trim()
          ? req.body.docId.trim()
          : 'vellum-doc';
      const revision = Number(req.body?.revision) || 1;
      const markdown = typeof req.body?.markdown === 'string' ? req.body.markdown : '';
      const preset: FormalPresetKind =
        req.body?.preset === 'official' || req.body?.preset === 'academic'
          ? req.body.preset
          : 'spec';
      const paperSize: 'A4' | 'LETTER' = req.body?.paperSize === 'Letter' ? 'LETTER' : 'A4';
      const rawMarginMm = Number(req.body?.marginMm);
      const marginMm = Number.isFinite(rawMarginMm)
        ? Math.min(38, Math.max(15, rawMarginMm))
        : 25.4;

      const options: FormalPdfRenderOptions = {
        title,
        docId,
        revision,
        markdown,
        preset,
        paperSize,
        marginMm,
        includeCoverMeta: req.body?.includeCoverMeta !== false,
        includeToc: req.body?.includeToc !== false,
        autoNumberHeadings: req.body?.autoNumberHeadings !== false,
        includeHeaderFooter: req.body?.includeHeaderFooter !== false,
        organization:
          typeof req.body?.organization === 'string' && req.body.organization.trim()
            ? req.body.organization.trim()
            : 'Vellum Native 本地知识工程体系',
        documentCode:
          typeof req.body?.documentCode === 'string' && req.body.documentCode.trim()
            ? req.body.documentCode.trim()
            : `VN-${docId.slice(0, 12).toUpperCase()}-V${revision}`,
      };

      const pdfBuffer = await generateFormalPdfBuffer(options);
      const safeFilename = encodeURIComponent(
        `${title.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vellum-document.pdf"; filename*=UTF-8''${safeFilename}`
      );
      res.setHeader('Content-Length', String(pdfBuffer.length));
      res.status(200).send(pdfBuffer);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vellum Server running on http://0.0.0.0:${PORT}`);
  });
}

type FormalPresetKind = 'spec' | 'official' | 'academic';

interface FormalPdfRenderOptions {
  title: string;
  docId: string;
  revision: number;
  markdown: string;
  preset: FormalPresetKind;
  paperSize: 'A4' | 'LETTER';
  marginMm: number;
  includeCoverMeta: boolean;
  includeToc: boolean;
  autoNumberHeadings: boolean;
  includeHeaderFooter: boolean;
  organization: string;
  documentCode: string;
}

type FormalBlockNode =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list_item'; orderedPrefix: string | null; taskState: 'todo' | 'done' | null; indent: number; text: string }
  | { kind: 'blockquote'; calloutTag: string | null; lines: string[] }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'table'; headers: string[]; alignments: Array<'left' | 'center' | 'right'>; rows: string[][] }
  | { kind: 'math'; latex: string }
  | { kind: 'embed'; target: string }
  | { kind: 'thematic_break' };

function cleanInlineMarkdownForPdf(input: string): string {
  return input
    // Embed & WikiLinks `![[Doc#Sec|Alias]]` / `[[Doc|Alias]]` -> clean formal label
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => inner.replace(/#/g, ' § '))
    // Standard links `[Label](url)` -> `Label`
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图表：$1]')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    // Bold / Italic / Strikethrough / Inline code / Inline math
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .trim();
}

function parseMarkdownForFormalPdf(markdown: string): FormalBlockNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: FormalBlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // YAML Frontmatter skip
    if (i === 0 && trimmed === '---') {
      let endIdx = 1;
      while (endIdx < lines.length && lines[endIdx].trim() !== '---') {
        endIdx++;
      }
      if (endIdx < lines.length) {
        i = endIdx + 1;
        continue;
      }
    }

    // Fenced Code Block
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const closeTrim = lines[i].trim();
        if (closeTrim.startsWith(marker.repeat(fenceLen))) {
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'code', language: lang, code: buf.join('\n') });
      continue;
    }

    // Display Math Block $$...$$
    if (trimmed.startsWith('$$')) {
      if (trimmed.endsWith('$$') && trimmed.length > 4) {
        blocks.push({ kind: 'math', latex: trimmed.slice(2, -2).trim() });
        i++;
        continue;
      }
      const buf: string[] = [];
      const firstAfter = trimmed.slice(2).trim();
      if (firstAfter) buf.push(firstAfter);
      i++;
      while (i < lines.length) {
        if (lines[i].trim().endsWith('$$')) {
          const beforeClose = lines[i].trim().slice(0, -2).trim();
          if (beforeClose) buf.push(beforeClose);
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'math', latex: buf.join('\n').trim() });
      continue;
    }

    // ATX Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length,
        text: cleanInlineMarkdownForPdf(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Thematic Break
    if (/^(---+|___+|\*\*\*+)$/.test(trimmed)) {
      blocks.push({ kind: 'thematic_break' });
      i++;
      continue;
    }

    // Standalone Transclusion `![[Target]]`
    const embedMatch = trimmed.match(/^!\[\[([^\]]+)\]\]$/);
    if (embedMatch) {
      blocks.push({ kind: 'embed', target: embedMatch[1].replace(/#/g, ' § ') });
      i++;
      continue;
    }

    // GFM Table
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1])
    ) {
      const splitCells = (rowStr: string): string[] => {
        const s = rowStr.trim().replace(/^\|/, '').replace(/\|$/, '');
        return s.split('|').map((c) => cleanInlineMarkdownForPdf(c.trim()));
      };
      const headers = splitCells(lines[i]);
      const alignCells = lines[i + 1]
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => {
          const t = c.trim();
          if (t.startsWith(':') && t.endsWith(':')) return 'center' as const;
          if (t.endsWith(':')) return 'right' as const;
          return 'left' as const;
        });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const r = splitCells(lines[i]);
        while (r.length < headers.length) r.push('');
        rows.push(r.slice(0, headers.length));
        i++;
      }
      blocks.push({
        kind: 'table',
        headers,
        alignments: headers.map((_, idx) => alignCells[idx] ?? 'left'),
        rows,
      });
      continue;
    }

    // Blockquote / Callout
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      let calloutTag: string | null = null;
      if (quoteLines.length > 0) {
        const calloutMatch = quoteLines[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
        if (calloutMatch) {
          calloutTag = calloutMatch[1].toUpperCase();
          if (calloutMatch[2].trim()) {
            quoteLines[0] = cleanInlineMarkdownForPdf(calloutMatch[2].trim());
          } else {
            quoteLines.shift();
          }
        }
      }
      blocks.push({
        kind: 'blockquote',
        calloutTag,
        lines: quoteLines.map((l) => cleanInlineMarkdownForPdf(l)).filter(Boolean),
      });
      continue;
    }

    // Task List or Bullet / Ordered List Item
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const indent = Math.min(3, Math.floor(listMatch[1].length / 2));
      const marker = listMatch[2];
      const rest = listMatch[3];
      const taskMatch = rest.match(/^\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        blocks.push({
          kind: 'list_item',
          orderedPrefix: null,
          taskState: taskMatch[1].toLowerCase() === 'x' ? 'done' : 'todo',
          indent,
          text: cleanInlineMarkdownForPdf(taskMatch[2]),
        });
      } else {
        blocks.push({
          kind: 'list_item',
          orderedPrefix: /^\d+\.$/.test(marker) ? marker : null,
          taskState: null,
          indent,
          text: cleanInlineMarkdownForPdf(rest),
        });
      }
      i++;
      continue;
    }

    // Paragraph (coalesce contiguous lines)
    const paraBuf: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const nxt = lines[i].trim();
      if (
        !nxt ||
        /^(#{1,6}\s|`{3,}|~{3,}|\$\$|>\s?|[-*+]\s|\d+\.\s|\|.+\||---+$|!\[\[)/.test(nxt)
      ) {
        break;
      }
      paraBuf.push(nxt);
      i++;
    }
    blocks.push({
      kind: 'paragraph',
      text: cleanInlineMarkdownForPdf(paraBuf.join(' ')),
    });
  }

  return blocks;
}

function registerFormalPdfFonts(doc: InstanceType<typeof PDFDocument>): {
  bodyFont: string;
  monoFont: string;
} {
  const candidates: Array<{ file: string; bodyFamily?: string; monoFamily?: string }> = [
    {
      file: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
      bodyFamily: 'WenQuanYiZenHei',
      monoFamily: 'WenQuanYiZenHeiMono',
    },
    {
      file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    },
    {
      file: '/System/Library/Fonts/Supplemental/Songti.ttc',
    },
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand.file)) {
      try {
        if (cand.bodyFamily) {
          doc.registerFont('CJKBody', cand.file, cand.bodyFamily);
        } else {
          doc.registerFont('CJKBody', cand.file);
        }
        if (cand.monoFamily) {
          doc.registerFont('CJKMono', cand.file, cand.monoFamily);
        } else {
          doc.registerFont('CJKMono', cand.file);
        }
        return { bodyFont: 'CJKBody', monoFont: 'CJKMono' };
      } catch {
        // Continue to next font candidate
      }
    }
  }

  return { bodyFont: 'Helvetica', monoFont: 'Courier' };
}

async function generateFormalPdfBuffer(opts: FormalPdfRenderOptions): Promise<Buffer> {
  const marginPt = opts.marginMm * 2.83465;
  const stats = computeStats(opts.markdown);
  const allBlocks = parseMarkdownForFormalPdf(opts.markdown);

  // If the first block is an H1 identical to document title, avoid printing the title twice
  const blocks =
    allBlocks.length > 0 &&
    allBlocks[0].kind === 'heading' &&
    allBlocks[0].level === 1 &&
    normalizeNoteKey(allBlocks[0].text) === normalizeNoteKey(opts.title)
      ? allBlocks.slice(1)
      : allBlocks;

  // Palette per formal document preset
  const palette =
    opts.preset === 'official'
      ? {
          accent: '#991B1B',
          inkPrimary: '#111827',
          inkSecondary: '#374151',
          inkMuted: '#6B7280',
          borderRule: '#D1D5DB',
          tableHeaderBg: '#F9FAFB',
          codeBg: '#F4F4F5',
          calloutBg: '#FEF2F2',
          presetLabel: '正式报告与公文版式',
        }
      : opts.preset === 'academic'
        ? {
            accent: '#18181B',
            inkPrimary: '#09090B',
            inkSecondary: '#27272A',
            inkMuted: '#52525B',
            borderRule: '#D4D4D8',
            tableHeaderBg: '#FAFAFA',
            codeBg: '#F4F4F5',
            calloutBg: '#F8FAFC',
            presetLabel: '学术论文与单栏手稿',
          }
        : {
            accent: '#1E3A8A',
            inkPrimary: '#0F172A',
            inkSecondary: '#334155',
            inkMuted: '#64748B',
            borderRule: '#CBD5E1',
            tableHeaderBg: '#F1F5F9',
            codeBg: '#F8FAFC',
            calloutBg: '#EFF6FF',
            presetLabel: '技术白皮书与工程规范',
          };

  // Pre-compute hierarchical section numbering for headings & TOC
  const minHeadingLevel = blocks.reduce((acc, b) => {
    if (b.kind === 'heading') return Math.min(acc, b.level);
    return acc;
  }, 6);

  const counters = [0, 0, 0, 0, 0, 0];
  const numberedHeadings = new Map<number, string>();
  const tocItems: Array<{ level: number; numberPrefix: string; title: string }> = [];

  blocks.forEach((b, idx) => {
    if (b.kind === 'heading') {
      const normDepth = Math.min(5, Math.max(0, b.level - minHeadingLevel));
      counters[normDepth] += 1;
      for (let d = normDepth + 1; d < 6; d++) counters[d] = 0;
      const numStr = opts.autoNumberHeadings
        ? counters.slice(0, normDepth + 1).join('.')
        : '';
      numberedHeadings.set(idx, numStr);
      if (normDepth <= 2) {
        tocItems.push({
          level: normDepth + 1,
          numberPrefix: numStr,
          title: b.text,
        });
      }
    }
  });

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: opts.paperSize,
      margin: marginPt,
      bufferPages: true,
      autoFirstPage: false,
      info: {
        Title: opts.title,
        Author: opts.organization,
        Subject: `${palette.presetLabel} (${opts.documentCode})`,
        Creator: 'Vellum Native Formal Publishing Engine',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', (err: Error) => reject(err));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const { bodyFont, monoFont } = registerFormalPdfFonts(doc);

    doc.addPage();
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - marginPt * 2;
    const topSafeY = marginPt + (opts.includeHeaderFooter ? 18 : 0);
    const bottomSafeY = pageH - marginPt - (opts.includeHeaderFooter ? 22 : 0);

    let curY = topSafeY;
    let mathCounter = 0;

    const ensureSpace = (neededPt: number) => {
      if (curY + neededPt > bottomSafeY) {
        doc.addPage();
        curY = topSafeY;
      }
    };

    const drawHLine = (x: number, y: number, w: number, thickness: number, color: string) => {
      doc
        .save()
        .lineWidth(thickness)
        .strokeColor(color)
        .moveTo(x, y)
        .lineTo(x + w, y)
        .stroke()
        .restore();
    };

    // 1. Formal Cover / Document Header Block
    doc.font(bodyFont).fontSize(9).fillColor(palette.accent);
    doc.text(
      `${opts.organization}  ·  ${palette.presetLabel}`,
      marginPt,
      curY,
      {
        width: contentW,
        align: opts.preset === 'spec' ? 'left' : 'center',
      }
    );
    curY = doc.y + 6;

    doc.font(bodyFont).fontSize(opts.preset === 'official' ? 21 : 19).fillColor(palette.inkPrimary);
    doc.text(opts.title, marginPt, curY, {
      width: contentW,
      align: opts.preset === 'spec' ? 'left' : 'center',
      lineGap: 4,
    });
    curY = doc.y + 10;

    // Classic Formal Double Rule (上粗下细双文头线)
    drawHLine(marginPt, curY, contentW, opts.preset === 'official' ? 2.0 : 1.5, palette.accent);
    drawHLine(marginPt, curY + 3.2, contentW, 0.55, palette.accent);
    curY += 13;

    // Document Control Metadata Grid (`受控文档元信息表`)
    if (opts.includeCoverMeta) {
      const todayIso = new Date().toISOString().slice(0, 10);
      if (opts.preset === 'spec') {
        const rowH = 22;
        const colW = contentW / 4;
        doc
          .save()
          .rect(marginPt, curY, contentW, rowH * 2)
          .fillAndStroke('#F8FAFC', palette.borderRule)
          .restore();
        drawHLine(marginPt, curY + rowH, contentW, 0.5, palette.borderRule);
        for (let c = 1; c < 4; c++) {
          doc
            .save()
            .lineWidth(0.5)
            .strokeColor(palette.borderRule)
            .moveTo(marginPt + colW * c, curY)
            .lineTo(marginPt + colW * c, curY + rowH * 2)
            .stroke()
            .restore();
        }
        const metaLabels = ['文档编号', '受控版本', '签发日期', '规模与校验'];
        const metaValues = [
          opts.documentCode,
          `Rev #${opts.revision}`,
          todayIso,
          `${stats.wordCount.toLocaleString()} 字 · ${stats.checksum.slice(0, 8)}`,
        ];
        for (let c = 0; c < 4; c++) {
          doc
            .font(bodyFont)
            .fontSize(8)
            .fillColor(palette.inkMuted)
            .text(metaLabels[c], marginPt + colW * c + 6, curY + 6, {
              width: colW - 12,
              lineBreak: false,
            });
          doc
            .font(monoFont)
            .fontSize(8.5)
            .fillColor(palette.inkPrimary)
            .text(metaValues[c], marginPt + colW * c + 6, curY + rowH + 6, {
              width: colW - 12,
              lineBreak: false,
            });
        }
        curY += rowH * 2 + 16;
      } else {
        doc
          .font(bodyFont)
          .fontSize(9)
          .fillColor(palette.inkMuted)
          .text(
            `编号：${opts.documentCode}    版本：Rev #${opts.revision}    日期：${todayIso}    全文：${stats.wordCount.toLocaleString()} 字`,
            marginPt,
            curY,
            { width: contentW, align: 'center' }
          );
        curY = doc.y + 14;
      }
    }

    // 2. Automatic Hierarchical Table of Contents (`目 录`)
    if (opts.includeToc && tocItems.length >= 2) {
      ensureSpace(48 + Math.min(tocItems.length, 6) * 15);
      doc
        .font(bodyFont)
        .fontSize(11.5)
        .fillColor(palette.inkPrimary)
        .text('目  录', marginPt, curY, {
          width: contentW,
          align: opts.preset === 'spec' ? 'left' : 'center',
        });
      curY = doc.y + 6;
      drawHLine(marginPt, curY, contentW, 0.5, palette.borderRule);
      curY += 8;

      for (const item of tocItems.slice(0, 28)) {
        ensureSpace(16);
        const indentX = (item.level - 1) * 14;
        const label = item.numberPrefix ? `${item.numberPrefix}  ${item.title}` : item.title;
        doc
          .font(bodyFont)
          .fontSize(item.level === 1 ? 9.5 : 9)
          .fillColor(item.level === 1 ? palette.inkPrimary : palette.inkSecondary)
          .text(label, marginPt + indentX, curY, {
            width: contentW - indentX,
            lineGap: 2,
          });
        curY = doc.y + 3;
      }
      curY += 6;
      drawHLine(marginPt, curY, contentW, 0.5, palette.borderRule);
      curY += 16;
    }

    const bodyFontSize = opts.preset === 'official' ? 11 : opts.preset === 'academic' ? 10 : 10.5;
    const bodyLineGap = opts.preset === 'official' ? 5.5 : opts.preset === 'academic' ? 3.5 : 4.5;

    // 3. Render Formal Document Blocks
    blocks.forEach((block, blockIdx) => {
      switch (block.kind) {
        case 'heading': {
          const fontSize =
            block.level === 1
              ? 15
              : block.level === 2
                ? 13
                : block.level === 3
                  ? 11.5
                  : 10.5;
          const prefix = numberedHeadings.get(blockIdx);
          const headingLabel = prefix ? `${prefix}  ${block.text}` : block.text;

          doc.font(bodyFont).fontSize(fontSize);
          const hHeight = doc.heightOfString(headingLabel, { width: contentW, lineGap: 3 });
          // Widow/orphan protection: keep heading + at least 2 body lines on same page
          ensureSpace(hHeight + 44);
          curY += block.level <= 2 ? 10 : 6;

          if (block.level <= 2) {
            try {
              doc.outline.addItem(headingLabel);
            } catch {
              // Ignore outline error if unsupported
            }
          }

          doc
            .font(bodyFont)
            .fontSize(fontSize)
            .fillColor(block.level === 1 ? palette.accent : palette.inkPrimary)
            .text(headingLabel, marginPt, curY, {
              width: contentW,
              lineGap: 3,
            });
          curY = doc.y + 4;

          if (block.level === 1 && opts.preset === 'spec') {
            drawHLine(marginPt, curY, contentW, 0.75, palette.borderRule);
            curY += 7;
          } else {
            curY += 3;
          }
          break;
        }

        case 'paragraph': {
          const textBody =
            opts.preset === 'official' ? `　　${block.text}` : block.text;
          doc.font(bodyFont).fontSize(bodyFontSize);
          const pHeight = doc.heightOfString(textBody, {
            width: contentW,
            lineGap: bodyLineGap,
          });
          ensureSpace(Math.min(pHeight, 56));
          doc
            .font(bodyFont)
            .fontSize(bodyFontSize)
            .fillColor(palette.inkPrimary)
            .text(textBody, marginPt, curY, {
              width: contentW,
              lineGap: bodyLineGap,
              align: 'left',
            });
          curY = doc.y + 8;
          break;
        }

        case 'list_item': {
          const indentPt = 12 + block.indent * 14;
          const marker =
            block.taskState === 'done'
              ? '[✓]'
              : block.taskState === 'todo'
                ? '[ ]'
                : block.orderedPrefix ?? '•';
          doc.font(bodyFont).fontSize(bodyFontSize);
          const itemH = doc.heightOfString(block.text, {
            width: contentW - indentPt - 18,
            lineGap: bodyLineGap - 1,
          });
          ensureSpace(Math.min(itemH + 4, 42));

          doc
            .font(block.taskState ? monoFont : bodyFont)
            .fontSize(bodyFontSize - 0.5)
            .fillColor(block.taskState === 'done' ? palette.accent : palette.inkSecondary)
            .text(marker, marginPt + indentPt - 12, curY, {
              width: 24,
              lineBreak: false,
            });

          doc
            .font(bodyFont)
            .fontSize(bodyFontSize)
            .fillColor(block.taskState === 'done' ? palette.inkMuted : palette.inkPrimary)
            .text(block.text, marginPt + indentPt + 10, curY, {
              width: contentW - indentPt - 10,
              lineGap: bodyLineGap - 1,
            });
          curY = doc.y + 4.5;
          break;
        }

        case 'blockquote': {
          const innerW = contentW - 24;
          const titleTag = block.calloutTag
            ? {
                NOTE: '说明 (NOTE)',
                TIP: '建议 (TIP)',
                IMPORTANT: '重要规范 (IMPORTANT)',
                WARNING: '注意 (WARNING)',
                CAUTION: '警示 (CAUTION)',
              }[block.calloutTag] ?? block.calloutTag
            : null;

          const bodyStr = block.lines.join('\n');
          doc.font(bodyFont).fontSize(9.5);
          const textH = bodyStr
            ? doc.heightOfString(bodyStr, { width: innerW, lineGap: 3.5 })
            : 0;
          const boxH = (titleTag ? 18 : 0) + textH + 14;
          ensureSpace(Math.min(boxH + 8, 140));

          doc
            .save()
            .rect(marginPt, curY, contentW, boxH)
            .fillAndStroke(palette.calloutBg, palette.borderRule)
            .restore();

          let innerY = curY + 7;
          if (titleTag) {
            doc
              .font(bodyFont)
              .fontSize(9)
              .fillColor(palette.accent)
              .text(titleTag, marginPt + 12, innerY, { width: innerW });
            innerY = doc.y + 3;
          }
          if (bodyStr) {
            doc
              .font(bodyFont)
              .fontSize(9.5)
              .fillColor(palette.inkSecondary)
              .text(bodyStr, marginPt + 12, innerY, { width: innerW, lineGap: 3.5 });
          }
          curY += boxH + 10;
          break;
        }

        case 'code': {
          const codeText = block.code || '';
          const innerW = contentW - 20;
          doc.font(monoFont).fontSize(8.5);
          const codeH = doc.heightOfString(codeText, { width: innerW, lineGap: 2.5 });
          const headerH = block.language ? 16 : 0;
          const totalBoxH = headerH + codeH + 14;

          // If code block fits on next page cleanly, avoid awkward 1-line split
          if (totalBoxH < bottomSafeY - topSafeY && curY + totalBoxH > bottomSafeY) {
            doc.addPage();
            curY = topSafeY;
          } else {
            ensureSpace(44);
          }

          if (totalBoxH <= bottomSafeY - curY) {
            doc
              .save()
              .rect(marginPt, curY, contentW, totalBoxH)
              .fillAndStroke(palette.codeBg, palette.borderRule)
              .restore();
            let cy = curY + 6;
            if (block.language) {
              doc
                .font(monoFont)
                .fontSize(7.5)
                .fillColor(palette.inkMuted)
                .text(block.language.toUpperCase(), marginPt + 10, cy, {
                  width: innerW,
                  align: 'right',
                });
              drawHLine(marginPt, curY + 18, contentW, 0.4, palette.borderRule);
              cy = curY + 22;
            }
            doc
              .font(monoFont)
              .fontSize(8.5)
              .fillColor(palette.inkPrimary)
              .text(codeText, marginPt + 10, cy, { width: innerW, lineGap: 2.5 });
            curY += totalBoxH + 10;
          } else {
            // Very long code block: stream line-by-line across pages cleanly
            const codeLines = codeText.split('\n');
            for (const cLine of codeLines) {
              ensureSpace(14);
              doc
                .font(monoFont)
                .fontSize(8.5)
                .fillColor(palette.inkPrimary)
                .text(cLine || ' ', marginPt + 8, curY, { width: contentW - 16, lineGap: 2 });
              curY = doc.y + 1.5;
            }
            curY += 8;
          }
          break;
        }

        case 'table': {
          const colCount = Math.max(1, block.headers.length);
          const colW = contentW / colCount;
          const cellPadX = 6;
          const cellPadY = 5.5;
          const isThreeLine = opts.preset === 'official' || opts.preset === 'academic';

          const measureRowH = (cells: string[], fSize: number): number => {
            doc.font(bodyFont).fontSize(fSize);
            let maxH = 14;
            for (let c = 0; c < colCount; c++) {
              const h = doc.heightOfString(cells[c] ?? '', {
                width: Math.max(24, colW - cellPadX * 2),
                lineGap: 2,
              });
              if (h > maxH) maxH = h;
            }
            return maxH + cellPadY * 2;
          };

          const headerRowH = measureRowH(block.headers, 9);
          ensureSpace(headerRowH + 28);
          curY += 4;
          const tableStartY = curY;

          // Draw Header Row
          if (isThreeLine) {
            drawHLine(marginPt, curY, contentW, 1.4, palette.inkPrimary);
          } else {
            doc
              .save()
              .rect(marginPt, curY, contentW, headerRowH)
              .fillAndStroke(palette.tableHeaderBg, palette.borderRule)
              .restore();
          }

          for (let c = 0; c < colCount; c++) {
            doc
              .font(bodyFont)
              .fontSize(9)
              .fillColor(palette.inkPrimary)
              .text(block.headers[c] ?? '', marginPt + colW * c + cellPadX, curY + cellPadY, {
                width: Math.max(24, colW - cellPadX * 2),
                align: block.alignments[c] ?? 'left',
                lineGap: 2,
              });
          }
          curY += headerRowH;

          if (isThreeLine) {
            drawHLine(marginPt, curY, contentW, 0.75, palette.inkPrimary);
          }

          // Draw Data Rows
          for (let rIdx = 0; rIdx < block.rows.length; rIdx++) {
            const row = block.rows[rIdx];
            const rowH = measureRowH(row, 8.8);
            if (curY + rowH > bottomSafeY) {
              if (isThreeLine) {
                drawHLine(marginPt, curY, contentW, 1.0, palette.inkPrimary);
              }
              doc.addPage();
              curY = topSafeY;
              if (isThreeLine) {
                drawHLine(marginPt, curY, contentW, 1.0, palette.inkPrimary);
              }
            }

            if (!isThreeLine) {
              doc
                .save()
                .rect(marginPt, curY, contentW, rowH)
                .fillAndStroke(rIdx % 2 === 1 ? '#FAFAFA' : '#FFFFFF', palette.borderRule)
                .restore();
              for (let c = 1; c < colCount; c++) {
                doc
                  .save()
                  .lineWidth(0.4)
                  .strokeColor(palette.borderRule)
                  .moveTo(marginPt + colW * c, curY)
                  .lineTo(marginPt + colW * c, curY + rowH)
                  .stroke()
                  .restore();
              }
            }

            for (let c = 0; c < colCount; c++) {
              doc
                .font(bodyFont)
                .fontSize(8.8)
                .fillColor(palette.inkSecondary)
                .text(row[c] ?? '', marginPt + colW * c + cellPadX, curY + cellPadY, {
                  width: Math.max(24, colW - cellPadX * 2),
                  align: block.alignments[c] ?? 'left',
                  lineGap: 2,
                });
            }
            curY += rowH;
          }

          if (isThreeLine) {
            drawHLine(marginPt, curY, contentW, 1.4, palette.inkPrimary);
          } else {
            // Vertical column dividers on header row for grid style
            for (let c = 1; c < colCount; c++) {
              doc
                .save()
                .lineWidth(0.4)
                .strokeColor(palette.borderRule)
                .moveTo(marginPt + colW * c, tableStartY)
                .lineTo(marginPt + colW * c, tableStartY + headerRowH)
                .stroke()
                .restore();
            }
          }
          curY += 12;
          break;
        }

        case 'math': {
          mathCounter += 1;
          doc.font(monoFont).fontSize(9.5);
          const mH = doc.heightOfString(block.latex, { width: contentW - 60, lineGap: 2 });
          ensureSpace(mH + 18);
          curY += 4;
          doc
            .font(monoFont)
            .fontSize(9.5)
            .fillColor(palette.inkPrimary)
            .text(block.latex, marginPt + 24, curY, {
              width: contentW - 64,
              align: 'center',
              lineGap: 2,
            });
          const eqNumY = curY;
          const afterY = doc.y;
          doc
            .font(bodyFont)
            .fontSize(9)
            .fillColor(palette.inkMuted)
            .text(`(${mathCounter})`, marginPt, eqNumY, {
              width: contentW,
              align: 'right',
              lineBreak: false,
            });
          curY = afterY + 10;
          break;
        }

        case 'embed': {
          ensureSpace(30);
          doc
            .save()
            .rect(marginPt, curY, contentW, 24)
            .fillAndStroke('#F8FAFC', palette.borderRule)
            .restore();
          doc
            .font(bodyFont)
            .fontSize(9)
            .fillColor(palette.inkSecondary)
            .text(`引用嵌入文档章节：${block.target}`, marginPt + 10, curY + 6.5, {
              width: contentW - 20,
              lineBreak: false,
            });
          curY += 32;
          break;
        }

        case 'thematic_break': {
          ensureSpace(18);
          curY += 6;
          drawHLine(marginPt, curY, contentW, 0.6, palette.borderRule);
          curY += 10;
          break;
        }
      }
    });

    // 4. Second-Pass Running Headers & Exact Page Numbers (`第 X 页 / 共 Y 页`)
    if (opts.includeHeaderFooter) {
      const range = doc.bufferedPageRange();
      const totalPages = range.count;
      for (let idx = 0; idx < totalPages; idx++) {
        doc.switchToPage(range.start + idx);
        const savedBottom = doc.page.margins.bottom;
        const savedTop = doc.page.margins.top;
        doc.page.margins.bottom = 0;
        doc.page.margins.top = 0;

        // Running Header on pages 2..N
        if (idx > 0) {
          const headerY = marginPt - 14;
          doc
            .font(bodyFont)
            .fontSize(8)
            .fillColor(palette.inkMuted)
            .text(opts.title, marginPt, headerY, {
              width: contentW * 0.68,
              align: 'left',
              lineBreak: false,
            });
          doc
            .font(monoFont)
            .fontSize(8)
            .fillColor(palette.inkMuted)
            .text(opts.documentCode, marginPt, headerY, {
              width: contentW,
              align: 'right',
              lineBreak: false,
            });
          drawHLine(marginPt, marginPt - 2, contentW, 0.45, palette.borderRule);
        }

        // Formal Page Footer on all pages
        const footerLineY = pageH - marginPt + 4;
        drawHLine(marginPt, footerLineY, contentW, 0.45, palette.borderRule);
        const footerLabel =
          opts.preset === 'official'
            ? `— ${idx + 1} —`
            : `第 ${idx + 1} 页 / 共 ${totalPages} 页`;
        doc
          .font(bodyFont)
          .fontSize(8.5)
          .fillColor(palette.inkMuted)
          .text(footerLabel, marginPt, footerLineY + 6, {
            width: contentW,
            align: 'center',
            lineBreak: false,
          });

        doc.page.margins.bottom = savedBottom;
        doc.page.margins.top = savedTop;
      }
    }

    doc.end();
  });
}

startServer();
