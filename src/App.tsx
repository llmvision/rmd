/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BlockRecord,
  parseMarkdownToBlocks,
  serializeBlocksLossless,
} from './engine/markdownEngine';
import {
  WorkspaceDocSummary,
  WysiwygWorkspace,
} from './components/WysiwygWorkspace';
import {
  RustSourceExplorer,
  RustWorkspaceFile,
} from './components/RustSourceExplorer';
import {
  BenchmarkSuite,
  ShortcutsSpecView,
} from './components/BenchmarkSuite';
import { KnowledgeGraphView } from './components/KnowledgeGraphView';
import { KanbanBoardView } from './components/KanbanBoardView';
import { FormalPdfExportModal } from './components/FormalPdfExportModal';

type ActiveSection =
  | 'editor'
  | 'kanban-board'
  | 'knowledge-graph'
  | 'rust-source'
  | 'benchmark'
  | 'spec';

interface UndoFrame {
  blocks: BlockRecord[];
  activeIndex: number;
  isInputRuleTransform: boolean;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('editor');
  const [isDark, setIsDark] = useState(false);

  const [documents, setDocuments] = useState<WorkspaceDocSummary[]>([]);
  const [activeDocId, setActiveDocId] = useState<string>('');
  const [activeTitle, setActiveTitle] = useState<string>('加载中…');
  const [lineEnding, setLineEnding] = useState<'lf' | 'crlf'>('lf');
  const [blocks, setBlocks] = useState<BlockRecord[]>(() =>
    parseMarkdownToBlocks('# 正在加载本地工作区文档…')
  );

  const [undoStack, setUndoStack] = useState<UndoFrame[]>([]);
  const [redoStack, setRedoStack] = useState<UndoFrame[]>([]);
  const [saveStatusText, setSaveStatusText] = useState<string>('已同步至本地磁盘');

