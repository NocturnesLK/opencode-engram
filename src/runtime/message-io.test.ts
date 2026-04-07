import { afterEach, describe, expect, test, vi } from "vitest";

import {
  getAllMessages,
  getMessage,
  getMessagePage,
  messageLimit,
  normalizeCursor,
  sortMessagesChronological,
  sortMessagesNewestFirst,
  toNormalizedMessage,
} from "./message-io.ts";

function makeHeaders(nextCursor: string | undefined) {
  return {
    get(name: string) {
      if (name.toLowerCase() === "x-next-cursor") {
        return nextCursor ?? "";
      }
      return null;
    },
  };
}

function makeInput(overrides?: {
  sessionMessages?: ReturnType<typeof vi.fn>;
  sessionMessage?: ReturnType<typeof vi.fn>;
  appLog?: ReturnType<typeof vi.fn>;
}) {
  return {
    client: {
      session: {
        messages: overrides?.sessionMessages ?? vi.fn(),
        message: overrides?.sessionMessage ?? vi.fn(),
      },
      app: {
        log: overrides?.appLog ?? vi.fn(async () => undefined),
      },
    },
    directory: "/project",
  } as unknown as import("../common/common.ts").PluginInput;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("message-io/normalizeCursor", () => {
  test("empty or whitespace returns undefined", () => {
    expect(normalizeCursor("")).toBeUndefined();
    expect(normalizeCursor("   ")).toBeUndefined();
    expect(normalizeCursor(undefined)).toBeUndefined();
  });

  test("trims valid cursor", () => {
    expect(normalizeCursor("  abc ")).toBe("abc");
  });
});

describe("message-io/messageLimit", () => {
  test("default is 20", () => {
    expect(messageLimit(undefined, 999)).toBe(20);
  });

  test("clamps to max", () => {
    expect(messageLimit(50, 10)).toBe(10);
  });

  test("throws for invalid limits", () => {
    expect(() => messageLimit(0, 10)).toThrow(/limit must be a positive integer/);
    expect(() => messageLimit(-1, 10)).toThrow(/limit must be a positive integer/);
    expect(() => messageLimit(1.1, 10)).toThrow(/limit must be a positive integer/);
  });
});

describe("message-io/toNormalizedMessage", () => {
  test("maps fields", () => {
    const msg = {
      id: "m",
      role: "user",
      time: { created: 123 },
      summary: true,
    } as unknown as import("@opencode-ai/sdk").Message;

    expect(toNormalizedMessage(msg)).toEqual({
      id: "m",
      role: "user",
      time: 123,
      summary: true,
    });
  });
});

describe("message-io/sortMessagesChronological", () => {
  test("sorts by time asc, then role user first, then id", () => {
    const msgs = [
      { info: { id: "b", role: "assistant", time: { created: 1 } }, parts: [] },
      { info: { id: "a", role: "user", time: { created: 1 } }, parts: [] },
      { info: { id: "c", role: "assistant", time: { created: 0 } }, parts: [] },
      { info: { id: "d", role: "assistant", time: { created: undefined } }, parts: [] },
    ] as unknown as import("./message-io.ts").MessageBundle[];

    const sorted = sortMessagesChronological(msgs);
    expect(sorted.map((m) => m.info.id)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("message-io/sortMessagesNewestFirst", () => {
  test("sorts by time desc, undefined time last, stable for equals", () => {
    const msgs = [
      { info: { id: "a", role: "assistant", time: { created: 2 } }, parts: [] },
      { info: { id: "b", role: "assistant", time: { created: 2 } }, parts: [] },
      { info: { id: "c", role: "assistant", time: { created: 3 } }, parts: [] },
      { info: { id: "d", role: "assistant", time: { created: undefined } }, parts: [] },
    ] as unknown as import("./message-io.ts").MessageBundle[];

    const sorted = sortMessagesNewestFirst(msgs);
    expect(sorted.map((m) => m.info.id)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("message-io/getMessagePage", () => {
  test("normalizes empty next cursor and forwards before cursor", async () => {
    const sessionMessages = vi.fn(async (input: unknown) => ({
      data: [{ info: { id: "m1" }, parts: [] }],
      error: undefined,
      response: { status: 200, headers: makeHeaders("   ") },
      input,
    }));
    const input = makeInput({ sessionMessages });

    await expect(getMessagePage(input, "s1", 5, "cursor-1")).resolves.toEqual({
      msgs: [{ info: { id: "m1" }, parts: [] }],
      next_cursor: undefined,
    });
    expect(sessionMessages).toHaveBeenCalledWith({
      path: { id: "s1" },
      query: { limit: 5, before: "cursor-1" },
      throwOnError: false,
    });
  });

  test("maps 400 on paged cursor to invalid cursor error", async () => {
    const input = makeInput({
      sessionMessages: vi.fn(async () => ({
        data: undefined,
        error: { message: "bad cursor" },
        response: { status: 400, headers: makeHeaders(undefined) },
      })),
    });

    await expect(getMessagePage(input, "s1", 5, "bad")).rejects.toThrow(
      "Message 'bad' not found in history. It may be an invalid message_id.",
    );
  });
});

describe("message-io/getMessage", () => {
  test("maps auth, not-found, invalid, and transient errors", async () => {
    const sessionMessage = vi.fn()
      .mockResolvedValueOnce({
        data: undefined,
        error: { message: "missing" },
        response: { status: 404 },
      })
      .mockResolvedValueOnce({
        data: undefined,
        error: { message: "denied" },
        response: { status: 403 },
      })
      .mockResolvedValueOnce({
        data: undefined,
        error: { message: "bad" },
        response: { status: 400 },
      })
      .mockResolvedValueOnce({
        data: undefined,
        error: { message: "boom" },
        response: { status: 500 },
      })
      .mockResolvedValueOnce({
        data: { info: { id: "m1" }, parts: [] },
        error: undefined,
        response: { status: 200 },
      });
    const input = makeInput({ sessionMessage });

    await expect(getMessage(input, "s1", "m404")).rejects.toThrow(
      "Requested message not found. Please ensure the message_id is correct.",
    );
    await expect(getMessage(input, "s1", "m403")).rejects.toThrow(
      "Not authorized to read this message. Please check your permissions.",
    );
    await expect(getMessage(input, "s1", "m400")).rejects.toThrow(
      "Invalid request (status 400). Please check your parameters.",
    );
    await expect(getMessage(input, "s1", "m500")).rejects.toThrow(
      "Failed to read message. This may be a temporary issue — try again.",
    );
    await expect(getMessage(input, "s1", "m1")).resolves.toEqual({ info: { id: "m1" }, parts: [] });
  });
});

describe("message-io/getAllMessages", () => {
  test("uses seed page before fetching remaining pages", async () => {
    const sessionMessages = vi.fn(async ({ query }: { query: { before?: string } }) => {
      if (query.before === "cursor-1") {
        return {
          data: [{ info: { id: "m2" }, parts: [] }],
          error: undefined,
          response: { status: 200, headers: makeHeaders(undefined) },
        };
      }

      throw new Error("unexpected page request");
    });
    const input = makeInput({ sessionMessages });

    await expect(
      getAllMessages(input, "s1", 2, {
        msgs: [{ info: { id: "m1" }, parts: [] } as unknown as import("./message-io.ts").MessageBundle],
        next_cursor: "cursor-1",
      }),
    ).resolves.toEqual([
      { info: { id: "m1" }, parts: [] },
      { info: { id: "m2" }, parts: [] },
    ]);
    expect(sessionMessages).toHaveBeenCalledTimes(1);
  });

  test("detects repeated cursors and logs internal error", async () => {
    const appLog = vi.fn(async () => undefined);
    const sessionMessages = vi.fn(async () => ({
      data: [{ info: { id: "m1" }, parts: [] }],
      error: undefined,
      response: { status: 200, headers: makeHeaders("dup") },
    }));
    const input = makeInput({ sessionMessages, appLog });

    await expect(getAllMessages(input, "s1", 2)).rejects.toThrow("Internal error (do not retry).");
    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "engram-plugin",
        level: "error",
        message: "Internal error: paging cursor repeated in getAllMessages",
        extra: { sessionID: "s1", repeatedCursor: "dup" },
      },
    });
  });
});
