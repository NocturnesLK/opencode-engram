import { afterEach, describe, expect, test, vi } from "vitest";

import { createOpenCodeBackend } from "./opencode-backend.ts";

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
  sessionGet?: ReturnType<typeof vi.fn>;
  sessionMessages?: ReturnType<typeof vi.fn>;
  sessionMessage?: ReturnType<typeof vi.fn>;
}) {
  return {
    directory: "/project",
    client: {
      session: {
        get: overrides?.sessionGet ?? vi.fn(),
        messages: overrides?.sessionMessages ?? vi.fn(),
        message: overrides?.sessionMessage ?? vi.fn(),
      },
    },
  } as unknown as import("../../common/common.ts").PluginInput;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runtime/backends/opencode-backend", () => {
  test("maps valid SDK payloads to HistoryBackend shapes", async () => {
    const input = makeInput({
      sessionGet: vi.fn(async () => ({
        data: {
          id: "s1",
          title: "Session",
          version: 2,
          time: { updated: 123 },
          parentID: "parent",
        },
        error: undefined,
        response: { status: 200 },
      })),
      sessionMessages: vi.fn(async () => ({
        data: [
          {
            info: {
              id: "m1",
              role: "assistant",
              time: { created: 11 },
              summary: true,
            },
            parts: [
              {
                type: "text",
                id: "t1",
                messageID: "m1",
                text: "hello",
                ignored: false,
              },
              {
                type: "tool",
                id: "tool1",
                messageID: "m1",
                tool: "bash",
                state: {
                  status: "completed",
                  title: "done",
                  input: { cmd: "pwd" },
                  output: "out",
                  attachments: [
                    {
                      type: "file",
                      id: "file1",
                      messageID: "m1",
                      mime: "text/plain",
                      source: { path: "out.txt" },
                    },
                  ],
                },
              },
            ],
          },
        ],
        error: undefined,
        response: { status: 200, headers: makeHeaders(" cursor-1 ") },
      })),
      sessionMessage: vi.fn(async () => ({
        data: {
          info: {
            id: "m1",
            role: "user",
            time: { created: 5 },
          },
          parts: [
            {
              type: "reasoning",
              id: "r1",
              messageID: "m1",
              text: "thinking",
            },
          ],
        },
        error: undefined,
        response: { status: 200 },
      })),
    });

    const backend = createOpenCodeBackend(input);

    await expect(backend.getSession("s1")).resolves.toEqual({
      id: "s1",
      title: "Session",
      version: 2,
      time: { updated: 123 },
      parentID: "parent",
    });

    await expect(backend.listMessages("s1", { limit: 10, before: "m0" })).resolves.toEqual({
      msgs: [
        {
          info: {
            id: "m1",
            role: "assistant",
            time: { created: 11 },
            summary: true,
          },
          parts: [
            {
              type: "text",
              id: "t1",
              messageID: "m1",
              text: "hello",
              ignored: false,
            },
            {
              type: "tool",
              id: "tool1",
              messageID: "m1",
              tool: "bash",
              state: {
                status: "completed",
                title: "done",
                input: { cmd: "pwd" },
                output: "out",
                attachments: [
                  {
                    type: "file",
                    id: "file1",
                    messageID: "m1",
                    mime: "text/plain",
                    source: { path: "out.txt" },
                    filename: undefined,
                    url: undefined,
                  },
                ],
              },
            },
          ],
        },
      ],
      nextCursor: " cursor-1 ",
    });

    await expect(backend.getMessage("s1", "m1")).resolves.toEqual({
      info: {
        id: "m1",
        role: "user",
        time: { created: 5 },
      },
      parts: [
        {
          type: "reasoning",
          id: "r1",
          messageID: "m1",
          text: "thinking",
        },
      ],
    });
  });

  test("throws on unsupported message role", async () => {
    const input = makeInput({
      sessionMessages: vi.fn(async () => ({
        data: [
          {
            info: {
              id: "m1",
              role: "system",
            },
            parts: [],
          },
        ],
        error: undefined,
        response: { status: 200, headers: makeHeaders(undefined) },
      })),
    });

    const backend = createOpenCodeBackend(input);
    await expect(backend.listMessages("s1", { limit: 10 })).rejects.toThrow(
      "Unsupported message role 'system'",
    );
  });

  test("throws on unsupported tool state", async () => {
    const input = makeInput({
      sessionMessages: vi.fn(async () => ({
        data: [
          {
            info: {
              id: "m1",
              role: "assistant",
            },
            parts: [
              {
                type: "tool",
                id: "tool1",
                messageID: "m1",
                tool: "bash",
                state: {
                  status: "unknown",
                  input: {},
                },
              },
            ],
          },
        ],
        error: undefined,
        response: { status: 200, headers: makeHeaders(undefined) },
      })),
    });

    const backend = createOpenCodeBackend(input);
    await expect(backend.listMessages("s1", { limit: 10 })).rejects.toThrow(
      "Unsupported tool state 'unknown'",
    );
  });

  test("maps SDK transport errors to stable backend errors", async () => {
    const input = makeInput({
      sessionGet: vi.fn(async () => ({
        data: undefined,
        error: { message: "boom" },
        response: { status: 500 },
      })),
      sessionMessages: vi.fn(async () => ({
        data: undefined,
        error: { message: "bad" },
        response: { status: 400, headers: makeHeaders(undefined) },
      })),
      sessionMessage: vi.fn(async () => ({
        data: undefined,
        error: { message: "missing" },
        response: { status: 404 },
      })),
    });

    const backend = createOpenCodeBackend(input);

    await expect(backend.getSession("s1")).rejects.toThrow(
      "Failed to load session 's1'. This may be a temporary issue — try again.",
    );
    await expect(backend.listMessages("s1", { limit: 10 })).rejects.toThrow(
      "Failed to read session messages. This may be a temporary issue — try again.",
    );
    await expect(backend.getMessage("s1", "m1")).rejects.toThrow(
      "Requested message not found. Please ensure the message_id is correct.",
    );
  });
});
