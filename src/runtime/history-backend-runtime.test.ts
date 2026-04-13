import { afterEach, describe, expect, test, vi } from "vitest";

import type { PluginInput } from "../common/common.ts";
import type { EngramConfig } from "../common/config.ts";
import { createBrowseContext, type SessionTarget } from "../core/index.ts";
import type { HistoryBackend } from "../core/history-backend.ts";
import type { HistorySessionData } from "../core/session.ts";
import { clearTurnCache } from "../core/turn-index.ts";
import type { HistoryMessageBundle, HistoryToolState } from "../domain/types.ts";

import { browseData, overviewData, readData, searchData } from "./runtime.ts";

const fakeSessionIds = [
  "fake-browse",
  "fake-overview",
  "fake-read",
  "fake-search",
];

function makeConfig(): EngramConfig {
  return {
    debug_mode: {
      enable: false,
      log_tool_calls: true,
    },
    upstream_history: {
      enable: true,
      disable_for_agents: [],
    },
    context_charting: {
      enable: false,
      recent_turns: 10,
      recent_messages: 5,
    },
    browse_messages: {
      message_limit: 100,
      user_preview_length: 140,
      assistant_preview_length: 140,
    },
    browse_turns: {
      user_preview_length: 140,
      assistant_preview_length: 140,
    },
    pull_message: {
      text_length: 400,
      reasoning_length: 400,
      tool_output_length: 400,
      tool_input_length: 50,
    },
    show_tool_input: ["*"],
    show_tool_output: ["*"],
    search: {
      max_hits_per_message: 5,
      max_snippets_per_hit: 5,
      snippet_length: 120,
      message_limit: 5,
    },
  };
}

function makeJournal() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import("./logger.ts").Logger;
}

function makeInputWithoutSdk(): PluginInput {
  const client = {
    app: {
      log: vi.fn(async () => undefined),
    },
    get session() {
      throw new Error("OpenCode SDK session client should not be used");
    },
  };

  return {
    client,
    directory: "/project",
  } as unknown as PluginInput;
}

function makeTextPart(messageID: string, id: string, text: string) {
  return {
    type: "text" as const,
    id,
    messageID,
    text,
  };
}

function makeReasoningPart(messageID: string, id: string, text: string) {
  return {
    type: "reasoning" as const,
    id,
    messageID,
    text,
  };
}

function makeToolPart(
  messageID: string,
  id: string,
  tool: string,
  state: HistoryToolState,
) {
  return {
    type: "tool" as const,
    id,
    messageID,
    tool,
    state,
  };
}

function makeBundle(
  sessionID: string,
  id: string,
  role: "user" | "assistant",
  created: number,
  parts: HistoryMessageBundle["parts"],
): HistoryMessageBundle {
  return {
    info: {
      id,
      role,
      time: { created },
    },
    parts,
  };
}

function sortNewestFirst(messages: readonly HistoryMessageBundle[]) {
  return [...messages].sort((left, right) => {
    const leftTime = left.info.time?.created ?? Number.NEGATIVE_INFINITY;
    const rightTime = right.info.time?.created ?? Number.NEGATIVE_INFINITY;
    return rightTime - leftTime;
  });
}

function makeBackend(
  session: HistorySessionData,
  messages: readonly HistoryMessageBundle[],
): HistoryBackend {
  return {
    async getSession(sessionId) {
      if (sessionId !== session.id) {
        throw new Error(`Session '${sessionId}' not found`);
      }
      return session;
    },
    async listMessages(sessionId, options) {
      if (sessionId !== session.id) {
        throw new Error(`Session '${sessionId}' not found`);
      }

      const newestFirst = sortNewestFirst(messages);
      let start = 0;
      if (options.before) {
        const index = newestFirst.findIndex((message) => message.info.id === options.before);
        if (index < 0) {
          throw new Error(`Message '${options.before}' not found in history. It may be an invalid message_id.`);
        }
        start = index + 1;
      }

      const page = newestFirst.slice(start, start + options.limit);
      const nextCursor = start + options.limit < newestFirst.length && page.length > 0
        ? page[page.length - 1]!.info.id
        : undefined;

      return {
        msgs: page,
        nextCursor,
      };
    },
    async getMessage(sessionId, messageId) {
      if (sessionId !== session.id) {
        throw new Error(`Session '${sessionId}' not found`);
      }

      const message = messages.find((item) => item.info.id === messageId);
      if (!message) {
        throw new Error("Requested message not found. Please ensure the message_id is correct.");
      }
      return message;
    },
  };
}

function makeBrowse(
  sessionId: string,
  backend: HistoryBackend,
): import("../core/index.ts").BrowseContext {
  const target: SessionTarget = {
    session: {
      id: sessionId,
      title: "Fake Session",
      version: 1,
      updatedAt: 100,
      parentId: undefined,
    },
  };
  return createBrowseContext(target, false, backend);
}

afterEach(() => {
  for (const sessionId of fakeSessionIds) {
    clearTurnCache(sessionId);
  }
  vi.clearAllMocks();
});

