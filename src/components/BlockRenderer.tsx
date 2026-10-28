import React, { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Code2,
  Copy,
  Eye,
  FilePlus2,
  Plus,
  Trash2,
} from 'lucide-react';
import type { BlockRecord, ColumnAlign } from '../engine/markdownEngine';
import {
  parseGfmTable,
  parseMarkdownToBlocks,
  parseMermaidFlowchart,
  parseWikiLinkSpec,
  serializeGfmTable,
} from '../engine/markdownEngine';

export type SyntaxRevealMode = 'active' | 'hidden' | 'always';

export interface WikiRenderContext {
  isTargetResolved: (target: string) => boolean;
  onNavigateWikiLink: (target: string, heading?: string) => void;
}

interface BlockRendererProps {
  block: BlockRecord;
  index: number;
  isActive: boolean;
  isDark: boolean;
  focusMode: boolean;
  syntaxReveal: SyntaxRevealMode;
  fontSizeClass: string;
  proseFontClass: string;
  searchQuery: string;
  wikiContext?: WikiRenderContext;
  workspaceRevisionKey?: string;
  onActivate: (index: number) => void;
  onChangeRaw: (index: number, nextRaw: string, isInputRule?: boolean) => void;
  onSplitBlockAfter: (index: number, beforeRaw: string, afterRaw: string) => void;
  onDeleteBlock: (index: number) => void;
  onMoveBlock: (index: number, direction: -1 | 1) => void;
  onInsertBlockBelow: (index: number, initialRaw?: string) => void;
  onOpenSlashMenu: (index: number, query: string, anchorEl: HTMLElement | null) => void;
  onCloseSlashMenu: () => void;
  onOpenWikiMenu?: (index: number, query: string, replaceStartOffset: number, isEmbed: boolean) => void;
  onCloseWikiMenu?: () => void;
  onMeasuredHeight: (index: number, heightPx: number) => void;
  onHtmlPaste: (index: number, convertedMarkdown: string, plainText: string) => void;
}

function tokenizeCodeLine(line: string): Array<{ text: string; kind: 'kw' | 'str' | 'cmt' | 'num' | 'fn' | 'plain' }> {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('# ') || trimmed.startsWith('--')) {
    return [{ text: line, kind: 'cmt' }];
  }

  const regex =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:pub|fn|let|mut|async|await|impl|struct|enum|trait|match|if|else|for|while|loop|return|use|mod|const|static|where|Self|self|Ok|Err|Some|None|import|export|from|function|interface|type|class)\b|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\())/g;

  const tokens: Array<{ text: string; kind: 'kw' | 'str' | 'cmt' | 'num' | 'fn' | 'plain' }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index), kind: 'plain' });
    }
    const val = match[0];
    if (val.startsWith('"') || val.startsWith("'") || val.startsWith('`')) {
      tokens.push({ text: val, kind: 'str' });
    } else if (/^\d/.test(val)) {
      tokens.push({ text: val, kind: 'num' });
    } else if (
      /^(pub|fn|let|mut|async|await|impl|struct|enum|trait|match|if|else|for|while|loop|return|use|mod|const|static|where|Self|self|Ok|Err|Some|None|import|export|from|function|interface|type|class)$/.test(
        val
      )
    ) {
      tokens.push({ text: val, kind: 'kw' });
    } else {
      tokens.push({ text: val, kind: 'fn' });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex), kind: 'plain' });
  }
  return tokens;
}

