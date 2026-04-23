import * as vscode from "vscode";

import { GraphDataFile, validateGraphDataFile } from "../protocol/events";

export async function loadSampleGraphFile(
  fileUri: vscode.Uri,
): Promise<GraphDataFile> {
  const rawBytes = await vscode.workspace.fs.readFile(fileUri);
  const fileText = Buffer.from(rawBytes).toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch (error) {
    throw new Error(
      `Unable to parse sample graph JSON from ${fileUri.path}: ${String(error)}`,
    );
  }

  return validateGraphDataFile(parsed);
}
