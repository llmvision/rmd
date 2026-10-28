import React, { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  FileCode2,
  FileText,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { BlockRecord, nextBlockId } from '../engine/markdownEngine';
import { renderInlineNodes, WikiRenderContext } from './BlockRenderer';
import type { WorkspaceDocSummary } from './WysiwygWorkspace';

export interface KanbanTaskItem {
  id: string;
  blockIndex: number;
  blockId: string;
  lineIndexInBlock: number;
  docLineNumber: number;
  completed: boolean;
  rawText: string;
  plainText: string;
  sectionHeading: string;
  indentLevel: number;
}

interface KanbanBoardViewProps {
  documents: WorkspaceDocSummary[];
  activeDocId: string;
  activeTitle: string;
  blocks: BlockRecord[];
  saveStatusText: string;
  onSelectDocument: (docId: string) => void;
  onUpdateBlocks: (
    nextBlocks: BlockRecord[],
    undoInfo?: { prevBlocks: BlockRecord[]; activeIdx: number; isInputRule: boolean }
  ) => void;
  onNavigateWikiLink: (target: string, heading?: string) => void;
  onJumpToEditor: (sectionHeading?: string) => void;
  onInspectRustFile?: (rustFilePath: string) => void;
}

const TASK_LINE_REGEX = /^(\s*(?:>\s*)*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;

function stripInlineSyntax(raw: string): string {
  return raw
    .replace(/!\[\[([^\][\n]+)\]\]/g, '$1')
    .replace(/\[\[([^\]|\n]+)\|([^\][\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\][\n]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*\*|\*\*|\*|~~|==|`)/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function extractHeadingLabel(raw: string): string {
  const firstLine = raw.split('\n')[0] || '';
  return firstLine.replace(/^#{1,6}\s+/, '').trim();
}

export function extractKanbanTasksFromBlocks(blocks: BlockRecord[]): KanbanTaskItem[] {
  const items: KanbanTaskItem[] = [];
  let currentSection = '文档导言';

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const block = blocks[bIdx];
    if (block.type === 'heading') {
      const label = extractHeadingLabel(block.raw);
      if (label) {
        currentSection = label;
      }
      continue;
    }

    // Never parse task syntax inside fenced code, math, diagram, or YAML frontmatter blocks
    if (
      block.type === 'code' ||
      block.type === 'mermaid' ||
      block.type === 'math' ||
      block.type === 'frontmatter'
    ) {
      continue;
    }

    const lines = block.raw.split('\n');
    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const line = lines[lIdx];
      const match = line.match(TASK_LINE_REGEX);
      if (!match) continue;

      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      const completed = match[2].toLowerCase() === 'x';
      const rawText = match[4].trim();

      items.push({
        id: `${block.id}:${lIdx}`,
        blockIndex: bIdx,
        blockId: block.id,
        lineIndexInBlock: lIdx,
        docLineNumber: block.startLine + lIdx,
        completed,
        rawText,
        plainText: stripInlineSyntax(rawText),
        sectionHeading: currentSection,
        indentLevel: Math.floor(leadingSpaces / 2),
      });
    }
  }

  return items;
}

export const KanbanBoardView: React.FC<KanbanBoardViewProps> = ({
  documents,
  activeDocId,
  activeTitle,
  blocks,
  saveStatusText,
  onSelectDocument,
  onUpdateBlocks,
  onNavigateWikiLink,
  onJumpToEditor,
  onInspectRustFile,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('ALL');

  // Drag-and-drop state
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [activeDropColumn, setActiveDropColumn] = useState<'todo' | 'done' | null>(null);
  const [dropTargetTaskId, setDropTargetTaskId] = useState<string | null>(null);

  // Quick add inputs per column
  const [newTodoText, setNewTodoText] = useState('');
  const [newDoneText, setNewDoneText] = useState('');
  const [addingColumn, setAddingColumn] = useState<'todo' | 'done' | null>(null);

  // Inline card editing state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  const wikiContext = useMemo<WikiRenderContext>(() => {
    const knownKeys = new Set<string>();
    for (const doc of documents) {
      knownKeys.add(doc.title.trim().toLowerCase());
      knownKeys.add(doc.id.trim().toLowerCase());
    }
    return {
      isTargetResolved: (target: string) => knownKeys.has(target.trim().toLowerCase()),
      onNavigateWikiLink,
    };
  }, [documents, onNavigateWikiLink]);

  const allTasks = useMemo(() => extractKanbanTasksFromBlocks(blocks), [blocks]);

  const availableSections = useMemo(() => {
    const seen = new Set<string>();
    for (const t of allTasks) {
      if (t.sectionHeading) seen.add(t.sectionHeading);
    }
    return Array.from(seen);
  }, [allTasks]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allTasks.filter((task) => {
      if (selectedSection !== 'ALL' && task.sectionHeading !== selectedSection) {
        return false;
      }
      if (!q) return true;
      return (
        task.plainText.toLowerCase().includes(q) ||
        task.rawText.toLowerCase().includes(q) ||
        task.sectionHeading.toLowerCase().includes(q)
      );
    });
  }, [allTasks, searchQuery, selectedSection]);

  const todoTasks = useMemo(
    () => filteredTasks.filter((t) => !t.completed),
    [filteredTasks]
  );
  const doneTasks = useMemo(
    () => filteredTasks.filter((t) => t.completed),
    [filteredTasks]
  );

  const totalCount = allTasks.length;
  const completedCount = useMemo(
    () => allTasks.filter((t) => t.completed).length,
    [allTasks]
  );
  const completionRate =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const draggedTask = useMemo(
    () => (draggedTaskId ? allTasks.find((t) => t.id === draggedTaskId) ?? null : null),
    [allTasks, draggedTaskId]
  );

  const mutateTaskStatusAndOrder = (
    taskId: string,
    targetCompleted: boolean,
    hoverTargetTaskId?: string | null
  ) => {
    const source = allTasks.find((t) => t.id === taskId);
    if (!source) return;

    const targetCard = hoverTargetTaskId
      ? allTasks.find((t) => t.id === hoverTargetTaskId) ?? null
      : null;

    // Case 1: Reordering / moving within the exact same Markdown task block
    if (
      targetCard &&
      targetCard.id !== source.id &&
      targetCard.blockIndex === source.blockIndex
    ) {
      const targetBlock = blocks[source.blockIndex];
      const lines = targetBlock.raw.split('\n');
      const movingLine = lines[source.lineIndexInBlock];
      const match = movingLine?.match(TASK_LINE_REGEX);
      if (!match) return;

      const updatedLine = `${match[1]}${targetCompleted ? 'x' : ' '}${match[3]}${match[4]}`;
      const nextLines = lines.slice();
      nextLines.splice(source.lineIndexInBlock, 1);
      nextLines.splice(targetCard.lineIndexInBlock, 0, updatedLine);

      const nextRaw = nextLines.join('\n');
      if (nextRaw === targetBlock.raw) return;

      const nextBlocks = blocks.slice();
      nextBlocks[source.blockIndex] = {
        ...targetBlock,
        raw: nextRaw,
      };
      onUpdateBlocks(nextBlocks, {
        prevBlocks: blocks,
        activeIdx: source.blockIndex,
        isInputRule: false,
      });
      return;
    }

    // Case 2: Toggling status (`- [ ]` <-> `- [x]`) across columns while preserving exact document section
    if (source.completed === targetCompleted) return;

    const targetBlock = blocks[source.blockIndex];
    if (!targetBlock) return;
    const lines = targetBlock.raw.split('\n');
    const line = lines[source.lineIndexInBlock];
    if (line === undefined) return;

    const match = line.match(TASK_LINE_REGEX);
    if (!match) return;

    lines[source.lineIndexInBlock] = `${match[1]}${targetCompleted ? 'x' : ' '}${match[3]}${match[4]}`;
    const nextBlocks = blocks.slice();
    nextBlocks[source.blockIndex] = {
      ...targetBlock,
      raw: lines.join('\n'),
    };

    onUpdateBlocks(nextBlocks, {
      prevBlocks: blocks,
      activeIdx: source.blockIndex,
      isInputRule: false,
    });
  };

  const handleAddTask = (completed: boolean) => {
    const draft = (completed ? newDoneText : newTodoText).trim();
    if (!draft) return;

    const formattedLine = `- [${completed ? 'x' : ' '}] ${draft}`;
    const nextBlocks = blocks.slice();

    // Append to the last task block in the document if one exists; otherwise append a new task section/block
    let lastTaskBlockIdx = -1;
    for (let i = nextBlocks.length - 1; i >= 0; i--) {
      if (nextBlocks[i].type === 'task') {
        lastTaskBlockIdx = i;
        break;
      }
    }

    if (lastTaskBlockIdx >= 0) {
      const blk = nextBlocks[lastTaskBlockIdx];
      nextBlocks[lastTaskBlockIdx] = {
        ...blk,
        raw: `${blk.raw}\n${formattedLine}`,
        estimatedHeight: blk.estimatedHeight + 30,
        endLine: blk.endLine + 1,
      };
      onUpdateBlocks(nextBlocks, {
        prevBlocks: blocks,
        activeIdx: lastTaskBlockIdx,
        isInputRule: false,
      });
    } else {
      const lastEndLine =
        nextBlocks.length > 0 ? nextBlocks[nextBlocks.length - 1].endLine : 1;
      const headingBlock: BlockRecord = {
        id: nextBlockId(),
        type: 'heading',
        level: 2,
        setext: false,
        raw: '## 任务看板清单',
        estimatedHeight: 52,
        startLine: lastEndLine + 2,
        endLine: lastEndLine + 2,
      };
      const taskBlock: BlockRecord = {
        id: nextBlockId(),
        type: 'task',
        raw: formattedLine,
        estimatedHeight: 46,
        startLine: lastEndLine + 4,
        endLine: lastEndLine + 4,
      };
      const appended =
        nextBlocks.length === 1 && nextBlocks[0].raw.trim() === ''
          ? [headingBlock, taskBlock]
          : [...nextBlocks, headingBlock, taskBlock];
      onUpdateBlocks(appended, {
        prevBlocks: blocks,
        activeIdx: appended.length - 1,
        isInputRule: false,
      });
    }

    if (completed) {
      setNewDoneText('');
    } else {
      setNewTodoText('');
    }
    setAddingColumn(null);
  };

  const handleCommitTaskEdit = (task: KanbanTaskItem) => {
    const clean = editingDraft.trim();
    setEditingTaskId(null);
    if (!clean || clean === task.rawText) return;

    const targetBlock = blocks[task.blockIndex];
    if (!targetBlock) return;
    const lines = targetBlock.raw.split('\n');
    const line = lines[task.lineIndexInBlock];
    const match = line?.match(TASK_LINE_REGEX);
    if (!match) return;

    lines[task.lineIndexInBlock] = `${match[1]}${match[2]}${match[3]}${clean}`;
    const nextBlocks = blocks.slice();
    nextBlocks[task.blockIndex] = {
      ...targetBlock,
      raw: lines.join('\n'),
    };
    onUpdateBlocks(nextBlocks, {
      prevBlocks: blocks,
      activeIdx: task.blockIndex,
      isInputRule: false,
    });
  };

  const handleDeleteTask = (task: KanbanTaskItem) => {
    const targetBlock = blocks[task.blockIndex];
    if (!targetBlock) return;
    const lines = targetBlock.raw.split('\n');
    lines.splice(task.lineIndexInBlock, 1);

    const nextBlocks = blocks.slice();
    if (lines.length === 0) {
      nextBlocks.splice(task.blockIndex, 1);
      if (nextBlocks.length === 0) {
        nextBlocks.push({
          id: nextBlockId(),
          type: 'paragraph',
          raw: '',
          estimatedHeight: 40,
          startLine: 1,
          endLine: 1,
        });
      }
    } else {
      nextBlocks[task.blockIndex] = {
        ...targetBlock,
        raw: lines.join('\n'),
        estimatedHeight: Math.max(36, targetBlock.estimatedHeight - 30),
      };
    }

    onUpdateBlocks(nextBlocks, {
      prevBlocks: blocks,
      activeIdx: Math.max(0, task.blockIndex - 1),
      isInputRule: false,
    });
  };

  const handleSeedStarterChecklist = () => {
    const lastEndLine = blocks.length > 0 ? blocks[blocks.length - 1].endLine : 1;
    const starterRaw = [
      '- [ ] 梳理核心需求边界与接口数据结构',
      '- [ ] 补充边界条件测试与性能回归验证',
      '- [x] 创建文档初始结构并接入本地工作区',
    ].join('\n');

    const headingBlock: BlockRecord = {
      id: nextBlockId(),
      type: 'heading',
      level: 2,
      setext: false,
      raw: '## 待办与进度追踪',
      estimatedHeight: 52,
      startLine: lastEndLine + 2,
      endLine: lastEndLine + 2,
    };
    const taskBlock: BlockRecord = {
      id: nextBlockId(),
      type: 'task',
      raw: starterRaw,
      estimatedHeight: 106,
      startLine: lastEndLine + 4,
      endLine: lastEndLine + 6,
    };

    onUpdateBlocks([...blocks, headingBlock, taskBlock], {
      prevBlocks: blocks,
      activeIdx: blocks.length + 1,
      isInputRule: false,
    });
  };

  const clearDragState = () => {
    setDraggedTaskId(null);
    setActiveDropColumn(null);
    setDropTargetTaskId(null);
  };

  const renderColumn = (columnKey: 'todo' | 'done') => {
    const isDoneCol = columnKey === 'done';
    const items = isDoneCol ? doneTasks : todoTasks;
    const isDropHighlighted = activeDropColumn === columnKey && draggedTaskId !== null;
    const isCrossColumnDrag =
      draggedTask !== null && draggedTask.completed !== isDoneCol;

    const draftValue = isDoneCol ? newDoneText : newTodoText;
    const setDraftValue = isDoneCol ? setNewDoneText : setNewTodoText;

    return (
      <section
        aria-label={isDoneCol ? '已完成任务栏' : '待办任务栏'}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (activeDropColumn !== columnKey) {
            setActiveDropColumn(columnKey);
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setActiveDropColumn(columnKey);
        }}
        onDragLeave={(e) => {
          const nextTarget = e.relatedTarget as Node | null;
          if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
            setActiveDropColumn((prev) => (prev === columnKey ? null : prev));
            setDropTargetTaskId(null);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const droppedId =
            e.dataTransfer.getData('application/x-vellum-task-id') ||
            e.dataTransfer.getData('text/plain') ||
            draggedTaskId;
          if (droppedId) {
            mutateTaskStatusAndOrder(droppedId, isDoneCol, dropTargetTaskId);
          }
          clearDragState();
        }}
        className={`flex min-h-[520px] flex-col rounded-xl border p-4 transition-colors duration-150 ${
          isDropHighlighted
            ? isDoneCol
              ? 'border-emerald-500 bg-emerald-50/40 ring-2 ring-emerald-500/20 dark:border-emerald-500/80 dark:bg-emerald-950/20'
              : 'border-blue-500 bg-blue-50/40 ring-2 ring-blue-500/20 dark:border-blue-500/80 dark:bg-blue-950/20'
            : 'border-zinc-200/90 bg-zinc-100/65 dark:border-zinc-800 dark:bg-[#111622]/85'
        }`}
      >
        {/* Column Header */}
        <div className="mb-3 flex items-center justify-between border-b border-zinc-200/80 pb-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            {isDoneCol ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
            )}
            <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">
              {isDoneCol ? '已完成' : '待办'}
            </h2>
            <span className="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
              · {items.length} 项
            </span>
          </div>

          <button
            type="button"
            onClick={() =>
              setAddingColumn((prev) => (prev === columnKey ? null : columnKey))
            }
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-white hover:text-zinc-950 whitespace-nowrap shrink-0 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>新增任务</span>
          </button>
        </div>

        {/* Inline Quick-Add Composer */}
        {addingColumn === columnKey && (
          <div className="mb-3 rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-[#161D2B]">
            <input
              type="text"
              autoFocus
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleAddTask(isDoneCol);
                } else if (e.key === 'Escape') {
                  setAddingColumn(null);
                }
              }}
              placeholder={
                isDoneCol
                  ? '输入已完成事项（自动写回 - [x] 语法）…'
                  : '输入待办事项（支持 **加粗** 或 [[双向链接]]，自动写回 - [ ]）…'
              }
              className="w-full bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
            />
            <div className="mt-2.5 flex items-center justify-between text-xs text-zinc-400">
              <span className="font-mono">
                {isDoneCol ? '- [x] 任务内容' : '- [ ] 任务内容'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAddingColumn(null)}
                  className="rounded-md px-2.5 py-1 font-medium text-zinc-600 hover:bg-zinc-100 whitespace-nowrap shrink-0 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => handleAddTask(isDoneCol)}
                  className="rounded-md bg-zinc-900 px-3 py-1 font-semibold text-white hover:bg-zinc-800 whitespace-nowrap shrink-0 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  写入文档
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Drop Indicator Banner when dragging from opposite column */}
        {isDropHighlighted && isCrossColumnDrag && (
          <div
            className={`mb-3 rounded-lg border border-dashed px-3 py-2 text-center text-xs font-medium ${
              isDoneCol
                ? 'border-emerald-400 bg-emerald-50/70 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-blue-400 bg-blue-50/70 text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
            }`}
          >
            松开鼠标将任务标记为「{isDoneCol ? '已完成 (- [x])' : '待办 (- [ ])'}」并同步更新 Markdown
          </div>
        )}

        {/* Task Cards List */}
        <div className="flex flex-1 flex-col gap-2.5">
          {items.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300/80 px-4 py-12 text-center dark:border-zinc-800">
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {isDoneCol
                  ? '暂无已完成事项，可将左侧「待办」卡片拖拽至此栏完成归档'
                  : '当前筛选下没有待办事项，可将右侧卡片拖回此处重新打开'}
              </p>
            </div>
          ) : (
            items.map((task) => {
              const isDraggingSelf = draggedTaskId === task.id;
              const isHoverDropTarget =
                dropTargetTaskId === task.id && draggedTaskId !== null && !isDraggingSelf;
              const isEditing = editingTaskId === task.id;

              return (
                <article
                  key={task.id}
                  draggable={!isEditing}
                  onDragStart={(e) => {
                    setDraggedTaskId(task.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('application/x-vellum-task-id', task.id);
                    e.dataTransfer.setData('text/plain', task.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dropTargetTaskId !== task.id) {
                      setDropTargetTaskId(task.id);
                    }
                  }}
                  onDragEnd={clearDragState}
                  className={`group rounded-lg border bg-white p-3.5 transition-all duration-150 dark:bg-[#151B28] ${
                    isDraggingSelf
                      ? 'scale-[0.99] border-blue-400 opacity-45'
                      : isHoverDropTarget
                      ? 'border-blue-500 ring-2 ring-blue-500/25'
                      : 'border-zinc-200/95 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                  } ${isEditing ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <div className="flex items-start gap-2.5">
                    {/* Drag Handle */}
                    <span
                      title="拖拽卡片改变状态或调整同组顺序"
                      className="mt-0.5 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-400"
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>

                    {/* Accessible Checkbox Button */}
                    <button
                      type="button"
                      aria-label={task.completed ? '标记为待办' : '标记为已完成'}
                      title={task.completed ? '点击切换为待办 (- [ ])' : '点击切换为已完成 (- [x])'}
                      onClick={() => mutateTaskStatusAndOrder(task.id, !task.completed)}
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                        task.completed
                          ? 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500 dark:border-emerald-500 dark:bg-emerald-500'
                          : 'border-zinc-300 bg-white hover:border-blue-500 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:border-blue-400'
                      }`}
                    >
                      {task.completed && <Check className="h-3 w-3 stroke-[2.75]" />}
                    </button>

                    {/* Task Body */}
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            autoFocus
                            value={editingDraft}
                            onChange={(e) => setEditingDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                handleCommitTaskEdit(task);
                              } else if (e.key === 'Escape') {
                                setEditingTaskId(null);
                              }
                            }}
                            className="w-full rounded border border-blue-500 bg-zinc-50 px-2.5 py-1 text-sm text-zinc-900 focus:outline-none dark:bg-zinc-900 dark:text-zinc-100"
                          />
                          <div className="flex items-center justify-end gap-1.5 text-xs">
                            <button
                              type="button"
                              onClick={() => setEditingTaskId(null)}
                              className="rounded px-2 py-0.5 text-zinc-500 hover:bg-zinc-100 whitespace-nowrap shrink-0 dark:hover:bg-zinc-800"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCommitTaskEdit(task)}
                              className="rounded bg-blue-600 px-2.5 py-0.5 font-medium text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div
                            onDoubleClick={() => {
                              setEditingTaskId(task.id);
                              setEditingDraft(task.rawText);
                            }}
                            className={`text-sm leading-relaxed break-words ${
                              task.completed
                                ? 'text-zinc-500 line-through decoration-zinc-400/80 dark:text-zinc-400'
                                : 'text-zinc-900 dark:text-zinc-100'
                            }`}
                          >
                            {renderInlineNodes(task.rawText, false, searchQuery, wikiContext)}
                          </div>

                          {/* Clean Unboxed Metadata Row + Hover Actions */}
                          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-400 dark:text-zinc-500">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate max-w-[200px]">
                                {task.sectionHeading}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums whitespace-nowrap shrink-0">
                                第 {task.docLineNumber} 行
                              </span>
                              {task.indentLevel > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="whitespace-nowrap shrink-0">
                                    子任务
                                  </span>
                                </>
                              )}
                            </div>

                            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 shrink-0">
                              <button
                                type="button"
                                title="编辑任务内容"
                                onClick={() => {
                                  setEditingTaskId(task.id);
                                  setEditingDraft(task.rawText);
                                }}
                                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="在编辑器中定位该章节"
                                onClick={() =>
                                  onJumpToEditor(
                                    task.sectionHeading !== '文档导言'
                                      ? task.sectionHeading
                                      : undefined
                                  )
                                }
                                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 hover:text-blue-600 whitespace-nowrap shrink-0 dark:hover:bg-zinc-800 dark:hover:text-blue-400"
                              >
                                <span>原文</span>
                                <ArrowUpRight className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                title="从 Markdown 中移除此任务行"
                                onClick={() => handleDeleteTask(task)}
                                className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="mx-auto max-w-[1360px] px-6 py-6">
      {/* Workspace Context & Controls Header */}
      <div className="mb-6 flex flex-col gap-4 border-b border-zinc-200 pb-5 dark:border-zinc-800 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>GPUI 原生任务看板原型</span>
            <span aria-hidden="true">·</span>
            <span>桌面端由 crates/vellum-gpui/src/kanban_board.rs 纯 GPU 渲染（零 WebView）</span>
            <span aria-hidden="true">·</span>
            <span>{saveStatusText}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
              {activeTitle}
            </h1>
            <button
              type="button"
              onClick={() => onJumpToEditor()}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 whitespace-nowrap shrink-0 dark:border-zinc-800 dark:bg-[#111622] dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>返回编辑区</span>
            </button>
            {onInspectRustFile && (
              <button
                type="button"
                onClick={() => onInspectRustFile('crates/vellum-gpui/src/kanban_board.rs')}
                className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50/70 px-2.5 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100/80 whitespace-nowrap shrink-0 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/60"
              >
                <FileCode2 className="h-3.5 w-3.5" />
                <span>检视 GPUI 原生源码 (kanban_board.rs)</span>
              </button>
            )}
          </div>
        </div>

        {/* Metrics & Progress Summary (Unboxed Tabular Figures) */}
        <div className="flex flex-wrap items-center gap-5">
          <div className="flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400">
            <span>
              待办{' '}
              <strong className="font-mono tabular-nums text-zinc-950 dark:text-zinc-100">
                {totalCount - completedCount}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              已完成{' '}
              <strong className="font-mono tabular-nums text-zinc-950 dark:text-zinc-100">
                {completedCount}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              完成率{' '}
              <strong className="font-mono tabular-nums text-zinc-950 dark:text-zinc-100">
                {completionRate}%
              </strong>
            </span>
          </div>

          <svg
            viewBox="0 0 100 4"
            preserveAspectRatio="none"
            aria-label={`任务完成进度 ${completionRate}%`}
            className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          >
            <rect
              x="0"
              y="0"
              width={completionRate}
              height="4"
              rx="2"
              className="fill-emerald-600 transition-all duration-200 dark:fill-emerald-500"
            />
          </svg>
        </div>
      </div>

      {/* Filter Bar: Document Switcher + Section Filter + Search Input */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            <span className="whitespace-nowrap shrink-0">工作区文档</span>
            <select
              value={activeDocId}
              onChange={(e) => {
                setSelectedSection('ALL');
                onSelectDocument(e.target.value);
              }}
              className="max-w-[260px] truncate rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-[#111622] dark:text-zinc-100"
            >
              {documents.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.title}
                </option>
              ))}
            </select>
          </label>

          {availableSections.length > 1 && (
            <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/90">
              <button
                type="button"
                onClick={() => setSelectedSection('ALL')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  selectedSection === 'ALL'
                    ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                全部章节
              </button>
              {availableSections.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setSelectedSection(sec)}
                  className={`max-w-[180px] truncate rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    selectedSection === sec
                      ? 'bg-white text-zinc-950 shadow-xs dark:bg-zinc-900 dark:text-white'
                      : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  {sec}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="筛选任务关键字或章节…"
            className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-8 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-[#111622] dark:text-zinc-100"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Empty Document Task State vs Two-Column Kanban Board */}
      {totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-200 bg-white px-6 py-16 text-center dark:border-zinc-800 dark:bg-[#111622]">
          <CheckCircle2 className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
          <h2 className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            当前文档尚未包含 Markdown 任务列表（`- [ ]` / `- [x]`）
          </h2>
          <p className="mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            看板会自动扫描当前文档中的 GFM Checkbox 语法并映射为「待办」与「已完成」两栏。你可以直接初始化示例任务组，或切换到其他包含任务清单的笔记。
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleSeedStarterChecklist}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 whitespace-nowrap shrink-0 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>插入示例 Checkbox 任务列表</span>
            </button>
            <button
              type="button"
              onClick={() => onJumpToEditor()}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 whitespace-nowrap shrink-0 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              在编辑器中手动输入
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 items-start">
          {renderColumn('todo')}
          {renderColumn('done')}
        </div>
      )}
    </div>
  );
};