describe("runtime/history tools with fake backend", () => {
  test("browseData uses only HistoryBackend", async () => {
    const sessionId = "fake-browse";
    const backend = makeBackend(
      { id: sessionId, title: "Fake Session", version: 1, time: { updated: 100 } },
      [
        makeBundle(sessionId, "u1", "user", 1, [makeTextPart("u1", "u1-text", "hello from fake backend")]),
        makeBundle(sessionId, "a1", "assistant", 2, [makeTextPart("a1", "a1-text", "answer from fake backend")]),
        makeBundle(sessionId, "u2", "user", 3, [makeTextPart("u2", "u2-text", "follow-up")]),
      ],
    );

    const out = await browseData(
      makeInputWithoutSdk(),
      makeBrowse(sessionId, backend),
      makeConfig(),
      makeJournal(),
      {
        messageID: "a1",
        numBefore: 1,
        numAfter: 1,
      },
    );

    expect(out).toEqual({
      before_message_id: null,
      messages: [
        {
          role: "user",
          turn_number: 1,
          message_id: "u1",
          preview: "hello from fake backend",
        },
        {
          role: "assistant",
          turn_number: 1,
          message_id: "a1",
          preview: "answer from fake backend",
        },
        {
          role: "user",
          turn_number: 2,
          message_id: "u2",
          preview: "follow-up",
        },
      ],
      after_message_id: null,
    });
  });

  test("overviewData uses only HistoryBackend", async () => {
    const sessionId = "fake-overview";
    const backend = makeBackend(
      { id: sessionId, title: "Fake Session", version: 1, time: { updated: 100 } },
      [
        makeBundle(sessionId, "u1", "user", 1, [makeTextPart("u1", "u1-text", "first question")]),
        makeBundle(sessionId, "a1", "assistant", 2, [
          makeToolPart("a1", "tool1", "grep", {
            status: "completed",
            title: "done",
            input: { q: "needle" },
            output: "found needle",
            attachments: [],
          }),
          makeTextPart("a1", "a1-text", "first answer"),
        ]),
        makeBundle(sessionId, "u2", "user", 3, [makeTextPart("u2", "u2-text", "second question")]),
      ],
    );

    const out = await overviewData(
      makeInputWithoutSdk(),
      makeBrowse(sessionId, backend),
      makeConfig(),
      makeJournal(),
      { numBefore: 10, numAfter: 10 },
    );

    expect(out).toEqual({
      turns: [
        {
          turn_number: 1,
          user: {
            message_id: "u1",
            preview: "first question",
          },
          assistant: {
            total_messages: 1,
            preview: "first answer",
            tool: {
              calls: ["1× grep"],
              outcome: "completed",
            },
          },
        },
        {
          turn_number: 2,
          user: {
            message_id: "u2",
            preview: "second question",
          },
          assistant: null,
        },
      ],
    });
  });

  test("readData uses only HistoryBackend", async () => {
    const sessionId = "fake-read";
    const backend = makeBackend(
      { id: sessionId, title: "Fake Session", version: 1, time: { updated: 100 } },
      [
        makeBundle(sessionId, "a1", "assistant", 2, [
          makeTextPart("a1", "a1-text", "first answer"),
          makeReasoningPart("a1", "a1-reason", "internal trace"),
          makeToolPart("a1", "tool1", "grep", {
            status: "completed",
            title: "done",
            input: { q: "needle" },
            output: "found needle",
            attachments: [],
          }),
        ]),
        makeBundle(sessionId, "u1", "user", 1, [makeTextPart("u1", "u1-text", "first question")]),
      ],
    );

    const out = await readData(
      makeInputWithoutSdk(),
      makeBrowse(sessionId, backend),
      makeConfig(),
      "a1",
      undefined,
      makeJournal(),
    );

    expect(out).toEqual({
      message_id: "a1",
      role: "assistant",
      turn_number: 1,
      time: "1970-01-01T00:00:00.002Z",
      sections: [
        { type: "text", content: "first answer" },
        { type: "reasoning", content: "internal trace" },
        {
          type: "tool",
          tool: "grep",
          status: "completed",
          input: { q: "needle" },
          content: "found needle",
        },
      ],
    });
  });

  test("searchData uses only HistoryBackend", async () => {
    const sessionId = "fake-search";
    const backend = makeBackend(
      { id: sessionId, title: "Fake Session", version: 1, time: { updated: 100 } },
      [
        makeBundle(sessionId, "u1", "user", 1, [makeTextPart("u1", "u1-text", "first question")]),
        makeBundle(sessionId, "a1", "assistant", 2, [
          makeToolPart("a1", "tool1", "grep", {
            status: "completed",
            title: "done",
            input: { q: "needle" },
            output: "found needle",
            attachments: [],
          }),
        ]),
      ],
    );

    const out = await searchData(
      makeInputWithoutSdk(),
      makeBrowse(sessionId, backend),
      makeConfig(),
      { query: "needle", literal: true, limit: 5, types: ["tool"] },
      makeJournal(),
    );

    expect(out).toEqual({
      messages: [
        {
          role: "assistant",
          turn_number: 1,
          message_id: "a1",
          hits: [
            {
              type: "tool",
              part_id: "tool1",
              tool_name: "grep",
              snippets: [expect.any(String)],
            },
          ],
        },
      ],
    });
  });
});
