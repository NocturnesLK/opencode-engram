import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Buffer } from "node:buffer";

vi.mock("@opencode-ai/plugin", () => {
  const chain = () => {
    const api = {
      optional: () => api,
      describe: () => api,
    };
    return api;
  };

  const toolFn = (def: unknown) => def;
  (toolFn as unknown as { schema: unknown }).schema = {
    string: chain,
    number: chain,
    boolean: chain,
    array: () => chain(),
  };

  return {
    tool: toolFn,
  };
});

vi.mock("../runtime/runtime.ts", () => {
  const browseData = vi.fn(async () => ({ ok: "browse" }));
  const overviewData = vi.fn(async () => ({ ok: "overview" }));
  const readData = vi.fn(async () => ({ ok: "read" }));
  const searchData = vi.fn(async () => ({ ok: "search" }));

  const runCall = vi.fn(
    async (
      _input: unknown,
      _ctx: unknown,
      _tool: string,
      _sessionId: string,
      _args: Record<string, unknown>,
      execute: (browse: unknown, config: unknown, journal: unknown) => Promise<unknown>,
    ) => {
      const browse = {
        target: {
          session: {
            id: "target",
            title: "T",
            version: 1,
            updatedAt: 1,
            parentId: undefined,
          },
        },
      };
      const config = {
      debug_mode: { enable: false, log_tool_calls: true },
      upstream_history: { enable: true },
        context_charting: { enable: false, recent_turns: 10, recent_messages: 5 },
        browse_messages: { message_limit: 100, user_preview_length: 140, assistant_preview_length: 140 },
        browse_turns: { user_preview_length: 140, assistant_preview_length: 140 },
        show_tool_input: ["*"],
        show_tool_output: ["*"],
        search: { message_limit: 5 },
        pull_message: {
          text_length: 400,
          reasoning_length: 400,
          tool_output_length: 400,
          tool_input_length: 50,
        },
      };
      const journal = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const out = await execute(browse, config, journal);
      return JSON.stringify(out);
    },
  );

  return {
    browseData,
    overviewData,
    readData,
    runCall,
    searchData,
  };
});

vi.mock("../runtime/charting.ts", () => {
  return {
    loadChartingData: vi.fn(async () => ({
      overview: {
        turns: [
          {
            turn_number: 1,
            user: {
              preview: "u",
              message_id: "m1",
            },
            assistant: {
              preview: "a",
              total_messages: 1,
            },
          },
        ],
      },
      latestTurnDetail: {
        before_message_id: null,
        messages: [
          {
            role: "user",
            turn_number: 1,
            message_id: "m1",
            preview: "u",
          },
          {
            role: "assistant",
            turn_number: 1,
            message_id: "m2",
            preview: "a",
          },
        ],
      },
    })),
  };
});

vi.mock("./config.ts", () => {
  return {
    loadEngramConfig: vi.fn(),
  };
});

vi.mock("node:fs/promises", () => {
  return {
    readFile: vi.fn(),
  };
});

import { readFile } from "node:fs/promises";
import { loadEngramConfig } from "./config.ts";
import { browseData, overviewData, readData, runCall, searchData } from "../runtime/runtime.ts";
import { loadChartingData } from "../runtime/charting.ts";
import type { HistoryBackend } from "../core/history-backend.ts";
import {
  buildChartingText,
  buildMinimalCompactionPrompt,
  buildMinimalCompactionText,
} from "./charting.ts";
import {
  builtInNavigatorPromptBody,
  buildNavigatorPrompt,
} from "./upstream-navigator-prompt.ts";
import {
  builtInHistoryPromptBody,
} from "./history-prompt.ts";
import EngramPluginDefault, {
  EngramPlugin,
  createEngramPlugin,
  type HistoryBackendProvider,
} from "./plugin.ts";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

type ReadFileMock = typeof readFile & { mockImplementation: (fn: unknown) => void };

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function setReadFileMap(map: Map<string, Buffer>) {
  (readFile as unknown as ReadFileMock).mockImplementation(async (filePath: string) => {
    const hit = map.get(filePath);
    if (!hit) {
      throw enoent(filePath);
    }
    return hit.toString("utf8");
  });
}

