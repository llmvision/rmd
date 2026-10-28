import React, { useEffect, useState } from 'react';
import { Check, Copy, Download, FileCode, FolderTree, Terminal } from 'lucide-react';

export interface RustWorkspaceFile {
  path: string;
  language: string;
  bytes: number;
  content: string;
}

interface RustSourceExplorerProps {
  files: RustWorkspaceFile[];
  initialPath?: string;
  onDownloadBundle: () => void;
}

export const RustSourceExplorer: React.FC<RustSourceExplorerProps> = ({
  files,
  initialPath,
  onDownloadBundle,
}) => {
  const [selectedPath, setSelectedPath] = useState<string>(
    initialPath || 'crates/vellum-gpui/src/kanban_board.rs'
  );
  const [copiedFile, setCopiedFile] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  useEffect(() => {
    if (initialPath && files.some((f) => f.path === initialPath)) {
      setSelectedPath(initialPath);
    }
  }, [initialPath, files]);

  useEffect(() => {
    if (files.length > 0 && !files.some((f) => f.path === selectedPath)) {
      const preferred =
        files.find((f) => f.path.includes('kanban_board.rs')) ||
        files.find((f) => f.path.includes('wysiwyg_surface.rs')) ||
        files[0];
      setSelectedPath(preferred.path);
    }
  }, [files, selectedPath]);

  const currentFile = files.find((f) => f.path === selectedPath) || files[0];
  const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);

  return (
    <div className="mx-auto max-w-[1380px] px-6 py-8">
      {/* Architecture Header */}
      <div className="mb-8 flex flex-col justify-between gap-6 border-b border-zinc-200 pb-6 lg:flex-row lg:items-end dark:border-zinc-800">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-950 sm:text-3xl dark:text-zinc-50">
            Rust + GPUI + Axum 本地原生工程源码
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            工程根目录已配置为标准 Rust Cargo Workspace（包含 <code className="font-mono text-zinc-800 dark:text-zinc-200">vellum-core</code> 低内存 Rope 内核、
            <code className="font-mono text-zinc-800 dark:text-zinc-200">vellum-server</code> Axum 高性能 RESTful 接口与{' '}
            <code className="font-mono text-zinc-800 dark:text-zinc-200">vellum-gpui</code> 原生 GPU 桌面编辑器）。下载后可直接在 macOS / Linux / Windows 本地编译运行。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500 tabular-nums">
            <span>共 {files.length} 个源码文件</span>
            <span aria-hidden="true">·</span>
            <span>{(totalBytes / 1024).toFixed(1)} KB 纯净 Rust 代码</span>
            <span aria-hidden="true">·</span>
            <span>Edition 2024</span>
            <span aria-hidden="true">·</span>
            <span>gpui 0.2.2 + axum 0.8 + ropey 1.6 + pulldown-cmark 0.12</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-100/80 px-3 py-2 font-mono text-xs text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            <Terminal className="h-3.5 w-3.5 text-zinc-500" />
            <span>cargo run --release -p vellum-gpui</span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText('cargo run --release -p vellum-gpui');
                setCopiedCmd(true);
                setTimeout(() => setCopiedCmd(false), 1500);
              }}
              className="ml-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
              title="复制本地启动命令"
            >
              {copiedCmd ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>

          <button
            type="button"
            onClick={onDownloadBundle}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            <span>导出自解压 Rust 工程包 (.sh)</span>
          </button>
        </div>
      </div>

      {/* Three-Crate Responsibility Strip */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-zinc-200/90 bg-white p-4 dark:border-zinc-800 dark:bg-[#111622]">
          <div className="font-mono text-xs font-semibold text-blue-600 dark:text-blue-400">
            crates/vellum-core
          </div>
          <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Ropey 零拷贝缓冲与增量解析内核
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            采用 64 KiB 流式 <code className="font-mono">BufReader</code> 加载超大文件，结合 SIMD{' '}
            <code className="font-mono">pulldown-cmark</code> 偏移量迭代与树状数组（Fenwick Tree）维护块高度前缀和，预留 Phase 2 CRDT 同步接口。
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200/90 bg-white p-4 dark:border-zinc-800 dark:bg-[#111622]">
          <div className="font-mono text-xs font-semibold text-blue-600 dark:text-blue-400">
            crates/vellum-gpui
          </div>
          <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            GPUI 纯原生 GPU 渲染桌面客户端（零 WebView）
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            直接通过 Metal / Vulkan / DX12 绘制界面与字体，完全不依赖任何网页或 WebView。内置{' '}
            <code className="font-mono">kanban_board.rs</code>（基于 <code className="font-mono">on_drag / drag_over / on_drop</code> 原生看板拖拽）、<code className="font-mono">wysiwyg_surface.rs</code> 与 <code className="font-mono">graph_canvas.rs</code>。
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200/90 bg-white p-4 dark:border-zinc-800 dark:bg-[#111622]">
          <div className="font-mono text-xs font-semibold text-blue-600 dark:text-blue-400">
            crates/vellum-server
          </div>
          <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Axum 0.8 本地与多端同步 RESTful 服务
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            既可作为 GPUI 客户端后台守护线程自动拉起，也可独立部署。提供 POSIX 临时文件原子重命名落盘、字节区间增量补丁（<code className="font-mono">PATCH /rope-delta</code>）与版本快照接口。
          </p>
        </div>
      </div>

      {/* File Tree + Code Viewer */}
      <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-zinc-200 bg-white lg:grid-cols-12 dark:border-zinc-800 dark:bg-[#111622]">
        <div className="border-b border-zinc-200 bg-zinc-50/70 p-3 lg:col-span-3 lg:border-b-0 lg:border-r dark:border-zinc-800 dark:bg-[#0E131E]">
          <div className="mb-2 flex items-center gap-1.5 px-2 text-xs font-semibold text-zinc-500">
            <FolderTree className="h-3.5 w-3.5" />
            <span>Cargo Workspace 文件树</span>
          </div>
          <div className="space-y-0.5">
            {files.map((file) => {
              const active = currentFile?.path === file.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    active
                      ? 'bg-blue-600 text-white font-medium'
                      : 'text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11.5px]">
                    <FileCode className="h-3.5 w-3.5 shrink-0 opacity-75" />
                    <span className="truncate">{file.path}</span>
                  </span>
                  <span className={`shrink-0 font-mono text-[10.5px] tabular-nums ${active ? 'text-blue-100' : 'text-zinc-400'}`}>
                    {(file.bytes / 1024).toFixed(1)}K
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col lg:col-span-9">
          {currentFile && (
            <>
              <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-2.5 text-xs dark:border-zinc-800">
                <div className="flex items-center gap-2 font-mono text-zinc-700 dark:text-zinc-200">
                  <span className="font-semibold">{currentFile.path}</span>
                  <span className="text-zinc-400">·</span>
                  <span className="text-zinc-500 tabular-nums">
                    {currentFile.content.split('\n').length} 行 · {currentFile.bytes.toLocaleString()} 字节
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(currentFile.content);
                    setCopiedFile(true);
                    setTimeout(() => setCopiedFile(false), 1500);
                  }}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  {copiedFile ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedFile ? '已复制源码' : '复制此文件'}</span>
                </button>
              </div>

              <pre className="max-h-[620px] overflow-auto p-5 font-mono text-[12.5px] leading-[1.65] text-zinc-800 dark:text-zinc-200">
                {currentFile.content.split('\n').map((line, idx) => (
                  <div key={idx} className="flex">
                    <span className="mr-5 inline-block w-8 shrink-0 select-none text-right text-zinc-400 tabular-nums dark:text-zinc-600">
                      {idx + 1}
                    </span>
                    <span className="whitespace-pre">{line}</span>
                  </div>
                ))}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
