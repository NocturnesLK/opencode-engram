import { describe, expect, test } from "vitest";

import {
  composeContentWithToolInputSignature,
  formatToolInputSignature,
  json,
} from "./common.ts";

describe("common/json", () => {
  test("serializes with stable indentation", () => {
    expect(json({ a: 1 })).toBe("{\n  \"a\": 1\n}");
  });
});

describe("common/formatToolInputSignature", () => {
  test("formats primitives and strings", () => {
    expect(formatToolInputSignature("grep", { pattern: "x", limit: 2, ok: true })).toBe(
      'grep(pattern="x", limit=2, ok=true)',
    );
  });

  test("formats undefined and bigint", () => {
    expect(formatToolInputSignature("t", { a: undefined, b: 10n })).toBe("t(a=undefined, b=10n)");
  });
});

describe("common/composeContentWithToolInputSignature", () => {
  test("returns content when input is undefined", () => {
    expect(composeContentWithToolInputSignature("t", undefined, "hi")).toBe("hi");
  });

  test("returns signature header when content is empty", () => {
    expect(composeContentWithToolInputSignature("t", { x: 1 }, "")).toBe("t(x=1)");
  });

  test("prefixes header and separator when content exists", () => {
    expect(composeContentWithToolInputSignature("t", { x: 1 }, "out")).toBe(
      "t(x=1)\n---\nout",
    );
  });
});
