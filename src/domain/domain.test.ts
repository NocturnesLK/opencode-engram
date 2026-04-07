import { describe, expect, test } from "vitest";

import {
  buildSections,
  computeAttachments,
  computeFileRefs,
  computeModifiedFiles,
  computeNotes,
  computeOutcome,
  computeToolCalls,
  computeTurns,
  formatToolCallSummaries,
} from "./domain.ts";
import type { NormalizedPart, NormalizedMessage, NormalizedToolPart, SectionConvertContext } from "./types.ts";

describe("domain/computeTurns", () => {
  test("increments on user messages; assistant shares turn", () => {
    const map = computeTurns([
      { id: "a2", role: "assistant", time: 2 },
      { id: "u1", role: "user", time: 1 },
      { id: "a1", role: "assistant", time: 1 },
      { id: "u2", role: "user", time: 3 },
    ]);
    expect(map.get("u1")).toBe(1);
    expect(map.get("a1")).toBe(1);
    expect(map.get("a2")).toBe(1);
    expect(map.get("u2")).toBe(2);
  });

  test("stable fallback when no user message appears", () => {
    const map = computeTurns([
      { id: "a1", role: "assistant", time: 1 },
      { id: "a2", role: "assistant", time: 2 },
    ]);
    expect(map.get("a1")).toBe(1);
    expect(map.get("a2")).toBe(1);
  });

  test("orders same-timestamp user before assistant and undefined time last", () => {
    const map = computeTurns([
      { id: "late-user", role: "user", time: undefined },
      { id: "a0", role: "assistant", time: 1 },
      { id: "u0", role: "user", time: 1 },
      { id: "a1", role: "assistant", time: undefined },
    ]);

    expect(map).toEqual(new Map([
      ["u0", 1],
      ["a0", 1],
      ["late-user", 2],
      ["a1", 2],
    ]));
  });
});

describe("domain/computeNotes", () => {
  test("adds compaction summary and image count", () => {
    const msg: NormalizedMessage = {
      id: "m",
      role: "assistant",
      time: 1,
      summary: true,
    };
    const parts: NormalizedPart[] = [
      { type: "image", partId: "p1", messageId: "m", mime: "image/png" },
      { type: "image", partId: "p2", messageId: "m", mime: "image/jpeg" },
    ];
    expect(computeNotes(msg, parts)).toEqual(["compacted summary", "2 images attached"]);
  });
});

describe("domain/computeToolCalls + formatToolCallSummaries", () => {
  test("aggregates totals and errors per tool", () => {
    const parts: NormalizedPart[] = [
      {
        type: "tool",
        partId: "t1",
        messageId: "m",
        tool: "grep",
        title: null,
        status: "completed",
        input: {},
        content: "ok",
      },
      {
        type: "tool",
        partId: "t2",
        messageId: "m",
        tool: "grep",
        title: null,
        status: "error",
        input: {},
        content: "bad",
      },
      {
        type: "tool",
        partId: "t3",
        messageId: "m",
        tool: "bash",
        title: null,
        status: "completed",
        input: {},
        content: "ok",
      },
    ];

    const summaries = computeToolCalls(parts);
    expect(summaries).toEqual([
      { tool: "grep", total: 2, errors: 1 },
      { tool: "bash", total: 1, errors: 0 },
    ]);
    expect(formatToolCallSummaries(summaries)).toEqual([
      "2× grep: 1× error",
      "1× bash",
    ]);
  });
});