  const [rustFiles, setRustFiles] = useState<RustWorkspaceFile[]>([]);
  const [focusedRustPath, setFocusedRustPath] = useState<string>(
    'crates/vellum-core/src/pdf_export.rs'
  );
  const [showExportModal, setShowExportModal] = useState(false);
  const [pendingJumpHeading, setPendingJumpHeading] = useState<string | null>(null);

  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // Global shortcut `Cmd/Ctrl + Shift + E` for Formal PDF Export Studio
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setShowExportModal((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, []);

  const loadDocumentById = useCallback(async (id: string, jumpHeading?: string) => {
    const res = await fetch(`/api/v1/documents/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = (await res.json()) as WorkspaceDocSummary & { content: string };
    setActiveDocId(data.id);
    setActiveTitle(data.title);
    setLineEnding(data.stats?.lineEnding || 'lf');
    setBlocks(parseMarkdownToBlocks(data.content));
    setUndoStack([]);
    setRedoStack([]);
    setPendingJumpHeading(jumpHeading || null);
    setSaveStatusText('已同步至本地磁盘');
  }, []);

  // Initial load of workspace documents & Rust Cargo source tree
  useEffect(() => {
    (async () => {
      try {
        const [docsRes, rustRes] = await Promise.all([
          fetch('/api/v1/documents'),
          fetch('/api/v1/rust-source'),
        ]);
        if (docsRes.ok) {
          const list = (await docsRes.json()) as WorkspaceDocSummary[];
          setDocuments(list);
          if (list.length > 0) {
            await loadDocumentById(list[0].id);
          }
        }
        if (rustRes.ok) {
          const rustData = (await rustRes.json()) as { files: RustWorkspaceFile[] };
          setRustFiles(rustData.files || []);
        }
      } catch {
        setSaveStatusText('离线本地缓冲模式');
      }
    })();
  }, [loadDocumentById]);

  const persistDocumentToDisk = useCallback(
    async (docId: string, title: string, nextBlocks: BlockRecord[], createSnap = false) => {
      if (!docId) return;
      const content = serializeBlocksLossless(nextBlocks, lineEnding);
      try {
        setSaveStatusText('正在原子写入…');
        const res = await fetch(`/api/v1/documents/${encodeURIComponent(docId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content }),
        });
        if (res.ok) {
          const updatedMeta = (await res.json()) as WorkspaceDocSummary;
          setDocuments((prev) =>
            prev.map((d) => (d.id === updatedMeta.id ? updatedMeta : d))
          );
          if (createSnap) {
            await fetch(`/api/v1/documents/${encodeURIComponent(docId)}/snapshots`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content }),
            });
            setSaveStatusText('已保存并生成快照');
          } else {
            setSaveStatusText('已原子保存至本地');
          }
        }
      } catch {
        setSaveStatusText('本地内存已缓存（等待连接）');
      }
    },
    [lineEnding]
  );

  const handleUpdateBlocks = useCallback(
    (
      nextBlocks: BlockRecord[],
      undoInfo?: { prevBlocks: BlockRecord[]; activeIdx: number; isInputRule: boolean }
    ) => {
      if (undoInfo) {
        setUndoStack((prev) => [
          ...prev.slice(-80),
          {
            blocks: undoInfo.prevBlocks,
            activeIndex: undoInfo.activeIdx,
            isInputRuleTransform: undoInfo.isInputRule,
          },
        ]);
        setRedoStack([]);
      }

      // Auto-sync document title if first H1 changes
      let nextTitle = activeTitle;
      const firstHeading = nextBlocks.find((b) => b.type === 'heading' && b.level === 1);
      if (firstHeading) {
        const extracted = firstHeading.raw
          .split('\n')[0]
          .replace(/^#\s+/, '')
          .trim();
        if (extracted) {
          nextTitle = extracted;
          setActiveTitle(extracted);
        }
      }

      setBlocks(nextBlocks);
      setSaveStatusText('编辑中…');

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        persistDocumentToDisk(activeDocId, nextTitle, nextBlocks, false);
      }, 650);
    },
    [activeDocId, activeTitle, persistDocumentToDisk]
  );

  const handleUndo = useCallback((): number | null => {
    if (undoStack.length === 0) return null;
    const top = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [
      ...prev,
      {
        blocks,
        activeIndex: top.activeIndex,
        isInputRuleTransform: top.isInputRuleTransform,
      },
    ]);
    setBlocks(top.blocks);
    setSaveStatusText(
      top.isInputRuleTransform ? '已还原输入规则原始语法字符' : '已撤销上一步修改'
    );
    return top.activeIndex;
  }, [blocks, undoStack]);

  const handleRedo = useCallback((): number | null => {
    if (redoStack.length === 0) return null;
    const top = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [
      ...prev,
      {
        blocks,
        activeIndex: top.activeIndex,
        isInputRuleTransform: top.isInputRuleTransform,
      },
    ]);
    setBlocks(top.blocks);
    return top.activeIndex;
  }, [blocks, redoStack]);

  const handleCreateDocument = async (customTitle?: string, customContent?: string) => {
    const title = customTitle || `新建笔记 ${documents.length + 1}`;
    const content =
      customContent ||
      `# ${title}\n\n在此输入正文，输入 \`[[\` 可关联已有笔记，或在新行输入 \`/\` 打开命令面板。\n`;
    const res = await fetch('/api/v1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    if (res.ok) {
      const created = (await res.json()) as WorkspaceDocSummary & { content: string };
      setDocuments((prev) => [created, ...prev]);
      setActiveDocId(created.id);
      setActiveTitle(created.title);
      setBlocks(parseMarkdownToBlocks(created.content));
      setUndoStack([]);
      setRedoStack([]);
      setActiveSection('editor');
    }
  };

  const handleNavigateWikiLink = useCallback(
    async (target: string, heading?: string) => {
      const key = target.trim().toLowerCase();
      if (!key) return;

      const existing = documents.find(
        (d) => d.title.trim().toLowerCase() === key || d.id.trim().toLowerCase() === key
      );
      if (existing) {
        await loadDocumentById(existing.id, heading);
        setActiveSection('editor');
        return;
      }

      // Target is an unresolved phantom node -> create it automatically with a bidirectional back-reference!
      const cleanTitle = target.trim();
      const backRefLine = activeTitle
        ? `> 本文档由 [[${activeTitle}]] 中的双向链接首次激活创建。\n\n`
        : '';
      const headingSection = heading ? `## ${heading}\n\n在此补充该章节内容。\n` : '在此记录核心观点，使用 `[[` 继续扩展知识网络。\n';
      const initialContent = `# ${cleanTitle}\n\n${backRefLine}${headingSection}`;

      const res = await fetch('/api/v1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: cleanTitle, content: initialContent }),
      });
      if (res.ok) {
        const created = (await res.json()) as WorkspaceDocSummary & { content: string };
        setDocuments((prev) => [created, ...prev]);
        setActiveDocId(created.id);
        setActiveTitle(created.title);
        setBlocks(parseMarkdownToBlocks(created.content));
        setUndoStack([]);
        setRedoStack([]);
        setPendingJumpHeading(heading || null);
        setSaveStatusText(`已创建知识节点《${cleanTitle}》`);
        setActiveSection('editor');
      }
    },
    [documents, activeTitle, loadDocumentById]
  );

  const handleRefactorDocumentTitle = useCallback(
    async (newTitle: string) => {
      if (!activeDocId) return null;
      const res = await fetch(`/api/v1/documents/${encodeURIComponent(activeDocId)}/refactor-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newTitle }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        updatedDoc: WorkspaceDocSummary;
        content: string;
        rewrittenFilesCount: number;
        rewrittenLinksCount: number;
      };
      setActiveTitle(data.updatedDoc.title);
      setBlocks(parseMarkdownToBlocks(data.content));
      setSaveStatusText('已完成全库双链重命名重构');

      const docsRes = await fetch('/api/v1/documents');
      if (docsRes.ok) {
        setDocuments((await docsRes.json()) as WorkspaceDocSummary[]);
      }

      return {
        rewrittenFilesCount: data.rewrittenFilesCount,
        rewrittenLinksCount: data.rewrittenLinksCount,
      };
    },
    [activeDocId]
  );

  const handleDeleteDocument = async (id: string) => {
    await fetch(`/api/v1/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const remaining = documents.filter((d) => d.id !== id);
    setDocuments(remaining);
    if (id === activeDocId && remaining.length > 0) {
      await loadDocumentById(remaining[0].id);
    }
  };

  // Generates a clean self-extracting POSIX shell script containing the entire Rust GPUI + Axum Cargo workspace!
  const downloadRustWorkspaceScript = () => {
    const lines: string[] = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "Extracting Vellum Native (Rust + GPUI + Axum) Cargo Workspace..."',
      'mkdir -p vellum-native',
      'cd vellum-native',
      '',
    ];

    for (const file of rustFiles) {
      const dir = file.path.includes('/')
        ? file.path.slice(0, file.path.lastIndexOf('/'))
        : '';
      if (dir) {
        lines.push(`mkdir -p "${dir}"`);
      }
      lines.push(`cat << 'VELLUM_EOF_MARKER' > "${file.path}"`);
      lines.push(file.content);
      lines.push('VELLUM_EOF_MARKER');
      lines.push('');
    }

    lines.push('chmod +x scripts/*.sh 2>/dev/null || true');
    lines.push('echo "Done! Workspace extracted into ./vellum-native"');
    lines.push('echo "  1) Desktop GPUI App : cd vellum-native && cargo build --release -p vellum-gpui"');
    lines.push('echo "  2) Axum API Server  : cd vellum-native && cargo build --release -p vellum-server"');

    const blob = new Blob([lines.join('\n')], { type: 'text/x-shellscript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'setup-vellum-rust-gpui.sh';
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeDocMeta = documents.find((d) => d.id === activeDocId);

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-zinc-900 dark:bg-[#0B0F17] dark:text-zinc-100">
      {/* Strict 3-Zone Top Bar Contract: [Brand Wordmark] — [4 Single-Line Nav Links] — [1 Primary Action] */}
      <header className="flex h-[57px] items-center justify-between gap-8 border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-[#111622]">
        <a
          href="#editor"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('editor');
          }}
          className="text-base font-bold tracking-tight text-zinc-950 whitespace-nowrap shrink-0 dark:text-white"
        >
          Vellum Native
        </a>

        <nav className="flex items-center gap-6 overflow-x-auto text-sm font-medium text-zinc-600 dark:text-zinc-400">
          {(
            [
              ['editor', 'GPUI 原型窗口'],
              ['kanban-board', '任务看板'],
              ['knowledge-graph', '知识图谱'],
              ['rust-source', 'Rust 工程源码'],
              ['benchmark', '压测与规范'],
            ] as const
          ).map(([id, label]) => {
            const isCurrent =
              activeSection === id || (id === 'benchmark' && activeSection === 'spec');
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveSection(id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  isCurrent
                    ? 'font-semibold text-zinc-950 underline decoration-blue-600 decoration-2 underline-offset-[18px] dark:text-white'
                    : 'hover:text-zinc-950 dark:hover:text-zinc-100'
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => setShowExportModal(true)}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 whitespace-nowrap shrink-0 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            正式 PDF 导出与工程包
          </button>
        </div>
      </header>

      {/* Active Main View */}
      {activeSection === 'editor' && (
        <WysiwygWorkspace
          documents={documents}
          activeDocId={activeDocId}
          activeTitle={activeTitle}
          blocks={blocks}
          lineEnding={lineEnding}
          isDark={isDark}
          pendingJumpHeading={pendingJumpHeading}
          onClearPendingJumpHeading={() => setPendingJumpHeading(null)}
          onToggleDark={() => setIsDark((v) => !v)}
          onSelectDocument={(id) => loadDocumentById(id)}
          onNavigateWikiLink={handleNavigateWikiLink}
          onOpenKnowledgeGraph={() => setActiveSection('knowledge-graph')}
          onOpenKanbanBoard={() => setActiveSection('kanban-board')}
          onOpenPdfExport={() => setShowExportModal(true)}
          onRefactorDocumentTitle={handleRefactorDocumentTitle}
          onCreateDocument={() => handleCreateDocument()}
          onDeleteDocument={handleDeleteDocument}
          onImportLocalMarkdown={(title, content) => handleCreateDocument(title, content)}
          onUpdateBlocks={handleUpdateBlocks}
          onSaveNow={(snap) => persistDocumentToDisk(activeDocId, activeTitle, blocks, snap)}
          undoStack={undoStack}
          redoStack={redoStack}
          onUndo={handleUndo}
          onRedo={handleRedo}
          saveStatusText={saveStatusText}
        />
      )}

      {activeSection === 'kanban-board' && (
        <KanbanBoardView
          documents={documents}
          activeDocId={activeDocId}
          activeTitle={activeTitle}
          blocks={blocks}
          saveStatusText={saveStatusText}
          onSelectDocument={(id) => loadDocumentById(id)}
          onUpdateBlocks={handleUpdateBlocks}
          onNavigateWikiLink={handleNavigateWikiLink}
          onJumpToEditor={(sectionHeading) => {
            if (sectionHeading) {
              setPendingJumpHeading(sectionHeading);
            }
            setActiveSection('editor');
          }}
          onInspectRustFile={(rustPath) => {
            setFocusedRustPath(rustPath);
            setActiveSection('rust-source');
          }}
        />
      )}

      {activeSection === 'knowledge-graph' && (
        <KnowledgeGraphView
          activeDocId={activeDocId}
          onOpenDocument={(docId, heading) => {
            loadDocumentById(docId, heading);
            setActiveSection('editor');
          }}
          onCreatePhantomDocument={(title) => {
            handleNavigateWikiLink(title);
          }}
        />
      )}

      {activeSection === 'rust-source' && (
        <RustSourceExplorer
          files={rustFiles}
          initialPath={focusedRustPath}
          onDownloadBundle={downloadRustWorkspaceScript}
        />
      )}

      {(activeSection === 'benchmark' || activeSection === 'spec') && (
        <div>
          <div className="mx-auto flex max-w-[1040px] items-center justify-between px-6 pt-6">
            <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/90">
              <button
                type="button"
                onClick={() => setActiveSection('benchmark')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeSection === 'benchmark'
                    ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                大文件压测
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('spec')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeSection === 'spec'
                    ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                快捷键与 API 契约
              </button>
            </div>
          </div>

          {activeSection === 'benchmark' ? (
            <BenchmarkSuite
              onLoadCorpusIntoEditor={(title, content) => {
                setActiveTitle(title);
                setBlocks(parseMarkdownToBlocks(content));
                setUndoStack([]);
                setRedoStack([]);
                setSaveStatusText('压测大文件内存预览态');
                setActiveSection('editor');
              }}
            />
          ) : (
            <ShortcutsSpecView />
          )}
        </div>
      )}

      {/* Formal Document PDF Export & Native Rust Bundle Studio */}
      <FormalPdfExportModal
        open={showExportModal}
        docId={activeDocId}
        title={activeTitle}
        revision={activeDocMeta?.revision || 1}
        blocks={blocks}
        lineEnding={lineEnding}
        onClose={() => setShowExportModal(false)}
        onDownloadRustWorkspace={downloadRustWorkspaceScript}
        onInspectRustPdfEngine={() => {
          setFocusedRustPath('crates/vellum-core/src/pdf_export.rs');
          setActiveSection('rust-source');
        }}
      />
    </div>
  );
}
