import { afterEach, describe, expect, test, vi } from "vitest";

import {
  builtInNavigatorPromptBody,
  createUpstreamNavigatorState,
  injectUpstreamNavigatorPrompt,
  recordUpstreamNavigatorSession,
  buildNavigatorPrompt,
} from "./upstream-navigator-prompt.ts";

function sessionCreatedEvent(sessionID: string, parentID?: string) {
  return {
    type: "session.created",
    properties: { info: { id: sessionID, ...(parentID ? { parentID } : {}) } },
  } as unknown as import("@opencode-ai/sdk").Event;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("upstream navigator state", () => {
  test("createUpstreamNavigatorState returns empty maps", () => {
    const state = createUpstreamNavigatorState();
    expect(state.sessionChildStates.size).toBe(0);
  });

  test("builtInNavigatorPromptBody contains key content", () => {
    expect(builtInNavigatorPromptBody).toContain("spawned from an upstream conversation");
    expect(builtInNavigatorPromptBody).toContain("## Common Patterns");
    expect(builtInNavigatorPromptBody).toContain("Continue prior work");
    expect(builtInNavigatorPromptBody).toContain("attachments and tool calls");
    expect(builtInNavigatorPromptBody).not.toContain("## Entry Point Decision");
    expect(builtInNavigatorPromptBody).not.toContain("## Rules");
    expect(builtInNavigatorPromptBody).not.toContain("## Search Usage");
  });
});

describe("recordUpstreamNavigatorSession", () => {
  test("stores parentId when parentID exists", () => {
    const state = createUpstreamNavigatorState();
    recordUpstreamNavigatorSession(state, sessionCreatedEvent("s", "p"));

    const entry = state.sessionChildStates.get("s");
    expect(entry?.resolved).toBe(true);
    expect(entry?.parentId).toBe("p");
  });

  test("stores parentId=undefined when parentID missing", () => {
    const state = createUpstreamNavigatorState();
    recordUpstreamNavigatorSession(state, sessionCreatedEvent("s"));

    const entry = state.sessionChildStates.get("s");
    expect(entry?.resolved).toBe(true);
    expect(entry?.parentId).toBeUndefined();
  });

  test("ignores non session.created events", () => {
    const state = createUpstreamNavigatorState();
    recordUpstreamNavigatorSession(state, {
      type: "tool.called",
      properties: {},
    } as unknown as import("@opencode-ai/sdk").Event);
    expect(state.sessionChildStates.size).toBe(0);
  });

  test("idempotent for repeated resolve", () => {
    const state = createUpstreamNavigatorState();
    const event = sessionCreatedEvent("s", "p");

    recordUpstreamNavigatorSession(state, event);
    recordUpstreamNavigatorSession(state, event);
    const entry = state.sessionChildStates.get("s");
    expect(entry?.resolved).toBe(true);
    expect(entry?.parentId).toBe("p");
  });
});

describe("injectUpstreamNavigatorPrompt", () => {
  test("buildNavigatorPrompt prepends bold session id line to built-in body", () => {
    expect(buildNavigatorPrompt("parent")).toBe(`**Upstream session ID: parent**\n\n${builtInNavigatorPromptBody}`);
  });

  test("no sessionID: no injection", async () => {
    const state = createUpstreamNavigatorState();
    const system: string[] = [];
    await injectUpstreamNavigatorPrompt(state, undefined, system);
    expect(system).toEqual([]);
  });

  test("child session: injects prompt once", async () => {
    const state = createUpstreamNavigatorState();
    recordUpstreamNavigatorSession(state, sessionCreatedEvent("s", "p"));

    const system: string[] = [];
    await injectUpstreamNavigatorPrompt(state, "s", system);
    await injectUpstreamNavigatorPrompt(state, "s", system);
    expect(system).toEqual([buildNavigatorPrompt("p")]);
  });

  test("non-child session: does not inject", async () => {
    const state = createUpstreamNavigatorState();
    recordUpstreamNavigatorSession(state, sessionCreatedEvent("s"));

    const system: string[] = [];
    await injectUpstreamNavigatorPrompt(state, "s", system);
    expect(system).toEqual([]);
  });

  test("unresolved state times out and does not inject", async () => {
    const state = createUpstreamNavigatorState();
    const system: string[] = [];

    // Avoid waiting the real timeout.
    vi.useFakeTimers();
    const promise = injectUpstreamNavigatorPrompt(state, "s", system);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    vi.useRealTimers();

    expect(system).toEqual([]);
  });

  test("waits for late session.created resolution and injects once", async () => {
    const state = createUpstreamNavigatorState();
    const system: string[] = [];

    vi.useFakeTimers();
    const promise = injectUpstreamNavigatorPrompt(state, "s", system);
    await vi.advanceTimersByTimeAsync(10);

    recordUpstreamNavigatorSession(state, sessionCreatedEvent("s", "parent"));
    await promise;

    expect(system).toEqual([buildNavigatorPrompt("parent")]);
    expect(state.sessionChildStates.get("s")?.waiters).toEqual([]);
  });
});
