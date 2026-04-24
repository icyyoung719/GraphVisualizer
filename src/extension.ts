import * as vscode from "vscode";

import { loadSampleGraphFile } from "./data/sampleLoader";
import {
  HostToWebviewMessage,
  PlaybackState,
  WebviewToHostMessage,
  createErrorMessage,
  createInitDataMessage,
  createPlaybackStateMessage,
  createSettingsMessage,
  isWebviewToHostMessage,
} from "./protocol/contracts";
import { GraphDataFile } from "./protocol/events";
import {
  GraphDyVisSettings,
  GraphDyVisSettingsInput,
  MAX_PLAYBACK_SPEED_MULTIPLIER,
  MIN_PLAYBACK_SPEED_MULTIPLIER,
  normalizeGraphDyVisSettings,
} from "./protocol/settings";

const SHOW_VISUALIZATION_COMMAND = "graphdyvis.showVisualization";
const SHOW_AGGREGATION_VISUALIZATION_COMMAND = "graphdyvis.showAggregationDemo";
const SHOW_LEGACY_VISUALIZATION_COMMAND = "graphdyvis.showLegacyVisualization";
const DEFAULT_SAMPLE_FILE = "astar-sample-events.json";
const AGGREGATION_SAMPLE_FILE = "aggregation-sample-events.json";
const LEGACY_SAMPLE_FILE = "sample-events.json";
const PLAYBACK_INTERVAL_MS = 900;
const PLAYBACK_FRAME_MS = 33;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_VISUALIZATION_COMMAND, () => {
      GraphVisualizerPanel.createOrShow(context, DEFAULT_SAMPLE_FILE);
    }),
    vscode.commands.registerCommand(SHOW_AGGREGATION_VISUALIZATION_COMMAND, () => {
      GraphVisualizerPanel.createOrShow(context, AGGREGATION_SAMPLE_FILE);
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
  private playbackAccumulatorMs = 0;
  private lastPlaybackTickMs = 0;

  private graphData: GraphDataFile | undefined;
  private settings: GraphDyVisSettings;
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
      sampleFileName === DEFAULT_SAMPLE_FILE
        ? "GraphDyVis - A* Demo"
        : sampleFileName === AGGREGATION_SAMPLE_FILE
          ? "GraphDyVis - Aggregation Demo"
          : "GraphDyVis - Legacy Sample",
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
    this.settings = this.loadSettingsFromConfiguration();
    this.playbackState.speedMultiplier = this.settings.playback.defaultSpeed;

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleWebviewMessage(message);
      },
      null,
      this.disposables,
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("graphdyvis")) {
          return;
        }

        void this.handleConfigurationChanged();
      }),
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
    await this.postMessage(createSettingsMessage(this.settings));
    await this.broadcastPlaybackState();
  }

  private async handleConfigurationChanged(): Promise<void> {
    const previousDefaultSpeed = this.settings.playback.defaultSpeed;
    this.settings = this.loadSettingsFromConfiguration();

    if (
      this.playbackState.status === "paused" &&
      this.playbackState.eventIndex === 0 &&
      this.playbackState.speedMultiplier === previousDefaultSpeed
    ) {
      this.playbackState.speedMultiplier = this.settings.playback.defaultSpeed;
    }

    await this.postMessage(createSettingsMessage(this.settings));
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

    this.playbackAccumulatorMs = 0;
    this.lastPlaybackTickMs = Date.now();
    this.playbackTimer = setInterval(() => {
      void this.handlePlaybackTick();
    }, PLAYBACK_FRAME_MS);
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
    this.playbackAccumulatorMs = 0;
    this.lastPlaybackTickMs = 0;
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

    const now = Date.now();
    const deltaMs = this.lastPlaybackTickMs > 0 ? now - this.lastPlaybackTickMs : PLAYBACK_FRAME_MS;
    this.lastPlaybackTickMs = now;

    const eventIntervalMs = getPlaybackIntervalMs(this.playbackState.speedMultiplier);
    this.playbackAccumulatorMs += Math.min(250, Math.max(0, deltaMs));

    if (this.playbackAccumulatorMs < eventIntervalMs) {
      return;
    }

    const pendingEvents = this.playbackState.totalEvents - this.playbackState.eventIndex;
    const eventsToAdvance = Math.min(
      pendingEvents,
      Math.floor(this.playbackAccumulatorMs / eventIntervalMs),
    );

    this.playbackAccumulatorMs -= eventsToAdvance * eventIntervalMs;
    this.playbackState.eventIndex += eventsToAdvance;

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
        <input id="playback-speed" type="range" min="${MIN_PLAYBACK_SPEED_MULTIPLIER}" max="${MAX_PLAYBACK_SPEED_MULTIPLIER}" step="0.25" value="${this.settings.playback.defaultSpeed}" />
        <span id="playback-speed-label">${this.settings.playback.defaultSpeed}x</span>
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

  private loadSettingsFromConfiguration(): GraphDyVisSettings {
    const configuration = vscode.workspace.getConfiguration("graphdyvis");

    const input: GraphDyVisSettingsInput = {
      playback: {
        autoFocusOnEvent: configuration.get<boolean>("playback.autoFocusOnEvent"),
        defaultSpeed: configuration.get<number>("playback.defaultSpeed"),
      },
      aggregation: {
        enabled: configuration.get<boolean>("aggregation.enabled"),
        minTotalNodes: configuration.get<number>("aggregation.minTotalNodes"),
        minGroupSize: configuration.get<number>("aggregation.minGroupSize"),
        recentEventWindow: configuration.get<number>("aggregation.recentEventWindow"),
        autoCollapseOnFocusAway: configuration.get<boolean>(
          "aggregation.autoCollapseOnFocusAway",
        ),
        autoCollapseDelayMs: configuration.get<number>("aggregation.autoCollapseDelayMs"),
      },
    };

    return normalizeGraphDyVisSettings(input);
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

  return Math.min(
    MAX_PLAYBACK_SPEED_MULTIPLIER,
    Math.max(MIN_PLAYBACK_SPEED_MULTIPLIER, value ?? 1),
  );
}

function getPlaybackIntervalMs(speedMultiplier: number): number {
  return Math.max(100, Math.round(PLAYBACK_INTERVAL_MS / clampSpeedMultiplier(speedMultiplier)));
}
