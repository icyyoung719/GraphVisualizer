import * as d3 from "d3";

import {
  CONTRACT_VERSION,
  PlaybackControlAction,
  WebviewToHostMessage,
  isHostToWebviewMessage,
} from "../src/protocol/contracts";
import {
  EdgeRecord,
  GraphDataFile,
  GraphEvent,
  GraphSnapshot,
  NodeRecord,
  applyEventToGraph,
  cloneGraphSnapshot,
  getEventTargetId,
} from "../src/protocol/events";

interface VsCodeApi<T> {
  postMessage(message: unknown): void;
  setState(state: T): void;
  getState(): T | undefined;
}

declare function acquireVsCodeApi<T = unknown>(): VsCodeApi<T>;

type SelectedKind = "node" | "edge" | "aggregate";

interface VisibleNodeDatum extends NodeRecord {
  isAggregate: boolean;
  memberNodeIds: string[];
}

interface VisibleEdgeDatum extends EdgeRecord {
  memberEdgeIds: string[];
}

interface AggregateGroup {
  id: string;
  groupKey: string;
  label: string;
  memberNodeIds: string[];
  representativeLayer: string;
  collapsed: boolean;
  centroidX: number;
  centroidY: number;
}

interface AggregationResult {
  nodes: VisibleNodeDatum[];
  edges: VisibleEdgeDatum[];
  nodeIdToVisibleId: Map<string, string>;
  nodeIdToCollapsedAggregateId: Map<string, string>;
  aggregatesById: Map<string, AggregateGroup>;
}

interface RuntimeState {
  baseGraph: GraphSnapshot | undefined;
  workingGraph: GraphSnapshot | undefined;
  events: GraphEvent[];
  appliedEvents: GraphEvent[];
  eventCursor: number;
  selectedId: string | undefined;
  selectedKind: SelectedKind | undefined;
  playbackStatus: "playing" | "paused";
  expandedAggregateIds: Set<string>;
  transientExpandedAggregateIds: Set<string>;
  transientAggregateCollapseTimer: number | undefined;
  latestAggregation: AggregationResult | undefined;
}

const NODE_RADIUS = 20;
const AGGREGATE_NODE_RADIUS = 27;
const EDGE_PADDING = NODE_RADIUS + 4;
const EDGE_CURVE_BASE = 16;
const EDGE_CURVE_STEP = 9;
const EDGE_CURVE_MAX = 68;
const EDGE_LABEL_BASE_OFFSET = 14;
const EDGE_LABEL_STRAIGHT_OFFSET = 12;
const TRANSIENT_AGGREGATE_REAPPEAR_DELAY_MS = 220;
const AGGREGATION_MIN_TOTAL_NODES = 20;
const AGGREGATION_MIN_GROUP_SIZE = 4;
const AGGREGATION_RECENT_EVENT_WINDOW = 8;

interface EdgePathGeometry {
  path: string;
  midX: number;
  midY: number;
  labelX: number;
  labelY: number;
  isStraight: boolean;
}

const vscodeApi = acquireVsCodeApi<{ selectedId?: string; selectedKind?: SelectedKind }>();

const runtimeState: RuntimeState = {
  baseGraph: undefined,
  expandedAggregateIds: new Set<string>(),
  transientExpandedAggregateIds: new Set<string>(),
  transientAggregateCollapseTimer: undefined,
  latestAggregation: undefined,
  workingGraph: undefined,
  events: [],
  appliedEvents: [],
  eventCursor: 0,
  selectedId: undefined,
  selectedKind: undefined,
  playbackStatus: "paused",
};

const graphPaneElement = getRequiredElement<HTMLElement>("graph-pane");
const svgElement = getRequiredElement<SVGSVGElement>("graph-svg");
const detailsElement = getRequiredElement<HTMLElement>("details-json");
const eventLogElement = getRequiredElement<HTMLElement>("event-log");
const searchInputElement = getRequiredElement<HTMLInputElement>("search-input");
const focusButtonElement = getRequiredElement<HTMLButtonElement>("focus-button");
const statusTextElement = getRequiredElement<HTMLElement>("status-text");
const playbackSpeedInputElement = getRequiredElement<HTMLInputElement>("playback-speed");
const playbackSpeedLabelElement = getRequiredElement<HTMLElement>("playback-speed-label");
const playbackButtonElements = {
  play: getRequiredElement<HTMLButtonElement>("playback-play"),
  pause: getRequiredElement<HTMLButtonElement>("playback-pause"),
  step: getRequiredElement<HTMLButtonElement>("playback-step"),
  reset: getRequiredElement<HTMLButtonElement>("playback-reset"),
};

const EDGE_TRANSITION_MS = 240;
const NODE_TRANSITION_MS = 260;
const GRAPH_VIEWBOX_PADDING = 72;

const svgSelection = d3.select<SVGSVGElement, unknown>(svgElement);
const viewportGroup = svgSelection.append("g").attr("class", "viewport");
const edgeLayer = viewportGroup.append("g").attr("class", "edges");
const nodeLayer = viewportGroup.append("g").attr("class", "nodes");

const zoomBehavior = d3
  .zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.2, 4])
  .on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
    viewportGroup.attr("transform", event.transform.toString());
  });

svgSelection.call(zoomBehavior);

function getRequiredElement<TElement extends Element>(id: string): TElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element with id \"${id}\".`);
  }
  return element as unknown as TElement;
}

function resizeGraphSurface(): void {
  const { width, height } = graphPaneElement.getBoundingClientRect();
  svgSelection.attr("width", Math.max(320, width)).attr("height", Math.max(320, height));
}

