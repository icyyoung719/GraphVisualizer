# AGENTS.md

## Purpose
This repository contains a working VS Code extension prototype for graph algorithm visualization driven by JSON event streams.

Primary reference: [README.md](README.md)

If guidance here conflicts with the README, follow the README.

## Project Scope
- Keep the extension and WebView usable end to end with sample data.
- Evolve event-schema and message contracts safely while preserving compatibility.
- Improve rendering and interaction iteratively from the current working baseline.

## Architecture Boundaries
- Runtime library side (GraphDyVis, C++): emit graph/events data; keep this layer lightweight and rendering-agnostic.
- Extension frontend side (WebView): render and interact with data (search, focus, zoom, property panels, event reasons).
- Protocol layer: keep a stable JSON/event-stream contract between algorithm runtime and frontend renderer.

## Current Phase
- MVP baseline is already implemented (static rendering + playback + basic interaction).
- Prioritize correctness, contract clarity, and maintainability over speculative feature spikes.
- For advanced features, require measurable need and keep docs synchronized.

## Refactoring Policy
- You may boldly modify and refactor existing extension/WebView code when it improves correctness, clarity, or maintainability.
- Do not preserve legacy structure just for compatibility with old internal code shape.
- Keep external contracts stable unless an intentional contract/schema change is made and documented in [README.md](README.md).

## Project Conventions
- Prefer C++17 and modern language features on the runtime library side.
- Do not overuse smart pointers in C++ code.
- Keep node positioning/layout algorithm-controlled by default; do not depend on manual layout tuning.
- Prefer incremental rendering/update strategies over full redraws for small deltas.

## Frontend Guidance
- Start with D3.js for baseline rendering and interaction.
- Introduce WebGL-oriented rendering only when performance measurements justify it.
- Keep extension/frontend communication explicit via VS Code message passing patterns.

## Agent Working Rules
- Keep changes aligned to the current phase and documented priorities in [README.md](README.md).
- Preserve separation between event generation and rendering concerns.
- When adding new event types or fields, update protocol documentation in [README.md](README.md) as part of the same change.
- Do not assume build/test commands that are not documented. If needed, add them explicitly to docs in the same change.
