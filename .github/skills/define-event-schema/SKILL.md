---
name: define-event-schema
description: "Use when adding or evolving DAG visualization event JSON schema, including schema update, sample event log updates, parser/consumer update checks, and protocol docs sync."
argument-hint: "What schema change is needed: new event type, new fields, renamed fields, or compatibility update?"
---

# Define Event Schema

## Outcome
- Produce a consistent schema change plan and implementation checklist.
- Keep producer, consumer, and documentation aligned for the same schema revision.

## Project References
- [README.md](../../../README.md)
- [AGENTS.md](../../../AGENTS.md)
- [WebView Frontend Guidelines](../../instructions/webview-frontend.instructions.md)

## When To Use
- You are introducing a new event type.
- You are adding, renaming, or removing event fields.
- You are changing semantics of an existing field.
- You need to ensure parser and docs stay in sync with event payload changes.

## Procedure
1. Define the schema change scope.
2. Classify compatibility impact.
3. Update canonical schema specification.
4. Add or refresh sample event logs.
5. Update producer-side export mapping.
6. Update consumer-side parser and guards.
7. Update UI-facing event usage where needed.
8. Update protocol documentation.
9. Run completion checks.

## Step Details

### 1) Define the schema change scope
- Record event name, triggering condition, and required fields.
- Record optional fields and default behavior when omitted.
- Record whether reason/context fields are required for user-visible changes.

### 2) Classify compatibility impact
- Additive change: new optional fields or event types that old consumers can ignore.
- Breaking change: renamed/removed required fields or changed meaning of existing fields.

Decision:
- If additive, keep existing payloads valid and treat new fields as optional in consumers.
- If breaking, introduce a documented versioning strategy and migration notes in docs.

### 3) Update canonical schema specification
- Define each field with type, required status, and semantic meaning.
- Define ordering/timing semantics if event sequence matters.

### 4) Add or refresh sample event logs
- Provide at least one minimal valid example and one realistic full example.
- For breaking changes, include old-vs-new examples in migration notes.

### 5) Update producer-side export mapping
- Ensure producer emits required fields on every matching event.
- Ensure optional fields are omitted or defaulted consistently.

### 6) Update consumer-side parser and guards
- Validate required fields before state mutation.
- Ignore unknown fields safely.
- Handle unknown event types without crashing.

### 7) Update UI-facing event usage where needed
- Ensure reasons and property details needed by UI are populated.
- Keep advanced rendering behavior out of schema changes unless explicitly requested.

### 8) Update protocol documentation
- Update protocol text in [README.md](../../../README.md) when fields or event types change.
- Add a concise migration note for breaking changes.

### 9) Run completion checks
- Every new/changed event has field definitions and examples.
- Producer and consumer agree on required fields and defaults.
- Parser behavior for unknown fields/event types is explicit.
- Docs and sample logs reflect the final payload shape.

## Quality Gates
- No undocumented event field appears in emitted payloads.
- No required field is missing from sample logs.
- Contract changes are visible in docs in the same change.
- Compatibility impact is explicitly labeled as additive or breaking.
