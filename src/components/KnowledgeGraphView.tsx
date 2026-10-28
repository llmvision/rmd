import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  FilePlus2,
  FileText,
  RefreshCw,
  RotateCcw,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

export interface GraphNodeItem {
  id: string;
  title: string;
  resolved: boolean;
  inDegree: number;
  outDegree: number;
  wordCount: number;
  headings: string[];
}

export interface GraphEdgeItem {
  sourceId: string;
  sourceTitle: string;
  targetId: string;
  targetTitle: string;
  kind: 'wikilink' | 'embed';
  headingAnchor?: string;
  contextExcerpt: string;
}

interface GraphApiResponse {
  nodes: GraphNodeItem[];
  edges: GraphEdgeItem[];
  resolvedDocCount: number;
  unresolvedNodeCount: number;
  totalConnections: number;
}

interface KnowledgeGraphViewProps {
  activeDocId: string;
  onOpenDocument: (docId: string, heading?: string) => void;
  onCreatePhantomDocument: (title: string) => void;
}

const CANVAS_W = 960;
const CANVAS_H = 620;

function computeForceDirectedPositions(
  nodes: GraphNodeItem[],
  edges: GraphEdgeItem[],
  seedSalt = 0
): Record<string, { x: number; y: number }> {
  const n = nodes.length;
  if (n === 0) return {};

  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;
  const pos: Array<{ x: number; y: number }> = nodes.map((_, i) => {
    const angle = ((i + seedSalt * 0.37) / Math.max(1, n)) * Math.PI * 2;
    const ringRadius = n <= 3 ? 130 : 195;
    return {
      x: cx + Math.cos(angle) * ringRadius,
      y: cy + Math.sin(angle) * (ringRadius * 0.78),
    };
  });

  const idxById = new Map<string, number>();
  nodes.forEach((node, idx) => idxById.set(node.id, idx));

  for (let iter = 0; iter < 85; iter++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    const temp = Math.max(3.5, 26 * (1 - iter / 90));

    // Repulsion between all node pairs
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const distSq = Math.max(140, dx * dx + dy * dy);
        const dist = Math.sqrt(distSq);
        const force = 26000 / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    // Spring attraction along bidirectional / embed edges
    for (const edge of edges) {
      const u = idxById.get(edge.sourceId);
      const v = idxById.get(edge.targetId);
      if (u === undefined || v === undefined || u === v) continue;
      const dx = pos[v].x - pos[u].x;
      const dy = pos[v].y - pos[u].y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const idealLen = edge.kind === 'embed' ? 165 : 210;
      const pull = (dist - idealLen) * 0.065;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      disp[u].x += fx;
      disp[u].y += fy;
      disp[v].x -= fx;
      disp[v].y -= fy;
    }

    // Gentle center gravity + viewport bounds
    for (let i = 0; i < n; i++) {
      const gx = (cx - pos[i].x) * 0.028;
      const gy = (cy - pos[i].y) * 0.032;
      const vx = Math.max(-temp, Math.min(temp, disp[i].x + gx));
      const vy = Math.max(-temp, Math.min(temp, disp[i].y + gy));
      pos[i].x = Math.max(95, Math.min(CANVAS_W - 95, pos[i].x + vx));
      pos[i].y = Math.max(68, Math.min(CANVAS_H - 68, pos[i].y + vy));
    }
  }

  const out: Record<string, { x: number; y: number }> = {};
  nodes.forEach((node, idx) => {
    out[node.id] = pos[idx];
  });
  return out;
}

