import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowUpRight,
  Bold,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code,
  Columns2,
  Eye,
  FileCode2,
  FilePlus2,
  FileText,
  FolderOpen,
  GitFork,
  Heading1,
  Heading2,
  History,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  ListChecks,
  ListTree,
  Moon,
  Redo2,
  Replace,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Strikethrough,
  Sun,
  Table as TableIcon,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  BlockRenderer,
  SyntaxRevealMode,
  WikiRenderContext,
} from './BlockRenderer';
import {
  BlockRecord,
  FenwickHeightTree,
  SLASH_COMMANDS,
  SlashCommandItem,
  computeClientMetrics,
  convertHtmlToCleanMarkdown,
  extractOutline,
  nextBlockId,
  parseMarkdownToBlocks,
  serializeBlocksLossless,
} from '../engine/markdownEngine';

export interface WorkspaceDocSummary {
  id: string;
  title: string;
  filename: string;
  revision: number;
  updatedAt: number;
  stats: {
    byteLen: number;
    wordCount: number;
    blockCount: number;
    readingMinutes: number;
    lineEnding: 'lf' | 'crlf';
  };
}

interface SnapshotEntry {
  snapshotId: string;
  createdAt: number;
  label: string;
  revision: number;
  content: string;
}

interface UndoSnapshot {
  blocks: BlockRecord[];
  activeIndex: number;
  isInputRuleTransform: boolean;
}

interface OutgoingLinkItem {
  targetName: string;
  targetDocId: string | null;
  targetTitle: string;
  resolved: boolean;
  headingAnchor?: string;
  displayAlias?: string;
  kind: 'wikilink' | 'embed';
  lineNumber: number;
  contextExcerpt: string;
}

interface BacklinkItem {
  sourceDocId: string;
  sourceTitle: string;
  kind: 'wikilink' | 'embed';
  headingAnchor?: string;
  lineNumber: number;
  contextExcerpt: string;
}

interface UnlinkedMentionItem {
  sourceDocId: string;
  sourceTitle: string;
  lineNumber: number;
  matchedText: string;
  contextExcerpt: string;
}

interface CatalogDocItem {
  id: string;
  title: string;
  headings: string[];
}

interface WysiwygWorkspaceProps {
  documents: WorkspaceDocSummary[];
  activeDocId: string;
  activeTitle: string;
  blocks: BlockRecord[];
  lineEnding: 'lf' | 'crlf';
  isDark: boolean;
  pendingJumpHeading?: string | null;
  onClearPendingJumpHeading?: () => void;
  onToggleDark: () => void;
  onSelectDocument: (id: string) => void;
  onNavigateWikiLink: (target: string, heading?: string) => void;
  onOpenKnowledgeGraph: () => void;
  onOpenKanbanBoard?: () => void;
  onOpenPdfExport?: () => void;
  onRefactorDocumentTitle: (
    newTitle: string
  ) => Promise<{ rewrittenFilesCount: number; rewrittenLinksCount: number } | null>;
  onCreateDocument: () => void;
  onDeleteDocument: (id: string) => void;
  onImportLocalMarkdown: (title: string, content: string) => void;
  onUpdateBlocks: (nextBlocks: BlockRecord[], pushUndo?: { prevBlocks: BlockRecord[]; activeIdx: number; isInputRule: boolean }) => void;
  onSaveNow: (createSnapshot?: boolean) => void;
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  onUndo: () => number | null;
  onRedo: () => number | null;
  saveStatusText: string;
}