function makeConfig(opts: { upstream: boolean }) {
    return {
      debug_mode: {
        enable: false,
        log_tool_calls: true,
      },
      upstream_history: {
        enable: opts.upstream,
        disable_for_agents: [],
      },
    context_charting: {
      enable: true,
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
  } as unknown as import("./config.ts").EngramConfig;
}

function makeInput() {
  const message = vi.fn(async () => ({
    data: {
      info: {
        id: "m1",
        role: "assistant",
        summary: true,
      },
      parts: [
        {
          id: "p1",
          type: "text",
        },
      ],
    },
    error: undefined,
    response: { status: 200 },
  }));
  const messages = vi.fn(async () => ({
    data: [],
    error: undefined,
    response: {
      status: 200,
      headers: {
        get: () => undefined,
      },
    },
  }));

  return {
    directory: "/project",
    client: {
      app: {
        log: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async () => ({
          data: undefined,
          error: undefined,
          response: { status: 200 },
        })),
        message,
        messages,
      },
    },
  } as unknown as import("./common.ts").PluginInput;
}

function makeHistoryMessage(
  id: string,
  text: string,
  role: "assistant" | "user" = "assistant",
) {
  return {
    info: {
      id,
      role,
      time: { created: 1 },
    },
    parts: [{ type: "text", text }],
  };
}

function makeChatMessageOutput(agent: string) {
  return {
    message: {
      agent,
    },
    parts: [],
  };
}

function makeProviderBackend() {
  return {
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      title: "Provider Session",
      version: 1,
      time: { updated: 1 },
    })),
    listMessages: vi.fn(async () => ({
      msgs: [],
      nextCursor: undefined,
    })),
    getMessage: vi.fn(async (_sessionId: string, messageId: string) => ({
      info: {
        id: messageId,
        role: "assistant",
        summary: true,
      },
      parts: [
        {
          id: "p1",
          type: "text",
          messageID: messageId,
          text: "provider summary",
        },
      ],
    })),
  } as unknown as HistoryBackend;
}

function makeHistoryBackendProvider(
  backend: HistoryBackend,
  matchesSessionId: (sessionId: string) => boolean,
) {
  const matchesSessionIdMock = vi.fn(matchesSessionId);
  const createBackendMock = vi.fn(() => backend);

  return {
    provider: {
      matchesSessionId: matchesSessionIdMock,
      createBackend: createBackendMock,
    } satisfies HistoryBackendProvider,
    matchesSessionIdMock,
    createBackendMock,
  };
}

function makeCtx() {
  return {
    sessionID: "anchor",
    messageID: "m",
    metadata: vi.fn(),
  } as unknown as import("./common.ts").ToolContext;
}

describe("plugin/tool registration", () => {
  test("always registers session history tools", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    expect(Object.keys(plugin.tool ?? {})).toEqual([
      "history_browse_turns",
      "history_browse_messages",
      "history_pull_message",
      "history_pull_part",
      "history_search",
    ]);
  });

  test("default export remains directly usable", async () => {
    expect(EngramPluginDefault).toBe(EngramPlugin);

    const plugin = await EngramPluginDefault(makeInput());

    expect(Object.keys(plugin.tool ?? {})).toEqual([
      "history_browse_turns",
      "history_browse_messages",
      "history_pull_message",
      "history_pull_part",
      "history_search",
    ]);
  });
});

describe("plugin factory", () => {
  test("forwards providers to runtime tool routing", async () => {
    const { provider } = makeHistoryBackendProvider(
      makeProviderBackend(),
      (sessionId) => sessionId === "provider-session",
    );
    const plugin = await createEngramPlugin({
      historyBackendProviders: [provider],
    })(makeInput());

    await (plugin.tool as any).history_browse_turns.execute({ session_id: "provider-session" }, makeCtx());

    expect(vi.mocked(runCall)).toHaveBeenCalledOnce();
    expect(vi.mocked(runCall).mock.calls[0]?.[6]).toEqual({
      providers: [provider],
    });
  });

  test("routes compaction reads through matching provider backends", async () => {
    const providerBackend = makeProviderBackend();
    const { provider, matchesSessionIdMock, createBackendMock } = makeHistoryBackendProvider(
      providerBackend,
      (sessionId) => sessionId === "provider-session",
    );
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    const input = makeInput();
    (input.client.session.message as any).mockImplementation(async () => {
      throw new Error("OpenCode SDK message client should not be used");
    });

    const plugin = await createEngramPlugin({
      historyBackendProviders: [provider],
    })(input);
    await (plugin as any)["experimental.session.compacting"](
      { sessionID: "provider-session" },
      { context: [], prompt: undefined },
    );

    const output = { text: "original" };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "provider-session", messageID: "m1", partID: "p1" },
      output,
    );

    expect(matchesSessionIdMock).toHaveBeenCalledWith("provider-session");
    expect(createBackendMock).toHaveBeenCalledWith(input);
    expect(input.client.session.message).not.toHaveBeenCalled();
    expect(vi.mocked(loadChartingData)).toHaveBeenCalledWith(
      input,
      "provider-session",
      cfg,
      {
        providers: [provider],
      },
    );
    expect(output.text).not.toBe("original");
  });
});