function fitGraphViewBox(nodes: NodeRecord[]): void {
  if (nodes.length === 0) {
    return;
  }

  const bounds = nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.x),
      minY: Math.min(accumulator.minY, node.y),
      maxX: Math.max(accumulator.maxX, node.x),
      maxY: Math.max(accumulator.maxY, node.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );

  const x = bounds.minX - GRAPH_VIEWBOX_PADDING;
  const y = bounds.minY - GRAPH_VIEWBOX_PADDING;
  const width = Math.max(1, bounds.maxX - bounds.minX + GRAPH_VIEWBOX_PADDING * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + GRAPH_VIEWBOX_PADDING * 2);

  svgSelection.attr("viewBox", `${x} ${y} ${width} ${height}`);
}

function setStatus(text: string, isError = false): void {
  statusTextElement.textContent = text;
  statusTextElement.classList.toggle("error", isError);
}

function findNodeById(id: string): NodeRecord | undefined {
  return runtimeState.workingGraph?.nodes.find((node) => node.id === id);
}

function findEdgeById(id: string): EdgeRecord | undefined {
  return runtimeState.workingGraph?.edges.find((edge) => edge.id === id);
}

function getNodeLayerValue(node: NodeRecord): string {
  const layer = node.properties?.layer;
  if (typeof layer === "number" || typeof layer === "string") {
    return String(layer);
  }

  return `x-${Math.round(node.x / 220)}`;
}

function getNodeGroupingKey(node: NodeRecord): string {
  const layer = getNodeLayerValue(node);
  const role =
    typeof node.properties?.role === "string" ? node.properties.role : "default";
  return `${layer}|${role}`;
}

function resolveEdgeById(edgeId: string, snapshot: GraphSnapshot): EdgeRecord | undefined {
  const inWorking = snapshot.edges.find((edge) => edge.id === edgeId);
  if (inWorking) {
    return inWorking;
  }

  const inBase = runtimeState.baseGraph?.edges.find((edge) => edge.id === edgeId);
  if (inBase) {
    return inBase;
  }

  const createEvent = runtimeState.events.find(
    (event) => event.eventType === "edge_create" && event.edge.id === edgeId,
  );
  if (createEvent && createEvent.eventType === "edge_create") {
    return createEvent.edge;
  }

  return undefined;
}

function getEventRelatedNodeIds(event: GraphEvent, snapshot: GraphSnapshot): string[] {
  switch (event.eventType) {
    case "node_create":
      return [event.node.id];
    case "edge_create":
      return [event.edge.source, event.edge.target];
    case "edge_update":
    case "edge_delete": {
      const edge = resolveEdgeById(event.id, snapshot);
      return edge ? [edge.source, edge.target] : [];
    }
  }
}

function getInterestingNodeIds(snapshot: GraphSnapshot): Set<string> {
  const interestingIds = new Set<string>();

  if (runtimeState.selectedId && runtimeState.selectedKind === "node") {
    interestingIds.add(runtimeState.selectedId);
  }

  if (runtimeState.selectedId && runtimeState.selectedKind === "edge") {
    const selectedEdge = resolveEdgeById(runtimeState.selectedId, snapshot);
    if (selectedEdge) {
      interestingIds.add(selectedEdge.source);
      interestingIds.add(selectedEdge.target);
    }
  }

  const recentEvents = runtimeState.appliedEvents.slice(-AGGREGATION_RECENT_EVENT_WINDOW);
  recentEvents.forEach((event) => {
    getEventRelatedNodeIds(event, snapshot).forEach((nodeId) => interestingIds.add(nodeId));
  });

  snapshot.nodes.forEach((node) => {
    const role = node.properties?.role;
    if (role === "source" || role === "target") {
      interestingIds.add(node.id);
    }
  });

  return interestingIds;
}

function createIdentityAggregation(snapshot: GraphSnapshot): AggregationResult {
  const nodes: VisibleNodeDatum[] = snapshot.nodes.map((node) => ({
    ...node,
    isAggregate: false,
    memberNodeIds: [node.id],
  }));

  const edges: VisibleEdgeDatum[] = snapshot.edges.map((edge) => ({
    ...edge,
    memberEdgeIds: [edge.id],
  }));

  const nodeIdToVisibleId = new Map<string, string>();
  snapshot.nodes.forEach((node) => {
    nodeIdToVisibleId.set(node.id, node.id);
  });

  return {
    nodes,
    edges,
    nodeIdToVisibleId,
    nodeIdToCollapsedAggregateId: new Map<string, string>(),
    aggregatesById: new Map<string, AggregateGroup>(),
  };
}

