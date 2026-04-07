import { afterEach, describe, expect, test, vi } from "vitest";

import { computeTurns } from "../domain/domain.ts";
import {
  buildFingerprint,
  clearTurnCache,
  getTurnCache,
  getTurnMapWithCache,
  setTurnCache,
  type SessionFingerprint,
} from "./turn-index.ts";

const bulkSessionIds = Array.from({ length: 129 }, (_, index) => `bulk-${index}`);

afterEach(() => {
  // Isolate module-level cache state.
  clearTurnCache("s1");
  clearTurnCache("s2");
  clearTurnCache("s3");
  for (const sessionId of bulkSessionIds) {
    clearTurnCache(sessionId);
  }
  vi.useRealTimers();
});

describe("turn-index/buildFingerprint", () => {
  test("returns structure", () => {
    expect(buildFingerprint(1, 2)).toEqual({ version: 1, updated: 2 });
  });
});

describe("turn-index get/set/getTurnCache", () => {
  test("miss returns undefined", () => {
    const fp = buildFingerprint(1, 2);
    expect(getTurnCache("s1", fp)).toBeUndefined();
  });

  test("hit returns turnMap", () => {
    const fp = buildFingerprint(1, 2);
    const map = new Map([["m1", 1]]);
    setTurnCache("s1", fp, map);
    expect(getTurnCache("s1", fp)).toEqual(map);
  });

  test("fingerprint mismatch invalidates", () => {
    const fp1 = buildFingerprint(1, 2);
    const fp2 = buildFingerprint(1, 3);
    setTurnCache("s1", fp1, new Map([["m1", 1]]));
    expect(getTurnCache("s1", fp2)).toBeUndefined();
    // Second read should still be empty.
    expect(getTurnCache("s1", fp1)).toBeUndefined();
  });

  test("ttl expiry prunes stale entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fp = buildFingerprint(1, 2);
    setTurnCache("s1", fp, new Map([["m1", 1]]));

    vi.setSystemTime(10 * 60 * 1000 + 1);
    expect(getTurnCache("s1", fp)).toBeUndefined();
  });

  test("refreshes hot entries before bounded-cache eviction", () => {
    const fp = buildFingerprint(1, 2);

    for (const [index, sessionId] of bulkSessionIds.slice(0, 128).entries()) {
      setTurnCache(sessionId, fp, new Map([[`m${index}`, index]]));
    }

    expect(getTurnCache("bulk-0", fp)).toEqual(new Map([["m0", 0]]));

    setTurnCache("bulk-128", fp, new Map([["m128", 128]]));

    expect(getTurnCache("bulk-1", fp)).toBeUndefined();
    expect(getTurnCache("bulk-0", fp)).toEqual(new Map([["m0", 0]]));
    expect(getTurnCache("bulk-128", fp)).toEqual(new Map([["m128", 128]]));
  });
});

describe("turn-index/getTurnMapWithCache", () => {
  test("fallback when fingerprint undefined", async () => {
    const fetchItems = vi.fn(async () => [
      { id: "u1", role: "user" as const, time: 1 },
      { id: "a1", role: "assistant" as const, time: 2 },
    ]);
    const logger = { debug: vi.fn() };
    const result = await getTurnMapWithCache(
      "s1",
      undefined,
      fetchItems,
      computeTurns,
      logger,
    );

    expect(result.source).toBe("fallback");
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(result.turnMap.get("u1")).toBe(1);
    expect(logger.debug).toHaveBeenCalledWith(
      "turn cache fallback (no fingerprint)",
      { sessionId: "s1" },
    );
  });

  test("hit when cache present", async () => {
    const fp: SessionFingerprint = buildFingerprint(1, 2);
    const cached = new Map([["m1", 1]]);
    setTurnCache("s1", fp, cached);
    const fetchItems = vi.fn(async () => []);
    const logger = { debug: vi.fn() };
    const result = await getTurnMapWithCache(
      "s1",
      fp,
      fetchItems,
      computeTurns,
      logger,
    );
    expect(result.source).toBe("hit");
    expect(result.turnMap).toEqual(cached);
    expect(fetchItems).not.toHaveBeenCalled();
  });

  test("rebuild when cache missing", async () => {
    const fp: SessionFingerprint = buildFingerprint(1, 2);
    const fetchItems = vi.fn(async () => [
      { id: "a1", role: "assistant" as const, time: 2 },
      { id: "u1", role: "user" as const, time: 1 },
      { id: "u2", role: "user" as const, time: 3 },
    ]);
    const logger = { debug: vi.fn() };
    const result = await getTurnMapWithCache(
      "s1",
      fp,
      fetchItems,
      computeTurns,
      logger,
    );

    expect(result.source).toBe("rebuild");
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(result.turnMap).toEqual(new Map([
      ["u1", 1],
      ["a1", 1],
      ["u2", 2],
    ]));
    expect(getTurnCache("s1", fp)).toEqual(result.turnMap);
    expect(logger.debug).toHaveBeenCalledWith("turn cache rebuild", {
      sessionId: "s1",
      version: 1,
      updated: 2,
    });
  });
});