describe("plugin/tool argument validation", () => {
  test("browse validates message_id and window values", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();

    await expect(
      (plugin.tool as any).history_browse_messages.execute({ session_id: "s", message_id: "  " }, ctx),
    ).rejects.toThrow("message_id is required");

    await expect(
      (plugin.tool as any).history_browse_messages.execute({ session_id: "s", num_before: -1 }, ctx),
    ).rejects.toThrow("num_before must be a non-negative integer");

    await expect(
      (plugin.tool as any).history_browse_messages.execute({ session_id: "s", num_after: 1.5 }, ctx),
    ).rejects.toThrow("num_after must be a non-negative integer");
  });

  test("overview validates session_id", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();
    await expect(
      (plugin.tool as any).history_browse_turns.execute({}, ctx),
    ).rejects.toThrow("session_id is required");
  });

  test("overview without turn_number forwards the default latest-turn request", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();

    await (plugin.tool as any).history_browse_turns.execute({ session_id: "anchor" }, ctx);

    expect(vi.mocked(runCall)).toHaveBeenCalledOnce();
    expect(vi.mocked(overviewData)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        turnIndex: undefined,
        numBefore: 0,
        numAfter: 0,
      },
    );
  });

  test("overview validates turn_number and window values", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();

    await expect(
      (plugin.tool as any).history_browse_turns.execute({ session_id: "anchor", turn_number: -1 }, ctx),
    ).rejects.toThrow("turn_number must be a non-negative integer");

    await expect(
      (plugin.tool as any).history_browse_turns.execute({ session_id: "anchor", num_before: -1 }, ctx),
    ).rejects.toThrow("num_before must be a non-negative integer");

    await expect(
      (plugin.tool as any).history_browse_turns.execute({ session_id: "anchor", num_after: 1.5 }, ctx),
    ).rejects.toThrow("num_after must be a non-negative integer");
  });

  test("pull_message validates message_id", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();

    await expect(
      (plugin.tool as any).history_pull_message.execute({ session_id: "s", message_id: "  " }, ctx),
    ).rejects.toThrow("message_id is required");
  });

  test("pull_part validates message_id and part_id", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();

    await expect(
      (plugin.tool as any).history_pull_part.execute({ session_id: "s", message_id: "  ", part_id: "p" }, ctx),
    ).rejects.toThrow("message_id is required");

    await expect(
      (plugin.tool as any).history_pull_part.execute({ session_id: "s", message_id: "m", part_id: "  " }, ctx),
    ).rejects.toThrow("part_id is required");
  });

  test("search validates query and normalizes literal/type", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const plugin = await EngramPlugin(makeInput());
    const ctx = makeCtx();

    await expect(
      (plugin.tool as any).history_search.execute({ session_id: "s", query: "" }, ctx),
    ).rejects.toThrow("query is required");

    await expect(
      (plugin.tool as any).history_search.execute({ session_id: "s", query: "x".repeat(501) }, ctx),
    ).rejects.toThrow("query is too long");

    await (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi" }, ctx);
    expect(vi.mocked(searchData)).toHaveBeenCalled();
    const searchInput = vi.mocked(searchData).mock.calls.at(-1)?.[3];
    expect(searchInput).toEqual({ query: "hi", literal: false, limit: 5, types: ["text", "tool"] });

    await (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi", literal: true }, ctx);
    const searchInput2 = vi.mocked(searchData).mock.calls.at(-1)?.[3];
    expect(searchInput2).toEqual({ query: "hi", literal: true, limit: 5, types: ["text", "tool"] });

    await (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi", type: " tool | reasoning | tool " }, ctx);
    const searchInput3 = vi.mocked(searchData).mock.calls.at(-1)?.[3];
    expect(searchInput3).toEqual({ query: "hi", literal: false, limit: 5, types: ["tool", "reasoning"] });

    await expect(
      (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi", type: "" }, ctx),
    ).rejects.toThrow("type must be a pipe-delimited string containing one or more of: text, tool, reasoning");

    await expect(
      (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi", type: "tool||reasoning" }, ctx),
    ).rejects.toThrow("type must not contain empty segments. Use pipe-delimited values: text|tool|reasoning");

    await expect(
      (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi", type: "bad" }, ctx),
    ).rejects.toThrow("type must contain only pipe-delimited values: text, tool, reasoning");

    await expect(
      (plugin.tool as any).history_search.execute({ session_id: "s", query: "hi", type: 1 }, ctx),
    ).rejects.toThrow("type must be a pipe-delimited string containing one or more of: text, tool, reasoning");
  });
});

describe("plugin/tool forwarding", () => {
  test("browse/overview/pull tools forward exact runtime helper arguments", async () => {
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(makeConfig({ upstream: true }));
    const input = makeInput();
    const plugin = await EngramPlugin(input);
    const ctx = makeCtx();

    await (plugin.tool as any).history_browse_messages.execute({ session_id: "s", message_id: "cursor-1", num_before: 2, num_after: 1 }, ctx);
    await (plugin.tool as any).history_browse_turns.execute({ session_id: "s", turn_number: 3, num_before: 1, num_after: 2 }, ctx);
    await (plugin.tool as any).history_pull_message.execute({ session_id: "s", message_id: "  m1  " }, ctx);
    await (plugin.tool as any).history_pull_part.execute({ session_id: "s", message_id: "  m1  ", part_id: "  p1  " }, ctx);

    expect(vi.mocked(browseData)).toHaveBeenCalledOnce();
    expect(vi.mocked(browseData).mock.calls[0]?.[0]).toBe(input);
    expect(vi.mocked(browseData).mock.calls[0]?.[4]).toEqual({
      messageID: "cursor-1",
      numBefore: 2,
      numAfter: 1,
    });

    expect(vi.mocked(overviewData)).toHaveBeenCalledOnce();
    expect(vi.mocked(overviewData).mock.calls[0]?.[0]).toBe(input);
    expect(vi.mocked(overviewData).mock.calls[0]?.[4]).toEqual({
      turnIndex: 3,
      numBefore: 1,
      numAfter: 2,
    });

    expect(vi.mocked(readData)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readData).mock.calls[0]?.[0]).toBe(input);
    expect(vi.mocked(readData).mock.calls[0]?.slice(3, 5)).toEqual(["m1", undefined]);
    expect(vi.mocked(readData).mock.calls[1]?.[0]).toBe(input);
    expect(vi.mocked(readData).mock.calls[1]?.slice(3, 5)).toEqual(["m1", "p1"]);
  });
});

describe("plugin/hooks", () => {
  beforeEach(() => {
    vi.mocked(loadEngramConfig).mockReset();
  });

  test("system.transform injects upstream navigator prompt only when upstream history is enabled", async () => {
    const enabledConfig = makeConfig({ upstream: true });
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(enabledConfig);
    const enabledPlugin = await EngramPlugin(makeInput());
    await (enabledPlugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });

    const enabledOutput = { system: [] as string[] };
    await (enabledPlugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, enabledOutput);
    expect(enabledOutput.system).toEqual([buildNavigatorPrompt("parent"), builtInHistoryPromptBody]);
    expect(enabledOutput.system[0]).toContain("**Upstream session ID: parent**");

    const disabledConfig = makeConfig({ upstream: false });
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(disabledConfig);
    const disabledPlugin = await EngramPlugin(makeInput());
    await (disabledPlugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });

    const disabledOutput = { system: [] as string[] };
    await (disabledPlugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, disabledOutput);
    expect(disabledOutput.system).toEqual([builtInHistoryPromptBody]);
  });

  test("system.transform uses latest upstream_history enable flag from reloaded config", async () => {
    const enabledConfig = makeConfig({ upstream: true });
    const disabledConfig = makeConfig({ upstream: false });
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(disabledConfig)
      .mockResolvedValueOnce(enabledConfig);

    const firstPlugin = await EngramPlugin(makeInput());
    await (firstPlugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child-a", parentID: "parent-a" } },
      },
    });

    const firstOutput = { system: [] as string[] };
    await (firstPlugin as any)["experimental.chat.system.transform"]({ sessionID: "child-a" }, firstOutput);
    expect(firstOutput.system).toEqual([builtInHistoryPromptBody]);

    const secondPlugin = await EngramPlugin(makeInput());
    await (secondPlugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child-b", parentID: "parent-b" } },
      },
    });

    const secondOutput = { system: [] as string[] };
    await (secondPlugin as any)["experimental.chat.system.transform"]({ sessionID: "child-b" }, secondOutput);
    expect(secondOutput.system).toEqual([buildNavigatorPrompt("parent-b"), builtInHistoryPromptBody]);
  });

  test("system.transform skips upstream history when current agent is disabled", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.upstream_history.disable_for_agents = ["helper-agent"];
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    await (plugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });
    await (plugin as any)["chat.message"]({ sessionID: "child", agent: "helper-agent" }, makeChatMessageOutput("helper-agent"));

    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);

    expect(output.system).toEqual([builtInHistoryPromptBody]);
  });

  test("system.transform still injects upstream history when current agent is not disabled", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.upstream_history.disable_for_agents = ["helper-agent"];
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    await (plugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });
    await (plugin as any)["chat.message"]({ sessionID: "child", agent: "other-agent" }, makeChatMessageOutput("other-agent"));

    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);

    expect(output.system).toEqual([buildNavigatorPrompt("parent"), builtInHistoryPromptBody]);
  });

  test("system.transform uses resolved agent when chat.message input agent is omitted", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.upstream_history.disable_for_agents = ["helper-agent"];
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    await (plugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });
    await (plugin as any)["chat.message"]({ sessionID: "child" }, makeChatMessageOutput("helper-agent"));

    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);

    expect(output.system).toEqual([builtInHistoryPromptBody]);
  });

  test("system.transform matches disable_for_agents entries exactly, including empty string", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.upstream_history.disable_for_agents = [""];
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    await (plugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });
    await (plugin as any)["chat.message"]({ sessionID: "child", agent: "" }, makeChatMessageOutput(""));

    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);

    expect(output.system).toEqual([builtInHistoryPromptBody]);
  });

  test("system.transform falls back to built-in upstream prompt when custom prompt path is invalid", async () => {
    const cfg = makeConfig({ upstream: true });
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    await (plugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });

    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);

    expect(output.system).toEqual([buildNavigatorPrompt("parent"), builtInHistoryPromptBody]);
  });

  test("text.complete writes chart block when charting is enabled", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    const compactingOutput = { context: [] as string[], prompt: undefined as string | undefined };
    await (plugin as any)["experimental.session.compacting"]({ sessionID: "anchor" }, compactingOutput);

    expect(compactingOutput.prompt).toBe(buildMinimalCompactionPrompt());

    const output = { text: "original" };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "anchor", messageID: "m1", partID: "p1" },
      output,
    );

    expect(vi.mocked(loadChartingData)).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/project" }),
      "anchor",
      cfg,
      undefined,
    );
    expect(output.text).toBe(buildChartingText(
      "anchor",
      {
        turns: [
          {
            turn_number: 1,
            user: {
              preview: "u",
              message_id: "m1",
            },
            assistant: {
              preview: "a",
              total_messages: 1,
            },
          },
        ],
      },
      {
        before_message_id: null,
        messages: [
          {
            role: "user",
            turn_number: 1,
            message_id: "m1",
            preview: "u",
          },
          {
            role: "assistant",
            turn_number: 1,
            message_id: "m2",
            preview: "a",
          },
        ],
      },
      {
        recentTurns: 10,
        recentMessages: 5,
      },
    ));
  });

  test("text.complete leaves generated text untouched when charting is disabled", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = false;
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    const compactingOutput = { context: [] as string[], prompt: undefined as string | undefined };
    await (plugin as any)["experimental.session.compacting"]({ sessionID: "anchor" }, compactingOutput);

    expect(compactingOutput.prompt).toBeUndefined();

    const output = { text: "original" };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "anchor", messageID: "m1", partID: "p1" },
      output,
    );

    expect(vi.mocked(loadChartingData)).not.toHaveBeenCalled();
    expect(output.text).toBe("original");
  });

  test("text.complete skips replacement without pending compaction state", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());

    const output = { text: "original" };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "anchor", messageID: "m1", partID: "p1" },
      output,
    );

    expect(vi.mocked(loadChartingData)).not.toHaveBeenCalled();
    expect(output.text).toBe("original");
  });

  test("text.complete ignores non-compaction completions and keeps pending state", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    const input = makeInput();
    (input.client.session.message as any)
      .mockResolvedValueOnce({
        data: {
          info: {
            id: "m1",
            role: "assistant",
            summary: false,
          },
          parts: [
            {
              id: "p1",
              type: "text",
            },
          ],
        },
        error: undefined,
        response: { status: 200 },
      })
      .mockResolvedValueOnce({
        data: {
          info: {
            id: "m1",
            role: "assistant",
            summary: true,
          },
          parts: [
            {
              id: "p1",
              type: "text",
            },
          ],
        },
        error: undefined,
        response: { status: 200 },
      });

    const plugin = await EngramPlugin(input);
    const compactingOutput = { context: [] as string[], prompt: undefined as string | undefined };
    await (plugin as any)["experimental.session.compacting"]({ sessionID: "anchor" }, compactingOutput);

    expect(compactingOutput.prompt).toBe(buildMinimalCompactionPrompt());

    const firstOutput = { text: "first" };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "anchor", messageID: "m1", partID: "p1" },
      firstOutput,
    );

    expect(vi.mocked(loadChartingData)).not.toHaveBeenCalled();
    expect(firstOutput.text).toBe("first");

    const secondOutput = { text: "second" };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "anchor", messageID: "m1", partID: "p1" },
      secondOutput,
    );

    expect(vi.mocked(loadChartingData)).toHaveBeenCalledOnce();
    expect(secondOutput.text).not.toBe("second");
  });

  test("session.compacting replaces default prompt when charting is enabled", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    const output = { context: ["keep me"] as string[], prompt: undefined as string | undefined };

    await (plugin as any)["experimental.session.compacting"]({ sessionID: "anchor" }, output);

    expect(output.context).toEqual(["keep me"]);
    expect(output.prompt).toBe(buildMinimalCompactionPrompt());
  });

  test("text.complete keeps minimal fallback text when chart replacement fails", async () => {
    const cfg = makeConfig({ upstream: true });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    const input = makeInput();
    (input.client.session.message as any).mockRejectedValueOnce(new Error("boom"));

    const plugin = await EngramPlugin(input);
    const compactingOutput = { context: [] as string[], prompt: undefined as string | undefined };
    await (plugin as any)["experimental.session.compacting"]({ sessionID: "anchor" }, compactingOutput);

    const output = { text: buildMinimalCompactionText() };
    await (plugin as any)["experimental.text.complete"](
      { sessionID: "anchor", messageID: "m1", partID: "p1" },
      output,
    );

    expect(output.text).toBe(buildMinimalCompactionText());
    expect((input as any).client.app.log).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: "Failed to inject chart block during compaction",
      }),
    }));
  });

  test("system.transform injects history prompt when only charting is enabled", async () => {
    const cfg = makeConfig({ upstream: false });
    cfg.context_charting.enable = true;
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "sess-1" }, output);

    expect(output.system).toEqual([builtInHistoryPromptBody]);
  });

  test("system.transform does not inject history prompt when both charting and upstream_history are disabled", async () => {
    const cfg = makeConfig({ upstream: false });
    cfg.context_charting.enable = false;
    vi.mocked(loadEngramConfig).mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "sess-1" }, output);

    expect(output.system).toEqual([]);
  });

  test("system.transform deduplicates history prompt injection per session", async () => {
    const cfg = makeConfig({ upstream: true });
    vi.mocked(loadEngramConfig)
      .mockResolvedValueOnce(cfg)
      .mockResolvedValueOnce(cfg);

    const plugin = await EngramPlugin(makeInput());
    await (plugin as any).event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });

    const output = { system: [] as string[] };
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);
    await (plugin as any)["experimental.chat.system.transform"]({ sessionID: "child" }, output);

    const historyPromptCount = output.system.filter((s) => s === builtInHistoryPromptBody).length;
    expect(historyPromptCount).toBe(1);
  });

});
