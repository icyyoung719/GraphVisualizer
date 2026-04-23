export type Primitive = string | number | boolean | null;
export type PropertyMap = Record<string, Primitive>;

export interface NodeRecord {
  id: string;
  label: string;
  x: number;
  y: number;
  properties?: PropertyMap;
}

export interface EdgeRecord {
  id: string;
  source: string;
  target: string;
  label?: string;
  weight?: number;
  properties?: PropertyMap;
}

export interface GraphSnapshot {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

interface EventBase {
  timestampMs: number;
  reason?: string;
}

export interface NodeCreateEvent extends EventBase {
  eventType: "node_create";
  node: NodeRecord;
}

export interface EdgeCreateEvent extends EventBase {
  eventType: "edge_create";
  edge: EdgeRecord;
}

export interface EdgeUpdateEvent extends EventBase {
  eventType: "edge_update";
  id: string;
  newWeight?: number;
  newProperties?: PropertyMap;
}

export interface EdgeDeleteEvent extends EventBase {
  eventType: "edge_delete";
  id: string;
}

export type GraphEvent =
  | NodeCreateEvent
  | EdgeCreateEvent
  | EdgeUpdateEvent
  | EdgeDeleteEvent;

export interface GraphDataFile {
  schemaVersion: string;
  graph: GraphSnapshot;
  events: GraphEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parsePropertyMap(value: unknown, path: string): PropertyMap | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`${path} must be an object when provided.`);
  }

  const entries = Object.entries(value);
  const mapped: PropertyMap = {};

  for (const [key, entryValue] of entries) {
    if (!isPrimitive(entryValue)) {
      throw new Error(`${path}.${key} must be a primitive JSON value.`);
    }

    mapped[key] = entryValue;
  }

  return mapped;
}

function parseNode(raw: unknown, path: string): NodeRecord {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }

  if (typeof raw.label !== "string") {
    throw new Error(`${path}.label must be a string.`);
  }

  if (typeof raw.x !== "number" || typeof raw.y !== "number") {
    throw new Error(`${path}.x and ${path}.y must be numbers.`);
  }

  return {
    id: raw.id,
    label: raw.label,
    x: raw.x,
    y: raw.y,
    properties: parsePropertyMap(raw.properties, `${path}.properties`),
  };
}

function parseEdge(raw: unknown, path: string): EdgeRecord {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }

  if (typeof raw.source !== "string" || typeof raw.target !== "string") {
    throw new Error(`${path}.source and ${path}.target must be strings.`);
  }

  if (raw.label !== undefined && typeof raw.label !== "string") {
    throw new Error(`${path}.label must be a string when provided.`);
  }

  if (raw.weight !== undefined && typeof raw.weight !== "number") {
    throw new Error(`${path}.weight must be a number when provided.`);
  }

  return {
    id: raw.id,
    source: raw.source,
    target: raw.target,
    label: raw.label,
    weight: raw.weight,
    properties: parsePropertyMap(raw.properties, `${path}.properties`),
  };
}

function parseTimestamp(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw new Error(`${path} must be a number.`);
  }

  return value;
}

function parseReason(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${path} must be a string when provided.`);
  }

  return value;
}

function parseGraphEvent(raw: unknown, index: number): GraphEvent {
  const path = `events[${index}]`;

  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }

  if (typeof raw.eventType !== "string") {
    throw new Error(`${path}.eventType must be a string.`);
  }

  switch (raw.eventType) {
    case "node_create":
      return {
        eventType: "node_create",
        node: parseNode(raw.node, `${path}.node`),
        timestampMs: parseTimestamp(raw.timestampMs, `${path}.timestampMs`),
        reason: parseReason(raw.reason, `${path}.reason`),
      };
    case "edge_create":
      return {
        eventType: "edge_create",
        edge: parseEdge(raw.edge, `${path}.edge`),
        timestampMs: parseTimestamp(raw.timestampMs, `${path}.timestampMs`),
        reason: parseReason(raw.reason, `${path}.reason`),
      };
    case "edge_update":
      if (typeof raw.id !== "string") {
        throw new Error(`${path}.id must be a string for edge_update.`);
      }

      if (raw.newWeight !== undefined && typeof raw.newWeight !== "number") {
        throw new Error(`${path}.newWeight must be a number when provided.`);
      }

      return {
        eventType: "edge_update",
        id: raw.id,
        timestampMs: parseTimestamp(raw.timestampMs, `${path}.timestampMs`),
        reason: parseReason(raw.reason, `${path}.reason`),
        newWeight: raw.newWeight,
        newProperties: parsePropertyMap(raw.newProperties, `${path}.newProperties`),
      };
    case "edge_delete":
      if (typeof raw.id !== "string") {
        throw new Error(`${path}.id must be a string for edge_delete.`);
      }

      return {
        eventType: "edge_delete",
        id: raw.id,
        timestampMs: parseTimestamp(raw.timestampMs, `${path}.timestampMs`),
        reason: parseReason(raw.reason, `${path}.reason`),
      };
    default:
      throw new Error(`${path}.eventType \"${raw.eventType}\" is not supported.`);
  }
}

