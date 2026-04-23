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
import {
  AggregationResult,
  EdgePathGeometry,
  GraphRenderContext,
  SelectedKind,
  buildEdgePathGeometry,
  buildSourceRanks,
  deriveAggregation,
  getEdgeStatus,
  getEventRelatedNodeIds,
  isEdgeRelevantToSelection,
  VisibleEdgeDatum,
  VisibleNodeDatum,
} from "./graphModel";

interface VsCodeApi<T> {
  postMessage(message: unknown): void;
  setState(state: T): void;
  getState(): T | undefined;
}

declare function acquireVsCodeApi<T = unknown>(): VsCodeApi<T>;

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
const TRANSIENT_AGGREGATE_REAPPEAR_DELAY_MS = 220;

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
svgSelection.on("click", (event: MouseEvent) => {
  if (event.target !== svgElement) {
    return;
  }

  clearFocusedSelection();
});

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

function ensureExpandedForNode(nodeId: string, isTransient = false): boolean {
  const graph = runtimeState.workingGraph;
  if (!graph) {
    return false;
  }

  const aggregation = deriveAggregation(graph, getGraphRenderContext());
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
    const aggregation = runtimeState.latestAggregation ?? deriveAggregation(graph, getGraphRenderContext());
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

  const context = getGraphRenderContext();
  const aggregation = deriveAggregation(graph, context);
  const relatedNodeIds = getEventRelatedNodeIds(event, graph, context);
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

function getGraphRenderContext(): GraphRenderContext {
  return {
    selectedId: runtimeState.selectedId,
    selectedKind: runtimeState.selectedKind,
    baseGraph: runtimeState.baseGraph,
    events: runtimeState.events,
    appliedEvents: runtimeState.appliedEvents,
    expandedAggregateIds: runtimeState.expandedAggregateIds,
  };
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

function clearFocusedSelection(): void {
  if (!runtimeState.selectedId && !runtimeState.selectedKind) {
    return;
  }

  clearSelection();
  renderGraph();
  renderDetailsPanel();
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

  const aggregation = deriveAggregation(graph, getGraphRenderContext());
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
    (edge: VisibleEdgeDatum) =>
      !isEdgeRelevantToSelection(
        edge,
        aggregation,
        runtimeState.selectedId,
        runtimeState.selectedKind,
      ),
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
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    clearFocusedSelection();
  });

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
