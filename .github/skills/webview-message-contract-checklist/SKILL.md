---
name: webview-message-contract-checklist
description: "Use when defining or changing VS Code extension WebView message contracts, including payload typing, message handlers, compatibility checks, and docs synchronization."
argument-hint: "Which message flow are you changing: extension-to-webview, webview-to-extension, or both?"
---

# WebView Message Contract Checklist

## Outcome
- Produce a safe, explicit message contract update with implementation and validation steps.
- Prevent message drift between WebView and extension host handlers.

## Project References
- [README.md](../../../README.md)
- [AGENTS.md](../../../AGENTS.md)
- [WebView Frontend Guidelines](../../instructions/webview-frontend.instructions.md)

## When To Use
- You add a new message type.
- You change payload fields for an existing message.
- You are debugging mismatches between sent and handled messages.
- You want a release checklist before merging WebView messaging changes.

## Procedure
1. Identify message direction and purpose.
2. Define contract shape and required fields.
3. Implement sender updates.
4. Implement receiver validation and fallback behavior.
5. Verify state update safety.
6. Verify interaction defaults still work.
7. Update protocol documentation.
8. Run completion checklist.

## Step Details

### 1) Identify message direction and purpose
- Extension to WebView: rendering updates, data delivery, event playback control.
- WebView to extension: user actions, commands, requests, telemetry-like diagnostics.

Decision:
- One-way notification if no response is required.
- Request/response pattern if UI must wait for host confirmation.

### 2) Define contract shape and required fields
- Include a stable type discriminator on every message.
- Document required vs optional fields.
- Define error payload shape for failure responses.

### 3) Implement sender updates
- Keep payload construction explicit and deterministic.
- Avoid emitting ambiguous field names.

### 4) Implement receiver validation and fallback behavior
- Validate required fields before mutating state.
- Ignore unknown message types safely.
- Surface malformed payload diagnostics without breaking the session.

### 5) Verify state update safety
- Ensure handlers are idempotent where repeated delivery is possible.
- Avoid partial state mutation when validation fails.

### 6) Verify interaction defaults still work
- Confirm search and focus still target expected nodes/edges.
- Confirm zoom/pan and selection state are preserved when safe after updates.
- Confirm node/edge property panels and event reason display still map correctly.

### 7) Update protocol documentation
- Update message contract documentation in [README.md](../../../README.md) for any added/changed fields.
- Add migration notes for any breaking contract change.

### 8) Run completion checklist
- Every handled message type has a documented payload shape.
- Unknown type handling is safe and explicit.
- Validation path is present before state mutation.
- Docs were updated in the same change.

## Quality Gates
- Message type names are stable and explicit.
- Receiver behavior is deterministic for valid and invalid payloads.
- Contract changes do not regress baseline UI interactions.
- Contract and docs stay synchronized.
