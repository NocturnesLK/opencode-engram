import type { Event } from "@opencode-ai/sdk";

export const builtInNavigatorPromptBody = `This session was spawned from an upstream conversation. Your task description
carries intent but not the full discussion that shaped it — requirements,
constraints, and rejected approaches may exist only in the upstream history.

## Common Patterns

| Scenario | Strategy |
|----------|----------|
| Continue prior work | history_browse_turns → history_browse_messages on 2-3 recent turns → history_pull_message if needed |
| Known topic / "as we discussed X" | history_search(X) → history_pull_message if snippet insufficient |
| Check what files were changed | history_browse_messages on recent turns → inspect attachments and tool calls |`;

function buildNavigatorSessionIdLine(parentId: string) {
  return `**Upstream session ID: ${parentId}**`;
}

export function buildNavigatorPrompt(parentId: string) {
  return `${buildNavigatorSessionIdLine(parentId)}

${builtInNavigatorPromptBody}`;
}

const upstreamNavigatorWaitTimeoutMs = 50;

type SessionChildState = {
  resolved: boolean;
  parentId: string | undefined;
  waiters: Array<(parentId: string | undefined) => void>;
};

type UpstreamNavigatorState = {
  sessionChildStates: Map<string, SessionChildState>;
};

function getOrCreateSessionChildState(states: Map<string, SessionChildState>, sessionID: string): SessionChildState {
  const existing = states.get(sessionID);
  if (existing) {
    return existing;
  }

  const created: SessionChildState = {
    resolved: false,
    parentId: undefined,
    waiters: [],
  };
  states.set(sessionID, created);
  return created;
}

function resolveSessionChildState(state: SessionChildState, parentId: string | undefined) {
  if (state.resolved) {
    return;
  }

  state.resolved = true;
  state.parentId = parentId;
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) {
    waiter(parentId);
  }
}

async function waitForSessionChildState(
  state: SessionChildState,
  timeoutMs: number,
): Promise<string | undefined> {
  if (state.resolved) {
    return state.parentId;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.waiters = state.waiters.filter((waiter) => waiter !== resolve);
      resolve(undefined);
    }, timeoutMs);

    state.waiters.push((parentId) => {
      clearTimeout(timer);
      resolve(parentId);
    });
  });
}

function isSessionCreatedEvent(event: Event): event is Extract<Event, { type: "session.created" }> {
  return event.type === "session.created";
}

export function createUpstreamNavigatorState(): UpstreamNavigatorState {
  return {
    sessionChildStates: new Map<string, SessionChildState>(),
  };
}

export function recordUpstreamNavigatorSession(
  state: UpstreamNavigatorState,
  event: Event,
) {
  if (!isSessionCreatedEvent(event)) {
    return;
  }

  const session = event.properties.info;
  const sessionState = getOrCreateSessionChildState(state.sessionChildStates, session.id);
  resolveSessionChildState(sessionState, session.parentID || undefined);
}

export async function injectUpstreamNavigatorPrompt(
  state: UpstreamNavigatorState,
  sessionID: string | undefined,
  system: string[],
) {
  if (!sessionID) {
    return;
  }

  const sessionState = getOrCreateSessionChildState(state.sessionChildStates, sessionID);
  const parentId = await waitForSessionChildState(
    sessionState,
    upstreamNavigatorWaitTimeoutMs,
  );
  if (!parentId) {
    return;
  }

  const prompt = buildNavigatorPrompt(parentId);
  if (!system.includes(prompt)) {
    system.push(prompt);
  }
}
