import { computeTurns, type TurnComputeItem } from "../domain/domain.ts";
import type { PluginInput } from "../common/common.ts";
import type { HistoryBackend } from "../core/history-backend.ts";
import {
  buildFingerprint,
  clearTurnCache,
  getTurnMapWithCache,
  type SessionFingerprint,
} from "../core/turn-index.ts";
import type { SessionTarget } from "../core/index.ts";
import type { Logger } from "./logger.ts";
import {
  type MessagePage,
  getAllMessages,
  internalScanPageSize,
} from "./message-io.ts";

/**
 * Build a session fingerprint for turn cache invalidation.
 *
 * Uses version and updated time from session metadata.
 * Returns undefined if metadata is unavailable.
 */
export function getSessionFingerprint(
  root: SessionTarget["session"],
): SessionFingerprint | undefined {
  const version = root.version;
  const updated = root.updatedAt;
  if (version === undefined || updated === undefined) {
    return undefined;
  }

  return buildFingerprint(version, updated);
}

/**
 * Fetch turn items from all messages in the upstream history.
 *
 * This is the fetch callback used by turn cache operations.
 * Optionally accepts a seed page to avoid re-fetching the first page.
 */
export async function fetchTurnItems(
  input: PluginInput,
  sessionId: string,
  scanPageSize: number,
  seedPage?: MessagePage,
  backend?: HistoryBackend,
): Promise<TurnComputeItem[]> {
  const allMessages = await getAllMessages(input, sessionId, scanPageSize, seedPage, backend);
  return allMessages.map((msg): TurnComputeItem => ({
    id: msg.info.id,
    role: msg.info.role === "user" ? "user" : "assistant",
    time: msg.info.time?.created,
  }));
}

/**
 * Retrieve a turn map with cache, falling back to rebuild if needed.
 *
 * Handles the common pattern of:
 * 1. Attempt cache hit
 * 2. Check for missing IDs
 * 3. Clear cache and rebuild if stale
 *
 * @param input Plugin input for message fetching
 * @param target Resolved session target metadata
 * @param seedPage Optional seed page to avoid duplicate fetches
 * @param requiredIds Message IDs that must be present in the turn map
 * @param journal Logger for debug output
 * @returns Turn map guaranteed to contain all required IDs (or throws)
 */
export async function getTurnMapWithFallback(
  input: PluginInput,
  target: SessionTarget,
  seedPage: MessagePage | undefined,
  requiredIds: string[],
  journal: Logger,
  backend?: HistoryBackend,
): Promise<Map<string, number>> {
  const targetSession = target.session;
  const fingerprint = getSessionFingerprint(targetSession);

  const { turnMap: initialTurnMap } = await getTurnMapWithCache(
    targetSession.id,
    fingerprint,
    () => fetchTurnItems(input, targetSession.id, internalScanPageSize, seedPage, backend),
    computeTurns,
    journal,
  );

  // Check if all required IDs are present
  const missingIds = requiredIds.filter((id) => initialTurnMap.get(id) === undefined);
  if (missingIds.length === 0) {
    return initialTurnMap;
  }

  // Cache is stale - clear and rebuild
  journal.debug("turn map missing required ids, rebuilding from full scan", {
    targetSessionID: targetSession.id,
    missingCount: missingIds.length,
    missingIDs: missingIds,
  });

  clearTurnCache(targetSession.id);
  const { turnMap: rebuiltTurnMap } = await getTurnMapWithCache(
    targetSession.id,
    fingerprint,
    () => fetchTurnItems(input, targetSession.id, internalScanPageSize, seedPage, backend),
    computeTurns,
    journal,
  );

  return rebuiltTurnMap;
}
