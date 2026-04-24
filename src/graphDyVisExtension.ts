import * as path from "path";
import * as vscode from "vscode";

import { loadGraphDataFile } from "./data/sampleLoader";
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

const CUSTOM_EDITOR_VIEW_TYPE = "graphdyvis.visualizer";
const OPEN_PREVIEW_COMMAND = "graphdyvis.openPreview";
const PLAYBACK_INTERVAL_MS = 900;
const PLAYBACK_FRAME_MS = 33;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CUSTOM_EDITOR_VIEW_TYPE,
      new GraphDyVisReadonlyEditorProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    vscode.commands.registerCommand(OPEN_PREVIEW_COMMAND, () => {
      void openGraphDyVisPreview();
    }),
  );
}

export function deactivate(): void {
  // No persistent resources to tear down.
}

async function openGraphDyVisPreview(): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    return;
  }

  const { uri } = activeEditor.document;
  if (!isGraphDyVisDocumentUri(uri)) {
    return;
  }

  await vscode.commands.executeCommand("vscode.openWith", uri, CUSTOM_EDITOR_VIEW_TYPE);
}

function isGraphDyVisDocumentUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && uri.fsPath.toLowerCase().endsWith(".graphdyvis.json");
}

class GraphDyVisDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // Read-only custom document; no resources to release.
  }
}

class GraphDyVisReadonlyEditorProvider
  implements vscode.CustomReadonlyEditorProvider<GraphDyVisDocument>
{
  constructor(private readonly extensionContext: vscode.ExtensionContext) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): GraphDyVisDocument {
    return new GraphDyVisDocument(uri);
  }

  resolveCustomEditor(
    document: GraphDyVisDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    new GraphVisualizerPanel(webviewPanel, this.extensionContext, document.uri);
  }
}

class GraphVisualizerPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionContext: vscode.ExtensionContext;
  private readonly documentUri: vscode.Uri;
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

  constructor(
    panel: vscode.WebviewPanel,
    extensionContext: vscode.ExtensionContext,
    documentUri: vscode.Uri,
  ) {
    this.panel = panel;
    this.extensionContext = extensionContext;
    this.documentUri = documentUri;
    this.panel.webview.options = {
      enableScripts: true,
    };
    this.settings = this.loadSettingsFromConfiguration();
    this.playbackState.speedMultiplier = this.settings.playback.defaultSpeed;
    this.panel.title = `GraphDyVis - ${path.basename(this.documentUri.fsPath)}`;

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

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private async handleWebviewMessage(rawMessage: unknown): Promise<void> {
    if (!isWebviewToHostMessage(rawMessage)) {
      await this.postMessage(createErrorMessage("Ignored malformed WebView message payload."));
      return;
    }

    try {
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
    } catch (error) {
      console.error("GraphDyVis host error while handling webview message", error);
      await this.postMessage(
        createErrorMessage(
          formatErrorMessage(error, "Unable to load the GraphDyVis preview."),
        ),
      );
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

    this.graphData = await loadGraphDataFile(this.documentUri);
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
        <div id="details-panel">Select a node or edge.</div>

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
      appearance: {
        style: configuration.get<"polished" | "simple">("appearance.style"),
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

function formatErrorMessage(error: unknown, prefix: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return `${prefix} ${error.message}`;
  }

  if (typeof error === "string" && error.length > 0) {
    return `${prefix} ${error}`;
  }

  return prefix;
}