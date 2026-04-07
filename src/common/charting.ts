export type ChartingState = {
  pendingSessionIds: Set<string>;
};

export type ChartingPromptWindows = {
  recentTurns: number;
  recentMessages: number;
};

const minimalCompactionText = "# Summary\nChart unavailable. Use history_browse_turns for prior context.";
const minimalCompactionPrompt = `Do not think. Do not summarize. Return exactly the following text and nothing else:\n${minimalCompactionText}`;

// =============================================================================
// Formatting Helpers
// =============================================================================

function toJsonBlock(value: unknown) {
  return `\`\`\` json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

// =============================================================================
// Pending State
// =============================================================================

/**
 * Create shared state for charting runs per session.
 */
export function createChartingState(): ChartingState {
  return {
    pendingSessionIds: new Set<string>(),
  };
}

/**
 * Mark a session as awaiting chart block injection.
 */
export function markChartingPending(
  state: ChartingState,
  sessionID: string,
) {
  state.pendingSessionIds.add(sessionID);
}

/**
 * Check whether a session has a pending chart block injection.
 */
export function hasPendingCharting(
  state: ChartingState,
  sessionID: string,
) {
  return state.pendingSessionIds.has(sessionID);
}

/**
 * Clear pending chart block injection state for a session.
 */
export function clearChartingPending(
  state: ChartingState,
  sessionID: string,
) {
  state.pendingSessionIds.delete(sessionID);
}

// =============================================================================
// Structured Output
// =============================================================================

/**
 * Build the short fallback text used when chart replacement cannot run.
 */
export function buildMinimalCompactionText() {
  return minimalCompactionText;
}

/**
 * Build the short compaction prompt used to minimize summary generation cost.
 */
export function buildMinimalCompactionPrompt() {
  return minimalCompactionPrompt;
}

/**
 * Build the structured chart block written during compaction.
 */
export function buildChartingText(
  sessionID: string,
  overview: unknown,
  latestTurnDetail: unknown,
  windows: ChartingPromptWindows,
) {
  return `I lost context from my prior conversation. What remains is a lossy index of session **${sessionID}** — turn structure and truncated previews are preserved, but full message content, reasoning chains, and precise details are not.

If I knew specific keywords — a file path, an identifier, or an error message — I would search directly with history_search. But right now I need the big picture first to understand what was being worked on, so I called history_browse_turns with num_before=${windows.recentTurns} and num_after=0:

${toJsonBlock(overview)}

I can call this again with a specific turn_index plus num_before and num_after to focus on nearby turns — to see earlier history, pass the earliest visible turn_index with num_before=N and num_after=0. When turn summaries are not enough, history_browse_messages gives message-level previews.

The overview gives structure but not detail. I called history_browse_messages on the latest turn's message_id with num_before=${windows.recentMessages} and num_after=0 to get surrounding context:

${toJsonBlock(latestTurnDetail)}

To extend this window: pass before_message_id as message_id to history_browse_messages with num_before, or after_message_id with num_after. For full content when a preview is insufficient: history_pull_message with the message's message_id.

This index answers "what happened and in what order." When I need "what exactly" — precise requirements, specific decisions, or full context — I'll retrieve it, using history_search if instructions refer to context not visible here. I will also verify critical details before acting, as these truncated previews can omit qualifiers that change meaning. No need to reconstruct the full history; I'll retrieve on demand as the task requires.
`;
}
