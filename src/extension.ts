import * as vscode from "vscode";

import { loadSampleGraphFile } from "./data/sampleLoader";
import {
  HostToWebviewMessage,
  PlaybackState,
  WebviewToHostMessage,
  createErrorMessage,
  createInitDataMessage,
  createPlaybackStateMessage,
  isWebviewToHostMessage,
} from "./protocol/contracts";
import { GraphDataFile } from "./protocol/events";

const SHOW_VISUALIZATION_COMMAND = "graphdyvis.showVisualization";
const SHOW_LEGACY_VISUALIZATION_COMMAND = "graphdyvis.showLegacyVisualization";
const DEFAULT_SAMPLE_FILE = "astar-sample-events.json";
const LEGACY_SAMPLE_FILE = "sample-events.json";
const PLAYBACK_INTERVAL_MS = 900;
const MIN_SPEED_MULTIPLIER = 0.25;
const MAX_SPEED_MULTIPLIER = 4;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_VISUALIZATION_COMMAND, () => {
      GraphVisualizerPanel.createOrShow(context, DEFAULT_SAMPLE_FILE);
    }),
    vscode.commands.registerCommand(SHOW_LEGACY_VISUALIZATION_COMMAND, () => {
      GraphVisualizerPanel.createOrShow(context, LEGACY_SAMPLE_FILE);
    }),
  );
}

export function deactivate(): void {
  // No persistent resources to tear down.
}

class GraphVisualizerPanel {
  private static readonly viewType = "graphdyvis.visualizer";
  private static currentPanel: GraphVisualizerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionContext: vscode.ExtensionContext;
  private readonly sampleFileName: string;
  private readonly disposables: vscode.Disposable[] = [];
  private playbackTimer: ReturnType<typeof setInterval> | undefined;

  private graphData: GraphDataFile | undefined;
  private playbackState: PlaybackState = {
    status: "paused",
    eventIndex: 0,
    totalEvents: 0,
    speedMultiplier: 1,
  };

