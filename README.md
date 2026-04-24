# GraphDyVis / GraphVisualizer

A code-driven graph visualization VS Code extension prototype. The repository already includes a working Extension + WebView implementation, so it is no longer just a planning document set.
## Current Status

Implemented capabilities, aligned with the current codebase:
- VS Code commands: `GraphDyVis: Show A* Demo`, `GraphDyVis: Show Aggregation Demo`, `GraphDyVis: Show Legacy Sample`
- WebView + D3 rendering with a static snapshot and event playback
- Adaptive aggregation rendering: automatically groups low-focus nodes in large graphs and maps edges to summary links to reduce visual clutter
- Interactions: pan, zoom, search focus, and node/edge property panels
- Automatic expansion: clicking an aggregate node or playing an event that hits an element inside an aggregate expands it; focus search also expands the matching hidden aggregate first
- Automatic collapse recovery: after focus moves away from a temporarily expanded aggregate, it collapses again after a short delay
- Edge visuals: complex links keep curves to reduce crossings, while simple chains prefer straight lines; edge weight labels try to avoid edge lines and crossing zones
- Playback controls: Play / Pause / Step / Reset / speed adjustment (0.25x - 4x)
- Configurable settings: playback auto-focus/default speed and aggregation thresholds/auto-collapse behavior via VS Code settings (user/workspace scope)
- Event reason display: supports `reason`
- Protocol validation: Host/WebView messages and event JSON are validated at runtime, and invalid input is ignored safely
- Sample validation script: checks the baseline and A* event streams under `data/`
- Parser tests: automated regression coverage for graph JSON parsing

## Settings

GraphDyVis settings are available in the VS Code Settings UI and can be overridden per user or workspace.
Workspace-level template with comments: `.vscode/settings.json`.

Supported keys and defaults:

- `graphdyvis.playback.autoFocusOnEvent` (default: `true`)
- `graphdyvis.playback.defaultSpeed` (default: `1`, range: `0.25` to `4`)
- `graphdyvis.aggregation.enabled` (default: `true`)
- `graphdyvis.aggregation.minTotalNodes` (default: `20`, integer `>= 1`)
- `graphdyvis.aggregation.minGroupSize` (default: `4`, integer `>= 2`)
- `graphdyvis.aggregation.recentEventWindow` (default: `8`, integer `>= 1`)
- `graphdyvis.aggregation.autoCollapseOnFocusAway` (default: `true`)
- `graphdyvis.aggregation.autoCollapseDelayMs` (default: `220`, integer `>= 0`)
- `graphdyvis.appearance.style` (default: `"polished"`, options: `"polished" | "simple"`)

Behavior notes:

- When `graphdyvis.playback.autoFocusOnEvent` is disabled, playback still applies events and keeps automatic highlight, but no longer auto-focuses event targets.
- When `graphdyvis.aggregation.enabled` is disabled, aggregation is bypassed and full graph detail is rendered.
- When `graphdyvis.appearance.style` is `simple`, the details panel uses a raw JSON presentation with minimal styling.
## Structure and Key Files

- Extension entry point: `src/extension.ts`
- WebView frontend: `webview/main.ts`
- WebView styles: `media/webview.css`
- Message contract: `src/protocol/contracts.ts`
- Event protocol and playback application: `src/protocol/events.ts`
- Sample data: `data/astar-sample-events.json`, `data/sample-events.json`
- Sample validation: `scripts/validate-samples.js`
- C++ generic exporter: `examples/cpp/graphdyvis_export.hpp`
- C++ algorithm demos: `examples/cpp/astar_demo.cpp`, `examples/cpp/workflow_demo.cpp`
## Local Development

Prerequisites: Node.js 18+, VS Code.
Install dependencies:

```bash
npm install
```
Build:

```bash
npm run build
```
Check:

```bash
npm run check
npm run test
```
Optional split commands:

```bash
npm run check:ts
npm run check:samples
npm run test
npm run watch:extension
npm run watch:webview
```
CI runs on pull requests and pushes to `main`: TypeScript checks, sample validation, parser tests, and C++ example compilation, export, and validation.

Debug the extension:
1. Press `F5` in VS Code to launch the Extension Development Host.
2. Run `GraphDyVis: Show A* Demo` from the command palette in the new window.

To open the aggregation test sample, run `GraphDyVis: Show Aggregation Demo`.
## Event Protocol (`schemaVersion = "1.0"`)

Source of truth: `src/protocol/events.ts`
Top-level structure:

```json
{
  "schemaVersion": "1.0",
  "graph": {
    "nodes": [],
    "edges": []
  },
  "events": []
}
```
Event types:

- `node_create`
- `edge_create`
- `edge_update`
- `edge_delete`

Note: the current aggregation and expansion behavior is derived in the WebView rendering layer, so this phase does not change the event schema.
Shared fields:

- Required: `eventType`, `timestampMs`
- Optional: `reason`

Node/edge auxiliary metadata fields (additive):

- `graph.nodes[].auxiliary` (optional JSON)
- `graph.edges[].auxiliary` (optional JSON)
- `events[].newAuxiliary` for `edge_update` (optional JSON)

These fields are intended for rich non-algorithm metadata (debug context, source mapping, operational annotations) and are surfaced in the node/edge details panel.

Compatibility strategy:

- Prefer additive optional fields
- Unrecognized fields and event types are safely ignored by consumers
## Aggregation Behavior

- When the node count is large, the frontend automatically detects low-focus node groups and renders them as aggregate nodes.
- Aggregate edges are mapped to summary connections, such as `N edges`, to reduce dense crossings.
- Clicking an aggregate node expands it, and playback events that hit an element inside an aggregate also expand it automatically.
- During playback, broad update events (create/update/delete) automatically drive focus and highlight state. Node-target events emphasize the node and its incident edges; edge-target events emphasize endpoint nodes and, when present in the current frame, the event edge itself.
- When search or focus hits a node hidden inside an aggregate, the aggregate is expanded first and then the camera is positioned.
- When focus moves to another node or edge, aggregates that were temporarily expanded by focus collapse again after a short delay.
- For simple edge chains without noticeable crossing pressure, rendering prefers straight lines; complex relationships still keep curves to reduce crossings.
## WebView Message Contract (`contractVersion = "1.0"`)

Source of truth: `src/protocol/contracts.ts`
Host -> WebView:

- `init-data`
- `settings`
- `playback-state`
- `error`

WebView -> Host:
- `ready`
- `focus-request`
- `playback-control` (`play | pause | step | reset | set-speed`)

Contract rules:
- Every message has a `type`
- Host messages always carry `contractVersion`
- Receivers validate before updating state
## Future Directions, Not Yet Implemented

- Performance optimizations for larger graphs, with WebGL only considered after measuring a bottleneck
- Richer dynamic event types, such as prune and push-pop semantics
- Finer-grained incremental rendering and more advanced interaction strategies
