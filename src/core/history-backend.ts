import type { HistoryMessageBundle } from "../domain/types.ts";

import { createSessionTarget, type HistorySessionData } from "./session.ts";

export interface HistoryMessagePage {
  msgs: HistoryMessageBundle[];
  nextCursor: string | undefined;
}

export interface HistoryBackend {
  getSession(sessionId: string): Promise<HistorySessionData>;
  listMessages(
    sessionId: string,
    options: {
      limit: number;
      before?: string;
    },
  ): Promise<HistoryMessagePage>;
  getMessage(sessionId: string, messageId: string): Promise<HistoryMessageBundle>;
}

/**
 * Resolve a session target through the backend.
 */
export async function resolveSessionTarget(
  backend: HistoryBackend,
  sessionId: string,
) {
  const session = await backend.getSession(sessionId);
  return createSessionTarget(session);
}

/**
 * Read the parent session id through the backend.
 */
export async function getParentSessionId(
  backend: HistoryBackend,
  sessionId: string,
): Promise<string | undefined> {
  const session = await backend.getSession(sessionId);
  return session.parentID || undefined;
}