  static createOrShow(
    extensionContext: vscode.ExtensionContext,
    sampleFileName = DEFAULT_SAMPLE_FILE,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (
      GraphVisualizerPanel.currentPanel &&
      GraphVisualizerPanel.currentPanel.sampleFileName === sampleFileName
    ) {
      GraphVisualizerPanel.currentPanel.panel.reveal(column);
      return;
    }

    if (GraphVisualizerPanel.currentPanel) {
      GraphVisualizerPanel.currentPanel.dispose();
    }

    const panel = vscode.window.createWebviewPanel(
      GraphVisualizerPanel.viewType,
      sampleFileName === DEFAULT_SAMPLE_FILE ? "GraphDyVis - A* Demo" : "GraphDyVis - Legacy Sample",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionContext.extensionUri, "media"),
          vscode.Uri.joinPath(extensionContext.extensionUri, "data"),
        ],
      },
    );

    GraphVisualizerPanel.currentPanel = new GraphVisualizerPanel(
      panel,
      extensionContext,
      sampleFileName,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionContext: vscode.ExtensionContext,
    sampleFileName: string,
  ) {
    this.panel = panel;
    this.extensionContext = extensionContext;
    this.sampleFileName = sampleFileName;

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleWebviewMessage(message);
      },
      null,
      this.disposables,
    );
  }

  private dispose(): void {
    this.stopPlaybackTimer();
    GraphVisualizerPanel.currentPanel = undefined;

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private async handleWebviewMessage(rawMessage: unknown): Promise<void> {
    if (!isWebviewToHostMessage(rawMessage)) {
      await this.postMessage(
        createErrorMessage("Ignored malformed WebView message payload."),
      );
      return;
    }

    switch (rawMessage.type) {
      case "ready":
        await this.handleReadyMessage();
        return;
      case "focus-request":
        vscode.window.setStatusBarMessage(
          `GraphDyVis focus request: ${rawMessage.targetId}`,
          2500,
        );
        return;
      case "playback-control":
        await this.handlePlaybackControl(rawMessage);
        return;
    }
  }

  private async handleReadyMessage(): Promise<void> {
    const graphData = await this.ensureGraphDataLoaded();

    await this.postMessage(createInitDataMessage(graphData));
    await this.broadcastPlaybackState();
  }

  private async handlePlaybackControl(
    message: Extract<WebviewToHostMessage, { type: "playback-control" }>,
  ): Promise<void> {
    await this.ensureGraphDataLoaded();

    switch (message.action) {
      case "play":
        if (this.playbackState.eventIndex >= this.playbackState.totalEvents) {
          this.playbackState.status = "paused";
          await this.broadcastPlaybackState();
          return;
        }

        this.playbackState.status = "playing";
        this.restartPlaybackTimer();
        await this.broadcastPlaybackState();
        break;
      case "pause":
        this.stopPlaybackTimer();
        this.playbackState.status = "paused";
        await this.broadcastPlaybackState();
        break;
      case "step":
        this.stopPlaybackTimer();
        this.playbackState.status = "paused";
        this.playbackState.eventIndex = Math.min(
          this.playbackState.totalEvents,
          this.playbackState.eventIndex + 1,
        );
        await this.broadcastPlaybackState();
        break;
      case "reset":
        this.stopPlaybackTimer();
        this.playbackState.status = "paused";
        this.playbackState.eventIndex = 0;
        await this.broadcastPlaybackState();
        break;
      case "set-speed":
        this.playbackState.speedMultiplier = clampSpeedMultiplier(message.speedMultiplier);
        if (this.playbackState.status === "playing") {
          this.restartPlaybackTimer();
        }
        await this.broadcastPlaybackState();
        break;
    }
  }

  private async ensureGraphDataLoaded(): Promise<GraphDataFile> {
    if (this.graphData) {
      return this.graphData;
    }

    const sampleFileUri = vscode.Uri.joinPath(
      this.extensionContext.extensionUri,
      "data",
      this.sampleFileName,
    );
    this.graphData = await loadSampleGraphFile(sampleFileUri);
    this.playbackState.totalEvents = this.graphData.events.length;
    return this.graphData;
  }

  private async broadcastPlaybackState(): Promise<void> {
    await this.postMessage(createPlaybackStateMessage(this.playbackState));
  }

  private startPlaybackTimer(): void {
    if (this.playbackTimer) {
      return;
    }

    const intervalMs = getPlaybackIntervalMs(this.playbackState.speedMultiplier);
    this.playbackTimer = setInterval(() => {
      void this.handlePlaybackTick();
    }, intervalMs);
  }

  private restartPlaybackTimer(): void {
    this.stopPlaybackTimer();
    if (this.playbackState.status === "playing") {
      this.startPlaybackTimer();
    }
  }

  private stopPlaybackTimer(): void {
    if (!this.playbackTimer) {
      return;
    }

    clearInterval(this.playbackTimer);
    this.playbackTimer = undefined;
  }

  private async handlePlaybackTick(): Promise<void> {
    if (this.playbackState.status !== "playing") {
      this.stopPlaybackTimer();
      return;
    }

    if (this.playbackState.eventIndex >= this.playbackState.totalEvents) {
      this.playbackState.status = "paused";
      this.stopPlaybackTimer();
      await this.broadcastPlaybackState();
      return;
    }

    this.playbackState.eventIndex += 1;

    if (this.playbackState.eventIndex >= this.playbackState.totalEvents) {
      this.playbackState.status = "paused";
      this.stopPlaybackTimer();
    }

    await this.broadcastPlaybackState();
  }

  private async postMessage(message: HostToWebviewMessage): Promise<void> {
    await this.panel.webview.postMessage(message);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionContext.extensionUri, "media", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionContext.extensionUri, "media", "webview.css"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  />
  <link rel="stylesheet" href="${styleUri}" />
  <title>GraphDyVis</title>
</head>
<body>
  <div class="app-shell">
    <header class="toolbar">
      <div class="search-group">
        <label for="search-input">Focus ID</label>
        <input id="search-input" type="text" placeholder="node or edge id" />
        <button id="focus-button">Focus</button>
      </div>
      <div class="speed-group">
        <label for="playback-speed">Speed</label>
        <input id="playback-speed" type="range" min="0.25" max="4" step="0.25" value="1" />
        <span id="playback-speed-label">1x</span>
      </div>
      <div class="playback-group">
        <button id="playback-play" data-action="play">Play</button>
        <button id="playback-pause" data-action="pause">Pause</button>
        <button id="playback-step" data-action="step">Step</button>
        <button id="playback-reset" data-action="reset">Reset</button>
      </div>
      <div id="status-text" class="status-text">Waiting for data...</div>
    </header>

    <main class="content-layout">
      <section class="graph-pane" id="graph-pane">
        <svg id="graph-svg" aria-label="Graph visualization canvas"></svg>
      </section>

      <aside class="detail-pane">
        <h2>Element Details</h2>
        <pre id="details-json">Select a node or edge.</pre>

        <h2>Event Log</h2>
        <ul id="event-log"></ul>
      </aside>
    </main>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function clampSpeedMultiplier(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 1;
  }

  return Math.min(MAX_SPEED_MULTIPLIER, Math.max(MIN_SPEED_MULTIPLIER, value ?? 1));
}

function getPlaybackIntervalMs(speedMultiplier: number): number {
  return Math.max(100, Math.round(PLAYBACK_INTERVAL_MS / clampSpeedMultiplier(speedMultiplier)));
}