export const WysiwygWorkspace: React.FC<WysiwygWorkspaceProps> = ({
  documents,
  activeDocId,
  activeTitle,
  blocks,
  lineEnding,
  isDark,
  pendingJumpHeading,
  onClearPendingJumpHeading,
  onToggleDark,
  onSelectDocument,
  onNavigateWikiLink,
  onOpenKnowledgeGraph,
  onOpenKanbanBoard,
  onOpenPdfExport,
  onRefactorDocumentTitle,
  onCreateDocument,
  onDeleteDocument,
  onImportLocalMarkdown,
  onUpdateBlocks,
  onSaveNow,
  undoStack,
  redoStack,
  onUndo,
  onRedo,
  saveStatusText,
}) => {
  const [editorMode, setEditorMode] = useState<'wysiwyg' | 'source' | 'split'>('wysiwyg');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline' | 'links' | 'snapshots'>('outline');
  const [activeBlockIndex, setActiveBlockIndex] = useState<number>(0);

  // Typography & WYSIWYG settings (PRD TH-01, TH-02, 5.3, NV-04)
  const [syntaxReveal, setSyntaxReveal] = useState<SyntaxRevealMode>('active');
  const [focusMode, setFocusMode] = useState(false);
  const [typewriterMode, setTypewriterMode] = useState(false);
  const [fontSizeStep, setFontSizeStep] = useState<'sm' | 'md' | 'lg'>('md');
  const [useSerifProse, setUseSerifProse] = useState(false);
  const [widthPreset, setWidthPreset] = useState<'narrow' | 'standard' | 'wide'>('standard');
  const [showSettingsPopover, setShowSettingsPopover] = useState(false);

  // Find & Replace Bar (PRD NV-01)
  const [showFindBar, setShowFindBar] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [activeMatchCursor, setActiveMatchCursor] = useState(0);

  // Slash Menu State (PRD 5.5)
  const [slashState, setSlashState] = useState<{
    open: boolean;
    blockIndex: number;
    query: string;
    selectedIdx: number;
  }>({ open: false, blockIndex: 0, query: '', selectedIdx: 0 });

  // WikiLink `[[` / `![[` Autocomplete Menu State
  const [wikiMenuState, setWikiMenuState] = useState<{
    open: boolean;
    blockIndex: number;
    query: string;
    replaceStartOffset: number;
    isEmbed: boolean;
  }>({ open: false, blockIndex: 0, query: '', replaceStartOffset: 0, isEmbed: false });

  // Bidirectional Links, Unlinked Mentions & Workspace Catalog State
  const [docLinksData, setDocLinksData] = useState<{
    outgoing: OutgoingLinkItem[];
    backlinks: BacklinkItem[];
    unlinkedMentions: UnlinkedMentionItem[];
    workspaceCatalog: CatalogDocItem[];
  }>({
    outgoing: [],
    backlinks: [],
    unlinkedMentions: [],
    workspaceCatalog: [],
  });
  const [linksRefreshTick, setLinksRefreshTick] = useState(0);
  const [renameDraft, setRenameDraft] = useState(activeTitle);
  const [refactorNotice, setRefactorNotice] = useState<string | null>(null);

  // Snapshots State (PRD CO-03)
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [pasteNotice, setPasteNotice] = useState<{
    blockIndex: number;
    plainText: string;
  } | null>(null);

  // Fenwick Tree Viewport Virtualization State (sustains 60-120fps on 10,000+ block files)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const splitPreviewRef = useRef<HTMLDivElement | null>(null);
  const topSpacerRef = useRef<HTMLDivElement | null>(null);
  const bottomSpacerRef = useRef<HTMLDivElement | null>(null);
  const fileInputMdRef = useRef<HTMLInputElement | null>(null);
  const fileInputImgRef = useRef<HTMLInputElement | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(760);
  const [heightTick, setHeightTick] = useState(0);

  const fenwickRef = useRef<FenwickHeightTree>(new FenwickHeightTree([40]));

  // Rebuild Fenwick tree when block array length changes
  useEffect(() => {
    fenwickRef.current = new FenwickHeightTree(blocks.map((b) => b.estimatedHeight));
    setHeightTick((t) => t + 1);
  }, [blocks.length, activeDocId]);

  // Measure viewport height
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const updateSize = () => setViewportHeight(el.clientHeight || 760);
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editorMode]);

  useEffect(() => {
    setRenameDraft(activeTitle);
    setRefactorNotice(null);
  }, [activeDocId, activeTitle]);

  // Fetch Bidirectional Links, Outgoing Links & Unlinked Mentions for active document
  useEffect(() => {
    if (!activeDocId) return;
    let cancelled = false;
    fetch(`/api/v1/documents/${encodeURIComponent(activeDocId)}/links`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setDocLinksData({
          outgoing: Array.isArray(data.outgoing) ? data.outgoing : [],
          backlinks: Array.isArray(data.backlinks) ? data.backlinks : [],
          unlinkedMentions: Array.isArray(data.unlinkedMentions) ? data.unlinkedMentions : [],
          workspaceCatalog: Array.isArray(data.workspaceCatalog) ? data.workspaceCatalog : [],
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeDocId, saveStatusText, linksRefreshTick]);

  // Load version snapshots when switching to snapshots tab
  useEffect(() => {
    if (sidebarTab === 'snapshots' && activeDocId) {
      fetch(`/api/v1/documents/${encodeURIComponent(activeDocId)}/snapshots`)
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => setSnapshots(Array.isArray(data) ? data : []))
        .catch(() => {});
    }
  }, [sidebarTab, activeDocId, saveStatusText]);

  const handleMeasuredHeight = useCallback((index: number, px: number) => {
    if (fenwickRef.current.update(index, px)) {
      setHeightTick((t) => t + 1);
    }
  }, []);

  // Compute virtualized visible window (mounts only ~30 blocks even if document has 12,000 blocks!)
  const virtualWindow = useMemo(() => {
    const total = blocks.length;
    if (total <= 80) {
      return {
        startIdx: 0,
        endIdx: total,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }
    const tree = fenwickRef.current;
    const first = tree.findBlockAtOffset(Math.max(0, scrollTop));
    const last = tree.findBlockAtOffset(Math.max(0, scrollTop + viewportHeight));
    const overscan = 10;
    const startIdx = Math.max(0, first - overscan);
    const endIdx = Math.min(total, last + overscan + 1);
    const topSpacer = tree.prefixSum(startIdx);
    const endSum = tree.prefixSum(endIdx);
    const bottomSpacer = Math.max(0, tree.totalHeight - endSum);
    return { startIdx, endIdx, topSpacer, bottomSpacer };
  }, [blocks.length, scrollTop, viewportHeight, heightTick]);

  // Apply spacer heights cleanly via DOM refs (no inline JSX style attributes)
  useLayoutEffect(() => {
    if (topSpacerRef.current) {
      topSpacerRef.current.style.height = `${Math.round(virtualWindow.topSpacer)}px`;
    }
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.height = `${Math.round(virtualWindow.bottomSpacer)}px`;
    }
  }, [virtualWindow.topSpacer, virtualWindow.bottomSpacer, editorMode]);

  const scrollToBlock = useCallback((blockIdx: number, center = false) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const y = fenwickRef.current.prefixSum(blockIdx);
    const targetTop = center ? Math.max(0, y - container.clientHeight * 0.36) : Math.max(0, y - 24);
    container.scrollTo({ top: targetTop, behavior: 'smooth' });
  }, []);

  // Typewriter mode: keep active block smoothly centered
  useEffect(() => {
    if (typewriterMode && editorMode === 'wysiwyg') {
      scrollToBlock(activeBlockIndex, true);
    }
  }, [activeBlockIndex, typewriterMode, editorMode, scrollToBlock]);

  const fullMarkdown = useMemo(
    () => serializeBlocksLossless(blocks, lineEnding),
    [blocks, lineEnding]
  );

  const liveMetrics = useMemo(
    () => computeClientMetrics(fullMarkdown, blocks.length),
    [fullMarkdown, blocks.length]
  );

  const outline = useMemo(() => extractOutline(blocks), [blocks]);

  // Scroll to target `#heading` when navigated via `[[Doc#Heading]]` or Knowledge Graph
  useEffect(() => {
    if (!pendingJumpHeading) return;
    const normTarget = pendingJumpHeading.trim().toLowerCase();
    const matched = outline.find(
      (item) =>
        item.text.trim().toLowerCase() === normTarget ||
        item.text.trim().toLowerCase().includes(normTarget)
    );
    if (matched) {
      setActiveBlockIndex(matched.blockIndex);
      setTimeout(() => scrollToBlock(matched.blockIndex, false), 60);
    }
    onClearPendingJumpHeading?.();
  }, [pendingJumpHeading, outline, scrollToBlock, onClearPendingJumpHeading]);

  const wikiContext = useMemo<WikiRenderContext>(() => {
    const resolvedSet = new Set<string>();
    for (const d of documents) {
      resolvedSet.add(d.title.trim().toLowerCase());
      resolvedSet.add(d.id.trim().toLowerCase());
    }
    return {
      isTargetResolved: (target: string) => resolvedSet.has(target.trim().toLowerCase()),
      onNavigateWikiLink,
    };
  }, [documents, onNavigateWikiLink]);

  const workspaceRevisionKey = useMemo(
    () => documents.map((d) => `${d.id}:${d.revision}`).join('|'),
    [documents]
  );

  // Search matches across all blocks (PRD NV-01)
  const searchMatchedBlocks = useMemo(() => {
    if (!findQuery.trim()) return [];
    try {
      const base = useRegex
        ? findQuery
        : findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pat = wholeWord ? `\\b(?:${base})\\b` : base;
      const re = new RegExp(pat, caseSensitive ? 'g' : 'gi');
      const matched: number[] = [];
      for (let i = 0; i < blocks.length; i++) {
        if (re.test(blocks[i].raw)) {
          matched.push(i);
        }
        re.lastIndex = 0;
      }
      return matched;
    } catch {
      return [];
    }
  }, [blocks, findQuery, caseSensitive, wholeWord, useRegex]);

  const insertWikiLinkAtCursor = () => {
    const target = blocks[activeBlockIndex];
    if (!target) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLTextAreaElement) {
      const s = activeEl.selectionStart ?? target.raw.length;
      const e = activeEl.selectionEnd ?? target.raw.length;
      const selected = target.raw.slice(s, e);
      if (selected) {
        const nextRaw = `${target.raw.slice(0, s)}[[${selected}]]${target.raw.slice(e)}`;
        handleBlockChange(activeBlockIndex, nextRaw, false);
        return;
      }
      const nextRaw = `${target.raw.slice(0, s)}[[${target.raw.slice(e)}`;
      handleBlockChange(activeBlockIndex, nextRaw, false);
      setWikiMenuState({
        open: true,
        blockIndex: activeBlockIndex,
        query: '',
        replaceStartOffset: s,
        isEmbed: false,
      });
      return;
    }
    const offset = target.raw.length;
    handleBlockChange(activeBlockIndex, `${target.raw}[[`, false);
    setWikiMenuState({
      open: true,
      blockIndex: activeBlockIndex,
      query: '',
      replaceStartOffset: offset,
      isEmbed: false,
    });
  };

  // Global keyboard shortcuts (PRD Section 5.4)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === '/') {
        e.preventDefault();
        setEditorMode((prev) => (prev === 'wysiwyg' ? 'source' : 'wysiwyg'));
      } else if (e.key.toLowerCase() === 'k' && !e.shiftKey && editorMode === 'wysiwyg') {
        e.preventDefault();
        insertWikiLinkAtCursor();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFindBar(true);
      } else if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setShowFindBar(true);
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSaveNow(true);
      } else if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        const restoredIdx = onUndo();
        if (restoredIdx !== null) setActiveBlockIndex(restoredIdx);
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        const restoredIdx = onRedo();
        if (restoredIdx !== null) setActiveBlockIndex(restoredIdx);
      } else if (e.key.toLowerCase() === 'b' && !e.shiftKey && editorMode === 'wysiwyg') {
        e.preventDefault();
        wrapActiveBlockInline('**');
      } else if (e.key.toLowerCase() === 'i' && !e.shiftKey && editorMode === 'wysiwyg') {
        e.preventDefault();
        wrapActiveBlockInline('*');
      } else if (e.key.toLowerCase() === 'e' && !e.shiftKey && editorMode === 'wysiwyg') {
        e.preventDefault();
        wrapActiveBlockInline('`');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const wrapActiveBlockInline = (delim: string) => {
    const target = blocks[activeBlockIndex];
    if (!target) return;
    const activeEl = document.activeElement;
    let nextRaw = `${target.raw}${delim}文本${delim}`;
    if (activeEl instanceof HTMLTextAreaElement) {
      const s = activeEl.selectionStart ?? 0;
      const e = activeEl.selectionEnd ?? 0;
      const selected = target.raw.slice(s, e) || '文本';
      nextRaw = target.raw.slice(0, s) + delim + selected + delim + target.raw.slice(e);
    }
    handleBlockChange(activeBlockIndex, nextRaw, false);
  };

  const reclassifySingleBlock = (existing: BlockRecord, nextRaw: string): BlockRecord => {
    const reparsed = parseMarkdownToBlocks(nextRaw);
    if (reparsed.length === 1) {
      return { ...reparsed[0], id: existing.id };
    }
    return { ...existing, raw: nextRaw };
  };

  const handleBlockChange = useCallback(
    (index: number, nextRaw: string, isInputRule = false) => {
      const next = blocks.slice();
      next[index] = reclassifySingleBlock(next[index], nextRaw);
      onUpdateBlocks(next, {
        prevBlocks: blocks,
        activeIdx: index,
        isInputRule,
      });
    },
    [blocks, onUpdateBlocks]
  );

  const handleSplitBlock = useCallback(
    (index: number, beforeRaw: string, afterRaw: string) => {
      const next = blocks.slice();
      const updatedCurrent = reclassifySingleBlock(next[index], beforeRaw);
      const insertedBlocks = parseMarkdownToBlocks(afterRaw);
      const firstNew = insertedBlocks[0] || {
        id: nextBlockId(),
        type: 'paragraph' as const,
        raw: afterRaw,
        estimatedHeight: 40,
        startLine: 1,
        endLine: 1,
      };
      next.splice(index, 1, updatedCurrent, firstNew);
      onUpdateBlocks(next, {
        prevBlocks: blocks,
        activeIdx: index,
        isInputRule: beforeRaw === '---',
      });
      setActiveBlockIndex(index + 1);
      setSlashState((s) => ({ ...s, open: false }));
    },
    [blocks, onUpdateBlocks]
  );

  const handleDeleteBlock = useCallback(
    (index: number) => {
      if (blocks.length <= 1) {
        handleBlockChange(0, '', false);
        return;
      }
      const next = blocks.slice();
      next.splice(index, 1);
      onUpdateBlocks(next, { prevBlocks: blocks, activeIdx: index, isInputRule: false });
      setActiveBlockIndex(Math.max(0, index - 1));
    },
    [blocks, handleBlockChange, onUpdateBlocks]
  );

  const handleMoveBlock = useCallback(
    (index: number, dir: -1 | 1) => {
      const target = index + dir;
      if (target < 0 || target >= blocks.length) return;
      const next = blocks.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      onUpdateBlocks(next, { prevBlocks: blocks, activeIdx: index, isInputRule: false });
      setActiveBlockIndex(target);
    },
    [blocks, onUpdateBlocks]
  );

  const handleInsertBelow = useCallback(
    (index: number, initialRaw = '') => {
      const created = parseMarkdownToBlocks(initialRaw);
      const next = blocks.slice();
      next.splice(index + 1, 0, ...created);
      onUpdateBlocks(next, { prevBlocks: blocks, activeIdx: index, isInputRule: false });
      setActiveBlockIndex(index + 1);
    },
    [blocks, onUpdateBlocks]
  );

  const handleHtmlPaste = useCallback(
    (index: number, rawHtml: string, plainText: string) => {
      const cleanMd = convertHtmlToCleanMarkdown(rawHtml);
      const parsedBlocks = parseMarkdownToBlocks(cleanMd || plainText);
      const next = blocks.slice();
      next.splice(index, 1, ...parsedBlocks);
      onUpdateBlocks(next, { prevBlocks: blocks, activeIdx: index, isInputRule: false });
      setPasteNotice({ blockIndex: index, plainText });
    },
    [blocks, onUpdateBlocks]
  );

  // Upload image file to local `/api/v1/assets` and insert `![alt](url)`
  const uploadAndInsertImage = async (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result || '');
      try {
        const res = await fetch('/api/v1/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, base64 }),
        });
        if (res.ok) {
          const data = (await res.json()) as { markdownUrl: string };
          handleInsertBelow(activeBlockIndex, `![${file.name}](${data.markdownUrl})`);
          return;
        }
      } catch {
        // Fallback to inline data URI if offline
      }
      handleInsertBelow(activeBlockIndex, `![${file.name}](${base64})`);
    };
    reader.readAsDataURL(file);
  };

  // Filtered Slash Commands (supports Chinese + Pinyin initials!)
  const filteredSlashCommands = useMemo(() => {
    if (!slashState.open) return [];
    const q = slashState.query.replace(/^\//, '').toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.includes(q))
    );
  }, [slashState]);

  const applySlashCommand = (cmd: SlashCommandItem) => {
    const parsed = parseMarkdownToBlocks(cmd.insert);
    const next = blocks.slice();
    next.splice(slashState.blockIndex, 1, ...parsed);
    onUpdateBlocks(next, {
      prevBlocks: blocks,
      activeIdx: slashState.blockIndex,
      isInputRule: false,
    });
    setSlashState((s) => ({ ...s, open: false }));
  };

  // Compute `[[` WikiLink / `#Section` autocomplete candidates
  const wikiSuggestions = useMemo(() => {
    if (!wikiMenuState.open) return [];
    const catalog =
      docLinksData.workspaceCatalog.length > 0
        ? docLinksData.workspaceCatalog
        : documents.map((d) => ({ id: d.id, title: d.title, headings: [] }));

    const hashIdx = wikiMenuState.query.indexOf('#');
    if (hashIdx >= 0) {
      const notePart = wikiMenuState.query.slice(0, hashIdx).trim().toLowerCase();
      const headingPart = wikiMenuState.query.slice(hashIdx + 1).trim().toLowerCase();
      const matchedDoc = catalog.find(
        (c) => c.title.toLowerCase() === notePart || c.title.toLowerCase().includes(notePart)
      );
      if (!matchedDoc) return [];
      return matchedDoc.headings
        .filter((h) => !headingPart || h.toLowerCase().includes(headingPart))
        .slice(0, 10)
        .map((h) => ({
          key: `${matchedDoc.id}#${h}`,
          title: matchedDoc.title,
          heading: h,
          insertInner: `${matchedDoc.title}#${h}`,
          isNew: false,
        }));
    }

    const q = wikiMenuState.query.trim().toLowerCase();
    const list: Array<{
      key: string;
      title: string;
      heading?: string;
      insertInner: string;
      isNew: boolean;
    }> = catalog
      .filter((c) => c.id !== activeDocId && (!q || c.title.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((c) => ({
        key: c.id,
        title: c.title,
        heading: c.headings[1] || c.headings[0],
        insertInner: c.title,
        isNew: false,
      }));

    if (q && !catalog.some((c) => c.title.trim().toLowerCase() === q)) {
      list.push({
        key: `new:${q}`,
        title: wikiMenuState.query.trim(),
        heading: undefined,
        insertInner: wikiMenuState.query.trim(),
        isNew: true,
      });
    }
    return list;
  }, [wikiMenuState, docLinksData.workspaceCatalog, documents, activeDocId]);

  const applyWikiSuggestion = (insertInner: string, forceEmbed?: boolean) => {
    const blk = blocks[wikiMenuState.blockIndex];
    if (!blk) return;
    const prefix = blk.raw.slice(0, wikiMenuState.replaceStartOffset);
    const openLen = (wikiMenuState.isEmbed ? 3 : 2) + wikiMenuState.query.length;
    const suffix = blk.raw.slice(wikiMenuState.replaceStartOffset + openLen);
    const useEmbed = forceEmbed ?? wikiMenuState.isEmbed;
    const token = `${useEmbed ? '!' : ''}[[${insertInner}]]`;
    const nextRaw = `${prefix}${token}${suffix.startsWith(']]') ? suffix.slice(2) : suffix}`;
    handleBlockChange(wikiMenuState.blockIndex, nextRaw, false);
    setWikiMenuState((s) => ({ ...s, open: false }));
  };

  const handleConvertUnlinkedMention = async (mention: UnlinkedMentionItem) => {
    if (!activeDocId) return;
    const res = await fetch(`/api/v1/documents/${encodeURIComponent(activeDocId)}/link-mention`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceDocId: mention.sourceDocId,
        lineNumber: mention.lineNumber,
        matchedText: mention.matchedText,
      }),
    });
    if (res.ok) {
      setLinksRefreshTick((t) => t + 1);
    }
  };

  const executeReplaceSingle = () => {
    if (searchMatchedBlocks.length === 0 || !findQuery) return;
    const blkIdx = searchMatchedBlocks[activeMatchCursor % searchMatchedBlocks.length];
    const base = useRegex ? findQuery : findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(wholeWord ? `\\b(?:${base})\\b` : base, caseSensitive ? '' : 'i');
    const nextRaw = blocks[blkIdx].raw.replace(re, replaceText);
    handleBlockChange(blkIdx, nextRaw, false);
  };

  const executeReplaceAll = () => {
    if (searchMatchedBlocks.length === 0 || !findQuery) return;
    const base = useRegex ? findQuery : findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(wholeWord ? `\\b(?:${base})\\b` : base, caseSensitive ? 'g' : 'gi');
    const next = blocks.map((b) =>
      re.test(b.raw) ? reclassifySingleBlock(b, b.raw.replace(re, replaceText)) : b
    );
    onUpdateBlocks(next, { prevBlocks: blocks, activeIdx: activeBlockIndex, isInputRule: false });
  };

  const fontSizeClass =
    fontSizeStep === 'sm' ? 'text-[14.5px]' : fontSizeStep === 'lg' ? 'text-[17.5px]' : 'text-[16px]';
  const proseFontClass = useSerifProse ? 'font-editorial-serif' : '';
  const containerMeasureClass =
    widthPreset === 'narrow'
      ? 'max-w-[680px]'
      : widthPreset === 'wide'
      ? 'max-w-[1100px]'
      : 'max-w-[860px]';

  return (
    <div className="flex h-[calc(100vh-57px)] flex-col overflow-hidden bg-[#FAFAFA] text-zinc-900 dark:bg-[#0B0F17] dark:text-zinc-100">
      {/* Hidden File Pickers for Local .md Import & Image Upload */}
      <input
        ref={fileInputMdRef}
        type="file"
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            const title = f.name.replace(/\.(md|markdown|txt)$/i, '');
            onImportLocalMarkdown(title, String(reader.result || ''));
          };
          reader.readAsText(f, 'utf-8');
          e.target.value = '';
        }}
      />
      <input
        ref={fileInputImgRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadAndInsertImage(f);
          e.target.value = '';
        }}
      />

      {/* Workspace Secondary Formatting & Mode Toolbar */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/90 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-[#111622]">
        {/* Left: Sidebar Toggle + Formatting Shortcuts */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            title="展开/收起侧边栏 (Ctrl+\)"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
          >
            {sidebarOpen ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>侧栏</span>
          </button>

          <div className="mx-1.5 h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

          <button
            type="button"
            disabled={undoStack.length === 0}
            onClick={() => {
              const idx = onUndo();
              if (idx !== null) setActiveBlockIndex(idx);
            }}
            title="撤销 (Ctrl/Cmd+Z · 输入规则首次撤销还原原始字符)"
            className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 disabled:opacity-35 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={redoStack.length === 0}
            onClick={() => {
              const idx = onRedo();
              if (idx !== null) setActiveBlockIndex(idx);
            }}
            title="重做 (Ctrl+Y / Cmd+Shift+Z)"
            className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 disabled:opacity-35 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1.5 hidden h-4 w-px bg-zinc-200 sm:block dark:bg-zinc-800" />

          <div className="hidden items-center gap-0.5 sm:flex">
            <button
              type="button"
              title="一级标题"
              onClick={() => {
                const curr = blocks[activeBlockIndex];
                if (!curr) return;
                const clean = curr.raw.replace(/^#{1,6}\s+/, '');
                handleBlockChange(activeBlockIndex, `# ${clean}`, false);
              }}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Heading1 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="二级标题"
              onClick={() => {
                const curr = blocks[activeBlockIndex];
                if (!curr) return;
                const clean = curr.raw.replace(/^#{1,6}\s+/, '');
                handleBlockChange(activeBlockIndex, `## ${clean}`, false);
              }}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Heading2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="加粗 (Ctrl/Cmd+B)"
              onClick={() => wrapActiveBlockInline('**')}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Bold className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="斜体 (Ctrl/Cmd+I)"
              onClick={() => wrapActiveBlockInline('*')}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Italic className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="删除线"
              onClick={() => wrapActiveBlockInline('~~')}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Strikethrough className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="高亮标记 (==文字==)"
              onClick={() => wrapActiveBlockInline('==')}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Highlighter className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="行内代码 (Ctrl/Cmd+E)"
              onClick={() => wrapActiveBlockInline('`')}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Code className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="插入任务清单"
              onClick={() => handleInsertBelow(activeBlockIndex, '- [ ] 新任务项')}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <ListChecks className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="插入 GFM 表格"
              onClick={() =>
                handleInsertBelow(
                  activeBlockIndex,
                  '| 字段名 | 类型 | 说明 |\n| :--- | :---: | :--- |\n| id | u64 | 主键索引 |'
                )
              }
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <TableIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="插入双向链接 [[文档]] (Ctrl/Cmd+K)"
              onClick={insertWikiLinkAtCursor}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Link2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="上传本地图片插入"
              onClick={() => fileInputImgRef.current?.click()}
              className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Center: PRD 5.1 Three-Mode Segmented Control */}
        <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/90">
          <button
            type="button"
            onClick={() => setEditorMode('wysiwyg')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              editorMode === 'wysiwyg'
                ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>即时渲染</span>
          </button>
          <button
            type="button"
            onClick={() => setEditorMode('source')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              editorMode === 'source'
                ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            <FileCode2 className="h-3.5 w-3.5" />
            <span>源码模式</span>
          </button>
          <button
            type="button"
            onClick={() => setEditorMode('split')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              editorMode === 'split'
                ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" />
            <span>分栏对照</span>
          </button>
        </div>

        {/* Right: Formal PDF, Kanban, Focus, Typewriter, Find, Theme & Typography Settings */}
        <div className="relative flex items-center gap-1.5">
          {onOpenPdfExport && (
            <button
              type="button"
              onClick={onOpenPdfExport}
              title="正式版式 PDF 导出与 A4 预览 (Ctrl/Cmd + Shift + E)"
              className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-800 transition-colors hover:bg-zinc-100 whitespace-nowrap shrink-0 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              导出 PDF
            </button>
          )}
          {onOpenKanbanBoard && (
            <button
              type="button"
              onClick={onOpenKanbanBoard}
              title="将当前文档 Checkbox 列表渲染为任务看板"
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 whitespace-nowrap shrink-0 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              看板
            </button>
          )}
          <button
            type="button"
            onClick={() => setFocusMode((v) => !v)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              focusMode
                ? 'bg-blue-600 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            专注
          </button>
          <button
            type="button"
            onClick={() => setTypewriterMode((v) => !v)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              typewriterMode
                ? 'bg-blue-600 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            打字机
          </button>
          <button
            type="button"
            onClick={() => setShowFindBar((v) => !v)}
            title="查找与替换 (Ctrl/Cmd+F)"
            className={`rounded-md p-1.5 transition-colors ${
              showFindBar
                ? 'bg-blue-600 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleDark}
            title="切换浅色 / 深色主题"
            className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setShowSettingsPopover((v) => !v)}
            title="排版与语法标记显示策略"
            className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>

          {showSettingsPopover && (
            <div className="absolute right-0 top-10 z-40 w-72 rounded-xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">排版与语法标记设置</span>
                <button
                  type="button"
                  onClick={() => setShowSettingsPopover(false)}
                  className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <div className="mb-1 text-zinc-500">语法标记显现策略 (PRD 5.3)</div>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
                    {(
                      [
                        ['active', '光标处'],
                        ['hidden', '始终隐藏'],
                        ['always', '始终显示'],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setSyntaxReveal(val)}
                        className={`rounded py-1 font-medium whitespace-nowrap shrink-0 ${
                          syntaxReveal === val
                            ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-white'
                            : 'text-zinc-600 dark:text-zinc-400'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-zinc-500">正文字体风格</div>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
                    <button
                      type="button"
                      onClick={() => setUseSerifProse(false)}
                      className={`rounded py-1 font-medium whitespace-nowrap shrink-0 ${
                        !useSerifProse
                          ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-white'
                          : 'text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      现代无衬线
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseSerifProse(true)}
                      className={`rounded py-1 font-medium whitespace-nowrap shrink-0 ${
                        useSerifProse
                          ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-white'
                          : 'text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      人文衬线体
                    </button>
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-zinc-500">字号与版心宽度 (PRD TH-02)</div>
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
                      {(['sm', 'md', 'lg'] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setFontSizeStep(sz)}
                          className={`flex-1 rounded py-1 whitespace-nowrap shrink-0 ${
                            fontSizeStep === sz
                              ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-white'
                              : 'text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          {sz === 'sm' ? '小' : sz === 'md' ? '标准' : '大'}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
                      {(['narrow', 'standard', 'wide'] as const).map((w) => (
                        <button
                          key={w}
                          type="button"
                          onClick={() => setWidthPreset(w)}
                          className={`flex-1 rounded py-1 whitespace-nowrap shrink-0 ${
                            widthPreset === w
                              ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-white'
                              : 'text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          {w === 'narrow' ? '窄' : w === 'standard' ? '中' : '宽'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Find & Replace Bar (PRD NV-01) */}
      {showFindBar && (
        <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 dark:border-zinc-700 dark:bg-zinc-950">
              <Search className="h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                value={findQuery}
                onChange={(e) => {
                  setFindQuery(e.target.value);
                  setActiveMatchCursor(0);
                }}
                placeholder="查找内容…"
                className="w-40 bg-transparent outline-none"
              />
              <span className="font-mono text-zinc-400 tabular-nums">
                {searchMatchedBlocks.length > 0
                  ? `${(activeMatchCursor % searchMatchedBlocks.length) + 1}/${searchMatchedBlocks.length}`
                  : '0/0'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => setCaseSensitive((v) => !v)}
              className={`rounded px-2 py-1 font-mono ${
                caseSensitive ? 'bg-blue-600 text-white' : 'bg-zinc-200/70 dark:bg-zinc-800'
              }`}
              title="区分大小写"
            >
              Aa
            </button>
            <button
              type="button"
              onClick={() => setWholeWord((v) => !v)}
              className={`rounded px-2 py-1 font-mono ${
                wholeWord ? 'bg-blue-600 text-white' : 'bg-zinc-200/70 dark:bg-zinc-800'
              }`}
              title="全字匹配"
            >
              \b
            </button>
            <button
              type="button"
              onClick={() => setUseRegex((v) => !v)}
              className={`rounded px-2 py-1 font-mono ${
                useRegex ? 'bg-blue-600 text-white' : 'bg-zinc-200/70 dark:bg-zinc-800'
              }`}
              title="正则表达式"
            >
              .*
            </button>

            <button
              type="button"
              disabled={searchMatchedBlocks.length === 0}
              onClick={() => {
                const next =
                  (activeMatchCursor - 1 + searchMatchedBlocks.length) % searchMatchedBlocks.length;
                setActiveMatchCursor(next);
                scrollToBlock(searchMatchedBlocks[next], true);
              }}
              className="rounded p-1 hover:bg-zinc-200 disabled:opacity-40 dark:hover:bg-zinc-800"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={searchMatchedBlocks.length === 0}
              onClick={() => {
                const next = (activeMatchCursor + 1) % searchMatchedBlocks.length;
                setActiveMatchCursor(next);
                scrollToBlock(searchMatchedBlocks[next], true);
              }}
              className="rounded p-1 hover:bg-zinc-200 disabled:opacity-40 dark:hover:bg-zinc-800"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            <div className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />

            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 dark:border-zinc-700 dark:bg-zinc-950">
              <Replace className="h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="替换为…"
                className="w-36 bg-transparent outline-none"
              />
            </div>
            <button
              type="button"
              onClick={executeReplaceSingle}
              className="rounded-md bg-zinc-200/80 px-2.5 py-1 font-medium hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 whitespace-nowrap shrink-0"
            >
              替换
            </button>
            <button
              type="button"
              onClick={executeReplaceAll}
              className="rounded-md bg-zinc-900 px-2.5 py-1 font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 whitespace-nowrap shrink-0"
            >
              全部替换
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setShowFindBar(false);
              setFindQuery('');
            }}
            className="rounded p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Smart HTML Paste Revert Banner (PRD IO-01) */}
      {pasteNotice && (
        <div className="no-print flex items-center justify-between bg-blue-50 px-4 py-1.5 text-xs text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
          <span>已自动将剪贴板富文本净化为标准 GFM Markdown 结构。</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                handleBlockChange(pasteNotice.blockIndex, pasteNotice.plainText, false);
                setPasteNotice(null);
              }}
              className="font-semibold underline hover:no-underline whitespace-nowrap shrink-0"
            >
              改为粘贴纯文本
            </button>
            <button
              type="button"
              onClick={() => setPasteNotice(null)}
              className="text-blue-600 dark:text-blue-300"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* Main Workspace Area: Collapsible Sidebar + Virtualized Editor Viewport */}
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <aside className="no-print flex w-68 shrink-0 flex-col border-r border-zinc-200/90 bg-[#F4F4F5] dark:border-zinc-800 dark:bg-[#111622]">
            {/* Sidebar Segmented Switcher (4 Tabs: 大纲 · 双链 · 文档 · 版本) */}
            <div className="grid grid-cols-4 gap-1 border-b border-zinc-200/80 p-2 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setSidebarTab('outline')}
                className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  sidebarTab === 'outline'
                    ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'
                }`}
              >
                <ListTree className="h-3.5 w-3.5" />
                <span>大纲</span>
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('links')}
                className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  sidebarTab === 'links'
                    ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'
                }`}
              >
                <GitFork className="h-3.5 w-3.5" />
                <span>双链</span>
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('files')}
                className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  sidebarTab === 'files'
                    ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'
                }`}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span>文档</span>
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('snapshots')}
                className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  sidebarTab === 'snapshots'
                    ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                <span>版本</span>
              </button>
            </div>

            {/* Sidebar Tab: Bidirectional Links, Unlinked Mentions & Title Refactoring */}
            {sidebarTab === 'links' && (
              <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-3 text-xs">
                <div className="flex items-center justify-between text-zinc-500 tabular-nums">
                  <span>
                    反向 {docLinksData.backlinks.length} · 正向 {docLinksData.outgoing.length}
                  </span>
                  <button
                    type="button"
                    onClick={onOpenKnowledgeGraph}
                    className="font-medium text-blue-600 hover:underline dark:text-blue-400 whitespace-nowrap shrink-0"
                  >
                    全局图谱 →
                  </button>
                </div>

                {/* Incoming Backlinks */}
                <section>
                  <div className="mb-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
                    反向链接 (引用本文档的笔记)
                  </div>
                  {docLinksData.backlinks.length === 0 ? (
                    <p className="text-zinc-400">
                      暂无反向链接。在其他笔记中输入 <code className="font-mono">[[{activeTitle}]]</code> 即可建立双向关联。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {docLinksData.backlinks.map((bl, idx) => (
                        <div
                          key={`${bl.sourceDocId}-${idx}`}
                          onClick={() => onSelectDocument(bl.sourceDocId)}
                          className="cursor-pointer rounded-lg border border-zinc-200/80 bg-white p-2.5 transition-colors hover:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-semibold text-blue-600 dark:text-blue-400">
                              {bl.sourceTitle}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-zinc-400 tabular-nums">
                              L{bl.lineNumber} · {bl.kind === 'embed' ? '嵌入' : '双链'}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 leading-relaxed text-zinc-600 dark:text-zinc-300">
                            {bl.contextExcerpt}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Unlinked Mentions */}
                <section>
                  <div className="mb-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
                    潜在未链接提及 ({docLinksData.unlinkedMentions.length})
                  </div>
                  {docLinksData.unlinkedMentions.length === 0 ? (
                    <p className="text-zinc-400">未发现纯文本同名提及。</p>
                  ) : (
                    <div className="space-y-2">
                      {docLinksData.unlinkedMentions.map((um, idx) => (
                        <div
                          key={`${um.sourceDocId}-${um.lineNumber}-${idx}`}
                          className="rounded-lg border border-zinc-200/80 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => onSelectDocument(um.sourceDocId)}
                              className="truncate font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                            >
                              {um.sourceTitle}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleConvertUnlinkedMention(um)}
                              className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 whitespace-nowrap"
                            >
                              转为双链
                            </button>
                          </div>
                          <p className="mt-1 line-clamp-2 text-zinc-500 dark:text-zinc-400">
                            {um.contextExcerpt}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Outgoing Links */}
                <section>
                  <div className="mb-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
                    本文档正向引用 ({docLinksData.outgoing.length})
                  </div>
                  {docLinksData.outgoing.length === 0 ? (
                    <p className="text-zinc-400">在正文中键入 [[ 可快速引用其他笔记。</p>
                  ) : (
                    <div className="space-y-1.5">
                      {docLinksData.outgoing.map((out, idx) => (
                        <button
                          key={`${out.targetName}-${idx}`}
                          type="button"
                          onClick={() => onNavigateWikiLink(out.targetName, out.headingAnchor)}
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200/70 bg-white px-2.5 py-2 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/80"
                        >
                          <div className="min-w-0">
                            <div
                              className={`truncate font-medium ${
                                out.resolved
                                  ? 'text-zinc-900 dark:text-zinc-100'
                                  : 'text-amber-700 dark:text-amber-300'
                              }`}
                            >
                              {out.targetTitle}
                            </div>
                            {out.headingAnchor && (
                              <div className="truncate text-[11px] text-zinc-400">
                                § {out.headingAnchor}
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 text-[11px] text-zinc-400">
                            {out.resolved ? '跳转' : '新建'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                {/* Rename Document + Atomic Workspace Link Refactoring */}
                <section className="border-t border-zinc-200/80 pt-3 dark:border-zinc-800">
                  <div className="mb-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
                    重命名并同步更新全库双链
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const trimmed = renameDraft.trim();
                        if (!trimmed || trimmed === activeTitle) return;
                        const result = await onRefactorDocumentTitle(trimmed);
                        if (result) {
                          setLinksRefreshTick((t) => t + 1);
                          setRefactorNotice(
                            `已同步更新标题及 ${result.rewrittenFilesCount} 个文件中的 ${result.rewrittenLinksCount} 处引用`
                          );
                        }
                      }}
                      className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 whitespace-nowrap shrink-0"
                    >
                      重构
                    </button>
                  </div>
                  {refactorNotice && (
                    <p className="mt-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                      {refactorNotice}
                    </p>
                  )}
                </section>
              </div>
            )}

            {/* Sidebar Tab 1: Auto-Generated Outline (PRD NV-02) */}
            {sidebarTab === 'outline' && (
              <div className="flex-1 overflow-y-auto p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>章节目录 ({outline.length})</span>
                  <span className="font-mono tabular-nums">{blocks.length} 块</span>
                </div>
                {outline.length === 0 ? (
                  <p className="py-6 text-center text-xs text-zinc-400">
                    在正文中输入 <code className="font-mono"># 标题</code> 自动生成目录树
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {outline.slice(0, 300).map((item) => {
                      const padMap = ['', 'pl-0', 'pl-3', 'pl-6', 'pl-9', 'pl-11', 'pl-12'];
                      const isCurrent = item.blockIndex === activeBlockIndex;
                      return (
                        <button
                          key={item.blockId}
                          type="button"
                          onClick={() => {
                            setActiveBlockIndex(item.blockIndex);
                            scrollToBlock(item.blockIndex, false);
                          }}
                          className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                            padMap[item.level] || 'pl-0'
                          } ${
                            isCurrent
                              ? 'bg-blue-600/10 font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                              : 'text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100'
                          }`}
                        >
                          {item.text}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Sidebar Tab 2: Local Workspace Markdown Files */}
            {sidebarTab === 'files' && (
              <div className="flex flex-1 flex-col overflow-hidden p-3">
                <div className="mb-2.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onCreateDocument}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 whitespace-nowrap shrink-0"
                  >
                    <FilePlus2 className="h-3.5 w-3.5" />
                    <span>新建文档</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputMdRef.current?.click()}
                    title="从本地磁盘导入 .md / .txt"
                    className="flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 whitespace-nowrap shrink-0"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>导入</span>
                  </button>
                </div>

                <div className="flex-1 space-y-1 overflow-y-auto">
                  {documents.map((doc) => {
                    const selected = doc.id === activeDocId;
                    return (
                      <div
                        key={doc.id}
                        onClick={() => onSelectDocument(doc.id)}
                        className={`group flex cursor-pointer items-start justify-between gap-2 rounded-lg p-2.5 transition-colors ${
                          selected
                            ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                            : 'text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="truncate text-xs font-semibold">{doc.title}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                            {doc.stats.wordCount.toLocaleString()} 字 · {doc.stats.blockCount} 块 ·{' '}
                            {doc.stats.lineEnding.toUpperCase()}
                          </div>
                        </div>
                        {documents.length > 1 && (
                          <button
                            type="button"
                            title="删除文档"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteDocument(doc.id);
                            }}
                            className="opacity-0 rounded p-1 text-zinc-400 hover:text-red-600 group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sidebar Tab 3: Local Version Snapshots (PRD CO-03) */}
            {sidebarTab === 'snapshots' && (
              <div className="flex flex-1 flex-col overflow-hidden p-3">
                <button
                  type="button"
                  onClick={() => onSaveNow(true)}
                  className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>创建当前版本快照</span>
                </button>

                <div className="flex-1 space-y-1.5 overflow-y-auto">
                  {snapshots.length === 0 ? (
                    <p className="py-6 text-center text-xs text-zinc-400">暂无历史快照</p>
                  ) : (
                    snapshots.map((snap) => (
                      <div
                        key={snap.snapshotId}
                        className="rounded-lg border border-zinc-200/80 bg-white p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{snap.label}</div>
                        <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                          {new Date(snap.createdAt).toLocaleTimeString()} · Rev #{snap.revision}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const restored = parseMarkdownToBlocks(snap.content);
                            onUpdateBlocks(restored, {
                              prevBlocks: blocks,
                              activeIdx: 0,
                              isInputRule: false,
                            });
                          }}
                          className="mt-2 flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>恢复至此版本</span>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Main Editor Canvas: WYSIWYG Virtualized / Source / Split */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (!f) return;
            if (f.type.startsWith('image/')) {
              uploadAndInsertImage(f);
            } else if (/\.(md|markdown|txt)$/i.test(f.name)) {
              const reader = new FileReader();
              reader.onload = () => {
                onImportLocalMarkdown(f.name.replace(/\.(md|markdown|txt)$/i, ''), String(reader.result || ''));
              };
              reader.readAsText(f, 'utf-8');
            }
          }}
          className="relative flex flex-1 flex-col overflow-hidden"
        >
          {/* Mode 1: Instant WYSIWYG with Fenwick Height Virtualization */}
          {editorMode === 'wysiwyg' && (
            <div
              ref={scrollContainerRef}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              className="flex-1 overflow-y-auto px-6 py-8 sm:px-14"
            >
              <div className={`mx-auto w-full ${containerMeasureClass}`}>
                <div ref={topSpacerRef} />

                {blocks.slice(virtualWindow.startIdx, virtualWindow.endIdx).map((blk, localOffset) => {
                  const globalIdx = virtualWindow.startIdx + localOffset;
                  return (
                    <BlockRenderer
                      key={blk.id}
                      block={blk}
                      index={globalIdx}
                      isActive={globalIdx === activeBlockIndex}
                      isDark={isDark}
                      focusMode={focusMode}
                      syntaxReveal={syntaxReveal}
                      fontSizeClass={fontSizeClass}
                      proseFontClass={proseFontClass}
                      searchQuery={findQuery}
                      wikiContext={wikiContext}
                      workspaceRevisionKey={workspaceRevisionKey}
                      onActivate={setActiveBlockIndex}
                      onChangeRaw={handleBlockChange}
                      onSplitBlockAfter={handleSplitBlock}
                      onDeleteBlock={handleDeleteBlock}
                      onMoveBlock={handleMoveBlock}
                      onInsertBlockBelow={handleInsertBelow}
                      onOpenSlashMenu={(idx, query) =>
                        setSlashState({ open: true, blockIndex: idx, query, selectedIdx: 0 })
                      }
                      onCloseSlashMenu={() =>
                        setSlashState((s) => (s.open ? { ...s, open: false } : s))
                      }
                      onOpenWikiMenu={(idx, query, replaceStartOffset, isEmbed) =>
                        setWikiMenuState({
                          open: true,
                          blockIndex: idx,
                          query,
                          replaceStartOffset,
                          isEmbed,
                        })
                      }
                      onCloseWikiMenu={() =>
                        setWikiMenuState((s) => (s.open ? { ...s, open: false } : s))
                      }
                      onMeasuredHeight={handleMeasuredHeight}
                      onHtmlPaste={handleHtmlPaste}
                    />
                  );
                })}

                <div ref={bottomSpacerRef} />

                {/* Click empty space to append new paragraph */}
                <div
                  onClick={() => handleInsertBelow(blocks.length - 1, '')}
                  className="h-16 cursor-text"
                />

                {/* Document Bottom Bidirectional Knowledge Network Section */}
                {blocks.length <= 400 && (
                  <section className="no-print mt-8 border-t border-zinc-200/80 pt-6 pb-16 dark:border-zinc-800/90">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                        <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                          文档双向连接网络
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>反向链接 {docLinksData.backlinks.length}</span>
                        <span aria-hidden="true">·</span>
                        <span>正向引用 {docLinksData.outgoing.length}</span>
                        {docLinksData.unlinkedMentions.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>潜在提及 {docLinksData.unlinkedMentions.length}</span>
                          </>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={onOpenKnowledgeGraph}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 whitespace-nowrap shrink-0"
                      >
                        <span>在全局知识图谱中定位</span>
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {docLinksData.backlinks.length === 0 &&
                    docLinksData.unlinkedMentions.length === 0 ? (
                      <p className="text-xs text-zinc-400">
                        当前文档暂无外部反向链接。可在其他笔记中通过{' '}
                        <code className="font-mono">[[{activeTitle}]]</code> 或{' '}
                        <code className="font-mono">![[{activeTitle}]]</code> 建立连接。
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {docLinksData.backlinks.map((bl, idx) => (
                          <div
                            key={`footer-bl-${bl.sourceDocId}-${idx}`}
                            onClick={() => onSelectDocument(bl.sourceDocId)}
                            className="cursor-pointer rounded-xl border border-zinc-200/80 bg-white px-4 py-3 text-xs transition-colors hover:border-blue-400 dark:border-zinc-800 dark:bg-[#111622]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100">
                                {bl.sourceTitle}
                              </span>
                              <span className="shrink-0 font-mono text-[11px] text-zinc-400 tabular-nums">
                                {bl.kind === 'embed' ? '嵌入引用' : '双向链接'} · L{bl.lineNumber}
                              </span>
                            </div>
                            <p className="mt-1.5 line-clamp-2 leading-relaxed text-zinc-600 dark:text-zinc-400">
                              {bl.contextExcerpt}
                            </p>
                          </div>
                        ))}

                        {docLinksData.unlinkedMentions.map((um, idx) => (
                          <div
                            key={`footer-um-${um.sourceDocId}-${idx}`}
                            className="rounded-xl border border-dashed border-zinc-300/90 bg-zinc-50/70 px-4 py-3 text-xs dark:border-zinc-700 dark:bg-zinc-900/40"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">
                                潜在提及：{um.sourceTitle}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleConvertUnlinkedMention(um)}
                                className="shrink-0 font-semibold text-blue-600 hover:underline dark:text-blue-400 whitespace-nowrap"
                              >
                                一键转为双链
                              </button>
                            </div>
                            <p className="mt-1.5 line-clamp-2 leading-relaxed text-zinc-500 dark:text-zinc-400">
                              {um.contextExcerpt}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </div>

              {/* WikiLink `[[` / `![[` Autocomplete Popover */}
              {wikiMenuState.open && wikiSuggestions.length > 0 && (
                <div className="fixed bottom-12 left-1/2 z-50 w-96 -translate-x-1/2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex items-center justify-between px-2.5 py-1 text-[11px] text-zinc-400">
                    <span>
                      {wikiMenuState.query.includes('#')
                        ? '选择目标章节锚点 (#)'
                        : '关联本地知识节点 · 输入 # 可定位章节'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setWikiMenuState((s) => ({ ...s, open: false }))}
                      className="hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      Esc
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {wikiSuggestions.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <button
                          type="button"
                          onClick={() => applyWikiSuggestion(item.insertInner, false)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate font-semibold text-zinc-900 dark:text-zinc-100">
                            {item.isNew ? `新建待连接节点：《${item.title}》` : item.title}
                          </div>
                          {item.heading && (
                            <div className="truncate text-[11px] text-zinc-400">
                              § {item.heading}
                            </div>
                          )}
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => applyWikiSuggestion(item.insertInner, false)}
                            className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-700 hover:bg-blue-600 hover:text-white dark:bg-zinc-800 dark:text-zinc-300 whitespace-nowrap"
                          >
                            [[双链]]
                          </button>
                          <button
                            type="button"
                            onClick={() => applyWikiSuggestion(item.insertInner, true)}
                            className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-700 hover:bg-blue-600 hover:text-white dark:bg-zinc-800 dark:text-zinc-300 whitespace-nowrap"
                          >
                            ![[嵌入]]
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Slash Command Popover (PRD 5.5) */}
              {slashState.open && filteredSlashCommands.length > 0 && (
                <div className="fixed bottom-12 left-1/2 z-50 w-80 -translate-x-1/2 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="px-2.5 py-1 text-[11px] font-medium text-zinc-400">
                    斜杠插入面板 · 支持中文与拼音首字母 ({slashState.query})
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {filteredSlashCommands.map((cmd, idx) => (
                      <button
                        key={cmd.id}
                        type="button"
                        onClick={() => applySlashCommand(cmd)}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                          idx === slashState.selectedIdx
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                            : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <div>
                          <div className="font-semibold">{cmd.label}</div>
                          <div className="text-[11px] text-zinc-400">{cmd.description}</div>
                        </div>
                        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {cmd.hint}
                        </code>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Mode 2: Pure Markdown Source Mode (PRD 5.1) */}
          {editorMode === 'source' && (
            <div className="flex flex-1 overflow-hidden">
              <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-6">
                <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>Markdown 源码视图 · {activeTitle}.md</span>
                  <span>按 Ctrl/Cmd + / 切回即时渲染模式</span>
                </div>
                <textarea
                  value={fullMarkdown}
                  onChange={(e) => {
                    const reparsed = parseMarkdownToBlocks(e.target.value);
                    onUpdateBlocks(reparsed, {
                      prevBlocks: blocks,
                      activeIdx: activeBlockIndex,
                      isInputRule: false,
                    });
                  }}
                  spellCheck={false}
                  aria-label="Markdown 完整源码编辑器"
                  className="flex-1 resize-none rounded-xl border border-zinc-200 bg-white p-5 font-mono text-[13.5px] leading-[1.68] text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-[#111622] dark:text-zinc-100"
                />
              </div>
            </div>
          )}

          {/* Mode 3: Synchronized Split Preview Mode (PRD 5.1) */}
          {editorMode === 'split' && (
            <div className="grid flex-1 grid-cols-1 divide-y divide-zinc-200 overflow-hidden lg:grid-cols-2 lg:divide-x lg:divide-y-0 dark:divide-zinc-800">
              <div className="flex h-full flex-col overflow-hidden p-4">
                <div className="mb-2 text-xs font-medium text-zinc-500">源码编辑 (自动同步右侧滚动比例)</div>
                <textarea
                  value={fullMarkdown}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    const ratio =
                      el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
                    if (splitPreviewRef.current) {
                      const target = splitPreviewRef.current;
                      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
                    }
                  }}
                  onChange={(e) => {
                    const reparsed = parseMarkdownToBlocks(e.target.value);
                    onUpdateBlocks(reparsed, {
                      prevBlocks: blocks,
                      activeIdx: activeBlockIndex,
                      isInputRule: false,
                    });
                  }}
                  spellCheck={false}
                  className="flex-1 resize-none rounded-xl border border-zinc-200 bg-white p-4 font-mono text-[13px] leading-[1.65] outline-none dark:border-zinc-800 dark:bg-[#111622]"
                />
              </div>

              <div
                ref={splitPreviewRef}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                className="h-full overflow-y-auto px-8 py-6"
              >
                <div ref={topSpacerRef} />
                {blocks.slice(virtualWindow.startIdx, virtualWindow.endIdx).map((blk, localOffset) => {
                  const globalIdx = virtualWindow.startIdx + localOffset;
                  return (
                    <BlockRenderer
                      key={blk.id}
                      block={blk}
                      index={globalIdx}
                      isActive={false}
                      isDark={isDark}
                      focusMode={false}
                      syntaxReveal="hidden"
                      fontSizeClass={fontSizeClass}
                      proseFontClass={proseFontClass}
                      searchQuery={findQuery}
                      wikiContext={wikiContext}
                      workspaceRevisionKey={workspaceRevisionKey}
                      onActivate={setActiveBlockIndex}
                      onChangeRaw={handleBlockChange}
                      onSplitBlockAfter={handleSplitBlock}
                      onDeleteBlock={handleDeleteBlock}
                      onMoveBlock={handleMoveBlock}
                      onInsertBlockBelow={handleInsertBelow}
                      onOpenSlashMenu={() => {}}
                      onCloseSlashMenu={() => {}}
                      onMeasuredHeight={handleMeasuredHeight}
                      onHtmlPaste={handleHtmlPaste}
                    />
                  );
                })}
                <div ref={bottomSpacerRef} />
              </div>
            </div>
          )}

          {/* Quiet Document Statistics Footer (Clean unboxed text, tabular-nums, zero fake telemetry) */}
          <footer className="no-print flex items-center justify-between border-t border-zinc-200/90 bg-white px-5 py-1.5 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-[#111622] dark:text-zinc-400">
            <div className="flex flex-wrap items-center gap-2 tabular-nums">
              <span>{liveMetrics.wordCount.toLocaleString()} 字</span>
              <span aria-hidden="true">·</span>
              <span>{liveMetrics.lineCount.toLocaleString()} 行</span>
              <span aria-hidden="true">·</span>
              <span>
                视口挂载 {virtualWindow.endIdx - virtualWindow.startIdx} / {blocks.length} 块
              </span>
              <span aria-hidden="true">·</span>
              <span>预计阅读 {liveMetrics.readingMinutes} 分钟</span>
              <span aria-hidden="true">·</span>
              <span>Rope 缓冲 ~{liveMetrics.estimatedRopeKb.toLocaleString()} KB</span>
            </div>

            <div className="flex items-center gap-2 tabular-nums">
              <span>UTF-8</span>
              <span aria-hidden="true">·</span>
              <span>{lineEnding.toUpperCase()}</span>
              <span aria-hidden="true">·</span>
              <span>{saveStatusText}</span>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
};
