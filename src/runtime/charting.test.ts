import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./runtime.ts", () => {
  return {
    loadOverviewState: vi.fn(async () => ({
      allTurns: [3],
      turns: [
        {
          turn: 3,
          output: {
            turn_number: 3,
            user: {
              preview: "u",
              message_id: "u3",
            },
            assistant: {
              preview: "a",
              total_messages: 1,
            },
          },
          lastVisibleMessageId: "m2",
          visibleMessageCount: 2,
        },
      ],
    })),
    browseData: vi.fn(async () => ({
      before_message_id: null,
      messages: [
        {
          role: "user",
          turn_number: 3,
          preview: "u",
        },
      ],
    })),
  };
});

vi.mock("../core/index.ts", () => {
  return {
    createBrowseContext: vi.fn((_target, selfSession) => ({
      target: {
        session: {
          id: "sess-1",
          title: "History",
          version: 1,
          updatedAt: 1,
          parentId: undefined,
        },
      },
      selfSession,
    })),
    resolveSessionTarget: vi.fn(async () => ({
      session: {
        id: "sess-1",
        title: "History",
        version: 1,
        updatedAt: 1,
        parentId: undefined,
      },
    })),
  };
});

vi.mock("./logger.ts", () => {
  return {
    log: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  };
});

import { createBrowseContext } from "../core/index.ts";
import { resolveSessionTarget } from "../core/index.ts";
import { loadChartingData } from "./charting.ts";
import { log } from "./logger.ts";
import { browseData, loadOverviewState } from "./runtime.ts";

afterEach(() => {
  vi.clearAllMocks();
});

function makeConfig() {
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
  } as unknown as import("../common/config.ts").EngramConfig;
}

function makeInput() {
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
        message: vi.fn(async () => ({
          data: undefined,
          error: undefined,
          response: { status: 200 },
        })),
        messages: vi.fn(async () => ({
          data: [],
          error: undefined,
          response: {
            status: 200,
            headers: {
              get: () => undefined,
            },
          },
        })),
      },
    },
  } as unknown as import("../common/common.ts").PluginInput;
}

describe("runtime/charting", () => {
  test("loads overview and latest turn detail for self session", async () => {
    const input = makeInput();
    const config = makeConfig();

    const result = await loadChartingData(input, "sess-1", config);

    expect(vi.mocked(resolveSessionTarget)).toHaveBeenCalledWith(
      expect.objectContaining({
        getSession: expect.any(Function),
        listMessages: expect.any(Function),
        getMessage: expect.any(Function),
      }),
      "sess-1",
    );
    expect(vi.mocked(createBrowseContext)).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: "sess-1" }) }),
      true,
      expect.objectContaining({
        getSession: expect.any(Function),
      }),
    );
    expect(vi.mocked(createBrowseContext)).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: "sess-1" }) }),
      false,
      expect.objectContaining({
        getSession: expect.any(Function),
      }),
    );
    expect(vi.mocked(log)).toHaveBeenCalledWith(input.client, "sess-1");
    expect(vi.mocked(loadOverviewState)).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ selfSession: true }),
      config,
      expect.any(Object),
    );
    expect(vi.mocked(browseData)).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ selfSession: false }),
      config,
      expect.any(Object),
      {
        messageID: "m2",
        numBefore: 5,
        numAfter: 0,
      },
    );
    expect(result.latestTurnDetail.messages).toHaveLength(1);
  });

  test("loads chart overview from the newest pre-compaction page", async () => {
    const input = makeInput();
    const config = makeConfig();

    const result = await loadChartingData(input, "sess-1", config);

    expect(result.overview).toEqual({
      turns: [
        {
          turn_number: 3,
          user: {
            preview: "u",
            message_id: "u3",
          },
          assistant: {
            preview: "a",
            total_messages: 1,
          },
        },
      ],
    });
    expect(vi.mocked(loadOverviewState)).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ selfSession: true }),
      config,
      expect.any(Object),
    );
  });

  test("returns empty latest turn detail when overview has no turns", async () => {
    vi.mocked(loadOverviewState).mockResolvedValueOnce({
      allTurns: [],
      turns: [],
    });

    const input = makeInput();
    const config = makeConfig();

    const result = await loadChartingData(input, "sess-1", config);

    expect(vi.mocked(browseData)).not.toHaveBeenCalled();
    expect(result.latestTurnDetail).toEqual({
      before_message_id: null,
      messages: [],
      after_message_id: null,
    });
  });
});
