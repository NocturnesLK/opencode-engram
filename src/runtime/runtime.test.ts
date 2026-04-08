import { afterEach, describe, expect, test, vi } from "vitest";

import {
  browseData,
  overviewData,
  readData,
  runCall,
  searchData,
} from "./runtime.ts";
import { transientSearchErrorMessage } from "./debug.ts";
import { loadChartingData } from "./charting.ts";
import type { EngramConfig } from "../common/config.ts";
import type { PluginInput, ToolContext } from "../common/common.ts";
import type { BrowseContext, SessionTarget } from "../core/index.ts";
import { clearTurnCache, setTurnCache, buildFingerprint } from "../core/turn-index.ts";

type MessageBundle = import("./message-io.ts").MessageBundle;

function makeTextPart(messageID: string, id: string, text: string, ignored = false) {
  return {
    type: "text",
    id,
    messageID,
    text,
    ignored,
  } as unknown as import("@opencode-ai/sdk").Part;
}

function makeReasoningPart(messageID: string, id: string, text: string) {
  return {
    type: "reasoning",
    id,
    messageID,
    text,
  } as unknown as import("@opencode-ai/sdk").Part;
}

function makeToolPart(
  messageID: string,
  id: string,
  toolName: string,
  state: import("@opencode-ai/sdk").ToolState,
) {
  return {
    type: "tool",
    id,
    messageID,
    tool: toolName,
    state,
  } as unknown as import("@opencode-ai/sdk").Part;
}

function makeCompactionPart(messageID: string, id: string, auto = false) {
  return {
    type: "compaction",
    id,
    messageID,
    auto,
  } as unknown as import("@opencode-ai/sdk").Part;
}

function makeStepStartPart(messageID: string, id: string) {
  return {
    type: "step-start",
    id,
    messageID,
  } as unknown as import("@opencode-ai/sdk").Part;
}

function makeFilePart(
  messageID: string,
  id: string,
  mime: string,
  path: string,
) {
  return {
    type: "file",
    id,
    messageID,
    mime,
    source: { path },
  } as unknown as import("@opencode-ai/sdk").Part;
}

function makeMessageBundle(
  sessionID: string,
  id: string,
  role: "user" | "assistant",
  created: number | undefined,
  parts: import("@opencode-ai/sdk").Part[],
  summary = false,
): MessageBundle {
  return {
    info: {
      id,
      sessionID,
      role,
      time: { created },
      summary,
    } as unknown as import("@opencode-ai/sdk").Message,
    parts,
  };
}

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

function makeClient(store: {
  sessions: Map<string, import("../core/session.ts").SdkSessionData>;
  messages: Map<string, MessageBundle[]>;
}) {
  const appLog = vi.fn(async () => undefined);

  const sessionGet = vi.fn(async ({ path }: { path: { id: string } }) => {
    const session = store.sessions.get(path.id);
    if (!session) {
      return {
        data: undefined,
        error: { message: "not found" },
        response: { status: 404 },
      };
    }
    return {
      data: session,
      error: undefined,
      response: { status: 200 },
    };
  });

  const sessionMessage = vi.fn(async ({ path }: { path: { id: string; messageID: string } }) => {
    const list = store.messages.get(path.id) ?? [];
    const hit = list.find((m) => m.info.id === path.messageID);
    if (!hit) {
      return {
        data: undefined,
        error: { message: "not found" },
        response: { status: 404 },
      };
    }
    return {
      data: hit,
      error: undefined,
      response: { status: 200 },
    };
  });

  const sessionMessages = vi.fn(
    async ({ path, query }: { path: { id: string }; query: { limit: number; before?: string } }) => {
      const list = store.messages.get(path.id) ?? [];
      const newestFirst = [...list].sort((a, b) => {
        const at = a.info.time?.created ?? Number.NEGATIVE_INFINITY;
        const bt = b.info.time?.created ?? Number.NEGATIVE_INFINITY;
        return bt - at;
      });

      let start = 0;
      if (query.before) {
        const idx = newestFirst.findIndex((m) => m.info.id === query.before);
        if (idx < 0) {
          return {
            data: undefined,
            error: { message: "bad cursor" },
            response: { status: 400, headers: makeHeaders(undefined) },
          };
        }
        start = idx + 1;
      }

      const page = newestFirst.slice(start, start + query.limit);
      const hasMore = start + query.limit < newestFirst.length;
      const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].info.id : undefined;

      return {
        data: page,
        error: undefined,
        response: { status: 200, headers: makeHeaders(nextCursor) },
      };
    },
  );

  return {
    app: {
      log: appLog,
    },
    session: {
      get: sessionGet,
      message: sessionMessage,
      messages: sessionMessages,
    },
  };
}

