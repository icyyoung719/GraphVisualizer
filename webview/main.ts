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

type SelectedKind = "node" | "edge";

interface RuntimeState {
  baseGraph: GraphSnapshot | undefined;
  workingGraph: GraphSnapshot | undefined;
  events: GraphEvent[];
  appliedEvents: GraphEvent[];
  eventCursor: number;
  selectedId: string | undefined;
  selectedKind: SelectedKind | undefined;
  playbackStatus: "playing" | "paused";
}

const vscodeApi = acquireVsCodeApi<{ selectedId?: string; selectedKind?: SelectedKind }>();

const runtimeState: RuntimeState = {
  baseGraph: undefined,
  workingGraph: undefined,
  events: [],
  appliedEvents: [],
  eventCursor: 0,
  selectedId: undefined,
  selectedKind: undefined,
  playbackStatus: "paused",
};

let playbackTimer: number | undefined;

const graphPaneElement = getRequiredElement<HTMLElement>("graph-pane");
const svgElement = getRequiredElement<SVGSVGElement>("graph-svg");
const detailsElement = getRequiredElement<HTMLElement>("details-json");
const eventLogElement = getRequiredElement<HTMLElement>("event-log");
const searchInputElement = getRequiredElement<HTMLInputElement>("search-input");
const focusButtonElement = getRequiredElement<HTMLButtonElement>("focus-button");
const statusTextElement = getRequiredElement<HTMLElement>("status-text");

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

function selectNode(nodeId: string): void {
  runtimeState.selectedId = nodeId;
  runtimeState.selectedKind = "node";
  vscodeApi.setState({ selectedId: nodeId, selectedKind: "node" });
  renderGraph();
  renderDetailsPanel();
}

function selectEdge(edgeId: string): void {
  runtimeState.selectedId = edgeId;
  runtimeState.selectedKind = "edge";
  vscodeApi.setState({ selectedId: edgeId, selectedKind: "edge" });
  renderGraph();
  renderDetailsPanel();
}

function clearSelection(): void {
  runtimeState.selectedId = undefined;
  runtimeState.selectedKind = undefined;
  vscodeApi.setState({ selectedId: undefined, selectedKind: undefined });
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
}

function renderDetailsPanel(): void {
  if (!runtimeState.selectedId || !runtimeState.selectedKind) {
    detailsElement.textContent = "Select a node or edge.";
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

  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));

  const edgeSelection = edgeLayer
    .selectAll<SVGGElement, EdgeRecord>("g.edge")
    .data(graph.edges, (edge: EdgeRecord) => edge.id);

  const edgeEnterSelection = edgeSelection
    .enter()
    .append("g")
    .attr("class", "edge")
    .on("click", (_event: MouseEvent, edge: EdgeRecord) => {
      selectEdge(edge.id);
    });

  edgeEnterSelection.append("line");
  edgeEnterSelection.append("text").attr("class", "edge-label");

  const edgeMergedSelection = edgeEnterSelection.merge(
    edgeSelection as d3.Selection<SVGGElement, EdgeRecord, SVGGElement, unknown>,
  );

  edgeMergedSelection.classed(
    "selected",
    (edge: EdgeRecord) =>
      runtimeState.selectedKind === "edge" && runtimeState.selectedId === edge.id,
  );

  edgeMergedSelection
    .select("line")
    .attr("x1", (edge: EdgeRecord) => nodeMap.get(edge.source)?.x ?? 0)
    .attr("y1", (edge: EdgeRecord) => nodeMap.get(edge.source)?.y ?? 0)
    .attr("x2", (edge: EdgeRecord) => nodeMap.get(edge.target)?.x ?? 0)
    .attr("y2", (edge: EdgeRecord) => nodeMap.get(edge.target)?.y ?? 0);

  edgeMergedSelection
    .select("text")
    .attr(
      "x",
      (edge: EdgeRecord) =>
        ((nodeMap.get(edge.source)?.x ?? 0) + (nodeMap.get(edge.target)?.x ?? 0)) / 2,
    )
    .attr(
      "y",
      (edge: EdgeRecord) =>
        ((nodeMap.get(edge.source)?.y ?? 0) + (nodeMap.get(edge.target)?.y ?? 0)) / 2 - 8,
    )
    .text((edge: EdgeRecord) => {
      if (edge.weight !== undefined) {
        return `${edge.weight}`;
      }
      if (edge.label) {
        return edge.label;
      }
      return edge.id;
    });

  edgeSelection.exit().remove();

  const nodeSelection = nodeLayer
    .selectAll<SVGGElement, NodeRecord>("g.node")
    .data(graph.nodes, (node: NodeRecord) => node.id);

  const nodeEnterSelection = nodeSelection
    .enter()
    .append("g")
    .attr("class", "node")
    .on("click", (_event: MouseEvent, node: NodeRecord) => {
      selectNode(node.id);
    });

  nodeEnterSelection.append("circle").attr("r", 20);
  nodeEnterSelection
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em");

  const nodeMergedSelection = nodeEnterSelection.merge(
    nodeSelection as d3.Selection<SVGGElement, NodeRecord, SVGGElement, unknown>,
  );

  nodeMergedSelection
    .attr("transform", (node: NodeRecord) => `translate(${node.x}, ${node.y})`)
    .classed(
      "selected",
      (node: NodeRecord) =>
        runtimeState.selectedKind === "node" && runtimeState.selectedId === node.id,
    );

  nodeMergedSelection.select("text").text((node: NodeRecord) => node.label);
  nodeSelection.exit().remove();
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
  runtimeState.playbackStatus = "paused";
  clearSelection();

  renderGraph();
  renderDetailsPanel();
  renderEventLog();
  setStatus("Playback reset to initial graph.");
}

