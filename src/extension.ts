import * as vscode from "vscode";

import { loadSampleGraphFile } from "./data/sampleLoader";
import {
  HostToWebviewMessage,
  PlaybackControlAction,
  PlaybackState,
  createErrorMessage,
  createInitDataMessage,
  createPlaybackStateMessage,
  isWebviewToHostMessage,
} from "./protocol/contracts";
import { GraphDataFile } from "./protocol/events";

const SHOW_VISUALIZATION_COMMAND = "graphdyvis.showVisualization";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_VISUALIZATION_COMMAND, () => {
      GraphVisualizerPanel.createOrShow(context);
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
  private readonly disposables: vscode.Disposable[] = [];

  private graphData: GraphDataFile | undefined;
  private playbackState: PlaybackState = {
    status: "paused",
    eventIndex: 0,
    totalEvents: 0,
  };

  static createOrShow(extensionContext: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (GraphVisualizerPanel.currentPanel) {
      GraphVisualizerPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      GraphVisualizerPanel.viewType,
      "GraphDyVis",
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
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionContext: vscode.ExtensionContext,
  ) {
    this.panel = panel;
    this.extensionContext = extensionContext;

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
        await this.handlePlaybackControl(rawMessage.action);
        return;
    }
  }

  private async handleReadyMessage(): Promise<void> {
    if (!this.graphData) {
      const sampleFileUri = vscode.Uri.joinPath(
        this.extensionContext.extensionUri,
        "data",
        "sample-events.json",
      );
      this.graphData = await loadSampleGraphFile(sampleFileUri);
      this.playbackState.totalEvents = this.graphData.events.length;
    }

    await this.postMessage(createInitDataMessage(this.graphData));
    await this.postMessage(createPlaybackStateMessage(this.playbackState));
  }

  private async handlePlaybackControl(
    action: PlaybackControlAction,
  ): Promise<void> {
    switch (action) {
      case "play":
        this.playbackState.status = "playing";
        break;
      case "pause":
        this.playbackState.status = "paused";
        break;
      case "step":
        this.playbackState.status = "paused";
        this.playbackState.eventIndex = Math.min(
          this.playbackState.totalEvents,
          this.playbackState.eventIndex + 1,
        );
        break;
      case "reset":
        this.playbackState.status = "paused";
        this.playbackState.eventIndex = 0;
        break;
    }

    await this.postMessage(createPlaybackStateMessage(this.playbackState));
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
      <div class="playback-group">
        <button data-action="play">Play</button>
        <button data-action="pause">Pause</button>
        <button data-action="step">Step</button>
        <button data-action="reset">Reset</button>
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