function makeConfig(overrides?: Partial<EngramConfig>): EngramConfig {
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
      max_hits_per_message: 2,
      max_snippets_per_hit: 5,
      snippet_length: 120,
      message_limit: 5,
    },
    ...(overrides ?? {}),
  };
}

function makeBrowse(target: SessionTarget): BrowseContext {
  return {
    target,
    selfSession: false,
  };
}

function makeSelfBrowse(target: SessionTarget): BrowseContext {
  return {
    target,
    selfSession: true,
  };
}

function makeJournal() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("runtime/browseData", () => {
  test("defaults to the latest visible message and returns older anchor", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m3", "assistant", 3, [makeTextPart("m3", "p3", "a3")]),
            makeMessageBundle(sessionID, "m2", "user", 2, [makeTextPart("m2", "p2", "u2")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "u1")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeBrowse(target), config, journal, {
      numBefore: 1,
      numAfter: 0,
    });
    expect(out.before_message_id).toBe("m1");
    expect(out).not.toHaveProperty("after_message_id");
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 2,
        message_id: "m2",
        preview: "u2",
      },
      {
        role: "assistant",
        turn_index: 2,
        message_id: "m3",
        preview: "a3",
      },
    ]);
  });

  test("returns a chronological window around message_id and throws on missing message", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m3", "assistant", 3, [makeTextPart("m3", "p3", "a3")]),
            makeMessageBundle(sessionID, "m2", "user", 2, [makeTextPart("m2", "p2", "u2")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "u1")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeBrowse(target), config, journal, {
      messageID: "m2",
      numBefore: 1,
      numAfter: 1,
    });
    expect(out.before_message_id).toBeNull();
    expect(out.after_message_id).toBeNull();
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "m1",
        preview: "u1",
      },
      {
        role: "user",
        turn_index: 2,
        message_id: "m2",
        preview: "u2",
      },
      {
        role: "assistant",
        turn_index: 2,
        message_id: "m3",
        preview: "a3",
      },
    ]);

    await expect(
      browseData(input, makeBrowse(target), config, journal, {
        messageID: "nope",
        numBefore: 0,
        numAfter: 0,
      }),
    ).rejects.toThrow(/Message 'nope' not found/);
  });

  test("rebuilds when cached turn map missing required ids", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m2", "user", 2, [makeTextPart("m2", "p2", "u2")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "u1")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    setTurnCache(sessionID, buildFingerprint(1, 1), new Map([["m2", 1]]));

    const out = await browseData(input, makeBrowse(target), config, journal, {
      numBefore: 1,
      numAfter: 0,
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "m1",
        preview: "u1",
      },
      {
        role: "user",
        turn_index: 2,
        message_id: "m2",
        preview: "u2",
      },
    ]);
    expect(journal.debug).toHaveBeenCalledWith(
      "turn map missing required ids in browse, rebuilding",
      expect.objectContaining({ missingCount: 1 }),
    );
  });

  test("self session filters to pre-compaction history", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m4", "assistant", 4, [makeTextPart("m4", "p4", "after")]),
            makeMessageBundle(sessionID, "sum", "assistant", 3, [makeTextPart("sum", "ps", "summary")], true),
            makeMessageBundle(sessionID, "m2", "user", 2, [makeTextPart("m2", "p2", "before")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "before2")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 0,
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "m1",
        preview: "before2",
      },
      {
        role: "user",
        turn_index: 2,
        message_id: "m2",
        preview: "before",
      },
    ]);
  });

  test("self session hides older summary messages within retained history", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 7, [makeTextPart("after", "p7", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 6, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "m4", "assistant", 5, [makeTextPart("m4", "p5", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 4, [makeTextPart("m3", "p4", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 3, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 0,
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "m1",
        preview: "first user",
      },
      {
        role: "assistant",
        turn_index: 1,
        message_id: "m2",
        preview: "first answer",
      },
      {
        role: "user",
        turn_index: 2,
        message_id: "m3",
        preview: "second user",
      },
      {
        role: "assistant",
        turn_index: 2,
        message_id: "m4",
        preview: "second answer",
      },
    ]);
  });

  test("self session returns before_message_id when older visible history exists", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 6, [makeTextPart("after", "p6", "after")]),
            makeMessageBundle(sessionID, "sum", "assistant", 5, [makeTextPart("sum", "ps", "summary")], true),
            makeMessageBundle(sessionID, "m4", "assistant", 4, [makeTextPart("m4", "p4", "answer 2")]),
            makeMessageBundle(sessionID, "m3", "user", 3, [makeTextPart("m3", "p3", "user 2")]),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "answer 1")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "user 1")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 1,
      numAfter: 0,
    });

    expect(out.before_message_id).toBe("m2");
    expect(out).not.toHaveProperty("after_message_id");
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 2,
        message_id: "m3",
        preview: "user 2",
      },
      {
        role: "assistant",
        turn_index: 2,
        message_id: "m4",
        preview: "answer 2",
      },
    ]);
  });

  test("self session reports hidden retained messages distinctly", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 7, [makeTextPart("after", "p7", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 6, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "m4", "assistant", 5, [makeTextPart("m4", "p5", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 4, [makeTextPart("m3", "p4", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 3, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 2, [makeCompactionPart("ct1", "c1", false)]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      browseData(input, makeSelfBrowse(target), config, journal, {
        messageID: "sum1",
        numBefore: 0,
        numAfter: 0,
      }),
    ).rejects.toThrow("Message 'sum1' is hidden in this session view. Try a nearby visible message instead.");

    await expect(
      browseData(input, makeSelfBrowse(target), config, journal, {
        messageID: "ct1",
        numBefore: 0,
        numAfter: 0,
      }),
    ).rejects.toThrow("Message 'ct1' is hidden in this session view. Try a nearby visible message instead.");
  });

  test("self session reports post-summary anchor as hidden", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 4, [makeTextPart("after", "p4", "after")]),
            makeMessageBundle(sessionID, "sum", "assistant", 3, [makeTextPart("sum", "ps", "summary")], true),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "before")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "before2")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      browseData(input, makeSelfBrowse(target), config, journal, {
        messageID: "after",
        numBefore: 0,
        numAfter: 0,
      }),
    ).rejects.toThrow("Message 'after' is hidden in this session view. Try a nearby visible message instead.");
  });

  test("adds semantic fallback previews for non-text messages", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "a1", "assistant", 2, [
              makeToolPart("a1", "tool1", "bash", {
                status: "completed",
                title: "done",
                input: { cmd: "pwd" },
                output: "ok",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeCompactionPart("u1", "c1")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 0,
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "u1",
        preview: "[compaction trigger]",
      },
      {
        role: "assistant",
        turn_index: 1,
        message_id: "a1",
        preview: "[tool calls only]",
        tool: {
          calls: ["1× bash"],
          outcome: "completed",
        },
      },
    ]);
  });

  test("keeps preview omitted for internal-only messages", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "a1", "assistant", 2, [makeStepStartPart("a1", "s1")]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeTextPart("u1", "p1", "hello")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 0,
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "u1",
        preview: "hello",
      },
      {
        role: "assistant",
        turn_index: 1,
        message_id: "a1",
      },
    ]);
  });

  test("keeps message_id in browse items when preview is truncated", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "u1", "user", 1, [makeTextPart("u1", "p1", "abcdef")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      browse_messages: {
        ...makeConfig().browse_messages,
        user_preview_length: 3,
      },
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await browseData(input, makeBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 0,
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "u1",
        preview: "abc...",
      },
    ]);
  });
});