export function renderInlineNodes(
  text: string,
  showDelimiters: boolean,
  searchQuery: string,
  wikiContext?: WikiRenderContext
): React.ReactNode[] {
  if (!text) return [];

  const highlightSearch = (segment: string, keyPrefix: string): React.ReactNode => {
    if (!searchQuery.trim()) return segment;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = segment.split(new RegExp(`(${escaped})`, 'gi'));
    if (parts.length === 1) return segment;
    return parts.map((p, i) =>
      p.toLowerCase() === searchQuery.toLowerCase() ? (
        <mark
          key={`${keyPrefix}-hl-${i}`}
          className="rounded bg-amber-300/70 px-0.5 text-zinc-950 dark:bg-amber-400/40 dark:text-amber-100"
        >
          {p}
        </mark>
      ) : (
        p
      )
    );
  };

  const inlinePattern =
    /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*\n]+)\*|~~([^~]+)~~|==([^=]+)==|`([^`\n]+)`|\$([^$\n]+)\$|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|!?\[\[([^\][\n]+)\]\]|\[\^([^\]]+)\]|<kbd>([^<]+)<\/kbd>|~([^~\s]+)~|\^([^^\s]+)\^)/g;

  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let tokenKey = 0;

  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      out.push(highlightSearch(text.slice(lastIdx, match.index), `txt-${tokenKey++}`));
    }

    const full = match[0];
    const delim = (d: string) =>
      showDelimiters ? (
        <span className="font-mono text-[0.85em] font-normal text-zinc-400 dark:text-zinc-500">{d}</span>
      ) : null;

    if (match[2] !== undefined) {
      out.push(
        <strong key={`bi-${tokenKey++}`} className="font-semibold italic">
          {delim('***')}
          {highlightSearch(match[2], `bi-c-${tokenKey}`)}
          {delim('***')}
        </strong>
      );
    } else if (match[3] !== undefined) {
      out.push(
        <strong key={`b-${tokenKey++}`} className="font-semibold text-zinc-950 dark:text-zinc-50">
          {delim('**')}
          {highlightSearch(match[3], `b-c-${tokenKey}`)}
          {delim('**')}
        </strong>
      );
    } else if (match[4] !== undefined) {
      out.push(
        <em key={`i-${tokenKey++}`} className="italic">
          {delim('*')}
          {highlightSearch(match[4], `i-c-${tokenKey}`)}
          {delim('*')}
        </em>
      );
    } else if (match[5] !== undefined) {
      out.push(
        <del key={`s-${tokenKey++}`} className="text-zinc-400 line-through dark:text-zinc-500">
          {delim('~~')}
          {match[5]}
          {delim('~~')}
        </del>
      );
    } else if (match[6] !== undefined) {
      out.push(
        <mark
          key={`mk-${tokenKey++}`}
          className="rounded-sm bg-amber-200/60 px-1 text-zinc-900 dark:bg-amber-500/25 dark:text-amber-100"
        >
          {delim('==')}
          {match[6]}
          {delim('==')}
        </mark>
      );
    } else if (match[7] !== undefined) {
      out.push(
        <code
          key={`cd-${tokenKey++}`}
          className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.88em] text-blue-700 dark:bg-zinc-800/90 dark:text-blue-300"
        >
          {delim('`')}
          {match[7]}
          {delim('`')}
        </code>
      );
    } else if (match[8] !== undefined) {
      const html = katex.renderToString(match[8], {
        throwOnError: false,
        displayMode: false,
      });
      out.push(
        <span
          key={`mth-${tokenKey++}`}
          className="inline-block align-middle px-0.5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    } else if (match[9] !== undefined && match[10] !== undefined) {
      out.push(
        <img
          key={`img-${tokenKey++}`}
          src={match[10]}
          alt={match[9] || '文档内嵌图像'}
          referrerPolicy="no-referrer"
          className="my-2 inline-block max-h-64 rounded-lg border border-zinc-200 object-contain dark:border-zinc-800"
        />
      );
    } else if (match[11] !== undefined && match[12] !== undefined) {
      out.push(
        <a
          key={`lnk-${tokenKey++}`}
          href={match[12]}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={match[12]}
          className="text-blue-600 underline decoration-blue-600/40 underline-offset-4 hover:decoration-blue-600 dark:text-blue-400"
        >
          {delim('[')}
          {match[11]}
          {delim(`](${match[12]})`)}
        </a>
      );
    } else if (match[13] !== undefined) {
      const isInlineEmbed = full.startsWith('![[');
      const spec = parseWikiLinkSpec(match[13]);
      const isResolved = wikiContext ? wikiContext.isTargetResolved(spec.target) : true;
      const openDelim = isInlineEmbed ? '![[' : '[[';
      const hoverHint = isResolved
        ? `跳转至《${spec.target}》${spec.heading ? ` · 定位章节「${spec.heading}」` : ''}`
        : `待建知识节点《${spec.target}》· 点击立即创建文档并建立双向连接`;

      out.push(
        <button
          key={`wiki-${tokenKey++}`}
          type="button"
          title={hoverHint}
          onClick={(e) => {
            e.stopPropagation();
            wikiContext?.onNavigateWikiLink(spec.target, spec.heading);
          }}
          className={`inline cursor-pointer text-left font-medium transition-colors ${
            isResolved
              ? 'text-blue-600 underline decoration-blue-500/45 underline-offset-4 hover:text-blue-700 hover:decoration-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
              : 'text-amber-700 underline decoration-dashed decoration-amber-500/70 underline-offset-4 hover:text-amber-800 dark:text-amber-300'
          }`}
        >
          {delim(openDelim)}
          <span>{showDelimiters ? match[13] : spec.displayLabel}</span>
          {delim(']]')}
        </button>
      );
    } else if (match[14] !== undefined) {
      out.push(
        <sup key={`fn-${tokenKey++}`} className="ml-0.5 font-mono text-xs text-blue-600 dark:text-blue-400">
          [{match[14]}]
        </sup>
      );
    } else if (match[15] !== undefined) {
      out.push(
        <kbd
          key={`kbd-${tokenKey++}`}
          className="mx-0.5 inline-block rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-mono text-[0.78em] leading-none text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
        >
          {match[15]}
        </kbd>
      );
    } else if (match[16] !== undefined) {
      out.push(<sub key={`sub-${tokenKey++}`}>{match[16]}</sub>);
    } else if (match[17] !== undefined) {
      out.push(<sup key={`sup-${tokenKey++}`}>{match[17]}</sup>);
    } else {
      out.push(full);
    }

    lastIdx = inlinePattern.lastIndex;
  }

  if (lastIdx < text.length) {
    out.push(highlightSearch(text.slice(lastIdx), `tail-${tokenKey}`));
  }

  return out;
}