describe("domain/computeFileRefs", () => {
  test("extracts unique file refs in first-seen order", () => {
    const parts: NormalizedPart[] = [
      { type: "file", partId: "f1", messageId: "m", path: "a.ts", mime: "text/plain" },
      { type: "file", partId: "f2", messageId: "m", path: "b.ts", mime: "text/plain" },
      { type: "file", partId: "f3", messageId: "m", path: "a.ts", mime: "text/plain" },
      { type: "image", partId: "i1", messageId: "m", mime: "image/png" },
    ];
    expect(computeFileRefs(parts)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("domain/computeAttachments", () => {
  test("combines image summary and file refs", () => {
    const parts: NormalizedPart[] = [
      { type: "image", partId: "i1", messageId: "m", mime: "image/png" },
      { type: "image", partId: "i2", messageId: "m", mime: "image/jpeg" },
      { type: "file", partId: "f1", messageId: "m", path: "a.ts", mime: "text/plain" },
      { type: "file", partId: "f2", messageId: "m", path: "a.ts", mime: "text/plain" },
      { type: "file", partId: "f3", messageId: "m", path: "b.ts", mime: "text/plain" },
    ];

    expect(computeAttachments(parts)).toEqual(["2 images", "a.ts", "b.ts"]);
  });

  test("returns image-only label when no file refs", () => {
    const parts: NormalizedPart[] = [
      { type: "image", partId: "i1", messageId: "m", mime: "image/png" },
    ];

    expect(computeAttachments(parts)).toEqual(["1 image"]);
  });
});

describe("domain/buildSections", () => {
  test("filters ignored/empty text and truncates content", () => {
    const parts: NormalizedPart[] = [
      { type: "text", partId: "p1", messageId: "m", text: "", ignored: false },
      { type: "text", partId: "p2", messageId: "m", text: " hi ", ignored: true },
      { type: "text", partId: "p3", messageId: "m", text: "abcdef", ignored: false },
    ];

    const ctx: SectionConvertContext = {
      maxTextLength: 3,
      maxReasoningLength: 10,
      maxToolOutputLength: 10,
      maxToolInputLength: 10,
      visibleToolInputs: new Set(),
      visibleToolOutputs: new Set(),
    };

    const sections = buildSections(parts, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe("text");
    if (sections[0].type === "text") {
      expect(sections[0].truncated).toBe(true);
      expect(sections[0].content).toContain("[3 chars more]");
    }
  });

  test("respects tool visibility and truncates nested inputs, output, and reasoning", () => {
    const parts: NormalizedPart[] = [
      { type: "reasoning", partId: "r1", messageId: "m", text: "abcdef" },
      {
        type: "tool",
        partId: "tool-visible",
        messageId: "m",
        tool: "bash",
        title: "run",
        status: "completed",
        input: {
          nested: {
            text: "abcdef",
            list: ["ghijkl", 1],
          },
        },
        content: "uvwxyz",
      },
      {
        type: "tool",
        partId: "tool-hidden",
        messageId: "m",
        tool: "grep",
        title: null,
        status: "error",
        input: { query: "abcdef" },
        content: "secret",
      },
      { type: "image", partId: "img", messageId: "m", mime: "image/png" },
      { type: "file", partId: "file", messageId: "m", path: "a.ts", mime: "text/plain" },
    ];

    const ctx: SectionConvertContext = {
      maxTextLength: 10,
      maxReasoningLength: 3,
      maxToolOutputLength: 3,
      maxToolInputLength: 3,
      visibleToolInputs: new Set(["bash"]),
      visibleToolOutputs: new Set(["bash"]),
    };

    expect(buildSections(parts, ctx)).toEqual([
      {
        type: "reasoning",
        partId: "r1",
        content: "abc\n[3 chars more]",
        truncated: true,
      },
      {
        type: "tool",
        partId: "tool-visible",
        tool: "bash",
        title: "run",
        status: "completed",
        input: {
          nested: {
            text: "abc\n[3 chars more]",
            list: ["ghi\n[3 chars more]", 1],
          },
        },
        content: "uvw\n[3 chars more]",
        truncated: true,
      },
      {
        type: "tool",
        partId: "tool-hidden",
        tool: "grep",
        title: null,
        status: "error",
        input: undefined,
        content: undefined,
        truncated: false,
      },
      {
        type: "image",
        partId: "img",
        mime: "image/png",
      },
      {
        type: "file",
        partId: "file",
        path: "a.ts",
        mime: "text/plain",
      },
    ]);
  });
});

// =============================================================================
// computeOutcome
// =============================================================================

function makeToolPart(
  tool: string,
  status: "pending" | "running" | "completed" | "error",
  input: Record<string, unknown> = {},
): NormalizedToolPart {
  return {
    type: "tool",
    partId: `${tool}-${status}`,
    messageId: "m",
    tool,
    title: null,
    status,
    input,
  };
}

describe("domain/computeOutcome", () => {
  test("returns completed when all tools completed", () => {
    expect(computeOutcome([
      makeToolPart("edit", "completed"),
      makeToolPart("bash", "completed"),
    ])).toBe("completed");
  });

  test("returns error when last settled tool errored", () => {
    expect(computeOutcome([
      makeToolPart("edit", "completed"),
      makeToolPart("bash", "error"),
    ])).toBe("error");
  });

  test("returns recovered when error followed by completed", () => {
    expect(computeOutcome([
      makeToolPart("edit", "completed"),
      makeToolPart("bash", "error"),
      makeToolPart("edit", "completed"),
      makeToolPart("bash", "completed"),
    ])).toBe("recovered");
  });

  test("returns running when last tool is running", () => {
    expect(computeOutcome([
      makeToolPart("edit", "completed"),
      makeToolPart("bash", "running"),
    ])).toBe("running");
  });

  test("returns running when last tool is pending", () => {
    expect(computeOutcome([
      makeToolPart("bash", "pending"),
    ])).toBe("running");
  });

  test("returns running when all tools are pending/running", () => {
    expect(computeOutcome([
      makeToolPart("bash", "running"),
      makeToolPart("edit", "pending"),
    ])).toBe("running");
  });

  test("returns completed for empty array", () => {
    expect(computeOutcome([])).toBe("completed");
  });

  test("returns error for single error", () => {
    expect(computeOutcome([
      makeToolPart("bash", "error"),
    ])).toBe("error");
  });

  test("error then running returns running", () => {
    expect(computeOutcome([
      makeToolPart("bash", "error"),
      makeToolPart("edit", "running"),
    ])).toBe("running");
  });
});

// =============================================================================
// computeModifiedFiles
// =============================================================================

describe("domain/computeModifiedFiles", () => {
  test("extracts paths from completed write tool inputs", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("edit", "completed", { file_path: "src/a.ts" }),
      makeToolPart("write", "completed", { path: "src/b.ts" }),
      makeToolPart("apply_patch", "completed", {
        patchText: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n*** End Patch",
      }),
    ];
    expect(computeModifiedFiles(parts)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("extracts multiple paths from apply_patch patchText", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("apply_patch", "completed", {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/c.ts",
          "*** Add File: src/d.ts",
          "*** Delete File: src/e.ts",
          "*** End Patch",
        ].join("\n"),
      }),
    ];
    expect(computeModifiedFiles(parts)).toEqual(["src/c.ts", "src/d.ts", "src/e.ts"]);
  });

  test("deduplicates file paths", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("edit", "completed", { file_path: "src/a.ts" }),
      makeToolPart("edit", "completed", { file_path: "src/a.ts" }),
      makeToolPart("apply_patch", "completed", {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "*** Add File: src/b.ts",
          "*** End Patch",
        ].join("\n"),
      }),
    ];
    expect(computeModifiedFiles(parts)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("ignores non-completed write tools", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("edit", "pending", { file_path: "src/a.ts" }),
      makeToolPart("write", "running", { path: "src/b.ts" }),
      makeToolPart("apply_patch", "error", {
        patchText: "*** Begin Patch\n*** Update File: src/c.ts\n*** End Patch",
      }),
      makeToolPart("edit", "completed", { file_path: "src/d.ts" }),
    ];
    expect(computeModifiedFiles(parts)).toEqual(["src/d.ts"]);
  });

  test("ignores non-write tools", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("bash", "completed", { cmd: "ls" }),
      makeToolPart("grep", "completed", { query: "foo", path: "src/a.ts" }),
    ];
    expect(computeModifiedFiles(parts)).toEqual([]);
  });

  test("handles missing path in input", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("edit", "completed", { content: "hello" }),
    ];
    expect(computeModifiedFiles(parts)).toEqual([]);
  });

  test("returns empty for empty input", () => {
    expect(computeModifiedFiles([])).toEqual([]);
  });

  test("supports 'file' as path key", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("write", "completed", { file: "src/d.ts" }),
    ];
    expect(computeModifiedFiles(parts)).toEqual(["src/d.ts"]);
  });

  test("falls back to direct path keys for apply_patch", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("apply_patch", "completed", { file_path: "src/e.ts" }),
    ];
    expect(computeModifiedFiles(parts)).toEqual(["src/e.ts"]);
  });

  test("returns empty when apply_patch has no detectable file headers", () => {
    const parts: NormalizedToolPart[] = [
      makeToolPart("apply_patch", "completed", {
        patchText: "*** Begin Patch\n@@\n*** End Patch",
      }),
    ];
    expect(computeModifiedFiles(parts)).toEqual([]);
  });
});