// Keep module-level caches from leaking across tests.
afterEach(() => {
  clearTurnCache("parent");
  clearTurnCache("parent2");
  clearTurnCache("parent3");
  clearTurnCache("parent4");
});

describe("runtime/overviewData", () => {
  test("aggregates turns and previews", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "u2", "user", 3, [makeTextPart("u2", "p3", "two")]),
            makeMessageBundle(sessionID, "a1", "assistant", 2, [makeTextPart("a1", "p2", "answer")]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeTextPart("u1", "p1", "one")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 10,
    });
    expect(out).toEqual({
      turns: [
        {
          turn_index: 1,
          user: {
            preview: "one",
            message_id: "u1",
          },
          assistant: {
            preview: "answer",
            total_messages: 1,
          },
        },
        {
          turn_index: 2,
          user: {
            preview: "two",
            message_id: "u2",
          },
          assistant: null,
        },
      ],
    });
  });

  test("includes user attachment in overview when present", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "u1", "user", 1, [
              makeTextPart("u1", "p1", "has attachments"),
              makeFilePart("u1", "img1", "image/png", "img.png"),
              makeFilePart("u1", "file1", "text/plain", "docs/a.md"),
            ]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 10,
    });
    expect(out).toEqual({
      turns: [
        {
          turn_index: 1,
          user: {
            preview: "has attachments",
            message_id: "u1",
            attachment: ["1 image", "docs/a.md"],
          },
          assistant: null,
        },
      ],
    });
  });

  test("self session excludes messages at or after latest summary", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 4, [makeTextPart("after", "p4", "new")]),
            makeMessageBundle(sessionID, "sum", "assistant", 3, [makeTextPart("sum", "ps", "summary")], true),
            makeMessageBundle(sessionID, "u1", "user", 2, [makeTextPart("u1", "p2", "old user")]),
            makeMessageBundle(sessionID, "a1", "assistant", 1, [makeTextPart("a1", "p1", "old assistant")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 10,
    });
    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "old user",
          message_id: "u1",
        },
        assistant: {
          preview: "old assistant",
          total_messages: 1,
        },
      },
    ]);
  });

  test("self session keeps stable turn numbers while hiding summary turns", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 7, [makeTextPart("after", "p7", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 6, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "m4", "assistant", 5, [makeTextPart("m4", "p5", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 4, [makeTextPart("m3", "p4", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 3, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 10,
    });
    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "first user",
          message_id: "m1",
        },
        assistant: {
          preview: "first answer",
          total_messages: 1,
        },
      },
      {
        turn_index: 2,
        user: {
          preview: "second user",
          message_id: "m3",
        },
        assistant: {
          preview: "second answer",
          total_messages: 1,
        },
      },
    ]);
  });

  test("uses semantic fallback previews when a role has only non-text messages", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "a1", "assistant", 2, [
              makeToolPart("a1", "tool1", "bash", {
                status: "completed",
                title: "done",
                input: { cmd: "pwd" },
                output: "ok",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeCompactionPart("u1", "c1")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      numBefore: 0,
      numAfter: 0,
    });
    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          message_id: "u1",
          preview: "[compaction trigger]",
        },
        assistant: {
          total_messages: 1,
          preview: "[tool calls only]",
          tool: {
            calls: ["1× bash"],
            outcome: "completed",
          },
        },
      },
    ]);
  });

  test("omits compaction-only turns from self-session overview results", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 4, [makeTextPart("after", "p4", "after")]),
            makeMessageBundle(sessionID, "sum", "assistant", 3, [makeTextPart("sum", "ps", "summary")], true),
            makeMessageBundle(sessionID, "ct", "user", 2, [makeCompactionPart("ct", "c1")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 10,
    });
    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "first user",
          message_id: "m1",
        },
        assistant: null,
      },
    ]);
  });

  test("keeps turn preview null for internal-only assistant content", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "a1", "assistant", 2, [makeStepStartPart("a1", "s1")]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeTextPart("u1", "p1", "hello")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      numBefore: 0,
      numAfter: 0,
    });
    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "hello",
          message_id: "u1",
        },
        assistant: {
          preview: null,
          total_messages: 1,
        },
      },
    ]);
  });

  test("prefers later text previews over earlier fallback previews within a turn", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "a2", "assistant", 3, [makeTextPart("a2", "p3", "final answer")]),
            makeMessageBundle(sessionID, "a1", "assistant", 2, [
              makeToolPart("a1", "tool1", "bash", {
                status: "completed",
                title: "done",
                input: { cmd: "pwd" },
                output: "ok",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeTextPart("u1", "p1", "do it")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      numBefore: 0,
      numAfter: 0,
    });
    expect(out.turns[0]).toEqual({
      turn_index: 1,
      user: {
        message_id: "u1",
        preview: "do it",
      },
      assistant: {
        total_messages: 2,
        preview: "final answer",
        tool: {
          calls: ["1× bash"],
          outcome: "completed",
        },
      },
    });
  });

  test("relativizes modified files under workspace and preserves external absolute paths", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "a1", "assistant", 2, [
              makeToolPart("a1", "tool1", "apply_patch", {
                status: "completed",
                title: "patched",
                input: {
                  patchText: [
                    "*** Begin Patch",
                    "*** Update File: /project/src/runtime/runtime.ts",
                    "@@",
                    "-old",
                    "+new",
                    "*** Add File: /tmp/outside.ts",
                    "+outside",
                    "*** End Patch",
                  ].join("\n"),
                },
                output: "ok",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
            makeMessageBundle(sessionID, "u1", "user", 1, [makeTextPart("u1", "p1", "update files")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      numBefore: 0,
      numAfter: 0,
    });

    expect(out.turns[0]).toEqual({
      turn_index: 1,
      user: {
        message_id: "u1",
        preview: "update files",
      },
      assistant: {
        total_messages: 1,
        preview: "[tool calls only]",
        modified: ["src/runtime/runtime.ts", "/tmp/outside.ts"],
        tool: {
          calls: ["1× apply_patch"],
          outcome: "completed",
        },
      },
    });
  });

  test("returns a focused turn window in ascending order", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m6", "assistant", 10, [makeTextPart("m6", "p10", "latest answer")]),
            makeMessageBundle(sessionID, "m5", "user", 9, [makeTextPart("m5", "p9", "latest user")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 8, [makeTextPart("sum2", "p8", "summary 2")], true),
            makeMessageBundle(sessionID, "ct2", "user", 7, [makeCompactionPart("ct2", "c2", false)]),
            makeMessageBundle(sessionID, "m4", "assistant", 6, [makeTextPart("m4", "p6", "mid answer")]),
            makeMessageBundle(sessionID, "m3", "user", 5, [makeTextPart("m3", "p5", "mid user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 4, [makeTextPart("sum1", "p4", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 3, [makeCompactionPart("ct1", "c1", false)]),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeBrowse(target), config, journal, {
      turnIndex: 3,
      numBefore: 1,
      numAfter: 2,
    });
    expect(out).toEqual({
      turns: [
        {
          turn_index: 2,
          user: {
            preview: "[compaction trigger]",
            message_id: "ct1",
          },
          assistant: {
            preview: "summary 1",
            total_messages: 1,
          },
        },
        {
          turn_index: 3,
          user: {
            preview: "mid user",
            message_id: "m3",
          },
          assistant: {
            preview: "mid answer",
            total_messages: 1,
          },
        },
        {
          turn_index: 4,
          user: {
            preview: "[compaction trigger]",
            message_id: "ct2",
          },
          assistant: {
            preview: "summary 2",
            total_messages: 1,
          },
        },
        {
          turn_index: 5,
          user: {
            preview: "latest user",
            message_id: "m5",
          },
          assistant: {
            preview: "latest answer",
            total_messages: 1,
          },
        },
      ],
    });
  });

  test("defaults to the latest visible turn when turn_index is omitted", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 7, [makeTextPart("after", "p7", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 6, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "ct2", "user", 5, [makeCompactionPart("ct2", "c2", false)]),
            makeMessageBundle(sessionID, "m4", "assistant", 4, [makeTextPart("m4", "p4", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 3, [makeTextPart("m3", "p3", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 2, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 2, [makeCompactionPart("ct1", "c1", false)]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 0,
      numAfter: 0,
    });
    expect(out).toEqual({
      turns: [
        {
          turn_index: 3,
          user: {
            preview: "second user",
            message_id: "m3",
          },
          assistant: {
            preview: "second answer",
            total_messages: 1,
          },
        },
      ],
    });
  });

  test("returns visible turns from the requested window even when turn_index is hidden", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 7, [makeTextPart("after", "p7", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 6, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "ct2", "user", 5, [makeCompactionPart("ct2", "c2", false)]),
            makeMessageBundle(sessionID, "m4", "assistant", 4, [makeTextPart("m4", "p4", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 3, [makeTextPart("m3", "p3", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 2, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 2, [makeCompactionPart("ct1", "c1", false)]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      turnIndex: 2,
      numBefore: 1,
      numAfter: 1,
    });

    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "first user",
          message_id: "m1",
        },
        assistant: null,
      },
      {
        turn_index: 3,
        user: {
          preview: "second user",
          message_id: "m3",
        },
        assistant: {
          preview: "second answer",
          total_messages: 1,
        },
      },
    ]);
  });

  test("returns visible turns from the requested window even when turn_index is missing", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      turnIndex: 0,
      numBefore: 0,
      numAfter: 2,
    });

    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "first user",
          message_id: "m1",
        },
        assistant: {
          preview: "first answer",
          total_messages: 1,
        },
      },
    ]);
  });

  test("reports an empty requested window for self sessions", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      overviewData(input, makeSelfBrowse(target), config, journal, {
        turnIndex: 99,
        numBefore: 0,
        numAfter: 0,
      }),
    ).rejects.toThrow(
      "The requested window contains no visible turns. They may be hidden or out of range. Try adjusting the window size. If you want the latest turns, omit `turn_index` and retry.",
    );
  });

  test("reports an empty requested window for non-self sessions too", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      overviewData(input, makeBrowse(target), config, journal, {
        turnIndex: 99,
        numBefore: 0,
        numAfter: 0,
      }),
    ).rejects.toThrow(
      "The requested window contains no visible turns. They may be hidden or out of range. Try adjusting the window size. If you want the latest turns, omit `turn_index` and retry.",
    );
  });

  test("full self-session overview removes all retained compaction triggers", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 9, [makeTextPart("after", "p9", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 8, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "ct2", "user", 7, [makeCompactionPart("ct2", "c2", false)]),
            makeMessageBundle(sessionID, "m4", "assistant", 6, [makeTextPart("m4", "p6", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 5, [makeTextPart("m3", "p5", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 4, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 3, [makeCompactionPart("ct1", "c1", false)]),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await overviewData(input, makeSelfBrowse(target), config, journal, {
      numBefore: 10,
      numAfter: 10,
    });
    expect(out.turns).toEqual([
      {
        turn_index: 1,
        user: {
          preview: "first user",
          message_id: "m1",
        },
        assistant: {
          preview: "first answer",
          total_messages: 1,
        },
      },
      {
        turn_index: 3,
        user: {
          preview: "second user",
          message_id: "m3",
        },
        assistant: {
          preview: "second answer",
          total_messages: 1,
        },
      },
    ]);
  });

  test("charting uses the full visible overview and latest visible turn detail", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "assistant", 9, [makeTextPart("after", "p9", "after")]),
            makeMessageBundle(sessionID, "sum2", "assistant", 8, [makeTextPart("sum2", "ps2", "summary 2")], true),
            makeMessageBundle(sessionID, "ct2", "user", 7, [makeCompactionPart("ct2", "c2", false)]),
            makeMessageBundle(sessionID, "m4", "assistant", 6, [makeTextPart("m4", "p6", "second answer")]),
            makeMessageBundle(sessionID, "m3", "user", 5, [makeTextPart("m3", "p5", "second user")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 4, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 3, [makeCompactionPart("ct1", "c1", false)]),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "first answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "first user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      context_charting: {
        enable: true,
        recent_turns: 10,
        recent_messages: 5,
      },
    });

    const result = await loadChartingData(input, sessionID, config);

    expect(result.overview).toEqual({
      turns: [
        {
          turn_index: 1,
          user: {
            preview: "first user",
            message_id: "m1",
          },
          assistant: {
            preview: "first answer",
            total_messages: 1,
          },
        },
        {
          turn_index: 3,
          user: {
            preview: "second user",
            message_id: "m3",
          },
          assistant: {
            preview: "second answer",
            total_messages: 1,
          },
        },
      ],
    });
    expect(result.latestTurnDetail.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "m1",
        preview: "first user",
      },
      {
        role: "assistant",
        turn_index: 1,
        message_id: "m2",
        preview: "first answer",
      },
      {
        role: "user",
        turn_index: 2,
        message_id: "ct1",
        preview: "[compaction trigger]",
      },
      {
        role: "assistant",
        turn_index: 2,
        message_id: "sum1",
        preview: "summary 1",
      },
      {
        role: "user",
        turn_index: 3,
        message_id: "m3",
        preview: "second user",
      },
      {
        role: "assistant",
        turn_index: 3,
        message_id: "m4",
        preview: "second answer",
      },
    ]);
  });

  test("charting excludes post-summary messages after auto compaction", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after2", "assistant", 6, [makeTextPart("after2", "p6", "after auto 2")]),
            makeMessageBundle(sessionID, "after1", "user", 5, [makeTextPart("after1", "p5", "after auto 1")]),
            makeMessageBundle(sessionID, "sum1", "assistant", 4, [makeTextPart("sum1", "ps1", "summary 1")], true),
            makeMessageBundle(sessionID, "ct1", "user", 3, [makeCompactionPart("ct1", "c1", true)]),
            makeMessageBundle(sessionID, "m2", "assistant", 2, [makeTextPart("m2", "p2", "before answer")]),
            makeMessageBundle(sessionID, "m1", "user", 1, [makeTextPart("m1", "p1", "before user")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      context_charting: {
        enable: true,
        recent_turns: 10,
        recent_messages: 5,
      },
    });

    const result = await loadChartingData(input, sessionID, config);

    expect(result.overview).toEqual({
      turns: [
        {
          turn_index: 1,
          user: {
            preview: "before user",
            message_id: "m1",
          },
          assistant: {
            preview: "before answer",
            total_messages: 1,
          },
        },
      ],
    });
    expect(result.latestTurnDetail.messages).toEqual([
      {
        role: "user",
        turn_index: 1,
        message_id: "m1",
        preview: "before user",
      },
      {
        role: "assistant",
        turn_index: 1,
        message_id: "m2",
        preview: "before answer",
      },
    ]);
  });

});

