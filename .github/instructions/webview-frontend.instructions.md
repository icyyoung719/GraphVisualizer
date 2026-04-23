---
description: "Use when implementing VS Code extension WebView UI, D3 graph rendering, message contracts, search/focus/zoom behavior, or node/edge property panels."
name: "WebView Frontend Guidelines"
applyTo:
  - "webview/**/*.{ts,tsx,js,jsx,html,css,scss}"
  - "src/webview/**/*.{ts,tsx,js,jsx,html,css,scss}"
  - "media/**/*.{ts,tsx,js,jsx,html,css,scss}"
---

# WebView Frontend Guidelines

Project context:
- [README.md](../../README.md)
- [AGENTS.md](../../AGENTS.md)

Scope:
- Applies to extension UI work only.
- Treat runtime algorithm/export code as out of scope unless message/schema changes are required.

Rendering defaults:
- Start with D3.js for rendering and interaction.
- Do not introduce WebGL-first rendering unless a measured performance issue justifies it.
- Keep layout algorithm-controlled by default; do not rely on manual layout tuning.

Message contract rules:
- Treat WebView <-> extension messages as a stable API.
- Define message names and payload types in one shared frontend contract module.
- Include a `type` discriminator for every message.
- Validate incoming message shape before mutating UI state.
- Ignore unknown message types safely, and surface parse/contract errors in UI diagnostics.
- If message/event fields change, update protocol documentation in [README.md](../../README.md) in the same change.

Interaction defaults (MVP):
- Enable pan and zoom.
- Support search and focus for node/edge lookup.
- Show node/edge properties on selection.
- Show event reasons for update/delete style operations.
- Keep advanced focus/hide/merge behavior behind explicit controls, not default behavior.

Update strategy:
- Prefer incremental D3 updates (keyed joins) over full redraw for small event deltas.
- Preserve interaction state (zoom, selection, focused node) across data refresh when safe.

Communication pattern:
- Use explicit `vscode.postMessage()` payloads from WebView.
- Keep message handlers deterministic and side-effect boundaries clear.
