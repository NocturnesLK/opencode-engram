export const builtInHistoryPromptBody = `## Session History

Conversation history is the only authoritative source of past state: what was done, why, what was decided, and what remains. Treat it as a first-class source alongside the local workspace.

Retrieve from history when the consequence of NOT having the information is:
- Wrong direction: acting on a requirement, constraint, or decision you can't verify from current context
- Wrong context: user corrections, rejections, or hard constraints that shaped prior work
- Missing substance: plans, specs, schemas, or analyses not present in current context

### Efficiency

- Prefer search over manual browse-window scanning when you do not already know the approximate location of the answer.
- Do not call pull unless the preview or search snippet is clearly insufficient.
- Parallel independent calls — multiple searches or pulls that don't depend on each other should run in the same round.
- Browse in small window (e.g., 3) initially and avoid overlapping window ranges as much as possible, as they result in duplicate information.

### Technique 

#### Browse (Turns & Messages)
- **Recent items**: Set \`num_before\`, omit \`num_after\` and ID/index.
- **From start (turns)**: Set \`turn_index=1\`, omit \`num_before\`.
- **Nearby context**: Set a specific ID/index and a small window to explore around a search result.
- **Full turn (messages)**: Set \`message_id=user.message_id\` and \`num_after=assistant.total_messages\`.

#### Search (history_search)
- **Precise**: Set \`literal=true\` for exact substring matches (e.g., unique identifiers, paths). Avoid for common terms.
- **Minimal**: Filter by type to reduce noise (default \`type="text|tool"\`):
  - \`type=text\`: Find specific communications/messages.
  - \`type=tool\`: Locate paths, errors, or identifiers.
  - \`type=reasoning\`: Find decision rationales.
- **Maximal**: Set \`type=text|tool|reasoning\` to verify the existence of a fact across all layers. Ineffective for retrieving detailed context.
`
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
