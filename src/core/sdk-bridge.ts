/**
 * sdk-bridge.ts - SDK-backed Session Resolution
 *
 * Wires core abstractions to the OpenCode SDK for session reading.
 * Provides two low-level primitives:
 * - getParentSessionId: retrieve the parentID from a session
 * - resolveSessionTarget: load a session by ID and wrap as SessionTarget
 */

import type { createOpencodeClient } from "@opencode-ai/sdk";

import { createSessionTarget, type SdkSessionData } from "./session.ts";

type SdkClient = ReturnType<typeof createOpencodeClient>;

function toQuery(directory?: string): { directory: string } | undefined {
  if (!directory?.trim()) {
    return undefined;
  }
  return { directory };
}

async function getSessionOrThrow(
  client: SdkClient,
  sessionId: string,
  directory?: string,
): Promise<SdkSessionData> {
  const result = await client.session.get({
    path: { id: sessionId },
    query: toQuery(directory),
    throwOnError: false,
  });

  const status = result.response?.status ?? 0;
  if (status === 404) {
    throw new Error(`Session '${sessionId}' not found`);
  }
  if (result.error || status >= 400 || !result.data) {
    throw new Error(
      `Failed to load session '${sessionId}'. This may be a temporary issue — try again.`,
    );
  }

  return result.data;
}

/**
 * Get the parentID from a session.
 *
 * Returns undefined if the session has no parent.
 */
export async function getParentSessionId(
  client: SdkClient,
  sessionId: string,
  directory?: string,
): Promise<string | undefined> {
  const session = await getSessionOrThrow(client, sessionId, directory);
  return session.parentID || undefined;
}

/**
 * Resolve a session target by session ID.
 *
 * Loads the session data from the SDK and wraps it as a SessionTarget.
 */
export async function resolveSessionTarget(
  client: SdkClient,
  sessionId: string,
  directory?: string,
) {
  const session = await getSessionOrThrow(client, sessionId, directory);
  return createSessionTarget(session);
}