export function validateGraphDataFile(raw: unknown): GraphDataFile {
  if (!isRecord(raw)) {
    throw new Error("Graph data must be a JSON object.");
  }

  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion.length === 0) {
    throw new Error("schemaVersion must be a non-empty string.");
  }

  if (!isRecord(raw.graph)) {
    throw new Error("graph must be an object.");
  }

  if (!Array.isArray(raw.graph.nodes) || !Array.isArray(raw.graph.edges)) {
    throw new Error("graph.nodes and graph.edges must be arrays.");
  }

  const nodes = raw.graph.nodes.map((node, index) =>
    parseNode(node, `graph.nodes[${index}]`),
  );

  const edges = raw.graph.edges.map((edge, index) =>
    parseEdge(edge, `graph.edges[${index}]`),
  );

  if (!Array.isArray(raw.events)) {
    throw new Error("events must be an array.");
  }

  const events = raw.events.map((event, index) => parseGraphEvent(event, index));

  return {
    schemaVersion: raw.schemaVersion,
    graph: {
      nodes,
      edges,
    },
    events,
  };
}

export function cloneGraphSnapshot(graph: GraphSnapshot): GraphSnapshot {
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      properties: node.properties ? { ...node.properties } : undefined,
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      properties: edge.properties ? { ...edge.properties } : undefined,
    })),
  };
}

export function applyEventToGraph(
  snapshot: GraphSnapshot,
  event: GraphEvent,
): GraphSnapshot {
  const nextSnapshot = cloneGraphSnapshot(snapshot);

  switch (event.eventType) {
    case "node_create": {
      const existingNodeIndex = nextSnapshot.nodes.findIndex(
        (node) => node.id === event.node.id,
      );

      if (existingNodeIndex >= 0) {
        nextSnapshot.nodes[existingNodeIndex] = event.node;
      } else {
        nextSnapshot.nodes.push(event.node);
      }
      return nextSnapshot;
    }
    case "edge_create": {
      const existingEdgeIndex = nextSnapshot.edges.findIndex(
        (edge) => edge.id === event.edge.id,
      );

      if (existingEdgeIndex >= 0) {
        nextSnapshot.edges[existingEdgeIndex] = event.edge;
      } else {
        nextSnapshot.edges.push(event.edge);
      }
      return nextSnapshot;
    }
    case "edge_update": {
      const edgeIndex = nextSnapshot.edges.findIndex((edge) => edge.id === event.id);
      if (edgeIndex < 0) {
        return nextSnapshot;
      }

      const edge = nextSnapshot.edges[edgeIndex];
      nextSnapshot.edges[edgeIndex] = {
        ...edge,
        weight: event.newWeight ?? edge.weight,
        properties: {
          ...(edge.properties ?? {}),
          ...(event.newProperties ?? {}),
        },
      };

      return nextSnapshot;
    }
    case "edge_delete":
      return {
        ...nextSnapshot,
        edges: nextSnapshot.edges.filter((edge) => edge.id !== event.id),
      };
  }
}

export function getEventTargetId(event: GraphEvent): string {
  switch (event.eventType) {
    case "node_create":
      return event.node.id;
    case "edge_create":
      return event.edge.id;
    case "edge_update":
    case "edge_delete":
      return event.id;
  }
}