export const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({
  activeDocId,
  onOpenDocument,
  onCreatePhantomDocument,
}) => {
  const [graphData, setGraphData] = useState<GraphApiResponse>({
    nodes: [],
    edges: [],
    resolvedDocCount: 0,
    unresolvedNodeCount: 0,
    totalConnections: 0,
  });
  const [loading, setLoading] = useState(true);
  const [filterKind, setFilterKind] = useState<'all' | 'resolved' | 'unresolved'>('all');
  const [showEmbedEdges, setShowEmbedEdges] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string>(activeDocId);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [layoutSeed, setLayoutSeed] = useState(0);

  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/graph');
      if (res.ok) {
        const data = (await res.json()) as GraphApiResponse;
        setGraphData(data);
        setPositions(computeForceDirectedPositions(data.nodes, data.edges, 0));
        setSelectedNodeId((prev) =>
          data.nodes.some((n) => n.id === prev)
            ? prev
            : data.nodes.some((n) => n.id === activeDocId)
            ? activeDocId
            : data.nodes[0]?.id || ''
        );
      }
    } finally {
      setLoading(false);
    }
  }, [activeDocId]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const relayoutGraph = () => {
    const nextSeed = layoutSeed + 1;
    setLayoutSeed(nextSeed);
    setPositions(computeForceDirectedPositions(graphData.nodes, graphData.edges, nextSeed));
  };

  const visibleNodes = useMemo(() => {
    return graphData.nodes.filter((n) => {
      if (filterKind === 'resolved' && !n.resolved) return false;
      if (filterKind === 'unresolved' && n.resolved) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchTitle = n.title.toLowerCase().includes(q);
        const matchHeading = n.headings.some((h) => h.toLowerCase().includes(q));
        if (!matchTitle && !matchHeading) return false;
      }
      return true;
    });
  }, [graphData.nodes, filterKind, searchQuery]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    return graphData.edges.filter((e) => {
      if (!showEmbedEdges && e.kind === 'embed') return false;
      return visibleNodeIds.has(e.sourceId) && visibleNodeIds.has(e.targetId);
    });
  }, [graphData.edges, showEmbedEdges, visibleNodeIds]);

  const focusAnchorId = hoveredNodeId || null;

  const connectedToFocus = useMemo(() => {
    if (!focusAnchorId) return null;
    const set = new Set<string>([focusAnchorId]);
    for (const e of visibleEdges) {
      if (e.sourceId === focusAnchorId) set.add(e.targetId);
      if (e.targetId === focusAnchorId) set.add(e.sourceId);
    }
    return set;
  }, [focusAnchorId, visibleEdges]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((n) => n.id === selectedNodeId) || visibleNodes[0] || null,
    [graphData.nodes, selectedNodeId, visibleNodes]
  );

  const selectedIncoming = useMemo(
    () =>
      selectedNode
        ? graphData.edges.filter((e) => e.targetId === selectedNode.id)
        : [],
    [graphData.edges, selectedNode]
  );

  const selectedOutgoing = useMemo(
    () =>
      selectedNode
        ? graphData.edges.filter((e) => e.sourceId === selectedNode.id)
        : [],
    [graphData.edges, selectedNode]
  );

  // Convert pointer position into SVG viewBox coordinates for smooth node dragging
  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingNodeId || !svgRef.current) return;
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const transformed = pt.matrixTransform(ctm.inverse());
    const clampedX = Math.max(60, Math.min(CANVAS_W - 60, transformed.x));
    const clampedY = Math.max(48, Math.min(CANVAS_H - 48, transformed.y));
    setPositions((prev) => ({
      ...prev,
      [draggingNodeId]: { x: clampedX, y: clampedY },
    }));
  };

  // Zoomed SVG viewBox calculation centered on canvas midpoint
  const viewW = CANVAS_W / zoom;
  const viewH = CANVAS_H / zoom;
  const viewX = (CANVAS_W - viewW) / 2;
  const viewY = (CANVAS_H - viewH) / 2;

  return (
    <div className="flex h-[calc(100vh-57px)] flex-col overflow-hidden bg-[#FAFAFA] text-zinc-900 dark:bg-[#0B0F17] dark:text-zinc-100">
      {/* Top Filter & Graph Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200/90 bg-white px-6 py-2.5 dark:border-zinc-800 dark:bg-[#111622]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文档或章节节点…"
              className="w-44 bg-transparent outline-none placeholder:text-zinc-400"
            />
          </div>

          {/* Interactive Filter Segmented Control */}
          <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 text-xs dark:bg-zinc-800/90">
            {(
              [
                ['all', '全部节点'],
                ['resolved', '已建文档'],
                ['unresolved', '待建悬空节点'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilterKind(id)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
                  filterKind === id
                    ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-900 dark:text-white'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowEmbedEdges((v) => !v)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              showEmbedEdges
                ? 'border-blue-200 bg-blue-50/70 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400'
            }`}
          >
            包含嵌入引用边
          </button>
        </div>

        {/* Quiet Unboxed Graph Metrics + Layout Controls */}
        <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <div className="hidden items-center gap-2 tabular-nums xl:flex">
            <span>{graphData.resolvedDocCount} 篇已建文档</span>
            <span aria-hidden="true">·</span>
            <span>{graphData.unresolvedNodeCount} 个待建节点</span>
            <span aria-hidden="true">·</span>
            <span>{graphData.totalConnections} 条连接关系</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              title="缩小画布"
              onClick={() => setZoom((z) => Math.max(0.65, Number((z - 0.15).toFixed(2))))}
              className="rounded-md p-1.5 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="rounded px-1.5 py-1 font-mono text-[11px] tabular-nums hover:bg-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              title="放大画布"
              onClick={() => setZoom((z) => Math.min(1.75, Number((z + 0.15).toFixed(2))))}
              className="rounded-md p-1.5 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="重新执行力导向排布"
              onClick={relayoutGraph}
              className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>重排</span>
            </button>
            <button
              type="button"
              title="从本地磁盘重新扫描双链索引"
              onClick={fetchGraph}
              className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>刷新</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Split: Interactive Force-Directed SVG Canvas + Node Relationship Inspector */}
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="relative flex-1 overflow-hidden bg-[#FAFAFA] dark:bg-[#0B0F17]">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-400">
              正在构建本地 Markdown 双向链接拓扑…
            </div>
          ) : visibleNodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                当前筛选条件下暂无匹配的图谱节点
              </p>
              <button
                type="button"
                onClick={() => {
                  setFilterKind('all');
                  setSearchQuery('');
                }}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 whitespace-nowrap shrink-0"
              >
                重置筛选条件
              </button>
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`${viewX} ${viewY} ${viewW} ${viewH}`}
              onPointerMove={handleSvgPointerMove}
              onPointerUp={() => setDraggingNodeId(null)}
              onPointerLeave={() => setDraggingNodeId(null)}
              className="h-full w-full select-none"
              role="img"
              aria-label="双向链接知识网络图谱"
            >
              <defs>
                <marker
                  id="kg-arrow-wiki"
                  viewBox="0 0 10 10"
                  refX="22"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.5 L 9 5 L 0 8.5 z" className="fill-zinc-400 dark:fill-zinc-500" />
                </marker>
                <marker
                  id="kg-arrow-active"
                  viewBox="0 0 10 10"
                  refX="22"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.5 L 9 5 L 0 8.5 z" className="fill-blue-600 dark:fill-blue-400" />
                </marker>
              </defs>

              {/* Edges */}
              {visibleEdges.map((edge, idx) => {
                const src = positions[edge.sourceId];
                const dst = positions[edge.targetId];
                if (!src || !dst) return null;

                const isHighlighted =
                  focusAnchorId === edge.sourceId ||
                  focusAnchorId === edge.targetId ||
                  (!focusAnchorId &&
                    (selectedNode?.id === edge.sourceId || selectedNode?.id === edge.targetId));
                const isDimmed =
                  connectedToFocus !== null &&
                  !(connectedToFocus.has(edge.sourceId) && connectedToFocus.has(edge.targetId));

                return (
                  <g
                    key={`${edge.sourceId}-${edge.targetId}-${idx}`}
                    className={isDimmed ? 'opacity-20 transition-opacity duration-150' : 'transition-opacity duration-150'}
                  >
                    <line
                      x1={src.x}
                      y1={src.y}
                      x2={dst.x}
                      y2={dst.y}
                      strokeWidth={isHighlighted ? 2 : 1.35}
                      strokeDasharray={edge.kind === 'embed' ? '5 4' : undefined}
                      markerEnd={isHighlighted ? 'url(#kg-arrow-active)' : 'url(#kg-arrow-wiki)'}
                      className={
                        isHighlighted
                          ? 'stroke-blue-600 dark:stroke-blue-400'
                          : 'stroke-zinc-300 dark:stroke-zinc-700'
                      }
                    />
                    {isHighlighted && edge.headingAnchor && (
                      <text
                        x={(src.x + dst.x) / 2}
                        y={(src.y + dst.y) / 2 - 6}
                        textAnchor="middle"
                        className="fill-blue-700 text-[10px] font-medium dark:fill-blue-300"
                      >
                        § {edge.headingAnchor.slice(0, 16)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Nodes */}
              {visibleNodes.map((node) => {
                const p = positions[node.id] || { x: CANVAS_W / 2, y: CANVAS_H / 2 };
                const degree = node.inDegree + node.outDegree;
                const radius = Math.min(22, 11 + degree * 2.1);
                const isSelected = selectedNode?.id === node.id;
                const isCurrentEditorDoc = node.id === activeDocId;
                const isDimmed = connectedToFocus !== null && !connectedToFocus.has(node.id);

                return (
                  <g
                    key={node.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedNodeId(node.id);
                      setDraggingNodeId(node.id);
                    }}
                    onDoubleClick={() => {
                      if (node.resolved) {
                        onOpenDocument(node.id);
                      } else {
                        onCreatePhantomDocument(node.title);
                      }
                    }}
                    onPointerEnter={() => setHoveredNodeId(node.id)}
                    onPointerLeave={() => setHoveredNodeId(null)}
                    className={`cursor-grab active:cursor-grabbing transition-opacity duration-150 ${
                      isDimmed ? 'opacity-25' : 'opacity-100'
                    }`}
                  >
                    {isSelected && (
                      <circle
                        r={radius + 6}
                        className="fill-blue-500/15 stroke-blue-500/40 dark:fill-blue-400/15 dark:stroke-blue-400/40"
                        strokeWidth={1.25}
                      />
                    )}
                    <circle
                      r={radius}
                      strokeWidth={isSelected || isCurrentEditorDoc ? 2.25 : 1.5}
                      strokeDasharray={node.resolved ? undefined : '3.5 2.5'}
                      className={
                        !node.resolved
                          ? 'fill-amber-50 stroke-amber-500 dark:fill-amber-950/70 dark:stroke-amber-400'
                          : isSelected
                          ? 'fill-blue-600 stroke-blue-700 dark:fill-blue-500 dark:stroke-blue-300'
                          : isCurrentEditorDoc
                          ? 'fill-zinc-900 stroke-blue-600 dark:fill-white dark:stroke-blue-400'
                          : 'fill-white stroke-zinc-400 hover:stroke-blue-600 dark:fill-zinc-900 dark:stroke-zinc-500'
                      }
                    />
                    <text
                      y={4}
                      textAnchor="middle"
                      className={`font-mono text-[10px] font-semibold tabular-nums ${
                        isSelected && node.resolved
                          ? 'fill-white'
                          : isCurrentEditorDoc && node.resolved
                          ? 'fill-white dark:fill-zinc-900'
                          : !node.resolved
                          ? 'fill-amber-800 dark:fill-amber-200'
                          : 'fill-zinc-700 dark:fill-zinc-200'
                      }`}
                    >
                      {node.inDegree}
                    </text>
                    <text
                      y={radius + 17}
                      textAnchor="middle"
                      className={`text-[12px] ${
                        isSelected
                          ? 'fill-blue-700 font-semibold dark:fill-blue-300'
                          : !node.resolved
                          ? 'fill-amber-800 dark:fill-amber-300'
                          : 'fill-zinc-800 font-medium dark:fill-zinc-200'
                      }`}
                    >
                      {node.title.length > 20 ? `${node.title.slice(0, 19)}…` : node.title}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}

          {/* Subtle Legend in Bottom-Left */}
          <div className="pointer-events-none absolute bottom-4 left-5 flex flex-wrap items-center gap-4 rounded-lg border border-zinc-200/80 bg-white/90 px-3.5 py-2 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-[#111622]/90 dark:text-zinc-400">
            <span>实线圆：已建本地文档（圆心数字为被引用次数）</span>
            <span aria-hidden="true">·</span>
            <span>虚线圆：待创建的悬空引用节点</span>
            <span aria-hidden="true">·</span>
            <span>虚线边：![[跨文档内容嵌入]] · 支持拖拽节点与双击直达</span>
          </div>
        </div>

        {/* Right Column: Selected Node Relationship Inspector */}
        <aside className="flex w-full shrink-0 flex-col border-t border-zinc-200/90 bg-white lg:w-96 lg:border-l lg:border-t-0 dark:border-zinc-800 dark:bg-[#111622]">
          {selectedNode ? (
            <div className="flex h-full flex-col overflow-hidden">
              <div className="border-b border-zinc-200/80 p-5 dark:border-zinc-800">
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  {selectedNode.resolved ? '已建本地 Markdown 文档' : '尚未创建的悬空知识节点'}
                </div>
                <h2 className="mt-1 text-base font-bold leading-snug text-zinc-950 dark:text-zinc-50">
                  {selectedNode.title}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                  <span>被引用 {selectedNode.inDegree} 次</span>
                  <span aria-hidden="true">·</span>
                  <span>向外引用 {selectedNode.outDegree} 处</span>
                  {selectedNode.resolved && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{selectedNode.wordCount.toLocaleString()} 字</span>
                    </>
                  )}
                </div>

                <div className="mt-4">
                  {selectedNode.resolved ? (
                    <button
                      type="button"
                      onClick={() => onOpenDocument(selectedNode.id)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-blue-600 dark:hover:bg-blue-500 whitespace-nowrap shrink-0"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>在即时渲染编辑器中打开</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onCreatePhantomDocument(selectedNode.title)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-amber-700 whitespace-nowrap shrink-0"
                    >
                      <FilePlus2 className="h-3.5 w-3.5" />
                      <span>创建《{selectedNode.title}》并激活节点</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 space-y-6 overflow-y-auto p-5 text-xs">
                {/* Incoming Backlinks */}
                <section>
                  <div className="mb-2.5 flex items-center justify-between">
                    <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                      反向链接 · 谁引用了它
                    </h3>
                    <span className="font-mono text-zinc-400 tabular-nums">
                      {selectedIncoming.length}
                    </span>
                  </div>
                  {selectedIncoming.length === 0 ? (
                    <p className="text-zinc-400">
                      暂无其他文档引用此节点。可在任意笔记中输入{' '}
                      <code className="font-mono">[[{selectedNode.title}]]</code> 建立连接。
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {selectedIncoming.map((inc, idx) => (
                        <div
                          key={`${inc.sourceId}-${idx}`}
                          className="rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenDocument(inc.sourceId)}
                              className="flex min-w-0 items-center gap-1 font-semibold text-blue-600 hover:underline dark:text-blue-400"
                            >
                              <span className="truncate">{inc.sourceTitle}</span>
                              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                            </button>
                            <span className="shrink-0 text-[11px] text-zinc-400">
                              {inc.kind === 'embed' ? '内容嵌入' : '双向链接'}
                            </span>
                          </div>
                          {inc.headingAnchor && (
                            <div className="mt-1 text-[11px] text-zinc-500">
                              定位章节：§ {inc.headingAnchor}
                            </div>
                          )}
                          <p className="mt-1.5 line-clamp-2 leading-relaxed text-zinc-600 dark:text-zinc-300">
                            {inc.contextExcerpt}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Outgoing Links */}
                <section>
                  <div className="mb-2.5 flex items-center justify-between">
                    <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                      正向引用 · 它指向了谁
                    </h3>
                    <span className="font-mono text-zinc-400 tabular-nums">
                      {selectedOutgoing.length}
                    </span>
                  </div>
                  {selectedOutgoing.length === 0 ? (
                    <p className="text-zinc-400">此节点尚未向外引用其他文档。</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedOutgoing.map((out, idx) => {
                        const targetNode = graphData.nodes.find((n) => n.id === out.targetId);
                        return (
                          <div
                            key={`${out.targetId}-${idx}`}
                            onClick={() => setSelectedNodeId(out.targetId)}
                            className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-200/80 px-3 py-2 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/70"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                                {out.targetTitle}
                              </div>
                              <div className="mt-0.5 text-[11px] text-zinc-400">
                                {out.kind === 'embed' ? '![[内容嵌入]]' : '[[双向链接]]'}
                                {out.headingAnchor ? ` · § ${out.headingAnchor}` : ''}
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              {targetNode?.resolved ? '定位节点' : '待创建'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Section Outline Quick Jump */}
                {selectedNode.resolved && selectedNode.headings.length > 0 && (
                  <section>
                    <div className="mb-2 font-semibold text-zinc-900 dark:text-zinc-100">
                      可被引用的章节锚点 (#)
                    </div>
                    <div className="space-y-1">
                      {selectedNode.headings.slice(0, 8).map((h, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => onOpenDocument(selectedNode.id, h)}
                          className="block w-full truncate rounded px-2 py-1 text-left text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          § {h}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
};
