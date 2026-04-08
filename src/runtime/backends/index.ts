import type { PluginInput } from "../../common/common.ts";
import type { HistoryBackend } from "../../core/history-backend.ts";

import { createOpenCodeBackend } from "./opencode-backend.ts";

/**
 * Create the default history backend for the current host runtime.
 */
export function createHistoryBackend(input: PluginInput): HistoryBackend {
  return createOpenCodeBackend(input);
}

/**
 * Reuse an injected backend when present, otherwise create the default backend.
 */
export function resolveHistoryBackend(
  input: PluginInput,
  backend?: HistoryBackend,
): HistoryBackend {
  return backend ?? createHistoryBackend(input);
}
