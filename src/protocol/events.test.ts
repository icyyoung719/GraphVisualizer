import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateGraphDataFile } from "./events";

function loadSample(relativePath: string): unknown {
  const sampleUrl = new URL(`../../${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(sampleUrl, "utf8"));
}

describe("validateGraphDataFile", () => {
  it("accepts the checked-in legacy sample", () => {
    const sample = loadSample("data/sample-events.json");

    const parsed = validateGraphDataFile(sample);

    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.graph.nodes).toHaveLength(4);
    expect(parsed.graph.edges).toHaveLength(4);
    expect(parsed.events).toHaveLength(3);
  });

  it("accepts a minimal graph payload", () => {
    const parsed = validateGraphDataFile({
      schemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "n1", label: "Node 1", x: 0, y: 0 },
        ],
        edges: [],
      },
      events: [
        {
          eventType: "node_create",
          timestampMs: 1,
          node: { id: "n2", label: "Node 2", x: 1, y: 1 },
        },
      ],
    });

    expect(parsed.graph.nodes).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      eventType: "node_create",
      timestampMs: 1,
    });
  });

  it("rejects missing required graph fields", () => {
    expect(() =>
      validateGraphDataFile({
        schemaVersion: "1.0",
        graph: {
          nodes: [],
        },
        events: [],
      }),
    ).toThrow("graph.nodes and graph.edges must be arrays.");
  });

  it("rejects invalid property values", () => {
    expect(() =>
      validateGraphDataFile({
        schemaVersion: "1.0",
        graph: {
          nodes: [
            {
              id: "n1",
              label: "Node 1",
              x: 0,
              y: 0,
              properties: {
                nested: { bad: true },
              },
            },
          ],
          edges: [],
        },
        events: [],
      }),
    ).toThrow("graph.nodes[0].properties.nested must be a primitive JSON value.");
  });

  it("rejects unsupported event types", () => {
    expect(() =>
      validateGraphDataFile({
        schemaVersion: "1.0",
        graph: {
          nodes: [],
          edges: [],
        },
        events: [
          {
            eventType: "node_delete",
            timestampMs: 1,
          },
        ],
      }),
    ).toThrow('events[0].eventType "node_delete" is not supported.');
  });

  it("rejects invalid event payload types", () => {
    expect(() =>
      validateGraphDataFile({
        schemaVersion: "1.0",
        graph: {
          nodes: [],
          edges: [],
        },
        events: [
          {
            eventType: "edge_update",
            id: 123,
            timestampMs: 1,
          },
        ],
      }),
    ).toThrow("events[0].id must be a string for edge_update.");
  });
});