function deriveAggregation(snapshot: GraphSnapshot): AggregationResult {
  if (snapshot.nodes.length < AGGREGATION_MIN_TOTAL_NODES) {
    return createIdentityAggregation(snapshot);
  }

  const interestingNodeIds = getInterestingNodeIds(snapshot);
  const groupedCandidates = new Map<string, NodeRecord[]>();

  snapshot.nodes.forEach((node) => {
    if (interestingNodeIds.has(node.id)) {
      return;
    }

    const groupKey = getNodeGroupingKey(node);
    const group = groupedCandidates.get(groupKey) ?? [];
    group.push(node);
    groupedCandidates.set(groupKey, group);
  });

  const aggregatesById = new Map<string, AggregateGroup>();
  groupedCandidates.forEach((members, groupKey) => {
    if (members.length < AGGREGATION_MIN_GROUP_SIZE) {
      return;
    }

    const aggregateId = `agg:${groupKey}`;
    const centroidX =
      members.reduce((sum, node) => sum + node.x, 0) / Math.max(1, members.length);
    const centroidY =
      members.reduce((sum, node) => sum + node.y, 0) / Math.max(1, members.length);
    const representativeLayer = getNodeLayerValue(members[0]);

    aggregatesById.set(aggregateId, {
      id: aggregateId,
      groupKey,
      label: `L${representativeLayer} (${members.length})`,
      memberNodeIds: members.map((member) => member.id),
      representativeLayer,
      collapsed: !runtimeState.expandedAggregateIds.has(aggregateId),
      centroidX,
      centroidY,
    });
  });

  if (aggregatesById.size === 0) {
    return createIdentityAggregation(snapshot);
  }

  const nodeIdToVisibleId = new Map<string, string>();
  const nodeIdToCollapsedAggregateId = new Map<string, string>();

  aggregatesById.forEach((group) => {
    if (!group.collapsed) {
      group.memberNodeIds.forEach((memberNodeId) => {
        nodeIdToVisibleId.set(memberNodeId, memberNodeId);
      });
      return;
    }

    group.memberNodeIds.forEach((memberNodeId) => {
      nodeIdToVisibleId.set(memberNodeId, group.id);
      nodeIdToCollapsedAggregateId.set(memberNodeId, group.id);
    });
  });

  const hiddenNodeIds = new Set<string>(nodeIdToCollapsedAggregateId.keys());
  const visibleNodes: VisibleNodeDatum[] = [];

  snapshot.nodes.forEach((node) => {
    if (hiddenNodeIds.has(node.id)) {
      return;
    }

    visibleNodes.push({
      ...node,
      isAggregate: false,
      memberNodeIds: [node.id],
    });
    if (!nodeIdToVisibleId.has(node.id)) {
      nodeIdToVisibleId.set(node.id, node.id);
    }
  });

  aggregatesById.forEach((group) => {
    if (!group.collapsed) {
      return;
    }

    visibleNodes.push({
      id: group.id,
      label: group.label,
      x: group.centroidX,
      y: group.centroidY,
      properties: {
        aggregate: true,
        memberCount: group.memberNodeIds.length,
        layer: group.representativeLayer,
      },
      isAggregate: true,
      memberNodeIds: [...group.memberNodeIds],
    });
  });

  const edgeBuckets = new Map<string, { source: string; target: string; rawEdges: EdgeRecord[] }>();

  snapshot.edges.forEach((edge) => {
    const mappedSource = nodeIdToVisibleId.get(edge.source) ?? edge.source;
    const mappedTarget = nodeIdToVisibleId.get(edge.target) ?? edge.target;

    if (mappedSource === mappedTarget) {
      return;
    }

    const bucketId = `${mappedSource}->${mappedTarget}`;
    const bucket = edgeBuckets.get(bucketId) ?? {
      source: mappedSource,
      target: mappedTarget,
      rawEdges: [],
    };
    bucket.rawEdges.push(edge);
    edgeBuckets.set(bucketId, bucket);
  });

  const visibleEdges: VisibleEdgeDatum[] = [];
  edgeBuckets.forEach((bucket, bucketId) => {
    const memberEdgeIds = bucket.rawEdges.map((edge) => edge.id);
    const firstEdge = bucket.rawEdges[0];
    const edgeCount = bucket.rawEdges.length;
    const averageWeight =
      bucket.rawEdges
        .map((edge) => edge.weight)
        .filter((weight): weight is number => typeof weight === "number")
        .reduce((sum, weight) => sum + weight, 0) /
      Math.max(1, bucket.rawEdges.filter((edge) => typeof edge.weight === "number").length);

    visibleEdges.push({
      id: edgeCount === 1 ? firstEdge.id : `agg-edge:${bucketId}`,
      source: bucket.source,
      target: bucket.target,
      label: edgeCount > 1 ? `${edgeCount} edges` : firstEdge.label,
      weight: Number.isFinite(averageWeight) ? averageWeight : firstEdge.weight,
      properties:
        edgeCount > 1
          ? {
              aggregate: true,
              edgeCount,
            }
          : firstEdge.properties,
      memberEdgeIds,
    });
  });

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    nodeIdToVisibleId,
    nodeIdToCollapsedAggregateId,
    aggregatesById,
  };
}

function ensureExpandedForNode(nodeId: string, isTransient = false): boolean {
  const graph = runtimeState.workingGraph;
  if (!graph) {
    return false;
  }

  const aggregation = deriveAggregation(graph);
  const aggregateId = aggregation.nodeIdToCollapsedAggregateId.get(nodeId);
  if (!aggregateId) {
    return false;
  }

  runtimeState.expandedAggregateIds.add(aggregateId);
  if (isTransient) {
    runtimeState.transientExpandedAggregateIds.add(aggregateId);
  }
  return true;
}

function expandAggregate(aggregateId: string): void {
  runtimeState.expandedAggregateIds.add(aggregateId);
  runtimeState.transientExpandedAggregateIds.delete(aggregateId);
}

function clearTransientAggregateCollapseTimer(): void {
  if (runtimeState.transientAggregateCollapseTimer !== undefined) {
    window.clearTimeout(runtimeState.transientAggregateCollapseTimer);
    runtimeState.transientAggregateCollapseTimer = undefined;
  }
}

