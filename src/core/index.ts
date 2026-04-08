/**
 * core/index.ts - Core Layer Public Exports
 *
 * Public API for the core layer. Runtime modules use these exports
 * to resolve targets and create browse contexts.
 *
 * Architectural boundary:
 * - Interface layer (`src/plugin/index.ts`) defines tool contracts only
 * - Runtime layer (`src/runtime/runtime.ts`) wires SDK calls to core abstractions
 * - Core modules provide target and browse primitives
 * - Serialization layer (`src/domain/serialize.ts`) remains separate
 */

// Session types, metadata, context, and utilities
export type {
  SessionMetadata,
  SessionTarget,
  BrowseContext,
  HistorySessionData,
  SdkSessionData,
} from "./session.ts";
export {
  createBrowseContext,
  normalizeSessionMetadata,
  toSessionMetadata,
  createSessionTarget,
  computeCacheFingerprint,
} from "./session.ts";

// SDK bridges for session resolution
export {
  getParentSessionId,
  resolveSessionTarget,
} from "./sdk-bridge.ts";

// History backend contract
export type {
  HistoryBackend,
  HistoryMessagePage,
} from "./history-backend.ts";
export {
  getParentSessionId as getBackendParentSessionId,
  resolveSessionTarget as resolveBackendSessionTarget,
} from "./history-backend.ts";
