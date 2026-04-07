import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildSearchCacheEntry,
  clearSearchCacheInflight,
  executeSearch,
  extractSearchDocuments,
  generateSnippets,
  getSearchCacheEntry,
  getSearchCacheInflight,
  setSearchCacheEntry,
  setSearchCacheInflight,
} from "./search.ts";
import type { NormalizedPart } from "../domain/types.ts";

afterEach(() => {
  // Avoid leaving behind in-flight builds between tests.
  clearSearchCacheInflight("s", "f", Promise.resolve({} as unknown as import("./search.ts").SearchCacheEntry));
});

describe("search/extractSearchDocuments", () => {
  test("extracts text, reasoning, tool; skips ignored/empty and image/file", () => {
    const parts: NormalizedPart[] = [
      { type: "text", partId: "t1", messageId: "m", text: "hello", ignored: false },
      { type: "text", partId: "t2", messageId: "m", text: "  ", ignored: false },
      { type: "text", partId: "t3", messageId: "m", text: "ignored", ignored: true },
      { type: "reasoning", partId: "r1", messageId: "m", text: "think" },
      { type: "reasoning", partId: "r2", messageId: "m", text: "   " },
      {
        type: "tool",
        partId: "p1",
        messageId: "m",
        tool: "grep",
        title: null,
        status: "completed",
        input: { q: "x" },
        content: undefined,
      },
      {
        type: "tool",
        partId: "p2",
        messageId: "m",
        tool: "grep",
        title: null,
        status: "completed",
        input: {},
        content: "out",
      },
      {
        type: "tool",
        partId: "p3",
        messageId: "m",
        tool: "grep",
        title: null,
        status: "completed",
        input: {},
        content: "   ",
      },
      { type: "image", partId: "i", messageId: "m", mime: "image/png" },
      { type: "file", partId: "f", messageId: "m", path: "a.ts", mime: "text/plain" },
    ];

    const docs = extractSearchDocuments(parts, 123);
    expect(docs.map((d) => d.id)).toEqual(["t1", "r1", "p1", "p2"]);
    expect(docs.find((d) => d.id === "p1")?.content).toContain("grep(");
    expect(docs.find((d) => d.id === "p2")?.content).toContain("out");
  });

  test("respects tool visibility for search extraction", () => {
    const parts: NormalizedPart[] = [
      {
        type: "tool",
        partId: "p1",
        messageId: "m",
        tool: "bash",
        title: null,
        status: "completed",
        input: { cmd: "needle" },
        content: "secret-output",
      },
    ];

    const hiddenOutput = extractSearchDocuments(parts, 123, {
      visibleToolInputs: new Set(["bash"]),
      visibleToolOutputs: new Set(),
    });
    expect(hiddenOutput).toHaveLength(1);
    expect(hiddenOutput[0]?.content).toContain("needle");
    expect(hiddenOutput[0]?.content).not.toContain("secret-output");

    const hiddenAll = extractSearchDocuments(parts, 123, {
      visibleToolInputs: new Set(),
      visibleToolOutputs: new Set(),
    });
    expect(hiddenAll).toEqual([]);
  });
});

