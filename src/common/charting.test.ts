import { describe, expect, test } from "vitest";

import {
  buildChartingText,
  buildMinimalCompactionPrompt,
  buildMinimalCompactionText,
  clearChartingPending,
  createChartingState,
  hasPendingCharting,
  markChartingPending,
} from "./charting.ts";

describe("common/charting", () => {
  test("tracks pending sessions", () => {
    const state = createChartingState();

    expect(hasPendingCharting(state, "sess-1")).toBe(false);

    markChartingPending(state, "sess-1");
    expect(hasPendingCharting(state, "sess-1")).toBe(true);

    clearChartingPending(state, "sess-1");
    expect(hasPendingCharting(state, "sess-1")).toBe(false);
  });

  test("builds structured chart text", () => {
    const result = buildChartingText(
      "sess-123",
      {
        turns: [],
      },
      {
        before_message_id: null,
        messages: [],
        after_message_id: null,
      },
      {
        recentTurns: 12,
        recentMessages: 34,
      },
    );

    expect(result).toContain("I lost context from my prior conversation.");
    expect(result).toContain("session **sess-123**");
    expect(result).toContain("history_browse_turns");
    expect(result).toContain("num_before=12 and num_after=0");
    expect(result).toContain("history_browse_messages");
    expect(result).toContain("num_before=34 and");
    expect(result).toContain("history_pull_message");
    expect(result).toContain("history_search");
    expect(result).toContain("\"turns\": []");
    expect(result).toContain("before_message_id");
    expect(result).toContain("after_message_id");
  });

  test("builds minimal compaction prompt", () => {
    expect(buildMinimalCompactionText()).toBe("# Summary\nChart unavailable. Use history_browse_turns for prior context.");
    expect(buildMinimalCompactionPrompt()).toContain(buildMinimalCompactionText());
    expect(buildMinimalCompactionPrompt()).toContain("Do not think. Do not summarize.");
  });
});
