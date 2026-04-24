import {
  EdgeRecord,
  GraphEvent,
  GraphSnapshot,
  NodeRecord,
} from "../src/protocol/events";
import {
  DEFAULT_GRAPH_DY_VIS_SETTINGS,
  GraphDyVisAggregationSettings,
} from "../src/protocol/settings";

export type SelectedKind = "node" | "edge" | "aggregate";

export interface VisibleNodeDatum extends NodeRecord {
  isAggregate: boolean;
  memberNodeIds: string[];
}

export interface VisibleEdgeDatum extends EdgeRecord {
  memberEdgeIds: string[];
}

export interface AggregateGroup {
  id: string;
  groupKey: string;
  label: string;
  memberNodeIds: string[];
  representativeLayer: string;
  collapsed: boolean;
  centroidX: number;
  centroidY: number;
}

export interface AggregationResult {
  nodes: VisibleNodeDatum[];
  edges: VisibleEdgeDatum[];
  nodeIdToVisibleId: Map<string, string>;
  nodeIdToCollapsedAggregateId: Map<string, string>;
  aggregatesById: Map<string, AggregateGroup>;
}

export interface GraphRenderContext {
  selectedId: string | undefined;
  selectedKind: SelectedKind | undefined;
  baseGraph: GraphSnapshot | undefined;
  events: GraphEvent[];
  appliedEvents: GraphEvent[];
  expandedAggregateIds: Set<string>;
  aggregationSettings: GraphDyVisAggregationSettings;
}

export interface EdgePathGeometry {
  path: string;
  midX: number;
  midY: number;
  labelX: number;
  labelY: number;
  isStraight: boolean;
}

const NODE_RADIUS = 20;
const EDGE_PADDING = NODE_RADIUS + 4;
const EDGE_CURVE_BASE = 16;
const EDGE_CURVE_STEP = 9;
const EDGE_CURVE_MAX = 68;
const EDGE_LABEL_BASE_OFFSET = 14;
const EDGE_LABEL_STRAIGHT_OFFSET = 12;
const DEFAULT_AGGREGATION_SETTINGS = DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation;

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

function resolveEdgeById(
  edgeId: string,
  snapshot: GraphSnapshot,
  context: Pick<GraphRenderContext, "baseGraph" | "events">,
): EdgeRecord | undefined {
  const inWorking = snapshot.edges.find((edge) => edge.id === edgeId);
  if (inWorking) {
    return inWorking;
  }

  const inBase = context.baseGraph?.edges.find((edge) => edge.id === edgeId);
  if (inBase) {
    return inBase;
  }

  const createEvent = context.events.find(
    (event) => event.eventType === "edge_create" && event.edge.id === edgeId,
  );
  if (createEvent && createEvent.eventType === "edge_create") {
    return createEvent.edge;
  }

  return undefined;
}

export function getEventRelatedNodeIds(
  event: GraphEvent,
  snapshot: GraphSnapshot,
  context: Pick<GraphRenderContext, "baseGraph" | "events">,
): string[] {
  switch (event.eventType) {
    case "node_create":
      return [event.node.id];
    case "edge_create":
      return [event.edge.source, event.edge.target];
    case "edge_update":
    case "edge_delete": {
      const edge = resolveEdgeById(event.id, snapshot, context);
      return edge ? [edge.source, edge.target] : [];
    }
  }
}

function getInterestingNodeIds(
  snapshot: GraphSnapshot,
  context: GraphRenderContext,
): Set<string> {
  const interestingIds = new Set<string>();

  if (context.selectedId && context.selectedKind === "node") {
    interestingIds.add(context.selectedId);
  }

  if (context.selectedId && context.selectedKind === "edge") {
    const selectedEdge = resolveEdgeById(context.selectedId, snapshot, context);
    if (selectedEdge) {
      interestingIds.add(selectedEdge.source);
      interestingIds.add(selectedEdge.target);
    }
  }

  const recentEventWindow = Math.max(1, context.aggregationSettings.recentEventWindow);
  const recentEvents = context.appliedEvents.slice(-recentEventWindow);
  recentEvents.forEach((event) => {
    getEventRelatedNodeIds(event, snapshot, context).forEach((nodeId) => interestingIds.add(nodeId));
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

export function deriveAggregation(
  snapshot: GraphSnapshot,
  context: GraphRenderContext,
): AggregationResult {
  const aggregationSettings = context.aggregationSettings ?? DEFAULT_AGGREGATION_SETTINGS;

  if (!aggregationSettings.enabled) {
    return createIdentityAggregation(snapshot);
  }

  if (snapshot.nodes.length < aggregationSettings.minTotalNodes) {
    return createIdentityAggregation(snapshot);
  }

  const interestingNodeIds = getInterestingNodeIds(snapshot, context);
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
    if (members.length < aggregationSettings.minGroupSize) {
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
      collapsed: !context.expandedAggregateIds.has(aggregateId),
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

export function getEdgeGeometry(
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

export function buildSourceRanks(edges: EdgeRecord[]): Map<string, number> {
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

export function getEdgeStatus(edge: EdgeRecord): "best-path" | "pruned" | "default" {
  const status = edge.properties?.status;
  if (status === "best-path") {
    return "best-path";
  }
  if (status === "pruned") {
    return "pruned";
  }
  return "default";
}

export function buildEdgePathGeometry(
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

export function isEdgeRelevantToSelection(
  edge: VisibleEdgeDatum,
  aggregation: AggregationResult,
  selectedId: string | undefined,
  selectedKind: SelectedKind | undefined,
): boolean {
  if (!selectedId || !selectedKind) {
    return true;
  }

  if (selectedKind === "edge") {
    return edge.memberEdgeIds.includes(selectedId);
  }

  if (selectedKind === "aggregate") {
    return edge.source === selectedId || edge.target === selectedId;
  }

  const selectedVisibleId = aggregation.nodeIdToVisibleId.get(selectedId) ?? selectedId;
  return edge.source === selectedVisibleId || edge.target === selectedVisibleId;
}