function stepPlaybackForward(): boolean {
  if (!runtimeState.workingGraph) {
    return false;
  }

  if (runtimeState.eventCursor >= runtimeState.events.length) {
    setStatus("Playback reached the end of the event stream.");
    return false;
  }

  const nextEvent = runtimeState.events[runtimeState.eventCursor];
  runtimeState.workingGraph = applyEventToGraph(runtimeState.workingGraph, nextEvent);
  runtimeState.appliedEvents.push(nextEvent);
  runtimeState.eventCursor += 1;

  reconcileSelection();
  renderGraph();
  renderDetailsPanel();
  renderEventLog();

  setStatus(
    `Applied event ${runtimeState.eventCursor}/${runtimeState.events.length}: ${nextEvent.eventType}`,
  );

  return true;
}

function postPlaybackAction(action: PlaybackControlAction): void {
  const message: WebviewToHostMessage = {
    type: "playback-control",
    contractVersion: CONTRACT_VERSION,
    action,
  };
  vscodeApi.postMessage(message);
}

function stopPlayback(sendHostUpdate: boolean): void {
  if (playbackTimer !== undefined) {
    window.clearInterval(playbackTimer);
    playbackTimer = undefined;
  }

  runtimeState.playbackStatus = "paused";
  if (sendHostUpdate) {
    postPlaybackAction("pause");
  }
}

function startPlayback(): void {
  if (runtimeState.playbackStatus === "playing") {
    return;
  }

  runtimeState.playbackStatus = "playing";
  postPlaybackAction("play");

  playbackTimer = window.setInterval(() => {
    const moved = stepPlaybackForward();
    if (!moved) {
      stopPlayback(true);
    }
  }, 950);
}

function handlePlaybackAction(action: PlaybackControlAction): void {
  switch (action) {
    case "play":
      startPlayback();
      return;
    case "pause":
      stopPlayback(true);
      setStatus("Playback paused.");
      return;
    case "step":
      stopPlayback(false);
      stepPlaybackForward();
      postPlaybackAction("step");
      return;
    case "reset":
      stopPlayback(false);
      resetGraphToBaseline();
      postPlaybackAction("reset");
      return;
  }
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

  const playbackButtons = document.querySelectorAll<HTMLButtonElement>(
    ".playback-group button[data-action]",
  );

  playbackButtons.forEach((button) => {
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
        setStatus(
          `Host state: ${rawMessage.payload.status} (${rawMessage.payload.eventIndex}/${rawMessage.payload.totalEvents})`,
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
  bindUIEvents();
  bindHostMessages();

  const readyMessage: WebviewToHostMessage = {
    type: "ready",
    contractVersion: CONTRACT_VERSION,
  };
  vscodeApi.postMessage(readyMessage);
}

initialize();
