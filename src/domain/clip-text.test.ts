import { describe, expect, test } from "vitest";

import { clipPreviewText, clipText } from "./clip-text.ts";

describe("domain/clipText", () => {
  test("returns short text unchanged", () => {
    expect(clipText("  short text  ", 20)).toBe("short text");
  });

  test("clips at an English sentence boundary when available", () => {
    expect(clipText("Hello world. Next sentence keeps going.", 20)).toBe(
      "Hello world.\n[27 chars more]",
    );
  });

  test("clips at a Chinese sentence boundary when available", () => {
    expect(clipText("第一句。第二句内容更多。第三句。", 8)).toBe(
      "第一句。\n[12 chars more]",
    );
  });

  test("clips at an exclamation sentence boundary when available", () => {
    expect(clipText("Wait! Another sentence follows.", 10)).toBe(
      "Wait!\n[26 chars more]",
    );
  });

  test("uses newline sentence boundaries for stack-trace like text", () => {
    const text = "Error: boom\n    at main (app.js:1:1)\n    at run (app.js:2:2)";
    expect(clipText(text, 20)).toBe("Error: boom\n[49 chars more]");
  });

  test("does not cut before half the budget when using sentence boundaries", () => {
    expect(clipText("Hi. This sentence keeps going for a while.", 20)).toBe(
      "Hi. This sentence\n[25 chars more]",
    );
  });

  test("falls back to a word boundary when no sentence boundary exists", () => {
    expect(clipText("alpha beta gamma delta", 12)).toBe(
      "alpha beta\n[12 chars more]",
    );
  });

  test("falls back to a hard cut when no word boundary exists", () => {
    expect(clipText("abcdefghijklmnopqrstuvwxyz", 10)).toBe(
      "abcdefghij\n[16 chars more]",
    );
  });

  test("keeps abbreviation text intact when segmenter does not provide a later boundary", () => {
    expect(clipText("e.g. this continues here and keeps going", 12)).toBe(
      "e.g. this\n[31 chars more]",
    );
  });

  test("preserves truncation marker format and remaining count", () => {
    expect(clipText("abcdef", 3)).toBe("abc\n[3 chars more]");
  });
});

describe("domain/clipPreviewText", () => {
  test("returns short preview unchanged", () => {
    expect(clipPreviewText("short text", 20)).toBe("short text");
  });

  test("clips preview at sentence boundary with ellipsis", () => {
    expect(clipPreviewText("Hello world. Next sentence keeps going.", 20)).toBe("Hello world....");
  });

  test("falls back to word boundary with ellipsis", () => {
    expect(clipPreviewText("alpha beta gamma delta", 12)).toBe("alpha beta...");
  });

  test("falls back to hard cut with ellipsis", () => {
    expect(clipPreviewText("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij...");
  });
});