describe("runtime/readData", () => {
  test("reads message detail sections", async () => {
    const sessionID = "parent";
    const msg = makeMessageBundle(
      sessionID,
      "m1",
      "assistant",
      1,
      [
        makeTextPart("m1", "t1", "hello"),
        makeReasoningPart("m1", "r1", "think"),
        makeToolPart("m1", "tool1", "grep", {
          status: "completed",
          title: "done",
          input: { q: "x" },
          output: "out",
          attachments: [],
        } as unknown as import("@opencode-ai/sdk").ToolState),
      ],
    );

    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, [msg]]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      show_tool_input: ["*"],
      show_tool_output: ["*"],
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await readData(input, makeBrowse(target), config, "m1", undefined, journal);
    expect(out).toEqual({
      message_id: "m1",
      role: "assistant",
      turn_index: 1,
      time: "1970-01-01T00:00:00.001Z",
      sections: [
        { type: "text", content: "hello" },
        { type: "reasoning", content: "think" },
        {
          type: "tool",
          tool: "grep",
          status: "completed",
          input: { q: "x" },
          content: "out",
        },
      ],
    });
  });

  test("part read returns full tool content with input signature", async () => {
    const sessionID = "parent";
    const msg = makeMessageBundle(
      sessionID,
      "m1",
      "assistant",
      1,
      [
        makeToolPart("m1", "tool1", "grep", {
          status: "completed",
          title: "done",
          input: { q: "x" },
          output: "out",
          attachments: [],
        } as unknown as import("@opencode-ai/sdk").ToolState),
      ],
    );

    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, [msg]]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      show_tool_input: ["*"],
      show_tool_output: ["*"],
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      readData(input, makeBrowse(target), config, "m1", "tool1", journal),
    ).resolves.toEqual({
      type: "tool",
      content: 'grep(q="x")\n---\nout',
    });
  });

  test("part read errors when tool content hidden", async () => {
    const sessionID = "parent";
    const msg = makeMessageBundle(
      sessionID,
      "m1",
      "assistant",
      1,
      [
        makeToolPart("m1", "tool1", "bash", {
          status: "completed",
          title: "done",
          input: { x: 1 },
          output: "out",
          attachments: [],
        } as unknown as import("@opencode-ai/sdk").ToolState),
      ],
    );

    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, [msg]]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      show_tool_input: ["*", "!bash"],
      show_tool_output: ["*", "!bash"],
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      readData(input, makeBrowse(target), config, "m1", "tool1", journal),
    ).rejects.toThrow(/content is hidden by show_tool_output/);
  });

  test("part read errors when tool has no content yet (running)", async () => {
    const sessionID = "parent";
    const msg = makeMessageBundle(
      sessionID,
      "m1",
      "assistant",
      1,
      [
        makeToolPart("m1", "tool1", "bash", {
          status: "running",
          title: "doing",
          input: { x: 1 },
        } as unknown as import("@opencode-ai/sdk").ToolState),
      ],
    );

    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, [msg]]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      show_tool_input: ["*", "!bash"],
      show_tool_output: ["*"],
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    await expect(
      readData(input, makeBrowse(target), config, "m1", "tool1", journal),
    ).rejects.toThrow(/has no content yet/);
  });
});

