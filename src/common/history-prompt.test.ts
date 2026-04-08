import { describe, expect, test } from "vitest";

import {
  builtInHistoryPromptBody,
  createHistoryPromptState,
  injectHistoryPrompt,
} from "./history-prompt.ts";

describe("common/history-prompt", () => {
  test("createHistoryPromptState returns empty set", () => {
    const state = createHistoryPromptState();
    expect(state.injectedSessionIds.size).toBe(0);
  });

  test("injectHistoryPrompt pushes prompt and records sessionID", () => {
    const state = createHistoryPromptState();
    const system: string[] = [];
    injectHistoryPrompt(state, "sess-1", system);
    expect(system).toEqual([builtInHistoryPromptBody]);
    expect(state.injectedSessionIds.has("sess-1")).toBe(true);
  });

  test("injectHistoryPrompt deduplicates by sessionID", () => {
    const state = createHistoryPromptState();
    const system: string[] = [];
    injectHistoryPrompt(state, "sess-1", system);
    injectHistoryPrompt(state, "sess-1", system);
    expect(system).toEqual([builtInHistoryPromptBody]);
  });

  test("injectHistoryPrompt does not inject when sessionID is undefined", () => {
    const state = createHistoryPromptState();
    const system: string[] = [];
    injectHistoryPrompt(state, undefined, system);
    expect(system).toEqual([]);
    expect(state.injectedSessionIds.size).toBe(0);
  });

  test("injectHistoryPrompt supports custom prompt body", () => {
    const state = createHistoryPromptState();
    const system: string[] = [];
    injectHistoryPrompt(state, "sess-1", system, "CUSTOM BODY");
    expect(system).toEqual(["CUSTOM BODY"]);
  });

  test("injectHistoryPrompt injects independently for different sessions", () => {
    const state = createHistoryPromptState();
    const system: string[] = [];
    injectHistoryPrompt(state, "sess-1", system);
    injectHistoryPrompt(state, "sess-2", system);
    expect(system).toEqual([builtInHistoryPromptBody, builtInHistoryPromptBody]);
    expect(state.injectedSessionIds.size).toBe(2);
  });

  test("builtInHistoryPromptBody contains key content", () => {
    expect(builtInHistoryPromptBody).toContain("## Session History");
    expect(builtInHistoryPromptBody).toContain("manual browse-window scanning");
    expect(builtInHistoryPromptBody).toContain("### Efficiency");
  });
});
