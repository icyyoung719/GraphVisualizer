# AGENTS.md

## Purpose
This repository currently contains product and architecture planning for a DAG shortest-path visualization tool integrated with a VS Code extension.

Primary reference: [README.md](README.md)

If guidance here conflicts with the README, follow the README.

## Project Scope
- Build a code-driven DAG visualization workflow for shortest-path algorithm execution.
- Support both static graph rendering and dynamic event playback.
- Integrate visualization into a VS Code extension WebView UI.

## Architecture Boundaries
- Runtime library side (GraphDyVis, C++): emit graph/events data; keep this layer lightweight and rendering-agnostic.
- Extension frontend side (WebView): render and interact with data (search, focus, zoom, property panels, event reasons).
- Protocol layer: keep a stable JSON/event-stream contract between algorithm runtime and frontend renderer.

## Implementation Order
Follow the phased delivery from [README.md](README.md):
1. MVP first: event export, static graph rendering, node/edge property display.
2. Then dynamic playback features (push/pop, prune, edge updates with reasons).
3. Then optimization and advanced UX (GPU/layout scaling, merge strategies, smart focus behavior).

Avoid implementing advanced visualization effects before the MVP path is working end to end.

## Project Conventions
- Prefer C++17 and modern language features on the runtime library side.
- Do not overuse smart pointers in C++ code.
- Keep node positioning/layout algorithm-controlled by default; do not depend on manual layout tuning.
- Prefer incremental rendering/update strategies once dynamic mode exists, rather than full redraws for every change.

## Frontend Guidance
- Start with D3.js for baseline rendering and interaction.
- Introduce WebGL-oriented rendering only when performance measurements justify it.
- Keep extension/frontend communication explicit via VS Code message passing patterns.

## Agent Working Rules
- Keep changes aligned to the current phase (MVP before advanced features).
- Preserve separation between event generation and rendering concerns.
- When adding new event types or fields, update protocol documentation in [README.md](README.md) as part of the same change.
- Do not assume build/test commands that are not documented. If needed, add them explicitly to docs in the same change.