function scheduleTransientAggregateCollapse(): void {
  if (runtimeState.transientExpandedAggregateIds.size === 0) {
    return;
  }

  clearTransientAggregateCollapseTimer();
  runtimeState.transientAggregateCollapseTimer = window.setTimeout(() => {
    runtimeState.transientAggregateCollapseTimer = undefined;

    const graph = runtimeState.workingGraph;
    if (!graph) {
      return;
    }

    const keepExpandedAggregateIds = new Set<string>();
    const aggregation = runtimeState.latestAggregation ?? deriveAggregation(graph);
    const selectedId = runtimeState.selectedId;

    if (runtimeState.selectedKind === "node" && selectedId) {
      aggregation.aggregatesById.forEach((group) => {
        if (group.memberNodeIds.includes(selectedId) && runtimeState.expandedAggregateIds.has(group.id)) {
          keepExpandedAggregateIds.add(group.id);
        }
      });
    }

    if (runtimeState.selectedKind === "aggregate" && selectedId) {
      keepExpandedAggregateIds.add(selectedId);
    }

    if (runtimeState.selectedKind === "edge" && selectedId) {
      const selectedEdge = findEdgeById(selectedId);
      if (selectedEdge) {
        aggregation.aggregatesById.forEach((group) => {
          if (!runtimeState.expandedAggregateIds.has(group.id)) {
            return;
          }

          if (
            group.memberNodeIds.includes(selectedEdge.source) ||
            group.memberNodeIds.includes(selectedEdge.target)
          ) {
            keepExpandedAggregateIds.add(group.id);
          }
        });
      }
    }

    let didCollapse = false;
    for (const aggregateId of [...runtimeState.transientExpandedAggregateIds]) {
      if (keepExpandedAggregateIds.has(aggregateId)) {
        continue;
      }

      runtimeState.transientExpandedAggregateIds.delete(aggregateId);
      if (runtimeState.expandedAggregateIds.delete(aggregateId)) {
        didCollapse = true;
      }
    }

    if (didCollapse) {
      renderGraph();
      reconcileSelection();
      renderDetailsPanel();
      setStatus("Re-aggregated temporary focus groups.");
    }
  }, TRANSIENT_AGGREGATE_REAPPEAR_DELAY_MS);
}

function markSelectionChanged(): void {
  scheduleTransientAggregateCollapse();
}

function autoExpandForEvent(event: GraphEvent): boolean {
  const graph = runtimeState.workingGraph;
  if (!graph) {
    return false;
  }

  const aggregation = deriveAggregation(graph);
  const relatedNodeIds = getEventRelatedNodeIds(event, graph);
  let expanded = false;

  relatedNodeIds.forEach((nodeId) => {
    const aggregateId = aggregation.nodeIdToCollapsedAggregateId.get(nodeId);
    if (!aggregateId) {
      return;
    }

    if (!runtimeState.expandedAggregateIds.has(aggregateId)) {
      runtimeState.expandedAggregateIds.add(aggregateId);
      runtimeState.transientExpandedAggregateIds.delete(aggregateId);
      expanded = true;
    }
  });

  return expanded;
}

function clampPlaybackSpeed(value: number): number {
  return Math.min(4, Math.max(0.25, value));
}

