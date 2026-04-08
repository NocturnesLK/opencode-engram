/**
 * sdk-bridge.ts - Backend-backed Session Resolution
 *
 * Keeps the existing import path while routing reads through HistoryBackend.
 */

import type { HistoryBackend } from "./history-backend.ts";

import {
  getParentSessionId as getBackendParentSessionId,
  resolveSessionTarget as resolveBackendSessionTarget,
} from "./history-backend.ts";

/**
 * Get the parentID from a session.
 *
 * Returns undefined if the session has no parent.
 */
export async function getParentSessionId(
  backend: HistoryBackend,
  sessionId: string,
): Promise<string | undefined> {
  return getBackendParentSessionId(backend, sessionId);
}

/**
 * Resolve a session target by session ID.
 */
export async function resolveSessionTarget(
  backend: HistoryBackend,
  sessionId: string,
) {
  return resolveBackendSessionTarget(backend, sessionId);
}
