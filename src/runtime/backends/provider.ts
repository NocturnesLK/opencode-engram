import type { PluginInput } from "../../common/common.ts";
import type { HistoryBackend } from "../../core/history-backend.ts";

/**
 * Provider that can route matching session ids to a specific history backend.
 */
export interface HistoryBackendProvider {
  /**
   * Return true when this provider should serve the given session id.
   */
  matchesSessionId(sessionId: string): boolean;

  /**
   * Create a backend instance for matched sessions.
   */
  createBackend(input: PluginInput): HistoryBackend;
}

/**
 * Optional backend routing configuration for runtime helpers.
 */
export interface HistoryBackendResolverOptions {
  providers?: readonly HistoryBackendProvider[];
}
