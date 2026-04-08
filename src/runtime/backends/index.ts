import type { PluginInput } from "../../common/common.ts";
import type { HistoryBackend } from "../../core/history-backend.ts";

import { createOpenCodeBackend } from "./opencode-backend.ts";
import type { HistoryBackendResolverOptions } from "./provider.ts";

function findHistoryBackendProvider(
  sessionId: string,
  options?: HistoryBackendResolverOptions,
) {
  for (const provider of options?.providers ?? []) {
    if (provider.matchesSessionId(sessionId)) {
      return provider;
    }
  }

  return undefined;
}

/**
 * Create the history backend for the current host runtime.
 *
 * Providers are checked in order when a session id is available.
 * Falls back to the default OpenCode backend when no provider matches.
 */
export function createHistoryBackend(
  input: PluginInput,
  sessionId?: string,
  options?: HistoryBackendResolverOptions,
): HistoryBackend {
  if (sessionId !== undefined) {
    const provider = findHistoryBackendProvider(sessionId, options);
    if (provider !== undefined) {
      return provider.createBackend(input);
    }
  }

  return createOpenCodeBackend(input);
}

/**
 * Reuse an injected backend when present, otherwise create the default backend.
 */
export function resolveHistoryBackend(
  input: PluginInput,
  sessionId: string,
  backend?: HistoryBackend,
  options?: HistoryBackendResolverOptions,
): HistoryBackend {
  return backend ?? createHistoryBackend(input, sessionId, options);
}

export type {
  HistoryBackendProvider,
  HistoryBackendResolverOptions,
} from "./provider.ts";
