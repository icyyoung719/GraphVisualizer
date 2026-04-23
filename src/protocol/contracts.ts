import { GraphDataFile, validateGraphDataFile } from "./events";

export const CONTRACT_VERSION = "1.0" as const;

export type ContractVersion = typeof CONTRACT_VERSION;

export type PlaybackStatus = "playing" | "paused";
export type PlaybackControlAction = "play" | "pause" | "step" | "reset";

export interface PlaybackState {
  status: PlaybackStatus;
  eventIndex: number;
  totalEvents: number;
}

export interface InitDataMessage {
  type: "init-data";
  contractVersion: ContractVersion;
  payload: GraphDataFile;
}

export interface PlaybackStateMessage {
  type: "playback-state";
  contractVersion: ContractVersion;
  payload: PlaybackState;
}

export interface ErrorMessage {
  type: "error";
  contractVersion: ContractVersion;
  payload: {
    message: string;
  };
}

export type HostToWebviewMessage =
  | InitDataMessage
  | PlaybackStateMessage
  | ErrorMessage;

export interface ReadyMessage {
  type: "ready";
  contractVersion?: string;
}

export interface FocusRequestMessage {
  type: "focus-request";
  contractVersion?: string;
  targetId: string;
}

export interface PlaybackControlMessage {
  type: "playback-control";
  contractVersion?: string;
  action: PlaybackControlAction;
}

export type WebviewToHostMessage =
  | ReadyMessage
  | FocusRequestMessage
  | PlaybackControlMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWebviewToHostMessage(
  raw: unknown,
): raw is WebviewToHostMessage {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return false;
  }

  switch (raw.type) {
    case "ready":
      return true;
    case "focus-request":
      return typeof raw.targetId === "string" && raw.targetId.length > 0;
    case "playback-control":
      return (
        typeof raw.action === "string" &&
        ["play", "pause", "step", "reset"].includes(raw.action)
      );
    default:
      return false;
  }
}

function isPlaybackState(value: unknown): value is PlaybackState {
  return (
    isRecord(value) &&
    (value.status === "playing" || value.status === "paused") &&
    typeof value.eventIndex === "number" &&
    typeof value.totalEvents === "number"
  );
}

export function isHostToWebviewMessage(raw: unknown): raw is HostToWebviewMessage {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return false;
  }

  if (raw.contractVersion !== CONTRACT_VERSION) {
    return false;
  }

  switch (raw.type) {
    case "init-data":
      try {
        validateGraphDataFile(raw.payload);
        return true;
      } catch {
        return false;
      }
    case "playback-state":
      return isPlaybackState(raw.payload);
    case "error":
      return (
        isRecord(raw.payload) &&
        typeof raw.payload.message === "string" &&
        raw.payload.message.length > 0
      );
    default:
      return false;
  }
}

export function createInitDataMessage(payload: GraphDataFile): InitDataMessage {
  return {
    type: "init-data",
    contractVersion: CONTRACT_VERSION,
    payload,
  };
}

export function createPlaybackStateMessage(
  state: PlaybackState,
): PlaybackStateMessage {
  return {
    type: "playback-state",
    contractVersion: CONTRACT_VERSION,
    payload: state,
  };
}

export function createErrorMessage(message: string): ErrorMessage {
  return {
    type: "error",
    contractVersion: CONTRACT_VERSION,
    payload: {
      message,
    },
  };
}
