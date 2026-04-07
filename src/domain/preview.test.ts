import { describe, expect, test } from "vitest";

import { computeLastPreview, computePreview, computePreviewFallback } from "./preview.ts";
import type { NormalizedMessage, NormalizedPart, PreviewFallbackHints } from "./types.ts";

describe("domain/computePreview", () => {
  test("returns first non-ignored non-empty text as single line", () => {
    const parts: NormalizedPart[] = [
      { type: "text", partId: "p1", messageId: "m", text: "\n\n", ignored: false },
      { type: "tool", partId: "t1", messageId: "m", tool: "x", title: null, status: "completed", input: {}, content: "out" },
      { type: "text", partId: "p2", messageId: "m", text: "hello\nworld", ignored: false },
    ];
    expect(computePreview(parts, 100)).toBe("hello world");
  });

  test("returns undefined when no readable text", () => {
    const parts: NormalizedPart[] = [
      { type: "text", partId: "p1", messageId: "m", text: " ", ignored: false },
      { type: "text", partId: "p2", messageId: "m", text: "x", ignored: true },
    ];
    expect(computePreview(parts, 10)).toBeUndefined();
  });

  test("clips previews at sentence boundaries with ellipsis", () => {
    const parts: NormalizedPart[] = [
      {
        type: "text",
        partId: "p1",
        messageId: "m",
        text: "Hello world.\nNext sentence keeps going.",
        ignored: false,
      },
    ];

    expect(computePreview(parts, 20)).toBe("Hello world....");
  });

  test("falls back to a word boundary for previews", () => {
    const parts: NormalizedPart[] = [
      {
        type: "text",
        partId: "p1",
        messageId: "m",
        text: "alpha beta gamma delta",
        ignored: false,
      },
    ];

    expect(computePreview(parts, 12)).toBe("alpha beta...");
  });

  test("falls back to a hard cut for previews when needed", () => {
    const parts: NormalizedPart[] = [
      {
        type: "text",
        partId: "p1",
        messageId: "m",
        text: "abcdefghijklmnopqrstuvwxyz",
        ignored: false,
      },
    ];

    expect(computePreview(parts, 10)).toBe("abcdefghij...");
  });

});

describe("domain/computeLastPreview", () => {
  test("returns the last visible text preview", () => {
    const parts: NormalizedPart[] = [
      { type: "text", partId: "p1", messageId: "m", text: "first text", ignored: false },
      { type: "text", partId: "p2", messageId: "m", text: "final sentence. Another one follows.", ignored: false },
    ];

    expect(computeLastPreview(parts, 18)).toBe("final sentence....");
  });

  test("returns undefined when no visible text exists", () => {
    const parts: NormalizedPart[] = [
      { type: "text", partId: "p1", messageId: "m", text: " ", ignored: false },
      { type: "text", partId: "p2", messageId: "m", text: "ignored", ignored: true },
    ];

    expect(computeLastPreview(parts, 10)).toBeUndefined();
  });
});

describe("domain/computePreviewFallback", () => {
  const baseHints: PreviewFallbackHints = {
    hasCompaction: false,
    hasSubtask: false,
    hasUnsupported: false,
  };

  test("returns tool-call fallback previews", () => {
    const msg: NormalizedMessage = {
      id: "a1",
      role: "assistant",
      time: 1,
      summary: false,
    };
    const parts: NormalizedPart[] = [
      {
        type: "tool",
        partId: "p1",
        messageId: "a1",
        tool: "bash",
        title: "done",
        status: "completed",
        input: { cmd: "pwd" },
        content: "ok",
      },
    ];

    expect(computePreviewFallback(msg, parts, baseHints, 140)).toEqual({
      preview: "[tool calls only]",
      priority: 40,
    });
  });

  test("returns compaction trigger fallback previews", () => {
    const msg: NormalizedMessage = {
      id: "u1",
      role: "user",
      time: 1,
      summary: false,
    };

    expect(computePreviewFallback(msg, [], {
      ...baseHints,
      hasCompaction: true,
    }, 140)).toEqual({
      preview: "[compaction trigger]",
      priority: 50,
    });
  });

  test("keeps mixed tool fallbacks distinct from tool-only", () => {
    const msg: NormalizedMessage = {
      id: "a-mixed",
      role: "assistant",
      time: 1,
      summary: false,
    };

    expect(computePreviewFallback(msg, [
      {
        type: "tool",
        partId: "p1",
        messageId: "a-mixed",
        tool: "bash",
        title: "done",
        status: "completed",
        input: { cmd: "pwd" },
        content: "ok",
      },
      {
        type: "reasoning",
        partId: "r1",
        messageId: "a-mixed",
        text: "plan",
      },
    ], baseHints, 140)).toEqual({
      preview: "[tool calls + reasoning]",
      priority: 40,
    });
  });

  test("returns compacted summary fallback previews", () => {
    const msg: NormalizedMessage = {
      id: "a2",
      role: "assistant",
      time: 1,
      summary: true,
    };

    expect(computePreviewFallback(msg, [], baseHints, 140)).toEqual({
      preview: "[compacted summary]",
      priority: 60,
    });
  });

  test("returns attachment-only fallback previews", () => {
    const msg: NormalizedMessage = {
      id: "u2",
      role: "user",
      time: 1,
      summary: false,
    };
    const parts: NormalizedPart[] = [
      { type: "image", partId: "img", messageId: "u2", mime: "image/png" },
    ];

    expect(computePreviewFallback(msg, parts, baseHints, 140)).toEqual({
      preview: "[attachments only]",
      priority: 15,
    });
  });

  test("returns reasoning-only fallback previews", () => {
    const msg: NormalizedMessage = {
      id: "a3",
      role: "assistant",
      time: 1,
      summary: false,
    };
    const parts: NormalizedPart[] = [
      { type: "reasoning", partId: "r1", messageId: "a3", text: "plan" },
    ];

    expect(computePreviewFallback(msg, parts, baseHints, 140)).toEqual({
      preview: "[reasoning only]",
      priority: 20,
    });
  });

  test("returns subtask fallback previews", () => {
    const msg: NormalizedMessage = {
      id: "u3",
      role: "user",
      time: 1,
      summary: false,
    };

    expect(computePreviewFallback(msg, [], {
      ...baseHints,
      hasSubtask: true,
    }, 140)).toEqual({
      preview: "[subtask request]",
      priority: 35,
    });
  });

  test("returns undefined for unsupported-only internal content", () => {
    const msg: NormalizedMessage = {
      id: "a4",
      role: "assistant",
      time: 1,
      summary: false,
    };

    expect(computePreviewFallback(msg, [], {
      ...baseHints,
      hasUnsupported: true,
    }, 140)).toBeUndefined();
  });

});
