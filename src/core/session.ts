/**
 * session.ts - Core Session Models and Utilities
 *
 * Unified module for session targeting, metadata normalization, browse context,
 * and SDK session adapters used by the core layer.
 *
 * Key concepts:
 * - SessionTarget: the resolved target session for reading
 * - BrowseContext: unified context for all core reading operations
 * - SessionMetadata: minimal metadata needed for reading
 * - SdkSessionData: shape of SDK session data for conversion
 */

// =============================================================================
// Session Metadata
// =============================================================================

/**
 * Minimal metadata needed to read a session's history.
 * Intentionally minimal to avoid coupling to SDK-specific types.
 */
export interface SessionMetadata {
  id: string;
  title: string;
  version: number | undefined;
  updatedAt: number | undefined;
  parentId: string | undefined;
}

// =============================================================================
// Session Target
// =============================================================================

/**
 * A resolved session target for core reading operations.
 *
 * All targets are treated uniformly by core operations —
 * the core layer only sees a session to read from.
 */
export interface SessionTarget {
  session: SessionMetadata;
}

// =============================================================================
// Browse Context
// =============================================================================

/**
 * Context for a core browsing operation.
 *
 * This context is passed to core timeline/read/summary operations.
 * It contains the resolved target and any operation-specific parameters
 * needed by the core layer.
 *
 * The context intentionally does NOT include:
 * - Tool-specific argument validation (interface layer responsibility)
 * - Public output field filtering (serialize layer responsibility)
 * - SDK client references (passed separately to avoid coupling)
 */
export interface BrowseContext {
  /**
   * The resolved session target to browse.
   */
  target: SessionTarget;

  /**
   * True when the target session is the caller's own session.
   *
   * This is detected once at the runtime boundary and propagated through
   * all data paths so tool implementations can apply self-session semantics
   * without adding new parameters.
   */
  selfSession: boolean;
}

/**
 * Create a browse context from a resolved target.
 *
 * @param target Resolved session target
 * @returns Browse context for core operations
 */
export function createBrowseContext(
  target: SessionTarget,
  selfSession: boolean = false,
): BrowseContext {
  return {
    target,
    selfSession,
  };
}

// =============================================================================
// SDK Session Adapter
// =============================================================================

/**
 * SDK session data shape.
 *
 * Captures the shape of session data returned by the SDK,
 * allowing conversion to core SessionMetadata.
 */
export interface SdkSessionData {
  id: string;
  title: string;
  version?: number | string;
  time?: {
    updated?: number | string;
  };
  parentID?: string;
}

// =============================================================================
// Session Metadata Normalization
// =============================================================================

/**
 * Normalize a flexible numeric value from SDK/session layer.
 */
function normalizeVersion(value: number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number"
    ? value
    : parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Normalize a flexible timestamp value from SDK/session layer.
 */
function normalizeUpdatedAt(
  value: number | string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number"
    ? value
    : Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Convert SDK session data to core SessionMetadata.
 */
export function normalizeSessionMetadata(session: SdkSessionData): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    version: normalizeVersion(session.version),
    updatedAt: normalizeUpdatedAt(session.time?.updated),
    parentId: session.parentID,
  };
}

// =============================================================================
// Session Target Factory
// =============================================================================

/**
 * Convert SDK session data to core SessionMetadata.
 */
export function toSessionMetadata(sdk: SdkSessionData): SessionMetadata {
  return normalizeSessionMetadata(sdk);
}

/**
 * Create a SessionTarget from SDK session data.
 */
export function createSessionTarget(
  sdk: SdkSessionData,
): SessionTarget {
  return {
    session: toSessionMetadata(sdk),
  };
}

// =============================================================================
// Session Fingerprint (for cache invalidation)
// =============================================================================

/**
 * Compute a cache fingerprint string from session metadata.
 * Returns undefined if required metadata is unavailable.
 */
export function computeCacheFingerprint(
  session: SessionMetadata,
): string | undefined {
  if (session.version === undefined || session.updatedAt === undefined) {
    return undefined;
  }
  return `${session.version}:${session.updatedAt}`;
}
