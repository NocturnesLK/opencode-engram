import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { json } from "../common/common.ts";
import type { ResolvedDebugModeConfig } from "../common/config.ts";

export const transientSearchErrorMessage =
  "Failed to query messages. Try again or use history_browse_turns to lookup instead.";

export type ToolCallRecord = {
  tool: string;
  sessionID: string;
  messageID: string;
  targetSessionID?: string;
  args: Record<string, unknown>;
  output?: unknown;
  error?: string;
  time: string;
};

/**
 * Check if tool call logging is enabled.
 *
 * Respects `enable` as the highest priority:
 * - If `enable` is false, logging is disabled regardless of other settings.
 * - Otherwise, returns the value of `log_tool_calls`.
 */
export function isToolCallLoggingEnabled(debug: ResolvedDebugModeConfig): boolean {
  if (!debug.enable) {
    return false;
  }
  return debug.log_tool_calls;
}

/**
 * Check if any debug feature is enabled that requires directory setup.
 *
 * This checks if any feature that writes to `.engram/` is active,
 * respecting `enable` as the highest priority.
 */
export function isDebugDirectoryNeeded(debug: ResolvedDebugModeConfig): boolean {
  if (!debug.enable) {
    return false;
  }
  return debug.log_tool_calls;
}

export function estimateSerializedTokens(value: unknown): number {
  const bytes = Buffer.byteLength(json(value), "utf8");
  return Math.max(1, Math.ceil(bytes / 3));
}

export function estimateCallDurationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function getLoggedResponsePayload(record: ToolCallRecord): unknown {
  if (record.output !== undefined) {
    return record.output;
  }

  if (record.error !== undefined) {
    return { error: record.error };
  }

  return null;
}

export function formatDebugTimestamp(date = new Date()) {
  const year = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  const millisecond = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}_${hour}${minute}${second}${millisecond}`;
}

export function debugFileName(tool: string) {
  return `${formatDebugTimestamp()}-${tool}-${randomUUID().slice(0, 8)}.json`;
}

export function getToolCallLogDirectory(projectRoot: string, sessionID: string) {
  return join(projectRoot, ".engram", "log_tool_calls", sessionID);
}

export async function recordToolCall(
  record: ToolCallRecord,
  enabled: boolean,
  durationMs: number,
  projectRoot: string,
) {
  if (!enabled) return;

  const dir = getToolCallLogDirectory(projectRoot, record.sessionID);
  const filePath = join(dir, debugFileName(record.tool));

  try {
    const loggedRecord = {
      ...record,
      estimated_tokens: estimateSerializedTokens(getLoggedResponsePayload(record)),
      duration_ms: durationMs,
    };
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify(loggedRecord, null, 2), "utf8");
  } catch {
    return;
  }
}

export async function ensureDebugGitIgnore(projectRoot: string) {
  const engramDir = join(projectRoot, ".engram");
  const gitIgnorePath = join(engramDir, ".gitignore");
  const requiredEntries = ["log_tool_calls", ".gitignore"];

  try {
    await mkdir(engramDir, { recursive: true });

    let existing = "";
    try {
      existing = await readFile(gitIgnorePath, "utf8");
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        return;
      }
    }

    const existingLines = existing
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lineSet = new Set(existingLines);
    const missing = requiredEntries.filter((entry) => !lineSet.has(entry));

    if (missing.length === 0) {
      return;
    }

    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(gitIgnorePath, `${prefix}${missing.join("\n")}\n`, "utf8");
  } catch {
    // Ignore errors; best effort
  }
}
