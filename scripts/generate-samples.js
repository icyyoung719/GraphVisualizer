const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filename, obj) {
  const filePath = path.join(dataDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${filePath}`);
}

// --- helpers ---

function makeNode(id, label, x, y, props = {}, aux = undefined) {
  const node = { id, label, x, y, properties: { ...props } };
  if (aux !== undefined) node.auxiliary = aux;
  return node;
}

function makeEdge(id, source, target, weight, label, props = {}, aux = undefined) {
  const edge = { id, source, target, weight, label, properties: { ...props } };
  if (aux !== undefined) edge.auxiliary = aux;
  return edge;
}

function nodeCreateEvent(node, timestampMs, reason) {
  const e = { eventType: 'node_create', timestampMs, node: { ...node } };
  if (reason) e.reason = reason;
  return e;
}

function edgeCreateEvent(edge, timestampMs, reason) {
  const e = { eventType: 'edge_create', timestampMs, edge: { ...edge } };
  if (reason) e.reason = reason;
  return e;
}

function edgeUpdateEvent(id, timestampMs, reason, newWeight, newProps) {
  const e = { eventType: 'edge_update', id, timestampMs };
  if (reason) e.reason = reason;
  if (newWeight !== undefined) e.newWeight = newWeight;
  if (newProps) e.newProperties = { ...newProps };
  return e;
}

function edgeDeleteEvent(id, timestampMs, reason) {
  const e = { eventType: 'edge_delete', id, timestampMs };
  if (reason) e.reason = reason;
  return e;
}

// --- 1. sample-events.json (legacy sample) ---

function generateLegacySample() {
  const nodes = [
    makeNode('A', 'Node A', 100, 100, { role: 'source' }),
    makeNode('B', 'Node B', 300, 100, { role: 'waypoint' }),
    makeNode('C', 'Node C', 500, 100, { role: 'target' }),
    makeNode('D', 'Node D', 300, 300, { role: 'waypoint' }),
  ];

  const edges = [
    makeEdge('A->B', 'A', 'B', 2, '2', { active: true }),
    makeEdge('B->C', 'B', 'C', 3, '3', { active: true }),
    makeEdge('A->D', 'A', 'D', 5, '5', { active: true }),
    makeEdge('D->C', 'D', 'C', 1, '1', { active: true }),
  ];

  const events = [
    edgeUpdateEvent('A->B', 500, 'Path A->B is under evaluation.', 2, { status: 'exploring', cumulativeCost: 2 }),
    edgeUpdateEvent('B->C', 1000, 'Path B->C confirmed as part of the best route.', 3, { status: 'best-path', cumulativeCost: 5 }),
    edgeDeleteEvent('A->D', 1500, 'Path A->D pruned — a cheaper alternative exists.'),
  ];

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 2. astar-sample-events.json ---

function generateAstarSample() {
  const nodes = [];
  const edges = [];
  const events = [];

  // Source node
  nodes.push(makeNode('S', 'S', 120, 160, { distance: 0, layer: 0, role: 'source' }));

  // 5 layers x 3 nodes per layer = 15 waypoint nodes
  for (let layer = 1; layer <= 5; layer++) {
    for (let idx = 0; idx < 3; idx++) {
      const id = `L${layer}_${idx}`;
      nodes.push(makeNode(id, id, 120 + layer * 150, 60 + idx * 110, { distance: layer * 2, layer, role: 'waypoint' }));
    }
  }

  // Target node
  nodes.push(makeNode('T', 'T', 120 + 6 * 150, 160, { distance: 12, layer: 6, role: 'target' }));

  // Create edges between consecutive layers (full bipartite)
  const layers = [];
  layers.push(['S']);
  for (let layer = 1; layer <= 5; layer++) {
    const layerNodes = [];
    for (let idx = 0; idx < 3; idx++) {
      layerNodes.push(`L${layer}_${idx}`);
    }
    layers.push(layerNodes);
  }
  layers.push(['T']);

  for (let li = 0; li + 1 < layers.length; li++) {
    for (const src of layers[li]) {
      for (const tgt of layers[li + 1]) {
        const weight = (src === 'S' && tgt === 'L1_0') || src.endsWith('_0') && tgt.endsWith('_0') ? 1 : (4 + Math.floor(Math.random() * 4));
        const edgeId = `${src}->${tgt}`;
        edges.push(makeEdge(edgeId, src, tgt, weight, `${weight}`, { relaxed: false, bestPath: false, step: 0 }));
      }
    }
  }

  // A* path events: confirm best path then prune others
  let ts = 500;
  const bestPathEdges = ['S->L1_0', 'L1_0->L2_0', 'L2_0->L3_0', 'L3_0->L4_0', 'L4_0->L5_0', 'L5_0->T'];
  let cumulativeCost = 0;
  for (const edgeId of bestPathEdges) {
    const edge = edges.find(e => e.id === edgeId);
    if (edge) {
      cumulativeCost += edge.weight;
      events.push(edgeUpdateEvent(edgeId, ts, 'A* confirmed this edge on the best path.', undefined, { status: 'best-path', relaxed: true, bestPath: true, cumulativeCost }));
      ts += 500;
    }
  }

  // Prune the rest
  for (const edge of edges) {
    if (!bestPathEdges.includes(edge.id)) {
      events.push(edgeDeleteEvent(edge.id, ts, 'A* pruned this branch after finding a cheaper route.'));
      ts += 350;
    }
  }

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 3. dijkstra-sample-events.json ---

function generateDijkstraSample() {
  const nodes = [];
  const edges = [];
  const events = [];

  // Source + 4 regions * 4 hubs = 16 regional nodes + source + target = 18 nodes
  nodes.push(makeNode('src', 'Source', 80, 160, { region: 0, hub: 0, distance: 0, role: 'source' }));

  for (let region = 1; region <= 3; region++) {
    for (let hub = 0; hub < 4; hub++) {
      const id = `R${region}_H${hub}`;
      nodes.push(makeNode(id, id, 80 + region * 180, 50 + hub * 100, { region, hub, distance: 999, role: 'waypoint' }));
    }
  }

  nodes.push(makeNode('dst', 'Target', 80 + 4 * 180, 160, { region: 4, hub: 0, distance: 999, role: 'target' }));

  // Connect adjacent regions (4 regions → 4 layers, 4 hubs each → 4*4*4 = 64 edges)
  let edgeIdCounter = 0;
  const regionNodes = [];
  regionNodes.push(['src']);
  for (let region = 1; region <= 3; region++) {
    const rn = [];
    for (let hub = 0; hub < 4; hub++) {
      rn.push(`R${region}_H${hub}`);
    }
    regionNodes.push(rn);
  }
  regionNodes.push(['dst']);

  for (let ri = 0; ri + 1 < regionNodes.length; ri++) {
    for (const src of regionNodes[ri]) {
      for (const tgt of regionNodes[ri + 1]) {
        const edgeId = `${src}->${tgt}`;
        const weight = 1 + Math.floor(Math.random() * 9);
        edges.push(makeEdge(edgeId, src, tgt, weight, `${weight}`, { settled: false, bestPath: false }));
        edgeIdCounter++;
      }
    }
  }

  // Events: simulate Dijkstra settling (ensure ≥20)
  let ts = 300;
  let eventCount = 0;
  const requiredEvents = 22;
  for (let i = 0; i < edges.length && events.length < requiredEvents; i++) {
    const edge = edges[i];
    eventCount++;
    events.push(edgeUpdateEvent(edge.id, ts, `Dijkstra evaluated edge ${edge.id}.`, undefined, { status: eventCount <= edges.length / 2 ? 'settled' : 'exploring', settled: true }));
    ts += 200;
    if (eventCount % 5 === 0 && events.length < requiredEvents) {
      events.push(edgeUpdateEvent(edges[i - 2]?.id ?? edge.id, ts, 'Marked as best-path candidate.', undefined, { status: 'best-path', bestPath: true }));
      ts += 150;
    }
  }

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 4. prim-sample-events.json ---

function generatePrimSample() {
  const nodes = [];
  const edges = [];
  const events = [];

  // 4 clusters x 4 nodes = 16 nodes
  for (let cluster = 0; cluster < 4; cluster++) {
    for (let idx = 0; idx < 4; idx++) {
      const id = `C${cluster}_${idx}`;
      nodes.push(makeNode(id, id, 100 + cluster * 180, 60 + idx * 110, { cluster, priority: idx === 0 ? 'frontier' : 'candidate', role: cluster === 0 ? 'source' : 'waypoint' }));
    }
  }

  // Dense edges within and between clusters
  for (const src of nodes) {
    for (const tgt of nodes) {
      if (src.id >= tgt.id) continue;
      const edgeId = `${src.id}->${tgt.id}`;
      const weight = 1 + Math.floor(Math.random() * 10);
      edges.push(makeEdge(edgeId, src.id, tgt.id, weight, `${weight}`, { mst: false, frontier: false }));
    }
  }

  // Events: MST growth
  let ts = 200;
  const mstEdges = [];
  let connected = new Set([nodes[0].id]);
  while (connected.size < nodes.length) {
    let bestEdge = null;
    let bestWeight = Infinity;
    for (const edge of edges) {
      const srcIn = connected.has(edge.source);
      const tgtIn = connected.has(edge.target);
      if (srcIn !== tgtIn && edge.weight < bestWeight) {
        bestEdge = edge;
        bestWeight = edge.weight;
      }
    }
    if (!bestEdge) break;
    mstEdges.push(bestEdge.id);
    connected.add(bestEdge.source);
    connected.add(bestEdge.target);
    events.push(edgeUpdateEvent(bestEdge.id, ts, 'Prim added this edge to the MST.', undefined, { status: 'best-path', mst: true }));
    ts += 300;
  }

  // Add frontier evaluation events
  let remaining = edges.filter(e => !mstEdges.includes(e.id));
  for (let i = 0; i < remaining.length && events.length < 25; i++) {
    events.push(edgeUpdateEvent(remaining[i].id, ts, 'Prim evaluated this frontier edge.', undefined, { status: 'evaluated', frontier: true }));
    ts += 200;
  }

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 5. kruskal-sample-events.json ---

function generateKruskalSample() {
  const nodes = [];
  const edges = [];
  const events = [];

  // 4 clusters x 4 nodes = 16 nodes
  for (let cluster = 0; cluster < 4; cluster++) {
    for (let idx = 0; idx < 4; idx++) {
      const id = `C${cluster}_${idx}`;
      nodes.push(makeNode(id, id, 100 + cluster * 180, 60 + idx * 110, { cluster, role: 'waypoint' }));
    }
  }

  // Dense edges
  for (const src of nodes) {
    for (const tgt of nodes) {
      if (src.id >= tgt.id) continue;
      const edgeId = `${src.id}->${tgt.id}`;
      const weight = 1 + Math.floor(Math.random() * 10);
      edges.push(makeEdge(edgeId, src.id, tgt.id, weight, `${weight}`, { mst: false, cycleDetected: false }));
    }
  }

  // Sort edges by weight (Kruskal's algorithm)
  edges.sort((a, b) => a.weight - b.weight);

  // Union-Find to simulate Kruskal
  const parent = {};
  function find(x) {
    if (!parent[x]) parent[x] = x;
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a, b) {
    parent[find(a)] = find(b);
  }

  let ts = 200;
  for (const edge of edges) {
    const srcRoot = find(edge.source);
    const tgtRoot = find(edge.target);
    if (srcRoot !== tgtRoot) {
      union(edge.source, edge.target);
      edge.properties.mst = true;
      events.push(edgeUpdateEvent(edge.id, ts, 'Kruskal added this edge to the MST (no cycle).', undefined, { status: 'best-path', mst: true }));
    } else {
      edge.properties.cycleDetected = true;
      events.push(edgeUpdateEvent(edge.id, ts, 'Kruskal rejected this edge (would create a cycle).', undefined, { status: 'pruned', cycleDetected: true }));
    }
    ts += 200;
  }

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 6. tsp-nearest-neighbor-sample-events.json ---

function generateTspSample() {
  const nodes = [];
  const edges = [];
  const events = [];

  // 12 cities on a circle
  const cityCount = 12;
  const centerX = 400, centerY = 250, radius = 180;
  for (let i = 0; i < cityCount; i++) {
    const angle = (2 * Math.PI * i) / cityCount;
    const x = Math.round(centerX + radius * Math.cos(angle));
    const y = Math.round(centerY + radius * Math.sin(angle));
    const id = `city_${i}`;
    nodes.push(makeNode(id, `City ${i}`, x, y, { visited: false, tourIndex: -1 }));
  }

  // Dense edges (complete graph, distances)
  for (let i = 0; i < cityCount; i++) {
    for (let j = i + 1; j < cityCount; j++) {
      const srcNode = nodes[i];
      const tgtNode = nodes[j];
      const dx = srcNode.x - tgtNode.x;
      const dy = srcNode.y - tgtNode.y;
      const weight = Math.round(Math.sqrt(dx * dx + dy * dy) / 10);
      const edgeId = `city_${i}->city_${j}`;
      edges.push(makeEdge(edgeId, `city_${i}`, `city_${j}`, weight, `${weight}`, { tourEdge: false }));
    }
  }

  // Nearest-neighbor tour construction
  let ts = 200;
  const visited = new Set();
  let current = 0;
  visited.add(current);
  nodes[current].properties.visited = true;
  nodes[current].properties.tourIndex = 0;

  for (let step = 1; step < cityCount; step++) {
    let nearestEdge = null;
    let nearestDist = Infinity;
    for (const edge of edges) {
      if (edge.source === `city_${current}` && !visited.has(parseInt(edge.target.split('_')[1]))) {
        if (edge.weight < nearestDist) {
          nearestDist = edge.weight;
          nearestEdge = edge;
        }
      } else if (edge.target === `city_${current}` && !visited.has(parseInt(edge.source.split('_')[1]))) {
        if (edge.weight < nearestDist) {
          nearestDist = edge.weight;
          nearestEdge = edge;
        }
      }
    }
    if (!nearestEdge) break;

    events.push(edgeUpdateEvent(nearestEdge.id, ts, `TSP tour step ${step}: selected from city ${current}.`, undefined, { status: 'best-path', tourEdge: true, step }));
    ts += 300;

    const nextCity = parseInt((nearestEdge.source === `city_${current}` ? nearestEdge.target : nearestEdge.source).split('_')[1]);
    visited.add(nextCity);
    nodes[nextCity].properties.visited = true;
    nodes[nextCity].properties.tourIndex = step;
    current = nextCity;
    nearestEdge.properties.tourEdge = true;
  }

  // Add more evaluation events
  for (let i = 0; i < edges.length && events.length < 22; i += 3) {
    const edge = edges[i];
    if (!edge.properties.tourEdge) {
      events.push(edgeUpdateEvent(edge.id, ts, 'TSP evaluated this edge but did not select it.', undefined, { status: 'evaluated' }));
      ts += 150;
    }
  }

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 7. hamiltonian-path-backtracking-sample-events.json ---

function generateHamiltonianSample() {
  const nodes = [];
  const edges = [];
  const events = [];

  // 4 layers x 3 width = 12 nodes + source + target = 14 nodes
  nodes.push(makeNode('start', 'Start', 80, 200, { layer: 0, role: 'source' }));

  for (let layer = 1; layer <= 3; layer++) {
    for (let idx = 0; idx < 3; idx++) {
      const id = `L${layer}_${idx}`;
      nodes.push(makeNode(id, id, 80 + layer * 170, 60 + idx * 120, { layer, visited: false, role: 'waypoint' }));
    }
  }

  nodes.push(makeNode('end', 'End', 80 + 4 * 170, 200, { layer: 4, role: 'target' }));

  // Edges between adjacent layers
  const layers = [['start']];
  for (let layer = 1; layer <= 3; layer++) {
    const layerNodes = [];
    for (let idx = 0; idx < 3; idx++) {
      layerNodes.push(`L${layer}_${idx}`);
    }
    layers.push(layerNodes);
  }
  layers.push(['end']);

  for (let li = 0; li + 1 < layers.length; li++) {
    for (const src of layers[li]) {
      for (const tgt of layers[li + 1]) {
        const edgeId = `${src}->${tgt}`;
        edges.push(makeEdge(edgeId, src, tgt, 1, '', { explored: false, backtracked: false, pathEdge: false }));
      }
    }
  }

  // Simulate backtracking search with exploration events
  let ts = 200;
  const requiredEvents = 22;

  // First, generate exploration events for many edges
  for (let i = 0; i < edges.length && events.length < requiredEvents - 4; i++) {
    const edge = edges[i];
    edge.properties.explored = true;
    events.push(edgeUpdateEvent(edge.id, ts, `Exploring edge ${edge.id} as candidate for Hamiltonian path.`, undefined, { status: 'exploring', explored: true }));
    ts += 200;
  }

  // Then walk a successful path
  const path = ['start', 'L1_0', 'L2_0', 'L3_0', 'end'];
  for (let i = 0; i < path.length - 1; i++) {
    const edgeId = `${path[i]}->${path[i + 1]}`;
    const edge = edges.find(e => e.id === edgeId);
    if (edge) {
      edge.properties.explored = true;
      edge.properties.pathEdge = true;
      events.push(edgeUpdateEvent(edgeId, ts, `${i === 0 ? 'Exploring' : 'Backtracking'} step: selected ${edgeId} for Hamiltonian path.`, undefined, { status: 'best-path', pathEdge: true }));
      ts += 300;
    }
  }

  // Mark remaining edges as backtracked (pruned)
  for (const edge of edges) {
    if (!edge.properties.pathEdge && Math.random() < 0.7) {
      edge.properties.backtracked = true;
      events.push(edgeUpdateEvent(edge.id, ts, 'Backtracked: dead end reached.', undefined, { status: 'pruned', backtracked: true }));
      ts += 200;
    }
  }

  return { schemaVersion: '1.0', graph: { nodes, edges }, events };
}

// --- 8. preview.graphdyvis.json ---

function generatePreviewSample() {
  return generateAstarSample();
}

// --- main ---

function main() {
  ensureDir(dataDir);

  writeJson('sample-events.json', generateLegacySample());
  writeJson('astar-sample-events.json', generateAstarSample());
  writeJson('dijkstra-sample-events.json', generateDijkstraSample());
  writeJson('prim-sample-events.json', generatePrimSample());
  writeJson('kruskal-sample-events.json', generateKruskalSample());
  writeJson('tsp-nearest-neighbor-sample-events.json', generateTspSample());
  writeJson('hamiltonian-path-backtracking-sample-events.json', generateHamiltonianSample());
  writeJson('preview.graphdyvis.json', generatePreviewSample());

  console.log('\nAll sample files generated.');
}

main();
