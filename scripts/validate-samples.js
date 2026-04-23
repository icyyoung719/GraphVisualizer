const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sampleFiles = [
  path.join(rootDir, 'data', 'sample-events.json'),
  path.join(rootDir, 'data', 'astar-sample-events.json'),
  path.join(rootDir, 'data', 'aggregation-sample-events.json'),
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function parseJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validatePropertyMap(value, pathLabel) {
  if (value === undefined) {
    return;
  }

  assert(isRecord(value), `${pathLabel} must be an object when provided.`);
  for (const [key, entryValue] of Object.entries(value)) {
    assert(isPrimitive(entryValue), `${pathLabel}.${key} must be a primitive JSON value.`);
  }
}

function validateNode(node, pathLabel) {
  assert(isRecord(node), `${pathLabel} must be an object.`);
  assert(typeof node.id === 'string' && node.id.length > 0, `${pathLabel}.id must be a non-empty string.`);
  assert(typeof node.label === 'string', `${pathLabel}.label must be a string.`);
  assert(typeof node.x === 'number' && typeof node.y === 'number', `${pathLabel}.x and ${pathLabel}.y must be numbers.`);
  validatePropertyMap(node.properties, `${pathLabel}.properties`);
}

function validateEdge(edge, pathLabel) {
  assert(isRecord(edge), `${pathLabel} must be an object.`);
  assert(typeof edge.id === 'string' && edge.id.length > 0, `${pathLabel}.id must be a non-empty string.`);
  assert(typeof edge.source === 'string' && typeof edge.target === 'string', `${pathLabel}.source and ${pathLabel}.target must be strings.`);
  if (edge.label !== undefined) {
    assert(typeof edge.label === 'string', `${pathLabel}.label must be a string when provided.`);
  }
  if (edge.weight !== undefined) {
    assert(typeof edge.weight === 'number', `${pathLabel}.weight must be a number when provided.`);
  }
  validatePropertyMap(edge.properties, `${pathLabel}.properties`);
}

function validateEvent(event, pathLabel) {
  assert(isRecord(event), `${pathLabel} must be an object.`);
  assert(typeof event.eventType === 'string', `${pathLabel}.eventType must be a string.`);
  assert(typeof event.timestampMs === 'number', `${pathLabel}.timestampMs must be a number.`);
  if (event.reason !== undefined) {
    assert(typeof event.reason === 'string', `${pathLabel}.reason must be a string when provided.`);
  }

  switch (event.eventType) {
    case 'node_create':
      validateNode(event.node, `${pathLabel}.node`);
      break;
    case 'edge_create':
      validateEdge(event.edge, `${pathLabel}.edge`);
      break;
    case 'edge_update':
      assert(typeof event.id === 'string', `${pathLabel}.id must be a string for edge_update.`);
      if (event.newWeight !== undefined) {
        assert(typeof event.newWeight === 'number', `${pathLabel}.newWeight must be a number when provided.`);
      }
      validatePropertyMap(event.newProperties, `${pathLabel}.newProperties`);
      break;
    case 'edge_delete':
      assert(typeof event.id === 'string', `${pathLabel}.id must be a string for edge_delete.`);
      break;
    default:
      throw new Error(`${pathLabel}.eventType "${event.eventType}" is not supported.`);
  }
}

function cloneGraph(graph) {
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

function applyEventToGraph(snapshot, event) {
  const next = cloneGraph(snapshot);

  switch (event.eventType) {
    case 'node_create': {
      const nodeIndex = next.nodes.findIndex((node) => node.id === event.node.id);
      if (nodeIndex >= 0) {
        next.nodes[nodeIndex] = event.node;
      } else {
        next.nodes.push(event.node);
      }
      return next;
    }
    case 'edge_create': {
      const edgeIndex = next.edges.findIndex((edge) => edge.id === event.edge.id);
      if (edgeIndex >= 0) {
        next.edges[edgeIndex] = event.edge;
      } else {
        next.edges.push(event.edge);
      }
      return next;
    }
    case 'edge_update': {
      const edgeIndex = next.edges.findIndex((edge) => edge.id === event.id);
      if (edgeIndex < 0) {
        return next;
      }
      const edge = next.edges[edgeIndex];
      next.edges[edgeIndex] = {
        ...edge,
        weight: event.newWeight ?? edge.weight,
        properties: {
          ...(edge.properties ?? {}),
          ...(event.newProperties ?? {}),
        },
      };
      return next;
    }
    case 'edge_delete':
      return {
        ...next,
        edges: next.edges.filter((edge) => edge.id !== event.id),
      };
    default:
      return next;
  }
}

function validateSampleFile(filePath) {
  const data = parseJson(filePath);
  assert(isRecord(data), `${filePath} must contain a JSON object.`);
  assert(typeof data.schemaVersion === 'string' && data.schemaVersion.length > 0, `${filePath}.schemaVersion must be a non-empty string.`);
  assert(isRecord(data.graph), `${filePath}.graph must be an object.`);
  assert(Array.isArray(data.graph.nodes), `${filePath}.graph.nodes must be an array.`);
  assert(Array.isArray(data.graph.edges), `${filePath}.graph.edges must be an array.`);
  assert(Array.isArray(data.events), `${filePath}.events must be an array.`);

  const nodeIds = new Set();
  for (const [index, node] of data.graph.nodes.entries()) {
    validateNode(node, `${filePath}.graph.nodes[${index}]`);
    assert(!nodeIds.has(node.id), `${filePath}.graph.nodes contains duplicate node id "${node.id}".`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set();
  for (const [index, edge] of data.graph.edges.entries()) {
    validateEdge(edge, `${filePath}.graph.edges[${index}]`);
    assert(!edgeIds.has(edge.id), `${filePath}.graph.edges contains duplicate edge id "${edge.id}".`);
    edgeIds.add(edge.id);
  }

  for (const [index, event] of data.events.entries()) {
    validateEvent(event, `${filePath}.events[${index}]`);
  }

  let workingGraph = cloneGraph(data.graph);
  for (const event of data.events) {
    workingGraph = applyEventToGraph(workingGraph, event);
  }

  return {
    nodeCount: data.graph.nodes.length,
    edgeCount: data.graph.edges.length,
    eventCount: data.events.length,
    finalEdgeCount: workingGraph.edges.length,
  };
}

function main() {
  const results = sampleFiles.map(validateSampleFile);
  const legacy = results[0];
  const astar = results[1];
  const aggregation = results[2];

  assert(astar.nodeCount >= 10, 'A* demo should contain at least 10 nodes for visualization testing.');
  assert(astar.eventCount >= 5, 'A* demo should contain enough events to exercise playback.');
  assert(astar.finalEdgeCount <= astar.edgeCount, 'Replay should not create more edges than the initial snapshot.');
  assert(legacy.eventCount > 0, 'Legacy sample should remain valid.');
  assert(aggregation.nodeCount >= 24, 'Aggregation demo should contain at least 24 nodes.');
  assert(aggregation.edgeCount >= 100, 'Aggregation demo should contain at least 100 edges.');
  assert(aggregation.eventCount >= 40, 'Aggregation demo should contain enough events to exercise playback expansion.');

  console.log(`Validated ${sampleFiles.length} sample files.`);
  for (let index = 0; index < sampleFiles.length; index += 1) {
    const result = results[index];
    console.log(`${path.relative(rootDir, sampleFiles[index])}: ${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.eventCount} events.`);
  }
}

main();
