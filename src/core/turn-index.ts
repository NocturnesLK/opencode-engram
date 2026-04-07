/**
 * turn-index.ts - Reusable Turn Cache for Upstream History
 *
 * This module provides a session-scoped turn cache that:
 * - Computes turn mappings once per session version
 * - Invalidates when session metadata changes (version/updated time)
 * - Falls back to full scan when cache unavailable or stale
 * - Logs cache hit/rebuild/fallback events
 */

import type { TurnComputeItem } from "../domain/domain.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Session fingerprint used for cache invalidation.
 * Combines version and updated time to detect any upstream changes.
 */
export interface SessionFingerprint {
  version: number;
  updated: number;
}

/**
 * Cached turn index entry for a session.
 */
interface TurnCacheEntry {
  fingerprint: SessionFingerprint;
  turnMap: Map<string, number>;
  cachedAt: number;
}

const turnCacheTtlMs = 10 * 60 * 1000;
const turnCacheMaxEntries = 128;

/**
 * Logger interface matching the runtime logger shape.
 */
export interface TurnCacheLogger {
  debug: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * Callback type for fetching all messages and computing turn items.
 */
export type FetchTurnItems = () => Promise<TurnComputeItem[]>;

/**
 * Callback type for computing turns from items.
 * Matches the signature of computeTurns from domain.ts.
 */
export type ComputeTurnsFn = (items: TurnComputeItem[]) => Map<string, number>;

// =============================================================================
// Turn Cache Implementation
// =============================================================================

/**
 * In-memory turn cache keyed by session ID.
 */
const turnCache = new Map<string, TurnCacheEntry>();

function pruneTurnCache(now = Date.now()) {
  for (const [sessionId, entry] of turnCache) {
    if (now - entry.cachedAt > turnCacheTtlMs) {
      turnCache.delete(sessionId);
    }
  }

  while (turnCache.size > turnCacheMaxEntries) {
    const oldest = turnCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    turnCache.delete(oldest);
  }
}

/**
 * Compare two fingerprints for equality.
 */
function fingerprintsMatch(a: SessionFingerprint, b: SessionFingerprint): boolean {
  return a.version === b.version && a.updated === b.updated;
}

/**
 * Build a fingerprint from session metadata.
 */
export function buildFingerprint(version: number, updated: number): SessionFingerprint {
  return { version, updated };
}

/**
 * Get cached turn map if valid, otherwise return undefined.
 *
 * @param sessionId Session ID to look up
 * @param fingerprint Current session fingerprint for validation
 * @returns Cached turn map if valid, undefined if stale/missing
 */
export function getTurnCache(
  sessionId: string,
  fingerprint: SessionFingerprint,
): Map<string, number> | undefined {
  pruneTurnCache();
  const entry = turnCache.get(sessionId);
  if (!entry) {
    return undefined;
  }

  if (!fingerprintsMatch(entry.fingerprint, fingerprint)) {
    turnCache.delete(sessionId);
    return undefined;
  }

  // Refresh insertion order to keep hot entries in this bounded cache.
  turnCache.delete(sessionId);
  turnCache.set(sessionId, entry);

  return entry.turnMap;
}

/**
 * Store turn map in cache.
 *
 * @param sessionId Session ID to cache for
 * @param fingerprint Session fingerprint at time of computation
 * @param turnMap Computed turn map
 */
export function setTurnCache(
  sessionId: string,
  fingerprint: SessionFingerprint,
  turnMap: Map<string, number>,
): void {
  turnCache.delete(sessionId);
  turnCache.set(sessionId, {
    fingerprint,
    turnMap,
    cachedAt: Date.now(),
  });
  pruneTurnCache();
}

/**
 * Clear turn cache for a specific session.
 */
export function clearTurnCache(sessionId: string): void {
  turnCache.delete(sessionId);
}

// =============================================================================
// High-Level API
// =============================================================================

/**
 * Result of getTurnMapWithCache operation.
 */
export interface TurnCacheResult {
  turnMap: Map<string, number>;
  source: "hit" | "rebuild" | "fallback";
}

/**
 * Get turn map with caching support.
 *
 * This is the main entry point for turn cache usage.
 * It handles:
 * - Cache hit: return cached turn map immediately
 * - Cache miss/stale: rebuild from full scan
 * - Fallback: if fingerprint unavailable, always do full scan
 *
 * @param sessionId Session ID for cache key
 * @param fingerprint Current session fingerprint (undefined triggers fallback)
 * @param fetchItems Callback to fetch turn items if rebuild needed
 * @param computeTurnsFn Function to compute turns from items
 * @param logger Optional logger for cache events
 * @returns Turn map and source indicator
 */
export async function getTurnMapWithCache(
  sessionId: string,
  fingerprint: SessionFingerprint | undefined,
  fetchItems: FetchTurnItems,
  computeTurnsFn: ComputeTurnsFn,
  logger?: TurnCacheLogger,
): Promise<TurnCacheResult> {
  // Fallback mode: no fingerprint means no caching possible
  if (fingerprint === undefined) {
    logger?.debug("turn cache fallback (no fingerprint)", { sessionId });
    const items = await fetchItems();
    const turnMap = computeTurnsFn(items);
    return { turnMap, source: "fallback" };
  }

  // Try cache hit
  const cached = getTurnCache(sessionId, fingerprint);
  if (cached) {
    logger?.debug("turn cache hit", {
      sessionId,
      entries: cached.size,
    });
    return { turnMap: cached, source: "hit" };
  }

  // Cache miss or stale - rebuild
  logger?.debug("turn cache rebuild", {
    sessionId,
    version: fingerprint.version,
    updated: fingerprint.updated,
  });

  const items = await fetchItems();
  const turnMap = computeTurnsFn(items);

  // Store in cache
  setTurnCache(sessionId, fingerprint, turnMap);

  return { turnMap, source: "rebuild" };
}
