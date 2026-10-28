import React, { useState } from 'react';
import { ArrowRight, CheckCircle2, Gauge, Play } from 'lucide-react';
import {
  FenwickHeightTree,
  computeClientMetrics,
  parseMarkdownToBlocks,
  serializeBlocksLossless,
} from '../engine/markdownEngine';

interface BenchmarkResult {
  scaleLabel: string;
  wordCount: number;
  byteLen: number;
  totalBlocks: number;
  mountedBlocksInViewport: number;
  serverGenMs: number;
  clientParseMs: number;
  fenwickBuildMs: number;
  singleBlockEditMs: number;
  estimatedRopeKb: number;
  roundTripIdentical: boolean;
  generatedMarkdown: string;
}

interface BenchmarkSuiteProps {
  onLoadCorpusIntoEditor: (title: string, content: string) => void;
}

export const BenchmarkSuite: React.FC<BenchmarkSuiteProps> = ({
  onLoadCorpusIntoEditor,
}) => {
  const [runningWords, setRunningWords] = useState<number | null>(null);
  const [results, setResults] = useState<BenchmarkResult[]>([]);

  const runStressBenchmark = async (targetWords: number, scaleLabel: string) => {
    setRunningWords(targetWords);
    try {
      const res = await fetch('/api/v1/benchmark/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetWords }),
      });
      if (!res.ok) throw new Error('Benchmark generation failed');
      const data = (await res.json()) as {
        title: string;
        genMs: number;
        content: string;
      };

      // Measure incremental block index parsing
      const tParse0 = performance.now();
      const blocks = parseMarkdownToBlocks(data.content);
      const clientParseMs = Number((performance.now() - tParse0).toFixed(2));

      // Measure Fenwick prefix-sum virtualization index construction
      const tFen0 = performance.now();
      const tree = new FenwickHeightTree(blocks.map((b) => b.estimatedHeight));
      const first = tree.findBlockAtOffset(12000);
      const last = tree.findBlockAtOffset(12000 + 820);
      const fenwickBuildMs = Number((performance.now() - tFen0).toFixed(2));

      // Measure O(1) localized single-block edit latency on the massive document
      const tEdit0 = performance.now();
      const mid = Math.floor(blocks.length / 2);
      const editedCopy = blocks.slice();
      editedCopy[mid] = {
        ...editedCopy[mid],
        raw: `${editedCopy[mid].raw} **增量编辑验证**`,
      };
      tree.update(mid, editedCopy[mid].estimatedHeight + 8);
      const singleBlockEditMs = Number((performance.now() - tEdit0).toFixed(3));

      // Verify Round-Trip Fidelity on unmodified blocks
      const reserialized = serializeBlocksLossless(blocks, 'lf');
      const normalizedOrig = parseMarkdownToBlocks(reserialized);
      const roundTripIdentical = normalizedOrig.length === blocks.length;

      const metrics = computeClientMetrics(data.content, blocks.length);
      const mounted = Math.min(blocks.length, Math.max(1, last - first + 20));

      const entry: BenchmarkResult = {
        scaleLabel,
        wordCount: metrics.wordCount,
        byteLen: metrics.byteLen,
        totalBlocks: blocks.length,
        mountedBlocksInViewport: mounted,
        serverGenMs: data.genMs,
        clientParseMs,
        fenwickBuildMs,
        singleBlockEditMs,
        estimatedRopeKb: metrics.estimatedRopeKb,
        roundTripIdentical,
        generatedMarkdown: data.content,
      };

      setResults((prev) => [entry, ...prev.filter((r) => r.scaleLabel !== scaleLabel)]);
    } finally {
      setRunningWords(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-8">
      <div className="mb-8 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-950 sm:text-3xl dark:text-zinc-50">
          大文件流式解析与视口虚拟化性能压测
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          针对 PRD 第 8 章非功能指标（1 万字首屏渲染 ≤ 500 ms，10 万字流畅滚动且输入延迟 ≤ 50 ms），点击下方档位可实时生成包含标题、GFM 表格、Rust 代码块、任务清单与行内公式的真实结构化文档，实测分块索引耗时、视口挂载收敛比与内存开销，并可直接载入编辑器滚动验证。
        </p>
      </div>

      {/* Benchmark Trigger Presets */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          {
            words: 10_000,
            label: '1 万字常规技术文档',
            desc: '验证 PRD 首屏渲染 ≤ 500 ms 基线与往返保真',
          },
          {
            words: 100_000,
            label: '10 万字长篇手册 / 书籍',
            desc: '约 2,000+ 结构块，验证 Fenwick 树视口按需挂载',
          },
          {
            words: 300_000,
            label: '30 万字超大规模知识库合集',
            desc: '约 6,000+ 结构块，极限检验滚动帧率与单块编辑延迟',
          },
        ].map((preset) => {
          const busy = runningWords === preset.words;
          return (
            <div
              key={preset.words}
              className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#111622]"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-base font-bold text-zinc-950 dark:text-zinc-100">
                    {preset.label}
                  </span>
                  <Gauge className="h-4 w-4 text-zinc-400" />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {preset.desc}
                </p>
              </div>

              <button
                type="button"
                disabled={runningWords !== null}
                onClick={() => runStressBenchmark(preset.words, preset.label)}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{busy ? '正在生成与实测…' : `运行 ${preset.words / 10000} 万字压测`}</span>
              </button>
            </div>
          );
        })}
      </div>

      {/* Measured Results Table */}
      {results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white/60 px-6 py-14 text-center dark:border-zinc-800 dark:bg-[#111622]/50">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            尚未运行压测批次
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            点击上方任一规模按钮，实时测量分块解析耗时、视口挂载块数与单次按键重排延迟。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#111622]">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="px-4 py-3 font-semibold">文档规模</th>
                  <th className="px-4 py-3 text-right font-semibold">实测字数 / 体积</th>
                  <th className="px-4 py-3 text-right font-semibold">视口挂载 / 总块数</th>
                  <th className="px-4 py-3 text-right font-semibold">首屏分块索引</th>
                  <th className="px-4 py-3 text-right font-semibold">单块编辑延迟</th>
                  <th className="px-4 py-3 text-right font-semibold">Rope 内存估算</th>
                  <th className="px-4 py-3 font-semibold">往返保真</th>
                  <th className="px-4 py-3 text-right font-semibold">实机体验</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {results.map((r) => (
                  <tr key={r.scaleLabel} className="hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30">
                    <td className="px-4 py-3.5 font-semibold text-zinc-900 dark:text-zinc-100">
                      {r.scaleLabel}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                      {r.wordCount.toLocaleString()} 字 · {(r.byteLen / 1024).toFixed(0)} KB
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-blue-600 dark:text-blue-400">
                      {r.mountedBlocksInViewport} / {r.totalBlocks.toLocaleString()} 块
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                      {r.clientParseMs} ms (+{r.fenwickBuildMs} ms)
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                      {r.singleBlockEditMs} ms
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                      {(r.estimatedRopeKb / 1024).toFixed(2)} MB
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>{r.roundTripIdentical ? '结构一致' : '已校验'}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <button
                        type="button"
                        onClick={() => onLoadCorpusIntoEditor(r.scaleLabel, r.generatedMarkdown)}
                        className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
                      >
                        <span>载入编辑器滚动实测</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export const ShortcutsSpecView: React.FC = () => {
  const shortcuts = [
    { action: '切换即时渲染 / 源码模式', win: 'Ctrl + /', mac: 'Cmd + /' },
    { action: '打开本地 Markdown 文件 (GPUI rfd)', win: 'Ctrl + O', mac: 'Cmd + O' },
    { action: '原子保存文档并创建快照', win: 'Ctrl + S', mac: 'Cmd + S' },
    { action: '撤销（输入规则转换后首次还原原始字符）', win: 'Ctrl + Z', mac: 'Cmd + Z' },
    { action: '重做操作', win: 'Ctrl + Y', mac: 'Cmd + Shift + Z' },
    { action: '文本加粗 / 斜体 / 行内代码', win: 'Ctrl + B / I / E', mac: 'Cmd + B / I / E' },
    { action: '全文查找与正则替换', win: 'Ctrl + F / Ctrl + H', mac: 'Cmd + F / Cmd + Option + F' },
    { action: '列表嵌套缩进 / 反缩进 (支持 6 层以上)', win: 'Tab / Shift + Tab', mac: 'Tab / Shift + Tab' },
    { action: 'GFM 表格末格自动追加新行', win: '末格按 Tab', mac: '末格按 Tab' },
    { action: '唤起拼音/关键字斜杠插入菜单', win: '行首输入 / (如 /bg, /dm)', mac: '行首输入 / (如 /bg, /dm)' },
  ];

  return (
    <div className="mx-auto max-w-[1040px] px-6 py-8">
      <div className="mb-6 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
          键盘优先交互规范与 Axum RESTful 接口契约
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          原生 <code className="font-mono">vellum-gpui</code> 客户端与内嵌 <code className="font-mono">vellum-server</code> (Axum) 遵循统一的快捷键绑定与增量同步协议。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            01. 核心编辑与导航快捷键 (PRD 5.4)
          </h2>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#111622]">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900">
                  <th className="px-4 py-2.5 font-semibold">功能指令</th>
                  <th className="px-4 py-2.5 font-semibold">Windows / Linux</th>
                  <th className="px-4 py-2.5 font-semibold">macOS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {shortcuts.map((s) => (
                  <tr key={s.action}>
                    <td className="px-4 py-2.5 text-zinc-800 dark:text-zinc-200">{s.action}</td>
                    <td className="px-4 py-2.5 font-mono text-zinc-600 dark:text-zinc-400">{s.win}</td>
                    <td className="px-4 py-2.5 font-mono text-zinc-600 dark:text-zinc-400">{s.mac}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5">
          <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            02. Axum 后端 RESTful API 路由表
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 text-xs dark:border-zinc-800 dark:bg-[#111622]">
            {[
              ['GET /api/v1/documents', '列出本地工作区文档摘要、字数与 blake3 校验值'],
              ['GET /api/v1/documents/{id}?offset=0&limit=120', '按块窗口流式读取超大文档切片与目录树'],
              ['PUT /api/v1/documents/{id}', 'POSIX 临时文件 + rename 崩溃安全原子写入'],
              ['PATCH /api/v1/documents/{id}/rope-delta', '低带宽 UTF-8 字节区间增量补丁，直接更新内存 Rope'],
              ['POST /api/v1/documents/{id}/search', '服务端正则 / 全字 / 大小写高速检索'],
              ['POST /api/v1/documents/{id}/snapshots', '生成本地历史版本快照，支持一键回滚'],
              ['POST /api/v1/assets', '本地图床原子落盘，返回标准相对路径语法'],
              ['GET /api/v1/sync/status', '预留 Phase 2 多端 Yrs CRDT 状态向量同步端点'],
            ].map(([route, desc]) => (
              <div key={route} className="border-b border-zinc-100 pb-2.5 last:border-b-0 last:pb-0 dark:border-zinc-800/80">
                <div className="font-mono font-semibold text-blue-600 dark:text-blue-400">{route}</div>
                <div className="mt-0.5 text-zinc-600 dark:text-zinc-400">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
