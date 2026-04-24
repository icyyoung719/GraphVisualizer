export const MIN_PLAYBACK_SPEED_MULTIPLIER = 0.25;
export const MAX_PLAYBACK_SPEED_MULTIPLIER = 4;

export interface GraphDyVisPlaybackSettings {
  autoFocusOnEvent: boolean;
  defaultSpeed: number;
}

export interface GraphDyVisAggregationSettings {
  enabled: boolean;
  minTotalNodes: number;
  minGroupSize: number;
  recentEventWindow: number;
  autoCollapseOnFocusAway: boolean;
  autoCollapseDelayMs: number;
}

export interface GraphDyVisSettings {
  playback: GraphDyVisPlaybackSettings;
  aggregation: GraphDyVisAggregationSettings;
}

export interface GraphDyVisSettingsInput {
  playback?: Partial<GraphDyVisPlaybackSettings>;
  aggregation?: Partial<GraphDyVisAggregationSettings>;
}

export const DEFAULT_GRAPH_DY_VIS_SETTINGS: GraphDyVisSettings = {
  playback: {
    autoFocusOnEvent: true,
    defaultSpeed: 1,
  },
  aggregation: {
    enabled: true,
    minTotalNodes: 20,
    minGroupSize: 4,
    recentEventWindow: 8,
    autoCollapseOnFocusAway: true,
    autoCollapseDelayMs: 220,
  },
};

function clampNumber(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function normalizeInteger(value: unknown, defaultValue: number, minValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.max(minValue, Math.round(value));
}

export function normalizePlaybackSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRAPH_DY_VIS_SETTINGS.playback.defaultSpeed;
  }

  return clampNumber(value, MIN_PLAYBACK_SPEED_MULTIPLIER, MAX_PLAYBACK_SPEED_MULTIPLIER);
}

export function normalizeGraphDyVisSettings(
  input: GraphDyVisSettingsInput | undefined,
): GraphDyVisSettings {
  return {
    playback: {
      autoFocusOnEvent:
        typeof input?.playback?.autoFocusOnEvent === "boolean"
          ? input.playback.autoFocusOnEvent
          : DEFAULT_GRAPH_DY_VIS_SETTINGS.playback.autoFocusOnEvent,
      defaultSpeed: normalizePlaybackSpeed(input?.playback?.defaultSpeed),
    },
    aggregation: {
      enabled:
        typeof input?.aggregation?.enabled === "boolean"
          ? input.aggregation.enabled
          : DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation.enabled,
      minTotalNodes: normalizeInteger(
        input?.aggregation?.minTotalNodes,
        DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation.minTotalNodes,
        1,
      ),
      minGroupSize: normalizeInteger(
        input?.aggregation?.minGroupSize,
        DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation.minGroupSize,
        2,
      ),
      recentEventWindow: normalizeInteger(
        input?.aggregation?.recentEventWindow,
        DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation.recentEventWindow,
        1,
      ),
      autoCollapseOnFocusAway:
        typeof input?.aggregation?.autoCollapseOnFocusAway === "boolean"
          ? input.aggregation.autoCollapseOnFocusAway
          : DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation.autoCollapseOnFocusAway,
      autoCollapseDelayMs: normalizeInteger(
        input?.aggregation?.autoCollapseDelayMs,
        DEFAULT_GRAPH_DY_VIS_SETTINGS.aggregation.autoCollapseDelayMs,
        0,
      ),
    },
  };
}

export function isGraphDyVisSettings(raw: unknown): raw is GraphDyVisSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }

  const value = raw as {
    playback?: {
      autoFocusOnEvent?: unknown;
      defaultSpeed?: unknown;
    };
    aggregation?: {
      enabled?: unknown;
      minTotalNodes?: unknown;
      minGroupSize?: unknown;
      recentEventWindow?: unknown;
      autoCollapseOnFocusAway?: unknown;
      autoCollapseDelayMs?: unknown;
    };
  };

  return (
    typeof value.playback?.autoFocusOnEvent === "boolean" &&
    typeof value.playback?.defaultSpeed === "number" &&
    Number.isFinite(value.playback.defaultSpeed) &&
    value.playback.defaultSpeed >= MIN_PLAYBACK_SPEED_MULTIPLIER &&
    value.playback.defaultSpeed <= MAX_PLAYBACK_SPEED_MULTIPLIER &&
    typeof value.aggregation?.enabled === "boolean" &&
    typeof value.aggregation?.minTotalNodes === "number" &&
    Number.isInteger(value.aggregation.minTotalNodes) &&
    value.aggregation.minTotalNodes >= 1 &&
    typeof value.aggregation?.minGroupSize === "number" &&
    Number.isInteger(value.aggregation.minGroupSize) &&
    value.aggregation.minGroupSize >= 2 &&
    typeof value.aggregation?.recentEventWindow === "number" &&
    Number.isInteger(value.aggregation.recentEventWindow) &&
    value.aggregation.recentEventWindow >= 1 &&
    typeof value.aggregation?.autoCollapseOnFocusAway === "boolean" &&
    typeof value.aggregation?.autoCollapseDelayMs === "number" &&
    Number.isInteger(value.aggregation.autoCollapseDelayMs) &&
    value.aggregation.autoCollapseDelayMs >= 0
  );
}