const MermaidSvgView: React.FC<{ raw: string }> = ({ raw }) => {
  const graph = parseMermaidFlowchart(raw);

  if (graph.error) {
    return (
      <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <div className="font-semibold">图表语法提示（已保留原始 Markdown 源码）</div>
        <div className="mt-1 font-mono">{graph.error}</div>
      </div>
    );
  }

  const isHorizontal = graph.direction === 'LR';
  const nodeW = 152;
  const nodeH = 42;
  const gapX = isHorizontal ? 62 : 0;
  const gapY = isHorizontal ? 0 : 48;

  const positions = new Map<string, { x: number; y: number }>();
  graph.nodes.forEach((n, idx) => {
    if (isHorizontal) {
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      positions.set(n.id, { x: 24 + col * (nodeW + gapX), y: 24 + row * 82 });
    } else {
      positions.set(n.id, { x: 80, y: 24 + idx * (nodeH + gapY) });
    }
  });

  const width = isHorizontal
    ? Math.max(360, Math.min(4, graph.nodes.length) * (nodeW + gapX) + 16)
    : 320;
  const height = isHorizontal
    ? Math.max(96, Math.ceil(graph.nodes.length / 4) * 82 + 20)
    : Math.max(100, graph.nodes.length * (nodeH + gapY) + 20);

  return (
    <div className="overflow-x-auto py-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto h-auto max-h-64 w-full max-w-3xl text-zinc-800 dark:text-zinc-200"
        role="img"
        aria-label="Mermaid 架构流程图"
      >
        <defs>
          <marker
            id="vellum-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" className="fill-zinc-400 dark:fill-zinc-500" />
          </marker>
        </defs>

        {graph.edges.map((edge, idx) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const x1 = isHorizontal ? from.x + nodeW : from.x + nodeW / 2;
          const y1 = isHorizontal ? from.y + nodeH / 2 : from.y + nodeH;
          const x2 = isHorizontal ? to.x : to.x + nodeW / 2;
          const y2 = isHorizontal ? to.y + nodeH / 2 : to.y;
          return (
            <g key={`edge-${idx}`}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                strokeWidth="1.5"
                markerEnd="url(#vellum-arrow)"
                className="stroke-zinc-400 dark:stroke-zinc-500"
              />
              {edge.label && (
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 6}
                  textAnchor="middle"
                  className="fill-zinc-500 text-[10px]"
                >
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}

        {graph.nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          return (
            <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
              <rect
                width={nodeW}
                height={nodeH}
                rx={node.shape === 'round' ? 20 : 8}
                className="fill-white stroke-zinc-300 dark:fill-zinc-900 dark:stroke-zinc-700"
                strokeWidth="1.25"
              />
              <text
                x={nodeW / 2}
                y={nodeH / 2 + 4}
                textAnchor="middle"
                className="fill-current text-[12px] font-medium"
              >
                {node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const EmbedTransclusionCard: React.FC<{
  raw: string;
  fontSizeClass: string;
  proseFontClass: string;
  searchQuery: string;
  wikiContext?: WikiRenderContext;
  workspaceRevisionKey?: string;
  onEditSyntax: () => void;
}> = ({
  raw,
  fontSizeClass,
  proseFontClass,
  searchQuery,
  wikiContext,
  workspaceRevisionKey,
  onEditSyntax,
}) => {
  const innerMatch = raw.trim().match(/^!\[\[([^\][\n]+)\]\]$/);
  const spec = parseWikiLinkSpec(innerMatch ? innerMatch[1] : raw);

  const [resolvedState, setResolvedState] = useState<{
    loading: boolean;
    found: boolean;
    title: string;
    wordCount: number;
    excerptMarkdown: string;
  }>({
    loading: true,
    found: false,
    title: spec.target,
    wordCount: 0,
    excerptMarkdown: '',
  });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ target: spec.target });
    if (spec.heading) params.set('heading', spec.heading);

    fetch(`/api/v1/references/resolve?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setResolvedState({
          loading: false,
          found: Boolean(data.found),
          title: data.title || spec.target,
          wordCount: data.wordCount || 0,
          excerptMarkdown: data.excerptMarkdown || '',
        });
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedState((s) => ({ ...s, loading: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [spec.target, spec.heading, workspaceRevisionKey]);

  const excerptBlocks = resolvedState.excerptMarkdown
    ? parseMarkdownToBlocks(resolvedState.excerptMarkdown).slice(0, 6)
    : [];

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="my-3 rounded-xl border border-zinc-200/90 bg-zinc-50/75 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/55"
    >
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/70 pb-2 text-xs text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-200 truncate">
            嵌入引用 · 《{spec.alias || resolvedState.title}》
          </span>
          {spec.heading && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate text-zinc-500 dark:text-zinc-400">§ {spec.heading}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onEditSyntax}
            className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>语法</span>
          </button>
          <button
            type="button"
            onClick={() => wikiContext?.onNavigateWikiLink(spec.target, spec.heading)}
            className="flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 whitespace-nowrap shrink-0"
          >
            <span>{resolvedState.found ? '跳转源文档' : '创建此文档'}</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {resolvedState.loading ? (
        <div className="space-y-2 py-2">
          <div className="h-3.5 w-2/5 rounded bg-zinc-200/70 dark:bg-zinc-800" />
          <div className="h-3.5 w-4/5 rounded bg-zinc-200/70 dark:bg-zinc-800" />
        </div>
      ) : resolvedState.found ? (
        <div className={`space-y-1.5 text-zinc-700 dark:text-zinc-300 ${fontSizeClass} ${proseFontClass}`}>
          {excerptBlocks.length === 0 ? (
            <p className="text-xs text-zinc-400">源文档该章节暂无正文内容。</p>
          ) : (
            excerptBlocks.map((eb) => {
              if (eb.type === 'heading') {
                const hText = eb.raw.replace(/^#{1,6}\s+/, '');
                return (
                  <div key={eb.id} className="pt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {renderInlineNodes(hText, false, searchQuery, wikiContext)}
                  </div>
                );
              }
              if (eb.type === 'ul' || eb.type === 'ol' || eb.type === 'task') {
                return (
                  <div key={eb.id} className="space-y-1 text-[0.94em]">
                    {eb.raw.split('\n').map((ln, idx) => {
                      const cleanLn = ln.replace(/^\s*(?:[-*+]\s+\[[ xX]\]|[-*+]|\d+\.)\s+/, '');
                      return (
                        <div key={idx} className="flex items-baseline gap-2 leading-relaxed">
                          <span className="text-xs text-zinc-400 select-none">•</span>
                          <div className="flex-1">
                            {renderInlineNodes(cleanLn, false, searchQuery, wikiContext)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              }
              return (
                <p key={eb.id} className="text-[0.95em] leading-relaxed">
                  {renderInlineNodes(eb.raw, false, searchQuery, wikiContext)}
                </p>
              );
            })
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span>《{spec.target}》尚未创建，创建后此处会自动同步显示对应内容。</span>
          <button
            type="button"
            onClick={() => wikiContext?.onNavigateWikiLink(spec.target, spec.heading)}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 whitespace-nowrap shrink-0"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            <span>立即创建</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const BlockRenderer: React.FC<BlockRendererProps> = ({
  block,
  index,
  isActive,
  focusMode,
  syntaxReveal,
  fontSizeClass,
  proseFontClass,
  searchQuery,
  wikiContext,
  workspaceRevisionKey,
  onActivate,
  onChangeRaw,
  onSplitBlockAfter,
  onDeleteBlock,
  onMoveBlock,
  onInsertBlockBelow,
  onOpenSlashMenu,
  onCloseSlashMenu,
  onOpenWikiMenu,
  onCloseWikiMenu,
  onMeasuredHeight,
  onHtmlPaste,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);

  const [copiedCode, setCopiedCode] = useState(false);
  const [showCodeLineNumbers, setShowCodeLineNumbers] = useState(true);
  const [editStructuredSource, setEditStructuredSource] = useState(false);
  const [imageWidthPreset, setImageWidthPreset] = useState<'full' | '3/4' | '1/2'>('full');
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  useEffect(() => {
    if (!isActive) {
      setEditStructuredSource(false);
    }
  }, [isActive]);

  // Measure rendered block height for Fenwick Tree O(log N) scroll virtualization
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.height > 8) {
        onMeasuredHeight(index, rect.height);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, block.raw, isActive, editStructuredSource, onMeasuredHeight]);

  // Auto-focus and auto-size textarea when entering inline text block
  const isInlineEditableType =
    block.type === 'paragraph' ||
    block.type === 'heading' ||
    block.type === 'blockquote' ||
    block.type === 'callout' ||
    block.type === 'ul' ||
    block.type === 'ol' ||
    editStructuredSource;

  useEffect(() => {
    if (isActive && isInlineEditableType && textareaRef.current) {
      const ta = textareaRef.current;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(32, ta.scrollHeight)}px`;
      if (document.activeElement !== ta) {
        ta.focus({ preventScroll: true });
      }
    }
  }, [isActive, isInlineEditableType, block.raw]);

  const showSyntaxMarkers =
    syntaxReveal === 'always' || (syntaxReveal === 'active' && isActive);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextVal = e.target.value;

    // PRD ED-03: Never trigger Input Rules or Slash Palette while CJK IME is composing!
    if (isComposingRef.current) {
      onChangeRaw(index, nextVal, false);
      return;
    }

    // PRD 5.2 Input Rule: `[ ] ` shorthand -> `- [ ] ` with separate undo step
    if (nextVal === '[ ] ' || nextVal === '[] ') {
      onChangeRaw(index, '- [ ] ', true);
      onCloseSlashMenu();
      return;
    }
    if (nextVal === '[x] ' || nextVal === '[X] ') {
      onChangeRaw(index, '- [x] ', true);
      onCloseSlashMenu();
      return;
    }

    onChangeRaw(index, nextVal, false);

    // Detect `[[` or `![[` WikiLink / Embed autocomplete trigger before cursor
    const cursor = e.target.selectionStart ?? nextVal.length;
    const beforeCursor = nextVal.slice(0, cursor);
    const wikiTrigger = beforeCursor.match(/(!?)\[\[([^\][\n]{0,48})$/);
    if (wikiTrigger && onOpenWikiMenu) {
      onCloseSlashMenu();
      onOpenWikiMenu(index, wikiTrigger[2], wikiTrigger.index ?? 0, wikiTrigger[1] === '!');
      return;
    }
    onCloseWikiMenu?.();

    // PRD 5.5 Slash command trigger on empty line / block start
    const trimmed = nextVal.trim();
    if (trimmed.startsWith('/') && !trimmed.includes(' ') && trimmed.length <= 20) {
      onOpenSlashMenu(index, trimmed, rootRef.current);
    } else {
      onCloseSlashMenu();
    }
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current || e.nativeEvent.isComposing) return;

    const ta = e.currentTarget;
    const val = ta.value;
    const selStart = ta.selectionStart ?? 0;
    const selEnd = ta.selectionEnd ?? 0;

    // Tab / Shift+Tab inside lists or code (`PRD ED-04`, `CD-02`)
    if (e.key === 'Tab') {
      e.preventDefault();
      const lineStart = val.lastIndexOf('\n', selStart - 1) + 1;
      if (e.shiftKey) {
        if (val.slice(lineStart, lineStart + 2) === '  ') {
          const next = val.slice(0, lineStart) + val.slice(lineStart + 2);
          onChangeRaw(index, next, false);
        }
      } else {
        const next = val.slice(0, lineStart) + '  ' + val.slice(lineStart);
        onChangeRaw(index, next, false);
      }
      return;
    }

    if (e.key === 'Escape') {
      onCloseSlashMenu();
      onCloseWikiMenu?.();
      setEditStructuredSource(false);
      ta.blur();
      return;
    }

    // Backspace on empty block deletes block
    if (e.key === 'Backspace' && val.length === 0) {
      e.preventDefault();
      onDeleteBlock(index);
      return;
    }

    // Enter handling: list continuation, fenced code auto-close, or paragraph split (`PRD 5.2`, `ED-04`)
    if (e.key === 'Enter' && !e.shiftKey) {
      // Allow normal multi-line newline inside fenced code / math / mermaid source editor
      if (editStructuredSource || block.type === 'code' || block.type === 'mermaid' || block.type === 'math') {
        return;
      }

      const trimmedLine = val.trim();
      // Input Rule: ```lang + Enter -> Fenced Code Block
      const fenceTrigger = trimmedLine.match(/^```([a-zA-Z0-9_-]*)$/);
      if (fenceTrigger) {
        e.preventDefault();
        const lang = fenceTrigger[1] || 'rust';
        onChangeRaw(index, `\`\`\`${lang}\n\n\`\`\``, true);
        setEditStructuredSource(true);
        onCloseSlashMenu();
        return;
      }

      // Input Rule: --- + Enter -> Horizontal Rule + new block
      if (trimmedLine === '---' || trimmedLine === '***') {
        e.preventDefault();
        onSplitBlockAfter(index, '---', '');
        return;
      }

      // List continuation & empty-item exit (`PRD ED-04`)
      if (block.type === 'ul' || block.type === 'ol' || block.type === 'task') {
        const lineStart = val.lastIndexOf('\n', selStart - 1) + 1;
        const currentLine = val.slice(lineStart, selStart);
        const emptyListMarker = currentLine.match(/^\s*(?:[-*+]\s+\[[ xX]\]|[-*+]|\d+\.)\s*$/);
        if (emptyListMarker) {
          e.preventDefault();
          const cleaned = (val.slice(0, lineStart) + val.slice(selEnd)).trimEnd();
          onSplitBlockAfter(index, cleaned, '');
          return;
        }
        const listPrefixMatch = currentLine.match(/^(\s*)(?:([-*+])\s+\[[ xX]\]|([-*+])|(\d+)\.)\s+/);
        if (listPrefixMatch) {
          e.preventDefault();
          const indent = listPrefixMatch[1] || '';
          const nextPrefix = listPrefixMatch[2]
            ? `${indent}${listPrefixMatch[2]} [ ] `
            : listPrefixMatch[3]
            ? `${indent}${listPrefixMatch[3]} `
            : `${indent}${Number(listPrefixMatch[4] || 1) + 1}. `;
          const next = val.slice(0, selStart) + '\n' + nextPrefix + val.slice(selEnd);
          onChangeRaw(index, next, false);
          return;
        }
      }

      // Heading or single-paragraph Enter at end -> create clean paragraph below
      if (block.type === 'heading' || selStart === val.length) {
        e.preventDefault();
        const before = val.slice(0, selStart);
        const after = val.slice(selEnd);
        onSplitBlockAfter(index, before, after);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const html = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');
    if (html && html.includes('<') && /<(h[1-6]|table|ul|ol|strong|b|em|a|pre|blockquote)/i.test(html)) {
      e.preventDefault();
      onHtmlPaste(index, html, plain);
    }
  };

  const dimmedClass = focusMode && !isActive ? 'opacity-30 hover:opacity-75 transition-opacity duration-150' : '';

  const renderStructuredOrPreview = (): React.ReactNode => {
    // Active inline editing mode for text-centric blocks
    if (isActive && isInlineEditableType) {
      const headingScale =
        block.type === 'heading'
          ? block.level === 1
            ? 'text-3xl font-bold tracking-tight'
            : block.level === 2
            ? 'text-2xl font-bold tracking-tight'
            : block.level === 3
            ? 'text-xl font-semibold'
            : 'text-lg font-semibold'
          : editStructuredSource
          ? 'font-mono text-[13.5px] leading-relaxed bg-zinc-100/80 dark:bg-zinc-900/80 p-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800'
          : `${fontSizeClass} ${proseFontClass} leading-[1.72]`;

      return (
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={block.raw}
            rows={1}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              handleTextareaChange(e as unknown as React.ChangeEvent<HTMLTextAreaElement>);
            }}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handlePaste}
            aria-label={`编辑第 ${index + 1} 块 Markdown 内容`}
            className={`w-full resize-none overflow-hidden bg-transparent text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 ${headingScale}`}
            placeholder="输入文字，或键入 / 唤起命令面板…"
          />
          {editStructuredSource && (
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditStructuredSource(false);
                }}
                className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
              >
                完成源码编辑 (Esc)
              </button>
            </div>
          )}
        </div>
      );
    }

    // Rendered WYSIWYG views for each block type
    switch (block.type) {
      case 'frontmatter': {
        const pairs = block.raw
          .split('\n')
          .filter((l) => l.trim() !== '---' && l.trim() !== '...' && l.includes(':'))
          .map((l) => {
            const idx = l.indexOf(':');
            return { k: l.slice(0, idx).trim(), v: l.slice(idx + 1).trim() };
          });
        return (
          <div
            onClick={() => {
              onActivate(index);
              setEditStructuredSource(true);
            }}
            className="my-2 cursor-text rounded-xl border border-zinc-200/90 bg-zinc-100/60 px-4 py-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            <div className="mb-1.5 font-medium text-zinc-500 dark:text-zinc-400">
              文档属性 (YAML Front Matter)
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-700 dark:text-zinc-300">
              {pairs.map((p, idx) => (
                <span key={idx}>
                  <span className="font-mono text-zinc-500">{p.k}:</span> {p.v}
                </span>
              ))}
            </div>
          </div>
        );
      }

      case 'heading': {
        const firstLine = block.raw.split('\n')[0] || '';
        const textOnly = firstLine.replace(/^#{1,6}\s+/, '');
        const prefix = showSyntaxMarkers && !block.setext ? `${'#'.repeat(block.level || 1)} ` : '';
        const cls =
          block.level === 1
            ? 'pt-4 pb-2 text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50'
            : block.level === 2
            ? 'pt-3.5 pb-1.5 text-2xl font-bold tracking-tight text-zinc-950 border-b border-zinc-200/70 dark:border-zinc-800/80 dark:text-zinc-50'
            : block.level === 3
            ? 'pt-2.5 pb-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100'
            : 'pt-2 pb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100';
        return (
          <div className={`cursor-text ${cls}`}>
            {prefix && (
              <span className="mr-1 font-mono font-normal text-zinc-400 dark:text-zinc-500">
                {prefix}
              </span>
            )}
            {renderInlineNodes(textOnly, showSyntaxMarkers, searchQuery, wikiContext)}
          </div>
        );
      }

      case 'task': {
        const lines = block.raw.split('\n');
        return (
          <div className={`space-y-1.5 py-1 ${fontSizeClass} ${proseFontClass}`}>
            {lines.map((line, lIdx) => {
              const m = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/);
              if (!m) {
                return (
                  <div key={lIdx} className="pl-6 text-zinc-700 dark:text-zinc-300">
                    {renderInlineNodes(line, showSyntaxMarkers, searchQuery, wikiContext)}
                  </div>
                );
              }
              const indentSpaces = Math.min(6, Math.floor((m[1]?.length || 0) / 2));
              const checked = m[3].toLowerCase() === 'x';
              const body = m[4];
              const padClasses = ['pl-0', 'pl-5', 'pl-10', 'pl-14', 'pl-20', 'pl-24', 'pl-28'];

              return (
                <div
                  key={lIdx}
                  className={`flex items-start gap-2.5 ${padClasses[indentSpaces]}`}
                >
                  <button
                    type="button"
                    aria-label={checked ? '标记为未完成' : '标记为已完成'}
                    onClick={(e) => {
                      e.stopPropagation();
                      const updated = lines.slice();
                      updated[lIdx] = `${m[1]}${m[2]} [${checked ? ' ' : 'x'}] ${body}`;
                      onChangeRaw(index, updated.join('\n'), false);
                    }}
                    className={`mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      checked
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-zinc-300 bg-white hover:border-blue-500 dark:border-zinc-600 dark:bg-zinc-900'
                    }`}
                  >
                    {checked && <Check className="h-3 w-3 stroke-[2.5]" />}
                  </button>
                  <div
                    onClick={() => {
                      onActivate(index);
                      setEditStructuredSource(true);
                    }}
                    className={`flex-1 cursor-text leading-[1.68] ${
                      checked
                        ? 'text-zinc-400 line-through dark:text-zinc-500'
                        : 'text-zinc-800 dark:text-zinc-200'
                    }`}
                  >
                    {renderInlineNodes(body, showSyntaxMarkers, searchQuery, wikiContext)}
                  </div>
                </div>
              );
            })}
          </div>
        );
      }

      case 'ul':
      case 'ol': {
        const lines = block.raw.split('\n');
        return (
          <div className={`space-y-1 py-1 ${fontSizeClass} ${proseFontClass}`}>
            {lines.map((line, lIdx) => {
              const indentMatch = line.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
              if (!indentMatch) {
                return (
                  <div key={lIdx} className="pl-6 text-zinc-700 dark:text-zinc-300">
                    {renderInlineNodes(line, showSyntaxMarkers, searchQuery, wikiContext)}
                  </div>
                );
              }
              const depth = Math.min(6, Math.floor((indentMatch[1]?.length || 0) / 2));
              const padClasses = ['pl-0', 'pl-5', 'pl-10', 'pl-14', 'pl-20', 'pl-24', 'pl-28'];
              const markerLabel = indentMatch[3] ? `${indentMatch[3]}.` : '•';
              return (
                <div key={lIdx} className={`flex items-baseline gap-2.5 leading-[1.68] ${padClasses[depth]}`}>
                  <span className="w-4 shrink-0 select-none font-mono text-xs text-zinc-400 tabular-nums">
                    {showSyntaxMarkers && indentMatch[2] ? indentMatch[2] : markerLabel}
                  </span>
                  <div className="flex-1 text-zinc-800 dark:text-zinc-200">
                    {renderInlineNodes(indentMatch[4], showSyntaxMarkers, searchQuery, wikiContext)}
                  </div>
                </div>
              );
            })}
          </div>
        );
      }

      case 'blockquote':
      case 'callout': {
        const strippedLines = block.raw
          .split('\n')
          .map((l) => l.replace(/^>\s?/, ''));
        const isCallout = block.type === 'callout';
        const bodyLines = isCallout ? strippedLines.slice(1) : strippedLines;
        const kindLabel =
          block.calloutKind === 'TIP'
            ? '写作技巧 (TIP)'
            : block.calloutKind === 'IMPORTANT'
            ? '关键约束 (IMPORTANT)'
            : block.calloutKind === 'WARNING'
            ? '注意事项 (WARNING)'
            : '说明标注 (NOTE)';

        return (
          <div
            className={`my-2.5 cursor-text rounded-xl border px-5 py-3.5 ${
              isCallout
                ? 'border-blue-200/80 bg-blue-50/50 dark:border-blue-900/60 dark:bg-blue-950/25'
                : 'border-zinc-200/90 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-900/60'
            }`}
          >
            {isCallout && (
              <div className="mb-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
                {kindLabel}
              </div>
            )}
            <div className={`space-y-1 text-zinc-700 dark:text-zinc-300 ${fontSizeClass} ${proseFontClass}`}>
              {bodyLines.map((line, i) => (
                <p key={i} className="leading-relaxed">
                  {renderInlineNodes(line, showSyntaxMarkers, searchQuery, wikiContext)}
                </p>
              ))}
            </div>
          </div>
        );
      }

      case 'code': {
        const rawLines = block.raw.split('\n');
        const hasFence = rawLines[0]?.trim().startsWith('```') || rawLines[0]?.trim().startsWith('~~~');
        const codeLines = hasFence
          ? rawLines.slice(1, rawLines[rawLines.length - 1]?.trim().startsWith('`') || rawLines[rawLines.length - 1]?.trim().startsWith('~') ? -1 : undefined)
          : rawLines;
        const codeContent = codeLines.join('\n');
        const lang = block.language || 'text';

        return (
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-3 overflow-hidden rounded-xl border border-zinc-200/90 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/90"
          >
            <div className="flex items-center justify-between gap-4 border-b border-zinc-200/80 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <div className="flex items-center gap-3">
                <select
                  value={lang}
                  aria-label="选择代码语言"
                  onChange={(e) => {
                    const nextLang = e.target.value;
                    onChangeRaw(index, `\`\`\`${nextLang}\n${codeContent}\n\`\`\``, false);
                  }}
                  className="rounded bg-transparent py-0.5 font-mono text-xs font-medium text-zinc-700 outline-none hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                >
                  {['rust', 'toml', 'typescript', 'javascript', 'python', 'bash', 'sql', 'json', 'markdown', 'text'].map(
                    (l) => (
                      <option key={l} value={l} className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
                        {l}
                      </option>
                    )
                  )}
                </select>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setShowCodeLineNumbers((v) => !v)}
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                >
                  {showCodeLineNumbers ? '隐藏行号' : '显示行号'}
                </button>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    onActivate(index);
                    setEditStructuredSource(true);
                  }}
                  className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                >
                  <Code2 className="h-3.5 w-3.5" />
                  <span>编辑代码</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(codeContent);
                    setCopiedCode(true);
                    setTimeout(() => setCopiedCode(false), 1500);
                  }}
                  className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                >
                  {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedCode ? '已复制' : '复制'}</span>
                </button>
              </div>
            </div>

            <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.62] text-zinc-800 dark:text-zinc-200">
              {codeLines.map((line, lIdx) => (
                <div key={lIdx} className="flex">
                  {showCodeLineNumbers && (
                    <span className="mr-4 inline-block w-7 shrink-0 select-none text-right text-zinc-400 tabular-nums dark:text-zinc-600">
                      {lIdx + 1}
                    </span>
                  )}
                  <span className="flex-1 whitespace-pre">
                    {tokenizeCodeLine(line).map((tok, tIdx) => {
                      const cls =
                        tok.kind === 'kw'
                          ? 'font-semibold text-blue-700 dark:text-blue-400'
                          : tok.kind === 'str'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : tok.kind === 'cmt'
                          ? 'italic text-zinc-400 dark:text-zinc-500'
                          : tok.kind === 'num'
                          ? 'text-amber-700 dark:text-amber-300'
                          : tok.kind === 'fn'
                          ? 'text-indigo-700 dark:text-indigo-300'
                          : '';
                      return (
                        <span key={tIdx} className={cls}>
                          {tok.text}
                        </span>
                      );
                    })}
                  </span>
                </div>
              ))}
            </pre>
          </div>
        );
      }

      case 'mermaid': {
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-3 rounded-xl border border-zinc-200/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
              <span>Mermaid 架构图 (即时矢量渲染)</span>
              <button
                type="button"
                onClick={() => {
                  onActivate(index);
                  setEditStructuredSource(true);
                }}
                className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
              >
                <Code2 className="h-3.5 w-3.5" />
                <span>编辑语法</span>
              </button>
            </div>
            <MermaidSvgView raw={block.raw} />
          </div>
        );
      }

      case 'math': {
        const expr = block.raw
          .replace(/^```(?:math|latex)\s*/i, '')
          .replace(/```$/, '')
          .replace(/^\$\$\s*/, '')
          .replace(/\s*\$\$$/, '')
          .trim();

        let renderedHtml = '';
        let mathError = '';
        try {
          renderedHtml = katex.renderToString(expr, {
            displayMode: true,
            throwOnError: true,
          });
        } catch (err) {
          mathError = err instanceof Error ? err.message : String(err);
        }

        return (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onActivate(index);
              setEditStructuredSource(true);
            }}
            title="点击编辑 LaTeX 公式源码"
            className="my-3 cursor-pointer rounded-xl border border-transparent px-4 py-3 transition-colors hover:border-zinc-200 hover:bg-zinc-100/50 dark:hover:border-zinc-800 dark:hover:bg-zinc-900/40"
          >
            {mathError ? (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                <div className="font-semibold">LaTeX 公式语法定位提示（点击修改源码）：</div>
                <div className="mt-1 font-mono">{mathError}</div>
              </div>
            ) : (
              <div
                className="overflow-x-auto text-center text-zinc-900 dark:text-zinc-100"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            )}
          </div>
        );
      }

      case 'table': {
        const parsed = parseGfmTable(block.raw);
        if (!parsed) {
          return (
            <div
              onClick={() => {
                onActivate(index);
                setEditStructuredSource(true);
              }}
              className="font-mono text-sm"
            >
              {block.raw}
            </div>
          );
        }

        const updateTable = (next: typeof parsed) => {
          onChangeRaw(index, serializeGfmTable(next), false);
        };

        const alignClass = (a: ColumnAlign) =>
          a === 'center' ? 'text-center' : a === 'right' ? 'text-right tabular-nums' : 'text-left';

        return (
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-3 overflow-hidden rounded-xl border border-zinc-200/90 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <span>GFM 表格 · 支持 Tab 切换单元格</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextRows = [...parsed.rows, Array(parsed.headers.length).fill('')];
                    updateTable({ ...parsed, rows: nextRows });
                  }}
                  className="rounded px-2 py-0.5 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  + 新增行
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateTable({
                      headers: [...parsed.headers, `列 ${parsed.headers.length + 1}`],
                      alignments: [...parsed.alignments, 'none'],
                      rows: parsed.rows.map((r) => [...r, '']),
                    });
                  }}
                  className="rounded px-2 py-0.5 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  + 新增列
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onActivate(index);
                    setEditStructuredSource(true);
                  }}
                  className="rounded px-2 py-0.5 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  源码
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/80">
                    {parsed.headers.map((h, cIdx) => (
                      <th
                        key={cIdx}
                        className={`border-r border-zinc-200/70 px-3 py-2 font-semibold last:border-r-0 dark:border-zinc-800 ${alignClass(
                          parsed.alignments[cIdx]
                        )}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={h}
                            aria-label={`表头第 ${cIdx + 1} 列`}
                            onChange={(e) => {
                              const nextHeaders = parsed.headers.slice();
                              nextHeaders[cIdx] = e.target.value;
                              updateTable({ ...parsed, headers: nextHeaders });
                            }}
                            className={`w-full bg-transparent font-semibold text-zinc-900 outline-none focus:text-blue-600 dark:text-zinc-100 ${alignClass(
                              parsed.alignments[cIdx]
                            )}`}
                          />
                          <button
                            type="button"
                            title="切换列对齐 (:--- / :---: / ---:)"
                            onClick={() => {
                              const order: ColumnAlign[] = ['left', 'center', 'right'];
                              const curr = parsed.alignments[cIdx];
                              const nextAlign = order[(order.indexOf(curr) + 1) % order.length];
                              const nextAligns = parsed.alignments.slice();
                              nextAligns[cIdx] = nextAlign;
                              updateTable({ ...parsed, alignments: nextAligns });
                            }}
                            className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          >
                            {parsed.alignments[cIdx] === 'center' ? (
                              <AlignCenter className="h-3.5 w-3.5" />
                            ) : parsed.alignments[cIdx] === 'right' ? (
                              <AlignRight className="h-3.5 w-3.5" />
                            ) : (
                              <AlignLeft className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="border-b border-zinc-200/60 last:border-b-0 hover:bg-zinc-50/60 dark:border-zinc-800/70 dark:hover:bg-zinc-800/30"
                    >
                      {parsed.headers.map((_, cIdx) => (
                        <td
                          key={cIdx}
                          className={`border-r border-zinc-200/60 px-3 py-2 last:border-r-0 dark:border-zinc-800/70 ${alignClass(
                            parsed.alignments[cIdx]
                          )}`}
                        >
                          <input
                            type="text"
                            value={row[cIdx] ?? ''}
                            aria-label={`表格第 ${rIdx + 1} 行第 ${cIdx + 1} 列`}
                            onChange={(e) => {
                              const nextRows = parsed.rows.map((r) => r.slice());
                              nextRows[rIdx][cIdx] = e.target.value;
                              updateTable({ ...parsed, rows: nextRows });
                            }}
                            onKeyDown={(e) => {
                              // PRD TB-02: Tab on last cell appends a new row automatically
                              if (
                                e.key === 'Tab' &&
                                !e.shiftKey &&
                                rIdx === parsed.rows.length - 1 &&
                                cIdx === parsed.headers.length - 1
                              ) {
                                e.preventDefault();
                                updateTable({
                                  ...parsed,
                                  rows: [...parsed.rows, Array(parsed.headers.length).fill('')],
                                });
                              }
                            }}
                            className={`w-full bg-transparent text-zinc-700 outline-none focus:text-zinc-950 dark:text-zinc-300 dark:focus:text-white ${alignClass(
                              parsed.alignments[cIdx]
                            )}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      }

      case 'image': {
        const m = block.raw.trim().match(/^!\[([^\]]*)\]\(([^\s")]+)(?:\s+"([^"]*)")?\)/);
        const alt = m?.[1] || '文档图像';
        const src = m?.[2] || '';
        const title = m?.[3] || '';
        const widthCls =
          imageWidthPreset === '1/2' ? 'max-w-md' : imageWidthPreset === '3/4' ? 'max-w-2xl' : 'max-w-full';

        return (
          <figure
            onClick={(e) => e.stopPropagation()}
            className="my-4 rounded-xl border border-zinc-200/80 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
              <span className="truncate">{alt}</span>
              <div className="flex items-center gap-2">
                {(['1/2', '3/4', 'full'] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setImageWidthPreset(preset)}
                    className={`rounded px-1.5 py-0.5 whitespace-nowrap shrink-0 ${
                      imageWidthPreset === preset
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                        : 'hover:bg-zinc-200 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {preset === 'full' ? '100%' : preset === '3/4' ? '75%' : '50%'}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    onActivate(index);
                    setEditStructuredSource(true);
                  }}
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
                >
                  属性
                </button>
              </div>
            </div>

            {src && !imageLoadFailed ? (
              <img
                src={src}
                alt={alt}
                title={title}
                referrerPolicy="no-referrer"
                onError={() => setImageLoadFailed(true)}
                className={`mx-auto rounded-lg object-contain ${widthCls}`}
              />
            ) : (
              <div className="flex h-36 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-100/70 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
                <Eye className="mb-1.5 h-5 w-5 text-zinc-400" />
                <span>图像资源：{alt}</span>
                <span className="mt-0.5 font-mono text-[11px]">{src || '未指定路径'}</span>
              </div>
            )}
          </figure>
        );
      }

      case 'embed':
        return (
          <EmbedTransclusionCard
            raw={block.raw}
            fontSizeClass={fontSizeClass}
            proseFontClass={proseFontClass}
            searchQuery={searchQuery}
            wikiContext={wikiContext}
            workspaceRevisionKey={workspaceRevisionKey}
            onEditSyntax={() => {
              onActivate(index);
              setEditStructuredSource(true);
            }}
          />
        );

      case 'hr':
        return (
          <div className="py-4">
            <hr className="border-zinc-200 dark:border-zinc-800" />
          </div>
        );

      default:
        return (
          <p
            className={`cursor-text whitespace-pre-wrap py-1 leading-[1.74] text-zinc-800 dark:text-zinc-200 ${fontSizeClass} ${proseFontClass}`}
          >
            {block.raw ? (
              renderInlineNodes(block.raw, showSyntaxMarkers, searchQuery, wikiContext)
            ) : (
              <span className="text-zinc-400 dark:text-zinc-600">点击输入内容，或键入 / 插入结构块…</span>
            )}
          </p>
        );
    }
  };

  return (
    <div
      ref={rootRef}
      onClick={() => onActivate(index)}
      className={`group relative rounded-lg px-2 py-0.5 transition-colors duration-150 ${
        isActive ? 'bg-blue-500/[0.03] dark:bg-blue-400/[0.04]' : ''
      } ${dimmedClass}`}
    >
      {/* PRD 5.5: Left Block Action Gutter (+ Insert & Reorder/Delete controls) */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="no-print absolute -left-12 top-1.5 hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 lg:flex"
      >
        <button
          type="button"
          title="在下方插入新段落"
          onClick={() => onInsertBlockBelow(index, '')}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <div className="flex flex-col">
          <button
            type="button"
            title="上移此块"
            onClick={() => onMoveBlock(index, -1)}
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="下移此块"
            onClick={() => onMoveBlock(index, 1)}
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>
        <button
          type="button"
          title="删除此块"
          onClick={() => onDeleteBlock(index)}
          className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {renderStructuredOrPreview()}
    </div>
  );
};
