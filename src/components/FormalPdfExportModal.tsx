import React, { useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import {
  Check,
  Download,
  FileCode2,
  FileDown,
  FileText,
  Loader2,
  X,
} from 'lucide-react';
import type { BlockRecord } from '../engine/markdownEngine';
import {
  computeClientMetrics,
  parseGfmTable,
  serializeBlocksLossless,
} from '../engine/markdownEngine';

export type FormalPresetId = 'spec' | 'official' | 'academic';
export type FormalPaperSize = 'A4' | 'Letter';
export type FormalMarginPreset = 'standard' | 'compact' | 'binding';

interface FormalPdfExportModalProps {
  open: boolean;
  docId: string;
  title: string;
  revision: number;
  blocks: BlockRecord[];
  lineEnding: 'lf' | 'crlf';
  onClose: () => void;
  onDownloadRustWorkspace: () => void;
  onInspectRustPdfEngine: () => void;
}

const PRESET_DEFINITIONS: Array<{
  id: FormalPresetId;
  label: string;
  subtitle: string;
  accentSwatchClass: string;
}> = [
  {
    id: 'spec',
    label: '技术白皮书 / 工程规范',
    subtitle: '深石板蓝双文头线 · 四栏受控元信息表 · 自动章节编号 · 正式网格表',
    accentSwatchClass: 'bg-[#1E3A8A]',
  },
  {
    id: 'official',
    label: '企事业正式报告 / 公文版式',
    subtitle: '朱红上粗下细双文头线 · 居中主标题 · 正文首行缩进两字 · 正式三线表',
    accentSwatchClass: 'bg-[#991B1B]',
  },
  {
    id: 'academic',
    label: '学术论文 / 单栏研究手稿',
    subtitle: '炭黑细线 · 居中题名与机构署名 · 右对齐公式编号 · 学术三线表',
    accentSwatchClass: 'bg-zinc-900',
  },
];

const MARGIN_MM_MAP: Record<FormalMarginPreset, number> = {
  standard: 25.4,
  compact: 18,
  binding: 30,
};

function cleanInlinePreviewText(raw: string): string {
  return raw
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => inner.replace(/#/g, ' § '))
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图表：$1]')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .trim();
}

export const FormalPdfExportModal: React.FC<FormalPdfExportModalProps> = ({
  open,
  docId,
  title,
  revision,
  blocks,
  lineEnding,
  onClose,
  onDownloadRustWorkspace,
  onInspectRustPdfEngine,
}) => {
  const [preset, setPreset] = useState<FormalPresetId>('spec');
  const [paperSize, setPaperSize] = useState<FormalPaperSize>('A4');
  const [marginPreset, setMarginPreset] = useState<FormalMarginPreset>('standard');
  const [includeCoverMeta, setIncludeCoverMeta] = useState(true);
  const [includeToc, setIncludeToc] = useState(true);
  const [autoNumberHeadings, setAutoNumberHeadings] = useState(true);
  const [includeHeaderFooter, setIncludeHeaderFooter] = useState(true);
  const [organization, setOrganization] = useState('Vellum Native 本地知识工程体系');
  const [documentCode, setDocumentCode] = useState('');
  const [exportListMarker, setExportListMarker] = useState<'-' | '*'>('-');

  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const safePrefix = (docId || 'DOC').slice(0, 12).toUpperCase();
    setDocumentCode(`VN-${safePrefix}-V${revision || 1}`);
    setExportFeedback(null);
    setExportError(null);
  }, [docId, revision, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const rawMarkdown = useMemo(
    () => serializeBlocksLossless(blocks, lineEnding),
    [blocks, lineEnding]
  );

  const metrics = useMemo(
    () => computeClientMetrics(rawMarkdown, blocks.length),
    [rawMarkdown, blocks.length]
  );

  // Deduplicate leading H1 if identical to document title
  const contentBlocks = useMemo(() => {
    if (blocks.length === 0) return blocks;
    const first = blocks[0];
    if (first.type === 'heading' && (first.level || 1) === 1) {
      const headingText = cleanInlinePreviewText(first.raw.replace(/^#{1,6}\s+/, ''));
      if (headingText.trim().toLowerCase() === title.trim().toLowerCase()) {
        return blocks.slice(1);
      }
    }
    return blocks;
  }, [blocks, title]);

  // Hierarchical section numbers & Table of Contents entries
  const { sectionNumberMap, tocEntries, displayEquationMap } = useMemo(() => {
    let minLevel = 6;
    for (const b of contentBlocks) {
      if (b.type === 'heading') {
        minLevel = Math.min(minLevel, b.level || 1);
      }
    }

    const counters = [0, 0, 0, 0, 0, 0];
    const numMap = new Map<string, string>();
    const toc: Array<{ id: string; depth: number; prefix: string; text: string }> = [];
    const eqMap = new Map<string, number>();
    let eqIdx = 0;

    for (const b of contentBlocks) {
      if (b.type === 'heading') {
        const lv = b.level || 1;
        const depth = Math.min(5, Math.max(0, lv - minLevel));
        counters[depth] += 1;
        for (let d = depth + 1; d < 6; d++) counters[d] = 0;
        const prefix = autoNumberHeadings ? counters.slice(0, depth + 1).join('.') : '';
        numMap.set(b.id, prefix);
        if (depth <= 2) {
          toc.push({
            id: b.id,
            depth: depth + 1,
            prefix,
            text: cleanInlinePreviewText(
              b.raw.split('\n')[0].replace(/^#{1,6}\s+/, '').replace(/\s+#*$/, '')
            ),
          });
        }
      } else if (b.type === 'math') {
        eqIdx += 1;
        eqMap.set(b.id, eqIdx);
      }
    }

    return {
      sectionNumberMap: numMap,
      tocEntries: toc,
      displayEquationMap: eqMap,
    };
  }, [contentBlocks, autoNumberHeadings]);

  const estimatedPages = useMemo(
    () => Math.max(1, Math.ceil((metrics.wordCount + (includeToc ? 220 : 0)) / 620)),
    [metrics.wordCount, includeToc]
  );

  if (!open) return null;

  const todayIso = new Date().toISOString().slice(0, 10);

  const handleDownloadFormalPdf = async () => {
    setIsGeneratingPdf(true);
    setExportError(null);
    setExportFeedback(null);

    try {
      const response = await fetch('/api/v1/export/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          docId: docId || 'vellum-doc',
          revision: revision || 1,
          markdown: rawMarkdown,
          preset,
          paperSize,
          marginMm: MARGIN_MM_MAP[marginPreset],
          includeCoverMeta,
          includeToc,
          autoNumberHeadings,
          includeHeaderFooter,
          organization,
          documentCode,
        }),
      });

      if (!response.ok) {
        let msg = `导出失败 (${response.status})`;
        try {
          const errJson = (await response.json()) as { error?: string };
          if (errJson.error) msg = errJson.error;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const pdfBlob = await response.blob();
      const url = URL.createObjectURL(pdfBlob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(title || '正式文档').replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);

      const kb = (pdfBlob.size / 1024).toFixed(1);
      setExportFeedback(`已生成并下载正式矢量 PDF（${kb} KB）`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'PDF 生成失败，请稍后重试');
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleDownloadMarkdown = () => {
    let md = rawMarkdown;
    if (exportListMarker === '*') {
      md = md.replace(/^(\s*)-(\s+(?!\[[ xX]\]))/gm, '$1*$2');
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'document'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadStandaloneHtml = () => {
    const mdEscaped = serializeBlocksLossless(blocks, 'lf')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const htmlDoc = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { max-width: 820px; margin: 48px auto; padding: 0 24px; font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif; line-height: 1.8; color: #111827; }
  h1 { border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; }
  pre { background: #f8fafc; border: 1px solid #cbd5e1; padding: 14px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 13px; }
</style>
</head>
<body>
<h1>${title}</h1>
<pre>${mdEscaped}</pre>
</body>
</html>`;
    const blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'document'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sheetPaddingClass =
    marginPreset === 'compact'
      ? 'px-10 py-10 sm:px-12 sm:py-12'
      : marginPreset === 'binding'
        ? 'px-12 py-14 sm:px-20 sm:py-16'
        : 'px-10 py-12 sm:px-16 sm:py-14';

  const sheetWidthClass = paperSize === 'Letter' ? 'max-w-[816px]' : 'max-w-[794px]';

  const ruleUpperColor =
    preset === 'official'
      ? 'border-[#991B1B]'
      : preset === 'academic'
        ? 'border-zinc-900'
        : 'border-[#1E3A8A]';

  const accentTextColor =
    preset === 'official'
      ? 'text-[#991B1B]'
      : preset === 'academic'
        ? 'text-zinc-900'
        : 'text-[#1E3A8A]';

  const presetHeaderLabel =
    preset === 'official'
      ? '正式报告与公文版式'
      : preset === 'academic'
        ? '学术论文与单栏研究手稿'
        : '技术白皮书与工程规范';

  const isThreeLineTable = preset === 'official' || preset === 'academic';

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 sm:p-5"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[90vh] w-full max-w-[1260px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl lg:flex-row dark:border-zinc-800 dark:bg-[#111622]"
      >
        {/* Left Control Rail: Formal PDF Typesetting Settings & Export Actions */}
        <div className="no-print flex w-full shrink-0 flex-col justify-between overflow-y-auto border-b border-zinc-200 bg-white p-5 lg:w-[392px] lg:border-b-0 lg:border-r dark:border-zinc-800 dark:bg-[#111622]">
          <div className="space-y-5">
            {/* Modal Title */}
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 pb-3.5 dark:border-zinc-800">
              <div>
                <h2 className="text-base font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
                  正式排版 PDF 导出中心
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  原生端基于 Rust <code className="font-mono">krilla</code> 离线子集化矢量引擎生成
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                title="关闭 (Esc)"
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 1. Formal Template Presets */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                1. 正式文档版式规范
              </div>
              <div className="space-y-1.5">
                {PRESET_DEFINITIONS.map((item) => {
                  const active = preset === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setPreset(item.id)}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        active
                          ? 'border-blue-600 bg-blue-50/50 dark:border-blue-500 dark:bg-blue-950/30'
                          : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-xs ${item.accentSwatchClass}`} />
                          <span className="text-xs font-semibold text-zinc-950 dark:text-zinc-100">
                            {item.label}
                          </span>
                        </div>
                        {active && <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        {item.subtitle}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Paper Size & Margin Geometry */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  纸张幅面
                </label>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/90">
                  {(['A4', 'Letter'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setPaperSize(sz)}
                      className={`rounded-md py-1 text-xs font-medium transition-colors ${
                        paperSize === sz
                          ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                          : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400'
                      }`}
                    >
                      {sz === 'A4' ? 'ISO A4' : 'US Letter'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  页边距标准
                </label>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/90">
                  {(
                    [
                      ['standard', '标准'],
                      ['compact', '紧凑'],
                      ['binding', '宽边'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setMarginPreset(id)}
                      className={`rounded-md py-1 text-xs font-medium transition-colors ${
                        marginPreset === id
                          ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                          : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 3. Controlled Header Metadata Inputs */}
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                  签发机构 / 署名单位
                </label>
                <input
                  type="text"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:border-blue-600 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                  受控文档编号
                </label>
                <input
                  type="text"
                  value={documentCode}
                  onChange={(e) => setDocumentCode(e.target.value)}
                  className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-900 focus:border-blue-600 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>

            {/* 4. Formal Typesetting Checkboxes */}
            <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
              <div className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
                正式排版结构要素
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={includeCoverMeta}
                  onChange={(e) => setIncludeCoverMeta(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 accent-blue-600"
                />
                <span>受控文头元信息栏（编号 / 版本 / 签发日期 / 校验码）</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={includeToc}
                  onChange={(e) => setIncludeToc(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 accent-blue-600"
                />
                <span>自动生成多级目录大纲（TOC）</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={autoNumberHeadings}
                  onChange={(e) => setAutoNumberHeadings(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 accent-blue-600"
                />
                <span>章节标题自动多级编号（1 / 1.1 / 1.1.1）</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={includeHeaderFooter}
                  onChange={(e) => setIncludeHeaderFooter(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 accent-blue-600"
                />
                <span>双遍扫描奇偶页眉与精确页码（第 X 页 / 共 Y 页）</span>
              </label>
            </div>

            {/* Primary Vector PDF Download Button */}
            <div className="space-y-2">
              <button
                type="button"
                disabled={isGeneratingPdf}
                onClick={handleDownloadFormalPdf}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                {isGeneratingPdf ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>正在子集化中文字体并排版矢量 PDF…</span>
                  </>
                ) : (
                  <>
                    <FileDown className="h-4 w-4" />
                    <span>下载正式排版矢量 PDF (.pdf)</span>
                  </>
                )}
              </button>

              {exportFeedback && (
                <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  {exportFeedback}
                </div>
              )}
              {exportError && (
                <div className="text-xs font-medium text-red-600 dark:text-red-400">
                  {exportError}
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  onClose();
                  onInspectRustPdfEngine();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <FileCode2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                <span>检视 Rust 原生矢量 PDF 源码 (pdf_export.rs)</span>
              </button>
            </div>
          </div>

          {/* Bottom Unified Export Formats & Rust Workspace Bundle */}
          <div className="mt-5 space-y-2.5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
              <span>其他格式与原生工程包</span>
              <span className="inline-flex items-center gap-1">
                <span>MD 列表符:</span>
                <button
                  type="button"
                  onClick={() => setExportListMarker('-')}
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    exportListMarker === '-'
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'bg-zinc-100 dark:bg-zinc-800'
                  }`}
                >
                  -
                </button>
                <button
                  type="button"
                  onClick={() => setExportListMarker('*')}
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    exportListMarker === '*'
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'bg-zinc-100 dark:bg-zinc-800'
                  }`}
                >
                  *
                </button>
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleDownloadMarkdown}
                className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Markdown (.md)</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadStandaloneHtml}
                className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>独立 HTML</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                onDownloadRustWorkspace();
                onClose();
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100/70 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300"
            >
              <FileCode2 className="h-3.5 w-3.5" />
              <span>下载完整本地 Rust + GPUI 工程 (setup-vellum-rust-gpui.sh)</span>
            </button>
          </div>
        </div>

        {/* Right Live Preview Pane: Authentic ISO A4 / Letter Formal Paper Sheet */}
        <div className="flex-1 overflow-y-auto bg-zinc-200/80 p-4 sm:p-8 dark:bg-[#090C12]">
          <div className="no-print mx-auto mb-3 flex max-w-[794px] items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
            <span>
              实时正式版式预览 · {paperSize === 'A4' ? 'ISO A4 (210 × 297 mm)' : 'US Letter (216 × 279 mm)'} · 页边距{' '}
              {MARGIN_MM_MAP[marginPreset]} mm
            </span>
            <span className="tabular-nums">
              {metrics.wordCount.toLocaleString()} 字 · 预计约 {estimatedPages} 页
            </span>
          </div>

          {/* Crisp White Physical Document Sheet */}
          <article
            className={`formal-print-sheet mx-auto min-h-[1060px] w-full ${sheetWidthClass} border border-zinc-300 bg-white text-zinc-950 shadow-xl ${sheetPaddingClass} ${
              preset === 'official' || preset === 'academic' ? 'font-editorial-serif' : ''
            }`}
          >
            {/* Running Header Indicator */}
            {includeHeaderFooter && (
              <div className="mb-7 flex items-center justify-between border-b border-zinc-200 pb-2 text-[11px] text-zinc-500">
                <span className="truncate">{organization}</span>
                <span className="font-mono">{documentCode}</span>
              </div>
            )}

            {/* Formal Title & Double Header Rule (`上粗下细双文头线`) */}
            <div className={preset === 'spec' ? 'text-left' : 'text-center'}>
              <div className={`text-xs font-semibold tracking-wide ${accentTextColor}`}>
                {organization} · {presetHeaderLabel}
              </div>
              <h1
                className={`mt-2 font-bold tracking-tight text-zinc-950 ${
                  preset === 'official' ? 'text-[26px] leading-snug' : 'text-[23px] leading-snug'
                }`}
              >
                {title}
              </h1>
            </div>

            <div className="mt-4 mb-5">
              <div className={`border-t-2 ${ruleUpperColor}`} />
              <div className={`mt-[3px] border-t ${ruleUpperColor}`} />
            </div>

            {/* Controlled Document Metadata Block */}
            {includeCoverMeta &&
              (preset === 'spec' ? (
                <div className="mb-7 grid grid-cols-2 border border-zinc-300 bg-slate-50/80 text-xs sm:grid-cols-4">
                  <div className="border-b border-r border-zinc-300 px-3 py-2 sm:border-b-0">
                    <div className="text-[10px] text-zinc-500">文档编号</div>
                    <div className="mt-0.5 font-mono font-medium text-zinc-900">{documentCode}</div>
                  </div>
                  <div className="border-b border-zinc-300 px-3 py-2 sm:border-b-0 sm:border-r">
                    <div className="text-[10px] text-zinc-500">受控版本</div>
                    <div className="mt-0.5 font-mono font-medium text-zinc-900">
                      Rev #{revision || 1}
                    </div>
                  </div>
                  <div className="border-r border-zinc-300 px-3 py-2">
                    <div className="text-[10px] text-zinc-500">签发日期</div>
                    <div className="mt-0.5 font-mono font-medium text-zinc-900">{todayIso}</div>
                  </div>
                  <div className="px-3 py-2">
                    <div className="text-[10px] text-zinc-500">字数与预计耗时</div>
                    <div className="mt-0.5 font-mono font-medium text-zinc-900">
                      {metrics.wordCount.toLocaleString()} 字 · {metrics.readingMinutes} min
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mb-7 text-center text-xs text-zinc-600">
                  编号：<span className="font-mono">{documentCode}</span>
                  <span className="mx-3">|</span>
                  版本：<span className="font-mono">Rev #{revision || 1}</span>
                  <span className="mx-3">|</span>
                  日期：<span className="font-mono">{todayIso}</span>
                  <span className="mx-3">|</span>
                  规模：{metrics.wordCount.toLocaleString()} 字
                </div>
              ))}

            {/* Automatic Hierarchical Table of Contents (`目 录`) */}
            {includeToc && tocEntries.length >= 2 && (
              <div className="mb-8 border-y border-zinc-200 py-4">
                <div
                  className={`mb-2.5 text-sm font-bold tracking-widest text-zinc-900 ${
                    preset === 'spec' ? 'text-left' : 'text-center'
                  }`}
                >
                  目 录
                </div>
                <div className="space-y-1.5">
                  {tocEntries.slice(0, 24).map((entry) => {
                    const indentClass =
                      entry.depth === 1 ? 'pl-0 font-semibold text-zinc-900' : entry.depth === 2 ? 'pl-4 text-zinc-700' : 'pl-8 text-zinc-600';
                    return (
                      <div
                        key={entry.id}
                        className={`flex items-baseline gap-2 text-xs ${indentClass}`}
                      >
                        <span className="shrink-0">
                          {entry.prefix ? `${entry.prefix}  ${entry.text}` : entry.text}
                        </span>
                        <span className="flex-1 border-b border-dotted border-zinc-300" />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Formal Document Body Content */}
            <div className="space-y-3.5 text-[14px] leading-[1.82] text-zinc-900">
              {contentBlocks.map((block) => {
                if (block.type === 'frontmatter') return null;

                if (block.type === 'heading') {
                  const lv = block.level || 1;
                  const numPrefix = sectionNumberMap.get(block.id);
                  const cleanHeading = cleanInlinePreviewText(
                    block.raw.split('\n')[0].replace(/^#{1,6}\s+/, '').replace(/\s+#*$/, '')
                  );
                  const fullHeading = numPrefix ? `${numPrefix}  ${cleanHeading}` : cleanHeading;

                  if (lv === 1) {
                    return (
                      <h2
                        key={block.id}
                        className={`mt-7 mb-2.5 text-[18px] font-bold tracking-tight ${accentTextColor} ${
                          preset === 'spec' ? 'border-b border-zinc-200 pb-1.5' : ''
                        }`}
                      >
                        {fullHeading}
                      </h2>
                    );
                  }
                  if (lv === 2) {
                    return (
                      <h3
                        key={block.id}
                        className="mt-5 mb-2 text-[15.5px] font-bold text-zinc-950"
                      >
                        {fullHeading}
                      </h3>
                    );
                  }
                  return (
                    <h4 key={block.id} className="mt-4 mb-1.5 text-[14px] font-semibold text-zinc-900">
                      {fullHeading}
                    </h4>
                  );
                }

                if (block.type === 'paragraph') {
                  const text = cleanInlinePreviewText(block.raw);
                  return (
                    <p
                      key={block.id}
                      className={`text-justify text-zinc-800 ${
                        preset === 'official' ? 'indent-[2em]' : ''
                      }`}
                    >
                      {text}
                    </p>
                  );
                }

                if (block.type === 'ul' || block.type === 'ol' || block.type === 'task') {
                  const items = block.raw.split('\n').filter((l) => l.trim().length > 0);
                  return (
                    <div key={block.id} className="space-y-1.5 pl-4">
                      {items.map((line, idx) => {
                        const taskM = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
                        if (taskM) {
                          const done = taskM[1].toLowerCase() === 'x';
                          return (
                            <div key={idx} className="flex items-baseline gap-2 text-[13.5px]">
                              <span className="font-mono text-xs text-zinc-600">
                                {done ? '[✓]' : '[ ]'}
                              </span>
                              <span className={done ? 'text-zinc-500' : 'text-zinc-800'}>
                                {cleanInlinePreviewText(taskM[2])}
                              </span>
                            </div>
                          );
                        }
                        const ordM = line.match(/^\s*(\d+\.)\s+(.*)$/);
                        if (ordM) {
                          return (
                            <div key={idx} className="flex items-baseline gap-2 text-[13.5px]">
                              <span className="font-mono text-xs text-zinc-600">{ordM[1]}</span>
                              <span className="text-zinc-800">{cleanInlinePreviewText(ordM[2])}</span>
                            </div>
                          );
                        }
                        const bul = line.replace(/^\s*[-*+]\s+/, '');
                        return (
                          <div key={idx} className="flex items-baseline gap-2 text-[13.5px]">
                            <span className="text-zinc-500">•</span>
                            <span className="text-zinc-800">{cleanInlinePreviewText(bul)}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                if (block.type === 'table') {
                  const parsed = parseGfmTable(block.raw);
                  if (!parsed) return null;
                  return (
                    <div key={block.id} className="my-4 overflow-x-auto">
                      <table
                        className={`w-full border-collapse text-xs ${
                          isThreeLineTable
                            ? 'border-y-2 border-zinc-900'
                            : 'border border-zinc-300'
                        }`}
                      >
                        <thead>
                          <tr
                            className={
                              isThreeLineTable
                                ? 'border-b border-zinc-800 bg-white'
                                : 'border-b border-zinc-300 bg-slate-100/90'
                            }
                          >
                            {parsed.headers.map((h, ci) => {
                              const align = parsed.alignments[ci];
                              const alignCls =
                                align === 'center'
                                  ? 'text-center'
                                  : align === 'right'
                                    ? 'text-right'
                                    : 'text-left';
                              return (
                                <th
                                  key={ci}
                                  className={`px-3 py-2 font-semibold text-zinc-950 ${alignCls} ${
                                    !isThreeLineTable ? 'border-r border-zinc-300 last:border-r-0' : ''
                                  }`}
                                >
                                  {cleanInlinePreviewText(h)}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {parsed.rows.map((row, ri) => (
                            <tr
                              key={ri}
                              className={
                                isThreeLineTable
                                  ? ''
                                  : 'border-b border-zinc-200 even:bg-zinc-50/70 last:border-b-0'
                              }
                            >
                              {parsed.headers.map((_, ci) => {
                                const align = parsed.alignments[ci];
                                const alignCls =
                                  align === 'center'
                                    ? 'text-center'
                                    : align === 'right'
                                      ? 'text-right'
                                      : 'text-left';
                                return (
                                  <td
                                    key={ci}
                                    className={`px-3 py-1.5 text-zinc-800 ${alignCls} ${
                                      !isThreeLineTable ? 'border-r border-zinc-200 last:border-r-0' : ''
                                    }`}
                                  >
                                    {cleanInlinePreviewText(row[ci] || '')}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                }

                if (block.type === 'code' || block.type === 'mermaid') {
                  const lines = block.raw.split('\n');
                  const lang = block.language || (block.type === 'mermaid' ? 'mermaid' : '');
                  const innerCode = lines.slice(1, lines[lines.length - 1]?.trim().startsWith('`') || lines[lines.length - 1]?.trim().startsWith('~') ? -1 : undefined).join('\n');
                  return (
                    <div
                      key={block.id}
                      className="my-3.5 rounded-xs border border-zinc-300 bg-zinc-50"
                    >
                      {lang && (
                        <div className="flex items-center justify-end border-b border-zinc-200 px-3 py-1 font-mono text-[10px] uppercase text-zinc-500">
                          {lang}
                        </div>
                      )}
                      <pre className="overflow-x-auto px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-zinc-900">
                        {innerCode}
                      </pre>
                    </div>
                  );
                }

                if (block.type === 'callout' || block.type === 'blockquote') {
                  const qLines = block.raw
                    .split('\n')
                    .map((l) => l.replace(/^>\s?/, ''))
                    .filter((l, i) => !(i === 0 && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(l)));
                  const tagLabel = block.calloutKind
                    ? {
                        NOTE: '说明 (NOTE)',
                        TIP: '建议 (TIP)',
                        IMPORTANT: '重要规范 (IMPORTANT)',
                        WARNING: '注意 (WARNING)',
                        CAUTION: '警示 (CAUTION)',
                      }[block.calloutKind.toUpperCase()] || block.calloutKind
                    : null;

                  return (
                    <div
                      key={block.id}
                      className="my-3.5 rounded-xs border border-zinc-300 bg-slate-50/70 px-4 py-3 text-[13px] text-zinc-700"
                    >
                      {tagLabel && (
                        <div className={`mb-1 text-xs font-bold ${accentTextColor}`}>
                          {tagLabel}
                        </div>
                      )}
                      <div className="space-y-1">
                        {qLines.map((ql, idx) => (
                          <p key={idx}>{cleanInlinePreviewText(ql)}</p>
                        ))}
                      </div>
                    </div>
                  );
                }

                if (block.type === 'math') {
                  const latex = block.raw
                    .replace(/^\$\$\s*/, '')
                    .replace(/\s*\$\$$/, '')
                    .trim();
                  const eqNo = displayEquationMap.get(block.id) || 1;
                  let renderedHtml = '';
                  try {
                    renderedHtml = katex.renderToString(latex, {
                      displayMode: true,
                      throwOnError: false,
                    });
                  } catch {
                    renderedHtml = latex;
                  }
                  return (
                    <div
                      key={block.id}
                      className="my-4 flex items-center justify-between gap-4 py-1"
                    >
                      <div
                        className="flex-1 overflow-x-auto text-center text-sm"
                        dangerouslySetInnerHTML={{ __html: renderedHtml }}
                      />
                      <span className="shrink-0 font-mono text-xs text-zinc-500">({eqNo})</span>
                    </div>
                  );
                }

                if (block.type === 'embed') {
                  const cleanTarget = block.raw
                    .replace(/^!\[\[/, '')
                    .replace(/\]\]$/, '')
                    .replace(/#/g, ' § ');
                  return (
                    <div
                      key={block.id}
                      className="my-3 border border-zinc-300 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-700"
                    >
                      引用嵌入章节：{cleanTarget}
                    </div>
                  );
                }

                if (block.type === 'hr') {
                  return <hr key={block.id} className="my-5 border-zinc-300" />;
                }

                return (
                  <p key={block.id} className="text-zinc-800">
                    {cleanInlinePreviewText(block.raw)}
                  </p>
                );
              })}
            </div>

            {/* Formal Page Footer */}
            {includeHeaderFooter && (
              <div className="mt-12 border-t border-zinc-300 pt-2.5 text-center text-[11px] text-zinc-500 tabular-nums">
                {preset === 'official' ? '— 1 —' : `第 1 页 / 共 ${estimatedPages} 页`}
              </div>
            )}
          </article>
        </div>
      </div>
    </div>
  );
};
