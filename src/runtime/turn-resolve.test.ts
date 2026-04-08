import { afterEach, describe, expect, test, vi } from "vitest";

import { clearTurnCache } from "../core/turn-index.ts";

vi.mock("./message-io.ts", () => {
  return {
    getAllMessages: vi.fn(),
    internalScanPageSize: 100,
    requireMessageRole: vi.fn((role: string | undefined) => {
      if (role === "user" || role === "assistant") {
        return role;
      }
      throw new Error(`Unsupported message role '${role ?? "undefined"}'`);
    }),
  };
});

import { getAllMessages } from "./message-io.ts";
import {
  fetchTurnItems,
  getSessionFingerprint,
  getTurnMapWithFallback,
} from "./turn-resolve.ts";

afterEach(() => {
  clearTurnCache("s");
  vi.clearAllMocks();
});

describe("turn-resolve/getSessionFingerprint", () => {
  test("returns fingerprint when version + updatedAt exist", () => {
    expect(getSessionFingerprint({
      id: "s",
      title: "t",
      version: 1,
      updatedAt: 2,
      parentId: undefined,
    })).toEqual({ version: 1, updated: 2 });
  });

  test("returns undefined when version missing", () => {
    expect(getSessionFingerprint({
      id: "s",
      title: "t",
      version: undefined,
      updatedAt: 2,
      parentId: undefined,
    })).toBeUndefined();
  });
});

describe("turn-resolve/fetchTurnItems", () => {
  test("maps messages to TurnComputeItem", async () => {
    (getAllMessages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [] },
      { info: { id: "m2", role: "assistant", time: { created: 2 } }, parts: [] },
    ]);

    const items = await fetchTurnItems(
      { client: {} } as unknown as import("../common/common.ts").PluginInput,
      "s",
      100,
    );
    expect(items).toEqual([
      { id: "m1", role: "user", time: 1 },
      { id: "m2", role: "assistant", time: 2 },
    ]);
  });
});

describe("turn-resolve/getTurnMapWithFallback", () => {
  test("rebuilds when required id missing", async () => {
    const getAll = getAllMessages as unknown as ReturnType<typeof vi.fn>;

    getAll
      .mockResolvedValueOnce([
        { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [] },
      ])
      .mockResolvedValueOnce([
        { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [] },
        { info: { id: "a1", role: "assistant", time: { created: 2 } }, parts: [] },
      ]);

    const journal = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const map = await getTurnMapWithFallback(
      { client: {} } as unknown as import("../common/common.ts").PluginInput,
      {
        session: {
          id: "s",
          title: "t",
          version: 1,
          updatedAt: 10,
          parentId: undefined,
        },
      },
      undefined,
      ["a1"],
      journal as unknown as import("./logger.ts").Logger,
    );

    expect(getAll).toHaveBeenCalledTimes(2);
    expect(map.get("a1")).toBeDefined();
  });
});