function formatPlaybackSpeed(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/, "")}x`;
}

function getEdgeGeometry(
  sourceNode: NodeRecord | undefined,
  targetNode: NodeRecord | undefined,
): { x1: number; y1: number; x2: number; y2: number } {
  if (!sourceNode || !targetNode) {
    return { x1: 0, y1: 0, x2: 0, y2: 0 };
  }

  const dx = targetNode.x - sourceNode.x;
  const dy = targetNode.y - sourceNode.y;
  const distance = Math.hypot(dx, dy);

  if (!Number.isFinite(distance) || distance <= EDGE_PADDING * 2) {
    return {
      x1: sourceNode.x,
      y1: sourceNode.y,
      x2: targetNode.x,
      y2: targetNode.y,
    };
  }

  const offsetX = (dx / distance) * EDGE_PADDING;
  const offsetY = (dy / distance) * EDGE_PADDING;

  return {
    x1: sourceNode.x + offsetX,
    y1: sourceNode.y + offsetY,
    x2: targetNode.x - offsetX,
    y2: targetNode.y - offsetY,
  };
}

function buildSourceRanks(edges: EdgeRecord[]): Map<string, number> {
  const grouped = new Map<string, EdgeRecord[]>();
  edges.forEach((edge) => {
    const list = grouped.get(edge.source) ?? [];
    list.push(edge);
    grouped.set(edge.source, list);
  });

  const ranks = new Map<string, number>();
  grouped.forEach((groupEdges) => {
    const sorted = [...groupEdges].sort((left, right) => {
      if (left.target === right.target) {
        return left.id.localeCompare(right.id);
      }
      return left.target.localeCompare(right.target);
    });
    const center = (sorted.length - 1) / 2;
    sorted.forEach((edge, index) => {
      ranks.set(edge.id, index - center);
    });
  });

  return ranks;
}

function getEdgeStatus(edge: EdgeRecord): "best-path" | "pruned" | "default" {
  const status = edge.properties?.status;
  if (status === "best-path") {
    return "best-path";
  }
  if (status === "pruned") {
    return "pruned";
  }
  return "default";
}

function buildEdgePathGeometry(
  edge: EdgeRecord,
  sourceNode: NodeRecord | undefined,
  targetNode: NodeRecord | undefined,
  sourceRanks: Map<string, number>,
  visibleEdges: EdgeRecord[],
): EdgePathGeometry {
  const trimmed = getEdgeGeometry(sourceNode, targetNode);
  const dx = trimmed.x2 - trimmed.x1;
  const dy = trimmed.y2 - trimmed.y1;
  const distance = Math.hypot(dx, dy);

  if (!Number.isFinite(distance) || distance < 1) {
    return {
      path: `M ${trimmed.x1} ${trimmed.y1} L ${trimmed.x2} ${trimmed.y2}`,
      midX: (trimmed.x1 + trimmed.x2) / 2,
      midY: (trimmed.y1 + trimmed.y2) / 2,
      labelX: (trimmed.x1 + trimmed.x2) / 2,
      labelY: (trimmed.y1 + trimmed.y2) / 2 - EDGE_LABEL_STRAIGHT_OFFSET,
      isStraight: true,
    };
  }

  const rank = sourceRanks.get(edge.id) ?? 0;
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const siblingEdges = visibleEdges.filter(
    (candidate) =>
      candidate.id !== edge.id &&
      (candidate.source === edge.source ||
        candidate.target === edge.target ||
        (candidate.source === edge.target && candidate.target === edge.source)),
  );
  const visibleEdge = visibleEdges.find((candidate) => candidate.id === edge.id) as
    | VisibleEdgeDatum
    | undefined;
  const isSimpleEdge = (visibleEdge?.memberEdgeIds.length ?? 1) === 1 && siblingEdges.length === 0 && rank === 0;

  if (isSimpleEdge) {
    const labelShift = Math.min(EDGE_LABEL_BASE_OFFSET, distance * 0.18);
    return {
      path: `M ${trimmed.x1} ${trimmed.y1} L ${trimmed.x2} ${trimmed.y2}`,
      midX: (trimmed.x1 + trimmed.x2) / 2,
      midY: (trimmed.y1 + trimmed.y2) / 2,
      labelX: (trimmed.x1 + trimmed.x2) / 2 + normalX * labelShift,
      labelY: (trimmed.y1 + trimmed.y2) / 2 + normalY * labelShift,
      isStraight: true,
    };
  }

  const baseDirection = edge.source.localeCompare(edge.target) <= 0 ? 1 : -1;
  const rankDirection = rank < 0 ? -1 : 1;
  const direction = baseDirection * rankDirection;
  const bendMagnitude = Math.min(
    EDGE_CURVE_MAX,
    EDGE_CURVE_BASE + Math.abs(rank) * EDGE_CURVE_STEP + Math.min(20, distance * 0.08),
  );

  const centerX = (trimmed.x1 + trimmed.x2) / 2;
  const centerY = (trimmed.y1 + trimmed.y2) / 2;
  const controlX = centerX + normalX * bendMagnitude * direction;
  const controlY = centerY + normalY * bendMagnitude * direction;

  const midX =
    0.25 * trimmed.x1 +
    0.5 * controlX +
    0.25 * trimmed.x2;
  const midY =
    0.25 * trimmed.y1 +
    0.5 * controlY +
    0.25 * trimmed.y2;

  const labelDirection = edge.weight !== undefined || edge.label ? 1 : -1;
  const labelOffset = Math.min(
    EDGE_LABEL_BASE_OFFSET + Math.abs(rank) * 4,
    Math.max(12, distance * 0.15),
  );

  return {
    path: `M ${trimmed.x1} ${trimmed.y1} Q ${controlX} ${controlY} ${trimmed.x2} ${trimmed.y2}`,
    midX,
    midY,
    labelX: midX + normalX * labelOffset * direction * labelDirection,
    labelY: midY + normalY * labelOffset * direction * labelDirection,
    isStraight: false,
  };
}

function isEdgeRelevantToSelection(edge: VisibleEdgeDatum, aggregation: AggregationResult): boolean {
  if (!runtimeState.selectedId || !runtimeState.selectedKind) {
    return true;
  }

  if (runtimeState.selectedKind === "edge") {
    return edge.memberEdgeIds.includes(runtimeState.selectedId);
  }

  if (runtimeState.selectedKind === "aggregate") {
    return edge.source === runtimeState.selectedId || edge.target === runtimeState.selectedId;
  }

  const selectedVisibleId =
    aggregation.nodeIdToVisibleId.get(runtimeState.selectedId) ?? runtimeState.selectedId;
  return edge.source === selectedVisibleId || edge.target === selectedVisibleId;
}

function selectNode(nodeId: string): void {
  runtimeState.selectedId = nodeId;
  runtimeState.selectedKind = "node";
  vscodeApi.setState({ selectedId: nodeId, selectedKind: "node" });
  renderGraph();
  renderDetailsPanel();
  markSelectionChanged();
}

function selectAggregate(aggregateId: string): void {
  runtimeState.selectedId = aggregateId;
  runtimeState.selectedKind = "aggregate";
  vscodeApi.setState({ selectedId: aggregateId, selectedKind: "aggregate" });
  renderGraph();
  renderDetailsPanel();
  markSelectionChanged();
}

function selectEdge(edgeId: string): void {
  runtimeState.selectedId = edgeId;
  runtimeState.selectedKind = "edge";
  vscodeApi.setState({ selectedId: edgeId, selectedKind: "edge" });
  renderGraph();
  renderDetailsPanel();
  markSelectionChanged();
}

function clearSelection(): void {
  runtimeState.selectedId = undefined;
  runtimeState.selectedKind = undefined;
  vscodeApi.setState({ selectedId: undefined, selectedKind: undefined });
  markSelectionChanged();
}

function reconcileSelection(): void {
  if (!runtimeState.selectedId || !runtimeState.selectedKind) {
    return;
  }

  if (
    runtimeState.selectedKind === "node" &&
    !findNodeById(runtimeState.selectedId)
  ) {
    clearSelection();
  }

  if (
    runtimeState.selectedKind === "edge" &&
    !findEdgeById(runtimeState.selectedId)
  ) {
    clearSelection();
  }

  if (runtimeState.selectedKind === "aggregate") {
    const aggregate = runtimeState.latestAggregation?.aggregatesById.get(runtimeState.selectedId);
    if (!aggregate || !aggregate.collapsed) {
      clearSelection();
    }
  }
}

function renderDetailsPanel(): void {
  if (!runtimeState.selectedId || !runtimeState.selectedKind) {
    detailsElement.textContent = "Select a node or edge.";
    return;
  }

  if (runtimeState.selectedKind === "aggregate") {
    const aggregate = runtimeState.latestAggregation?.aggregatesById.get(runtimeState.selectedId);
    if (!aggregate) {
      detailsElement.textContent = "Selected aggregate is no longer present in the active graph state.";
      return;
    }

    detailsElement.textContent = JSON.stringify(
      {
        id: aggregate.id,
        groupKey: aggregate.groupKey,
        layer: aggregate.representativeLayer,
        memberCount: aggregate.memberNodeIds.length,
        memberPreview: aggregate.memberNodeIds.slice(0, 20),
      },
      null,
      2,
    );
    return;
  }

  const details =
    runtimeState.selectedKind === "node"
      ? findNodeById(runtimeState.selectedId)
      : findEdgeById(runtimeState.selectedId);

  detailsElement.textContent = details
    ? JSON.stringify(details, null, 2)
    : "Selected element is no longer present in the active graph state.";
}

function renderEventLog(): void {
  eventLogElement.innerHTML = "";

  const visibleEvents = runtimeState.appliedEvents.slice(-14);
  if (visibleEvents.length === 0) {
    const item = document.createElement("li");
    item.className = "event-log-empty";
    item.textContent = "No dynamic events applied yet.";
    eventLogElement.appendChild(item);
    return;
  }

  visibleEvents.forEach((event, index) => {
    const item = document.createElement("li");
    item.className = "event-log-item";
    if (index === visibleEvents.length - 1) {
      item.classList.add("current");
    }

    const absoluteIndex = runtimeState.appliedEvents.length - visibleEvents.length + index + 1;
    const target = getEventTargetId(event);
    const reason = event.reason ? ` - ${event.reason}` : "";
    item.textContent = `${absoluteIndex}. ${event.eventType} (${target})${reason}`;

    eventLogElement.appendChild(item);
  });
}

function renderGraph(): void {
  const graph = runtimeState.workingGraph;
  if (!graph) {
    return;
  }

  const aggregation = deriveAggregation(graph);
  runtimeState.latestAggregation = aggregation;

  fitGraphViewBox(aggregation.nodes);

  const nodeMap = new Map(aggregation.nodes.map((node) => [node.id, node]));
  const sourceRanks = buildSourceRanks(aggregation.edges);
  const edgeGeometryMap = new Map<string, EdgePathGeometry>();

  aggregation.edges.forEach((edge) => {
    edgeGeometryMap.set(
      edge.id,
      buildEdgePathGeometry(
        edge,
        nodeMap.get(edge.source),
        nodeMap.get(edge.target),
        sourceRanks,
        aggregation.edges,
      ),
    );
  });

  const edgeSelection = edgeLayer
    .selectAll<SVGGElement, VisibleEdgeDatum>("g.edge")
    .data(aggregation.edges, (edge: VisibleEdgeDatum) => edge.id);

  const edgeEnterSelection = edgeSelection
    .enter()
    .append("g")
    .attr("class", "edge")
    .style("opacity", 0)
    .on("click", (_event: MouseEvent, edge: VisibleEdgeDatum) => {
      if (edge.memberEdgeIds.length === 1) {
        selectEdge(edge.memberEdgeIds[0]);
      }
    });

  edgeEnterSelection.append("path");
  edgeEnterSelection.append("text").attr("class", "edge-label");

  const edgeMergedSelection = edgeEnterSelection.merge(
    edgeSelection as d3.Selection<SVGGElement, VisibleEdgeDatum, SVGGElement, unknown>,
  );

  edgeMergedSelection.classed(
    "selected",
    (edge: VisibleEdgeDatum) =>
      runtimeState.selectedKind === "edge" &&
      !!runtimeState.selectedId &&
      edge.memberEdgeIds.includes(runtimeState.selectedId),
  );
  edgeMergedSelection.classed("state-best-path", (edge: VisibleEdgeDatum) => getEdgeStatus(edge) === "best-path");
  edgeMergedSelection.classed("state-pruned", (edge: VisibleEdgeDatum) => getEdgeStatus(edge) === "pruned");
  edgeMergedSelection.classed("aggregate", (edge: VisibleEdgeDatum) => edge.memberEdgeIds.length > 1);
  edgeMergedSelection.classed("straight", (edge: VisibleEdgeDatum) => edgeGeometryMap.get(edge.id)?.isStraight ?? false);
  edgeMergedSelection.classed(
    "deemphasized",
    (edge: VisibleEdgeDatum) => !isEdgeRelevantToSelection(edge, aggregation),
  );
  edgeMergedSelection
    .filter(
      (edge: VisibleEdgeDatum) =>
        runtimeState.selectedKind === "edge" &&
        !!runtimeState.selectedId &&
        edge.memberEdgeIds.includes(runtimeState.selectedId),
    )
    .raise();

  edgeMergedSelection
    .select("path")
    .interrupt()
    .transition()
    .duration(EDGE_TRANSITION_MS)
    .attr("d", (edge: VisibleEdgeDatum) => edgeGeometryMap.get(edge.id)?.path ?? "");

  edgeMergedSelection
    .select("text")
    .interrupt()
    .transition()
    .duration(EDGE_TRANSITION_MS)
    .attr(
      "x",
      (edge: VisibleEdgeDatum) => edgeGeometryMap.get(edge.id)?.labelX ?? 0,
    )
    .attr(
      "y",
      (edge: VisibleEdgeDatum) => edgeGeometryMap.get(edge.id)?.labelY ?? 0,
    )
    .text((edge: VisibleEdgeDatum) => {
      if (edge.memberEdgeIds.length > 1) {
        return `${edge.memberEdgeIds.length} edges`;
      }

      if (edge.weight !== undefined) {
        return `${edge.weight}`;
      }
      if (edge.label) {
        return edge.label;
      }
      return edge.id;
    });

  edgeEnterSelection
    .interrupt()
    .transition()
    .duration(EDGE_TRANSITION_MS)
    .style("opacity", 1);

  edgeSelection
    .exit()
    .interrupt()
    .transition()
    .duration(EDGE_TRANSITION_MS)
    .style("opacity", 0)
    .remove();

  const nodeSelection = nodeLayer
    .selectAll<SVGGElement, VisibleNodeDatum>("g.node")
    .data(aggregation.nodes, (node: VisibleNodeDatum) => node.id);

  const nodeEnterSelection = nodeSelection
    .enter()
    .append("g")
    .attr("class", "node")
    .attr("transform", (node: VisibleNodeDatum) => `translate(${node.x}, ${node.y})`)
    .style("opacity", 1)
    .on("click", (_event: MouseEvent, node: VisibleNodeDatum) => {
      if (node.isAggregate) {
        selectAggregate(node.id);
        expandAggregate(node.id);
        renderGraph();
        renderDetailsPanel();
        setStatus(`Expanded aggregate ${node.id}.`);
        return;
      }

      selectNode(node.id);
    });

  nodeEnterSelection.append("circle").attr("r", NODE_RADIUS);
  nodeEnterSelection
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em");

  const nodeMergedSelection = nodeEnterSelection.merge(
    nodeSelection as d3.Selection<SVGGElement, VisibleNodeDatum, SVGGElement, unknown>,
  );

  nodeMergedSelection.classed(
    "selected",
    (node: VisibleNodeDatum) => {
      if (!runtimeState.selectedId || !runtimeState.selectedKind) {
        return false;
      }

      if (runtimeState.selectedKind === "aggregate") {
        return node.id === runtimeState.selectedId;
      }

      if (runtimeState.selectedKind === "node") {
        if (node.id === runtimeState.selectedId) {
          return true;
        }

        return node.isAggregate && node.memberNodeIds.includes(runtimeState.selectedId);
      }

      return false;
    },
  );
  nodeMergedSelection.classed("aggregate", (node: VisibleNodeDatum) => node.isAggregate);
  nodeMergedSelection
    .filter(
      (node: VisibleNodeDatum) =>
        runtimeState.selectedKind === "node" &&
        !!runtimeState.selectedId &&
        (node.id === runtimeState.selectedId || (node.isAggregate && node.memberNodeIds.includes(runtimeState.selectedId))),
    )
    .raise();

  nodeMergedSelection
    .interrupt()
    .transition()
    .duration(NODE_TRANSITION_MS)
    .attr("transform", (node: VisibleNodeDatum) => `translate(${node.x}, ${node.y})`);

  nodeMergedSelection
    .select("circle")
    .interrupt()
    .transition()
    .duration(NODE_TRANSITION_MS)
    .attr("r", (node: VisibleNodeDatum) =>
      node.isAggregate
        ? Math.min(AGGREGATE_NODE_RADIUS + node.memberNodeIds.length * 0.8, 40)
        : NODE_RADIUS,
    );

  nodeMergedSelection.select("text").text((node: VisibleNodeDatum) => node.label);

  nodeMergedSelection.style("opacity", 1);

  nodeSelection
    .exit()
    .interrupt()
    .transition()
    .duration(NODE_TRANSITION_MS)
    .style("opacity", 0)
    .remove();
}

function focusById(targetId: string): boolean {
  const graph = runtimeState.workingGraph;
  if (!graph) {
    return false;
  }

  const node = graph.nodes.find((entry) => entry.id === targetId);
  let targetX: number;
  let targetY: number;

  if (node) {
    if (ensureExpandedForNode(node.id, true)) {
      renderGraph();
    }
    targetX = node.x;
    targetY = node.y;
    selectNode(node.id);
  } else {
    const edge = graph.edges.find((entry) => entry.id === targetId);
    if (!edge) {
      return false;
    }

    const sourceNode = graph.nodes.find((entry) => entry.id === edge.source);
    const targetNode = graph.nodes.find((entry) => entry.id === edge.target);
    if (!sourceNode || !targetNode) {
      return false;
    }

    const expandedSource = ensureExpandedForNode(sourceNode.id, true);
    const expandedTarget = ensureExpandedForNode(targetNode.id, true);
    if (expandedSource || expandedTarget) {
      renderGraph();
    }

    targetX = (sourceNode.x + targetNode.x) / 2;
    targetY = (sourceNode.y + targetNode.y) / 2;
    selectEdge(edge.id);
  }

  const { width, height } = graphPaneElement.getBoundingClientRect();
  const scale = 1.35;
  const transform = d3.zoomIdentity
    .translate(width / 2 - targetX * scale, height / 2 - targetY * scale)
    .scale(scale);

  svgSelection
    .transition()
    .duration(300)
    .call(zoomBehavior.transform as unknown as (selection: unknown, t: unknown) => void, transform);

  return true;
}

function resetGraphToBaseline(): void {
  if (!runtimeState.baseGraph) {
    return;
  }

  runtimeState.workingGraph = cloneGraphSnapshot(runtimeState.baseGraph);
  runtimeState.appliedEvents = [];
  runtimeState.eventCursor = 0;
  runtimeState.transientExpandedAggregateIds.clear();
  clearTransientAggregateCollapseTimer();
  runtimeState.latestAggregation = undefined;
}

function applyNextEvent(): GraphEvent | undefined {
  if (!runtimeState.workingGraph || runtimeState.eventCursor >= runtimeState.events.length) {
    return undefined;
  }

  const nextEvent = runtimeState.events[runtimeState.eventCursor];
  runtimeState.workingGraph = applyEventToGraph(runtimeState.workingGraph, nextEvent);
  runtimeState.appliedEvents.push(nextEvent);
  runtimeState.eventCursor += 1;

  return nextEvent;
}

function clampEventIndex(value: number): number {
  return Math.max(0, Math.min(runtimeState.events.length, value));
}

function syncGraphToEventIndex(targetEventIndex: number): void {
  if (!runtimeState.baseGraph) {
    return;
  }

  const clampedTarget = clampEventIndex(targetEventIndex);

  if (clampedTarget < runtimeState.eventCursor) {
    resetGraphToBaseline();
  }

  while (runtimeState.eventCursor < clampedTarget) {
    const pendingEvent = runtimeState.events[runtimeState.eventCursor];
    if (pendingEvent) {
      autoExpandForEvent(pendingEvent);
    }

    const nextEvent = applyNextEvent();
    if (!nextEvent) {
      break;
    }
  }

  reconcileSelection();
  renderGraph();
  renderDetailsPanel();
  renderEventLog();
}

function postPlaybackAction(action: PlaybackControlAction, speedMultiplier?: number): void {
  const message: WebviewToHostMessage =
    action === "set-speed"
      ? {
          type: "playback-control",
          contractVersion: CONTRACT_VERSION,
          action,
          speedMultiplier,
        }
      : {
          type: "playback-control",
          contractVersion: CONTRACT_VERSION,
          action,
        };
  vscodeApi.postMessage(message);
}

function updatePlaybackControls(): void {
  const hasGraph = runtimeState.baseGraph !== undefined;
  const atStart = runtimeState.eventCursor === 0;
  const atEnd = runtimeState.eventCursor >= runtimeState.events.length;
  const isPlaying = runtimeState.playbackStatus === "playing";

  playbackButtonElements.play.disabled = !hasGraph || isPlaying || atEnd;
  playbackButtonElements.pause.disabled = !hasGraph || !isPlaying;
  playbackButtonElements.step.disabled = !hasGraph || isPlaying || atEnd;
  playbackButtonElements.reset.disabled = !hasGraph || (atStart && !isPlaying);
}

function handlePlaybackAction(action: PlaybackControlAction): void {
  postPlaybackAction(action);
  setStatus(`Requested host action: ${action}.`);
}

function postFocusRequest(targetId: string): void {
  const message: WebviewToHostMessage = {
    type: "focus-request",
    contractVersion: CONTRACT_VERSION,
    targetId,
  };

  vscodeApi.postMessage(message);
}

function handleInitData(payload: GraphDataFile): void {
  runtimeState.baseGraph = cloneGraphSnapshot(payload.graph);
  runtimeState.workingGraph = cloneGraphSnapshot(payload.graph);
  runtimeState.events = payload.events;
  runtimeState.appliedEvents = [];
  runtimeState.eventCursor = 0;
  runtimeState.playbackStatus = "paused";
  runtimeState.expandedAggregateIds.clear();
  runtimeState.transientExpandedAggregateIds.clear();
  clearTransientAggregateCollapseTimer();
  runtimeState.latestAggregation = undefined;

  const persistedState = vscodeApi.getState();
  if (persistedState?.selectedId && persistedState.selectedKind) {
    runtimeState.selectedId = persistedState.selectedId;
    runtimeState.selectedKind = persistedState.selectedKind;
  } else {
    clearSelection();
  }

  renderGraph();
  reconcileSelection();
  renderDetailsPanel();
  renderEventLog();
  updatePlaybackControls();
  playbackSpeedInputElement.value = "1";
  playbackSpeedLabelElement.textContent = formatPlaybackSpeed(1);
  setStatus(
    `Loaded ${payload.graph.nodes.length} nodes, ${payload.graph.edges.length} edges, ${payload.events.length} events.`,
  );
}

function bindUIEvents(): void {
  focusButtonElement.addEventListener("click", () => {
    const targetId = searchInputElement.value.trim();
    if (!targetId) {
      return;
    }

    const found = focusById(targetId);
    if (!found) {
      setStatus(`Could not find node or edge id: ${targetId}`, true);
      return;
    }

    postFocusRequest(targetId);
    setStatus(`Focused on ${targetId}.`);
  });

  searchInputElement.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      focusButtonElement.click();
    }
  });

  Object.values(playbackButtonElements).forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (!action) {
        return;
      }

      if (
        action === "play" ||
        action === "pause" ||
        action === "step" ||
        action === "reset"
      ) {
        handlePlaybackAction(action);
      }
    });
  });

  playbackSpeedInputElement.addEventListener("input", () => {
    const speedMultiplier = clampPlaybackSpeed(Number(playbackSpeedInputElement.value));
    playbackSpeedLabelElement.textContent = formatPlaybackSpeed(speedMultiplier);
    postPlaybackAction("set-speed", speedMultiplier);
  });

  window.addEventListener("resize", () => {
    resizeGraphSurface();
    renderGraph();
  });
}

function bindHostMessages(): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const rawMessage = event.data;

    if (!isHostToWebviewMessage(rawMessage)) {
      setStatus("Ignored unsupported host message payload.", true);
      return;
    }

    switch (rawMessage.type) {
      case "init-data":
        handleInitData(rawMessage.payload);
        return;
      case "playback-state":
        runtimeState.playbackStatus = rawMessage.payload.status;
        playbackSpeedInputElement.value = `${rawMessage.payload.speedMultiplier}`;
        playbackSpeedLabelElement.textContent = formatPlaybackSpeed(
          rawMessage.payload.speedMultiplier,
        );
        syncGraphToEventIndex(rawMessage.payload.eventIndex);
        updatePlaybackControls();
        setStatus(
          `Playback: ${rawMessage.payload.status} ${formatPlaybackSpeed(rawMessage.payload.speedMultiplier)} (${runtimeState.eventCursor}/${rawMessage.payload.totalEvents})`,
        );
        return;
      case "error":
        setStatus(rawMessage.payload.message, true);
        return;
    }
  });
}

function initialize(): void {
  resizeGraphSurface();
  updatePlaybackControls();
  bindUIEvents();
  bindHostMessages();

  const readyMessage: WebviewToHostMessage = {
    type: "ready",
    contractVersion: CONTRACT_VERSION,
  };
  vscodeApi.postMessage(readyMessage);
}

initialize();
