import { describe, expect, test } from "vitest";

import {
  extractFilePath,
  extractToolState,
  isFilePart,
  isImageFilePart,
  isReasoningPart,
  isTextPart,
  isToolPart,
  normalizePart,
  normalizeParts,
} from "./adapter.ts";
import type { NormalizedPart } from "./types.ts";

describe("adapter/type guards", () => {
  test("detects part kinds", () => {
    const text = { type: "text" } as unknown as import("@opencode-ai/sdk").Part;
    const reasoning = { type: "reasoning" } as unknown as import("@opencode-ai/sdk").Part;
    const tool = { type: "tool" } as unknown as import("@opencode-ai/sdk").Part;
    const file = { type: "file", mime: "text/plain" } as unknown as import("@opencode-ai/sdk").Part;

    expect(isTextPart(text)).toBe(true);
    expect(isReasoningPart(text)).toBe(false);
    expect(isToolPart(text)).toBe(false);
    expect(isFilePart(text)).toBe(false);

    expect(isReasoningPart(reasoning)).toBe(true);
    expect(isToolPart(tool)).toBe(true);
    expect(isFilePart(file)).toBe(true);
  });

  test("isImageFilePart checks mime", () => {
    const img = { type: "file", mime: "image/png" } as unknown as import("@opencode-ai/sdk").Part;
    const non = { type: "file", mime: "text/plain" } as unknown as import("@opencode-ai/sdk").Part;
    expect(isImageFilePart(img)).toBe(true);
    expect(isImageFilePart(non)).toBe(false);
  });
});

describe("adapter/extractToolState", () => {
  test("completed state", () => {
    const part = {
      type: "tool",
      id: "p",
      messageID: "m",
      tool: "grep",
      state: {
        status: "completed",
        title: "t",
        input: { q: "x" },
        output: "ok",
        attachments: [],
      },
    } as unknown as import("@opencode-ai/sdk").ToolPart;
    expect(extractToolState(part)).toEqual({
      status: "completed",
      title: "t",
      input: { q: "x" },
      content: "ok",
    });
  });

  test("error state", () => {
    const part = {
      type: "tool",
      id: "p",
      messageID: "m",
      tool: "grep",
      state: {
        status: "error",
        input: { q: "x" },
        error: "bad",
      },
    } as unknown as import("@opencode-ai/sdk").ToolPart;
    expect(extractToolState(part)).toEqual({
      status: "error",
      title: null,
      input: { q: "x" },
      content: "bad",
    });
  });

  test("running state", () => {
    const part = {
      type: "tool",
      id: "p",
      messageID: "m",
      tool: "grep",
      state: {
        status: "running",
        title: "maybe",
        input: { q: "x" },
      },
    } as unknown as import("@opencode-ai/sdk").ToolPart;
    expect(extractToolState(part)).toEqual({
      status: "running",
      title: "maybe",
      input: { q: "x" },
      content: undefined,
    });
  });

  test("pending state", () => {
    const part = {
      type: "tool",
      id: "p",
      messageID: "m",
      tool: "grep",
      state: {
        status: "pending",
        input: { q: "x" },
      },
    } as unknown as import("@opencode-ai/sdk").ToolPart;
    expect(extractToolState(part)).toEqual({
      status: "pending",
      title: null,
      input: { q: "x" },
      content: undefined,
    });
  });

  test("unknown state throws", () => {
    const part = {
      type: "tool",
      id: "p",
      messageID: "m",
      tool: "grep",
      state: {
        status: "wat",
        input: {},
      },
    } as unknown as import("@opencode-ai/sdk").ToolPart;
    expect(() => extractToolState(part)).toThrow(/Unsupported tool state/);
  });
});

describe("adapter/extractFilePath", () => {
  test("prefers source.path", () => {
    const part = {
      type: "file",
      id: "f",
      messageID: "m",
      mime: "text/plain",
      source: { path: "src/a.ts" },
    } as unknown as import("@opencode-ai/sdk").FilePart;
    expect(extractFilePath(part)).toBe("src/a.ts");
  });

  test("falls back to filename", () => {
    const part = {
      type: "file",
      id: "f",
      messageID: "m",
      mime: "text/plain",
      filename: "a.ts",
    } as unknown as import("@opencode-ai/sdk").FilePart;
    expect(extractFilePath(part)).toBe("a.ts");
  });

  test("normalizes url path", () => {
    const part = {
      type: "file",
      id: "f",
      messageID: "m",
      mime: "text/plain",
      url: "https://example.com/path/to/a.ts",
    } as unknown as import("@opencode-ai/sdk").FilePart;
    expect(extractFilePath(part)).toBe("/path/to/a.ts");
  });

  test("normalizes windows drive url path", () => {
    const part = {
      type: "file",
      id: "f",
      messageID: "m",
      mime: "text/plain",
      url: "file:///C:/Users/me/a.ts",
    } as unknown as import("@opencode-ai/sdk").FilePart;
    expect(extractFilePath(part)).toBe("C:/Users/me/a.ts");
  });

  test("falls back to unknown-file", () => {
    const part = {
      type: "file",
      id: "f",
      messageID: "m",
      mime: "text/plain",
    } as unknown as import("@opencode-ai/sdk").FilePart;
    expect(extractFilePath(part)).toBe("unknown-file");
  });
});

describe("adapter/normalizePart(s)", () => {
  test("normalizePart returns null for unsupported types", () => {
    const part = { type: "snapshot" } as unknown as import("@opencode-ai/sdk").Part;
    expect(normalizePart(part)).toBeNull();
  });

  test("normalizeParts expands tool attachments", () => {
    const tool = {
      type: "tool",
      id: "t1",
      messageID: "m1",
      tool: "bash",
      state: {
        status: "completed",
        title: "done",
        input: {},
        output: "ok",
        attachments: [
          {
            type: "file",
            id: "a1",
            messageID: "m1",
            mime: "image/png",
            filename: "x.png",
          },
          {
            type: "file",
            id: "a2",
            messageID: "m1",
            mime: "text/plain",
            filename: "out.txt",
          },
        ],
      },
    } as unknown as import("@opencode-ai/sdk").ToolPart;

    const normalized = normalizeParts([tool]);
    expect(normalized).toHaveLength(3);

    const [toolPart, imgPart, filePart] = normalized;
    expect(toolPart.type).toBe("tool");
    expect(imgPart.type).toBe("image");
    expect(filePart.type).toBe("file");

    expect((imgPart as Extract<NormalizedPart, { type: "image" }>).mime).toBe("image/png");
    expect((filePart as Extract<NormalizedPart, { type: "file" }>).path).toBe("out.txt");
    expect((filePart as Extract<NormalizedPart, { type: "file" }>).partId).toContain("t1#attachment-a2");
  });
});