describe("search cache entry get/set", () => {
  test("stores and retrieves when fingerprint + ttl valid", () => {
    const entry = {
      sessionId: "s",
      fingerprint: "f1",
      createdAt: Date.now(),
      documents: [],
      db: {} as unknown as import("./search.ts").SearchOramaDb,
      messageMeta: new Map(),
    };
    setSearchCacheEntry(entry);
    expect(getSearchCacheEntry("s", "f1", 1000)).toBeDefined();
  });

  test("fingerprint mismatch invalidates", () => {
    const entry = {
      sessionId: "s",
      fingerprint: "f1",
      createdAt: Date.now(),
      documents: [],
      db: {} as unknown as import("./search.ts").SearchOramaDb,
      messageMeta: new Map(),
    };
    setSearchCacheEntry(entry);
    expect(getSearchCacheEntry("s", "f2", 1000)).toBeUndefined();
  });

  test("ttl expiry invalidates", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const entry = {
      sessionId: "s",
      fingerprint: "f1",
      createdAt: now,
      documents: [],
      db: {} as unknown as import("./search.ts").SearchOramaDb,
      messageMeta: new Map(),
    };
    setSearchCacheEntry(entry);

    vi.setSystemTime(now + 2000);
    expect(getSearchCacheEntry("s", "f1", 1000)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("search inflight build coalescing", () => {
  test("register/get/clear lifecycle", async () => {
    const p = Promise.resolve({} as unknown as import("./search.ts").SearchCacheEntry);
    setSearchCacheInflight("s", "f", p);
    expect(getSearchCacheInflight("s", "f")).toBe(p);
    clearSearchCacheInflight("s", "f", p);
    expect(getSearchCacheInflight("s", "f")).toBeUndefined();
  });

  test("clear only clears matching promise", async () => {
    const p1 = Promise.resolve({} as unknown as import("./search.ts").SearchCacheEntry);
    const p2 = Promise.resolve({} as unknown as import("./search.ts").SearchCacheEntry);
    setSearchCacheInflight("s", "f", p1);
    clearSearchCacheInflight("s", "f", p2);
    expect(getSearchCacheInflight("s", "f")).toBe(p1);
  });
});

describe("search/generateSnippets", () => {
  test("exact: finds literal occurrences and returns snippets", () => {
    const snippets = generateSnippets(
      "hello world hello",
      "hello",
      true,
      10,
      2,
    );
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]).toContain("hello");
  });

  test("exact: fallback when no matches", () => {
    const snippets = generateSnippets(
      "abcdef",
      "zzz",
      true,
      4,
      2,
    );
    expect(snippets).toEqual(["a..."]);
  });

  test("fulltext: prefers longer terms (provided terms)", () => {
    const snippets = generateSnippets(
      "xx abcdef yy ab zz",
      "ignored",
      false,
      30,
      1,
      ["ab", "abcdef"],
    );
    expect(snippets[0]).toContain("abcdef");
  });

  test("empty content yields no snippets", () => {
    expect(generateSnippets("  ", "x", true, 10, 1)).toEqual([]);
  });
});

describe("search/buildSearchCacheEntry + executeSearch (exact path)", () => {
  test("builds cache and executes exact search without Orama fulltext", async () => {
    const messages = [
      {
        id: "m1",
        role: "user" as const,
        time: 1,
        turn: 1,
        parts: [
          { type: "text", partId: "p1", messageId: "m1", text: "hello", ignored: false },
          { type: "text", partId: "p2", messageId: "m1", text: "world", ignored: false },
        ] as NormalizedPart[],
      },
      {
        id: "m2",
        role: "assistant" as const,
        time: 2,
        turn: 1,
        parts: [
          { type: "reasoning", partId: "r1", messageId: "m2", text: "thinking" },
        ] as NormalizedPart[],
      },
    ];

    const cache = await buildSearchCacheEntry("s", "f", messages);
    const res = await executeSearch(
      cache,
      { query: "hello", literal: true, limit: 10, types: ["text"] },
      20,
      2,
    );

    expect(res.totalHits).toBe(1);
    expect(res.hits[0].messageId).toBe("m1");
    expect(res.hits[0].snippets.join("\n")).toContain("hello");
  });

  test("fulltext search ranks matching messages and preserves grouped ordering", async () => {
    const messages = [
      {
        id: "m1",
        role: "user" as const,
        time: 1,
        turn: 1,
        parts: [
          { type: "text", partId: "p1", messageId: "m1", text: "alpha beta", ignored: false },
        ] as NormalizedPart[],
      },
      {
        id: "m2",
        role: "assistant" as const,
        time: 2,
        turn: 2,
        parts: [
          { type: "text", partId: "p2", messageId: "m2", text: "beta gamma", ignored: false },
        ] as NormalizedPart[],
      },
    ];

    const cache = await buildSearchCacheEntry("s", "f", messages);
    const res = await executeSearch(
      cache,
      { query: "beta", literal: false, limit: 2, types: ["text"] },
      20,
      2,
    );

    expect(res.totalHits).toBe(2);
    expect(res.hits.map((hit) => hit.messageId)).toEqual(["m2", "m1"]);
    expect(res.hits.map((hit) => hit.documentId)).toEqual(["p2", "p1"]);
    expect(res.hits[0]?.snippets).toEqual(["beta gamma"]);
    expect(res.hits[1]?.snippets).toEqual(["alpha beta"]);
  });

  test("filters exact search by allowed types", async () => {
    const messages = [
      {
        id: "m1",
        role: "user" as const,
        time: 1,
        turn: 1,
        parts: [
          { type: "text", partId: "p1", messageId: "m1", text: "hello world", ignored: false },
        ] as NormalizedPart[],
      },
      {
        id: "m2",
        role: "assistant" as const,
        time: 2,
        turn: 1,
        parts: [
          { type: "reasoning", partId: "r1", messageId: "m2", text: "hello plan" },
        ] as NormalizedPart[],
      },
    ];

    const cache = await buildSearchCacheEntry("s", "f", messages);
    const res = await executeSearch(
      cache,
      { query: "hello", literal: true, limit: 10, types: ["reasoning"] },
      20,
      2,
    );

    expect(res.totalHits).toBe(1);
    expect(res.hits.map((hit) => hit.type)).toEqual(["reasoning"]);
    expect(res.hits.map((hit) => hit.messageId)).toEqual(["m2"]);
  });

  test("filters fulltext search by allowed types", async () => {
    const messages = [
      {
        id: "m1",
        role: "user" as const,
        time: 1,
        turn: 1,
        parts: [
          { type: "text", partId: "p1", messageId: "m1", text: "beta alpha", ignored: false },
        ] as NormalizedPart[],
      },
      {
        id: "m2",
        role: "assistant" as const,
        time: 2,
        turn: 2,
        parts: [
          { type: "reasoning", partId: "r1", messageId: "m2", text: "beta plan" },
        ] as NormalizedPart[],
      },
      {
        id: "m3",
        role: "assistant" as const,
        time: 3,
        turn: 3,
        parts: [
          {
            type: "tool",
            partId: "t1",
            messageId: "m3",
            tool: "grep",
            title: null,
            status: "completed",
            input: { query: "beta" },
            content: "beta output",
          },
        ] as NormalizedPart[],
      },
    ];

    const cache = await buildSearchCacheEntry("s", "f", messages);
    const res = await executeSearch(
      cache,
      { query: "beta", literal: false, limit: 10, types: ["tool", "reasoning"] },
      20,
      2,
    );

    expect(res.totalHits).toBe(2);
    expect(res.hits.map((hit) => hit.type)).toEqual(["reasoning", "tool"]);
    expect(res.hits.map((hit) => hit.messageId)).toEqual(["m2", "m3"]);
  });
});