describe("runtime/searchData", () => {
  test("returns no messages when totalHits=0", async () => {
    const sessionID = "parent";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m1", "user", 1, [
              makeTextPart("m1", "p1", "hello"),
            ]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeBrowse(target),
      config,
      { query: "zzz", literal: true, limit: 5, types: ["text"] },
      journal,
    );
    expect(out).toEqual({});
  });

  test("supports fulltext search and serializes matching messages", async () => {
    const sessionID = "parent4";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 4 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m2", "assistant", 2, [
              makeTextPart("m2", "p2", "gamma"),
            ]),
            makeMessageBundle(sessionID, "m1", "user", 1, [
              makeTextPart("m1", "p1", "alpha beta"),
            ]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 4,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeBrowse(target),
      config,
      { query: "beta", literal: false, limit: 5, types: ["text"] },
      journal,
    );

    expect(out).toEqual({
      messages: [
        {
          role: "user",
          turn_index: 1,
          message_id: "m1",
          hits: [
            {
              type: "text",
              part_id: "p1",
              snippets: ["alpha beta"],
            },
          ],
        },
      ],
    });
  });

  test("includes remain_hits when max_hits_per_message limits hits", async () => {
    const sessionID = "parent2";
    const msg = makeMessageBundle(sessionID, "m1", "user", 1, [
      makeTextPart("m1", "p1", "hello"),
      makeTextPart("m1", "p2", "hello again"),
    ]);

    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        // Use a distinct fingerprint from other tests to avoid search-cache reuse.
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 2 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, [msg]]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      search: {
        ...makeConfig().search,
        max_hits_per_message: 1,
      },
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 2,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeBrowse(target),
      config,
      { query: "hello", literal: true, limit: 5, types: ["text"] },
      journal,
    );

    expect("messages" in out).toBe(true);
    if ("messages" in out) {
      expect(out.messages[0].remain_hits).toBe(1);
    }
  });

  test("maps transient cache build errors to stable message", async () => {
    const sessionID = "parent3";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        // Use a distinct fingerprint from other tests to avoid search-cache reuse.
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 3 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, []]]),
    };
    const client = makeClient(store);

    // Force the underlying messages API to fail to trigger a transient error.
    client.session.messages.mockResolvedValue({
      data: undefined,
      error: { message: "boom" },
      response: { status: 500, headers: makeHeaders(undefined) },
    });

    const input = { client, directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 3,
        parentId: undefined,
      },
    };

    await expect(
      searchData(input, makeBrowse(target), config, { query: "x", literal: true, limit: 5, types: ["text"] }, journal),
    ).rejects.toThrow(transientSearchErrorMessage);
  });

  test("self session: builds search index from pre-compaction messages", async () => {
    const sessionID = "parent5";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 5 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "after", "user", 4, [makeTextPart("after", "p4", "new beta")]),
            makeMessageBundle(sessionID, "sum", "assistant", 3, [makeTextPart("sum", "ps", "summary")], true),
            makeMessageBundle(sessionID, "before", "user", 2, [makeTextPart("before", "p2", "alpha beta")]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 5,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeSelfBrowse(target),
      config,
      { query: "beta", literal: true, limit: 5, types: ["text"] },
      journal,
    );
    expect("messages" in out).toBe(true);
    if ("messages" in out) {
      expect(out.messages.map((m) => m.message_id)).toEqual(["before"]);
    }
  });

  test("search filters results by requested hit types", async () => {
    const sessionID = "parent6";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 6 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m2", "assistant", 2, [
              makeTextPart("m2", "p2", "beta answer"),
              makeReasoningPart("m2", "r2", "beta reasoning"),
              makeToolPart("m2", "t2", "grep", {
                status: "completed",
                title: "done",
                input: { query: "beta" },
                output: "beta tool output",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig();
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 6,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeBrowse(target),
      config,
      { query: "beta", literal: false, limit: 5, types: ["tool", "reasoning"] },
      journal,
    );

    expect(out).toEqual({
      messages: [
        {
          role: "assistant",
          turn_index: 1,
          message_id: "m2",
          hits: [
            {
              type: "reasoning",
              part_id: "r2",
              snippets: [expect.any(String)],
            },
            {
              type: "tool",
              tool_name: "grep",
              part_id: "t2",
              snippets: [expect.any(String)],
            },
          ],
        },
      ],
    });
  });

  test("search hides tool output when show_tool_output denies tool", async () => {
    const sessionID = "parent7";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 7 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m1", "assistant", 1, [
              makeToolPart("m1", "t1", "bash", {
                status: "completed",
                title: "done",
                input: { cmd: "pwd" },
                output: "secret-output",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      show_tool_input: ["*"],
      show_tool_output: ["!"],
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 7,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeBrowse(target),
      config,
      { query: "secret-output", literal: true, limit: 5, types: ["tool"] },
      journal,
    );

    expect(out).toEqual({});
  });

  test("search hides tool input when show_tool_input denies tool", async () => {
    const sessionID = "parent8";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 8 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([
        [
          sessionID,
          [
            makeMessageBundle(sessionID, "m1", "assistant", 1, [
              makeToolPart("m1", "t1", "bash", {
                status: "completed",
                title: "done",
                input: { cmd: "needle" },
                output: "visible-output",
                attachments: [],
              } as unknown as import("@opencode-ai/sdk").ToolState),
            ]),
          ],
        ],
      ]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const config = makeConfig({
      show_tool_input: ["!"],
      show_tool_output: ["!"],
    });
    const journal = makeJournal();
    const target: SessionTarget = {
      session: {
        id: sessionID,
        title: "T",
        version: 1,
        updatedAt: 8,
        parentId: undefined,
      },
    };

    const out = await searchData(
      input,
      makeBrowse(target),
      config,
      { query: "needle", literal: true, limit: 5, types: ["tool"] },
      journal,
    );

    expect(out).toEqual({});
  });

});

describe("runtime/runCall", () => {
  test("resolves session target and returns json output", async () => {
    const sessionID = "target";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, []]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const ctx: ToolContext = {
      sessionID: "anchor",
      messageID: "m",
      metadata: vi.fn(),
    };

    const out = await runCall(
      input,
      ctx,
      "history_browse_turns",
      sessionID,
      {},
      async () => ({ ok: true }),
    );
    expect(JSON.parse(out)).toEqual({ ok: true });
    expect(ctx.metadata).toHaveBeenCalledWith({
      title: "history_browse_turns",
      metadata: expect.objectContaining({
        tool: "history_browse_turns",
        targetSessionId: sessionID,
      }),
    });
  });

  test("sets browse.selfSession when target session equals caller session", async () => {
    const sessionID = "anchor";
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        [sessionID, { id: sessionID, title: "T", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>([[sessionID, []]]),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const ctx: ToolContext = {
      sessionID: "anchor",
      messageID: "m",
      metadata: vi.fn(),
    };

    let observed: boolean | undefined;
    await runCall(
      input,
      ctx,
      "history_browse_turns",
      sessionID,
      {},
      async (browse) => {
        observed = (browse as BrowseContext).selfSession;
        return { ok: true };
      },
    );
    expect(observed).toBe(true);
  });

  test("invalid session_id bubbles resolveSessionTarget error", async () => {
    const store = {
      sessions: new Map<string, import("../core/session.ts").SdkSessionData>([
        ["some", { id: "some", title: "A", version: 1, time: { updated: 1 } }],
      ]),
      messages: new Map<string, MessageBundle[]>(),
    };
    const input = { client: makeClient(store), directory: "/project" } as unknown as PluginInput;
    const ctx: ToolContext = {
      sessionID: "anchor",
      messageID: "m",
      metadata: vi.fn(),
    };

    await expect(
      runCall(
        input,
        ctx,
        "history_browse_messages",
        "does-not-exist",
        {},
        async () => ({ ok: true }),
      ),
    ).rejects.toThrow("Session 'does-not-exist' not found");
  });
});
