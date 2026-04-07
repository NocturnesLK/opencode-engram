export const builtInHistoryPromptBody = `## Session History

Conversation history is the only authoritative source of past state: what was
done, why, what was decided, and what remains. Treat it as a first-class source
alongside the local workspace.

Retrieve from history when the consequence of NOT having the information is:
- Wrong direction: acting on a requirement, constraint, or decision you can't
  verify from current context
- Wrong context: user corrections, rejections, or hard constraints that shaped
  prior work
- Missing substance: plans, specs, schemas, or analyses not present in current
  context

### Efficiency

- Prefer search over manual browse-window scanning when you do not already know
  the approximate location of the answer.
- Do not call pull unless the preview or search snippet is clearly insufficient.
- Parallel independent calls — multiple searches or pulls that don't depend on
  each other should run in the same round.

### Turn Mechanics

- history_browse_turns returns visible turns in ascending order and can focus on
  a window around a specific \`turn_index\`.
- If a requested turn is hidden by self-session filtering, retry with a nearby
  visible turn.
- history_browse_messages returns a message window around a specific
  \`message_id\`, with \`before_message_id\` and \`after_message_id\` for
  extending the window.
- Use history_pull_message for full message content.`;

// =============================================================================
// State Management
// =============================================================================

export type HistoryPromptState = {
  injectedSessionIds: Set<string>;
};

/**
 * Create shared state for tracking which sessions have received the common
 * history prompt injection.
 */
export function createHistoryPromptState(): HistoryPromptState {
  return {
    injectedSessionIds: new Set<string>(),
  };
}

/**
 * Inject the common history prompt into a session's system prompts, at most
 * once per session.
 */
export function injectHistoryPrompt(
  state: HistoryPromptState,
  sessionID: string | undefined,
  system: string[],
  promptBody = builtInHistoryPromptBody,
): void {
  if (!sessionID) {
    return;
  }

  if (state.injectedSessionIds.has(sessionID)) {
    return;
  }

  state.injectedSessionIds.add(sessionID);
  system.push(promptBody);
}
