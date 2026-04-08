import {
  tool,
  type Plugin,
} from "@opencode-ai/plugin";

import {
  invalid,
  type PluginInput,
} from "./common.ts";
import { createOpenCodeBackend } from "../runtime/backends/opencode-backend.ts";
import {
  loadEngramConfig,
} from "./config.ts";
import {
  createUpstreamNavigatorState,
  injectUpstreamNavigatorPrompt,
  recordUpstreamNavigatorSession,
} from "./upstream-navigator-prompt.ts";
import {
  createHistoryPromptState,
  injectHistoryPrompt,
} from "./history-prompt.ts";
import {
  buildChartingText,
  buildMinimalCompactionPrompt,
  clearChartingPending,
  createChartingState,
  hasPendingCharting,
  markChartingPending,
} from "./charting.ts";
import { readData, runCall, overviewData, browseData, searchData } from "../runtime/runtime.ts";
import { loadChartingData } from "../runtime/charting.ts";
import type { SearchInput } from "../runtime/search.ts";
import type { EngramConfig } from "./config.ts";
import type { SearchPartType } from "../domain/types.ts";

function isUpstreamHistoryDisabledForAgent(
  agentName: string | undefined,
  config: EngramConfig,
): boolean {
  if (agentName === undefined) {
    return false;
  }

  return config.upstream_history.disable_for_agents.includes(agentName);
}

function checkMessageId(messageID?: string) {
  if (!messageID?.trim()) {
    invalid("message_id is required");
  }
}

function normalizeOptionalMessageId(messageID?: string) {
  if (messageID === undefined) {
    return undefined;
  }
  if (!messageID.trim()) {
    invalid("message_id is required");
  }
  return messageID.trim();
}

function normalizePartId(partID?: string) {
  if (!partID?.trim()) {
    invalid("part_id is required");
  }
  return partID.trim();
}

function checkSessionId(sessionID?: string): string {
  const normalized = sessionID?.trim();
  if (!normalized) {
    invalid("session_id is required");
  }
  return normalized;
}

function normalizeOverviewWindowValue(value: number | undefined, name: string) {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    invalid(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeOverviewTurnIndex(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    invalid("turn_index must be a non-negative integer");
  }
  return value;
}

// =============================================================================
// Search Input Validation
// =============================================================================

const searchQueryMaxLength = 500;
const SEARCH_TYPES = ["text", "tool", "reasoning"] as const satisfies readonly SearchPartType[];
const defaultSearchTypes = ["text", "tool"] as const satisfies readonly SearchPartType[];
const searchTypeOptions = SEARCH_TYPES.join(", ");
const searchTypePipeExample = SEARCH_TYPES.join("|");

function checkSearchQuery(query?: string): string {
  if (query === undefined || query === null) {
    invalid("query is required");
  }
  const normalized = String(query).trim();
  if (normalized.length === 0) {
    invalid("query is required");
  }
  if (normalized.length > searchQueryMaxLength) {
    invalid("query is too long. Use shorter, more specific keywords.");
  }
  return normalized;
}

function normalizeSearchLiteral(literal?: boolean): boolean {
  if (literal === undefined) return false;
  return literal === true;
}

function normalizeSearchTypes(value?: string): SearchPartType[] {
  if (value === undefined) {
    return [...defaultSearchTypes];
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`type must be a pipe-delimited string containing one or more of: ${searchTypeOptions}`);
  }

  const result: SearchPartType[] = [];
  const seen = new Set<SearchPartType>();
  for (const segment of value.split("|")) {
    const normalizedSegment = segment.trim();
    if (normalizedSegment.length === 0) {
      invalid(`type must not contain empty segments. Use pipe-delimited values: ${searchTypePipeExample}`);
    }
    if (!SEARCH_TYPES.includes(normalizedSegment as SearchPartType)) {
      invalid(`type must contain only pipe-delimited values: ${searchTypeOptions}`);
    }
    const normalized = normalizedSegment as SearchPartType;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function buildSearchInput(
  query: string,
  literal: boolean,
  types: SearchPartType[],
  config: EngramConfig,
): SearchInput {
  return {
    query,
    literal,
    limit: config.search.message_limit,
    types,
  };
}

async function logChartingWarning(
  input: PluginInput,
  sessionID: string,
  error: unknown,
) {
  await input.client.app.log({
    body: {
      service: "engram-plugin",
      level: "warn",
      message: "Failed to inject chart block during compaction",
      extra: {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      },
    },
  }).catch(() => undefined);
}

async function isCompactionTextCompletion(
  input: PluginInput,
  sessionID: string,
  messageID: string,
  partID: string,
) {
  const backend = createOpenCodeBackend(input);
  const message = await backend.getMessage(sessionID, messageID);
  const targetPart = message.parts.find((part) => part.id === partID);
  if (!targetPart || targetPart.type !== "text") {
    return false;
  }

  return message.info.role === "assistant" && message.info.summary === true;
}

export const EngramPlugin: Plugin = async (input) => {
  const upstreamNavigatorState = createUpstreamNavigatorState();
  const historyPromptState = createHistoryPromptState();
  const chartingState = createChartingState();
  const agentNamesBySession = new Map<string, string>();

  return {
    event: async ({ event }) => {
      recordUpstreamNavigatorSession(upstreamNavigatorState, event);
      if (event.type === "session.compacted") {
        clearChartingPending(
          chartingState,
          event.properties.sessionID,
        );
      }
    },
    "chat.message": async (hookInput, output) => {
      agentNamesBySession.set(hookInput.sessionID, output.message.agent);
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      const config = await loadEngramConfig(input.directory, undefined, input.client);

      // Upstream navigator prompt injection (only for child sessions with upstream_history enabled)
      if (config.upstream_history.enable) {
        const agentName = hookInput.sessionID
          ? agentNamesBySession.get(hookInput.sessionID)
          : undefined;
        if (!isUpstreamHistoryDisabledForAgent(agentName, config)) {
          await injectUpstreamNavigatorPrompt(
            upstreamNavigatorState,
            hookInput.sessionID,
            output.system,
          );
        }
      }

      // Common history prompt injection (charting or upstream_history enabled)
      if (config.context_charting.enable || config.upstream_history.enable) {
        injectHistoryPrompt(historyPromptState, hookInput.sessionID, output.system);
      }
    },
    "experimental.session.compacting": async (hookInput, output) => {
      const config = await loadEngramConfig(input.directory, undefined, input.client);
      if (!config.context_charting.enable) {
        return;
      }
      output.prompt = buildMinimalCompactionPrompt();
      markChartingPending(chartingState, hookInput.sessionID);
    },
    "experimental.text.complete": async (hookInput, output) => {
      if (!hasPendingCharting(chartingState, hookInput.sessionID)) {
        return;
      }

      try {
        const config = await loadEngramConfig(input.directory, undefined, input.client);
        if (!config.context_charting.enable) {
          return;
        }

        const isCompactionText = await isCompactionTextCompletion(
          input,
          hookInput.sessionID,
          hookInput.messageID,
          hookInput.partID,
        );
        if (!isCompactionText) {
          return;
        }

        const data = await loadChartingData(
          input,
          hookInput.sessionID,
          config,
        );
        output.text = buildChartingText(
          hookInput.sessionID,
          data.overview,
          data.latestTurnDetail,
          {
            recentTurns: config.context_charting.recent_turns,
            recentMessages: config.context_charting.recent_messages,
          },
        );
        clearChartingPending(
          chartingState,
          hookInput.sessionID,
        );
      } catch (error) {
        await logChartingWarning(input, hookInput.sessionID, error);
      }
    },
    tool: {
      history_browse_turns: tool({
        description: `Get a high-level overview of a session's history as turn-indexed summaries

USE WHEN:
- You need to understand the context, goals, or what happened in a session
- You need to inspect turns around a known turn_index

DO NOT USE WHEN:
- You already know what keywords to look for -> use history_search (overview gives the big picture; search locates specific content by keywords)
- You need exact message detail -> use history_browse_messages or history_pull_message

RETURNS: turn summaries in ascending turn_index order. Each turn includes user preview and message_id, plus assistant preview and total message count`,
        args: {
          session_id: tool.schema
            .string()
            .describe("Target session identifier"),
          turn_index: tool.schema
            .number()
            .optional()
            .describe("Target turn_index (starting from 1, not 0) for returning. Omit to automatically set the newest visible turn_index"),
          num_before: tool.schema
            .number()
            .optional()
            .describe("How many older turns before turn_index to include. Omit to exclude"),
          num_after: tool.schema
            .number()
            .optional()
            .describe("How many newer turns after turn_index to include. Omit to exclude"),
        },
        async execute(args, ctx) {
          const sessionID = checkSessionId(args.session_id);
          const turnIndex = normalizeOverviewTurnIndex(args.turn_index);
          const numBefore = normalizeOverviewWindowValue(args.num_before, "num_before");
          const numAfter = normalizeOverviewWindowValue(args.num_after, "num_after");

          return runCall(
            input,
            ctx,
            "history_browse_turns",
            sessionID,
            {
              session_id: args.session_id,
              turn_index: turnIndex,
              num_before: numBefore,
              num_after: numAfter,
            },
            async (browse, config, journal) => {
              return overviewData(input, browse, config, journal, {
                turnIndex,
                numBefore,
                numAfter,
              });
            },
          );
        },
      }),
      history_browse_messages: tool({
        description: `Browse session history around a specific message. Returns a message window in chronological order.

USE WHEN:
- You need context, facts, or decisions from a session history that you don't currently have
- The user references prior discussion ("as we discussed", "follow the plan", etc.) not present in this session
- You want messages before and after a known message_id

DO NOT USE WHEN:
- You don't know which part of history to look at -> use history_browse_turns first to get the big picture
- You know keywords but not the location -> use history_search (search locates by content; browse navigates by position)
- You already have a message_id and need full content -> use history_pull_message instead

RETURNS: messages[] plus before_message_id / after_message_id anchors for extending the visible window`,
        args: {
          session_id: tool.schema
            .string()
            .describe("Target session identifier"),
          message_id: tool.schema
            .string()
            .optional()
            .describe("Anchor message_id. Omit to automatically set the newest visible message_id"),
          num_before: tool.schema
            .number()
            .optional()
            .describe("How many older visible messages to include. Omit to exclude"),
          num_after: tool.schema
            .number()
            .optional()
            .describe("How many newer visible messages to include. Omit to exclude"),
        },
        async execute(args, ctx) {
          const messageID = normalizeOptionalMessageId(args.message_id);
          const numBefore = normalizeOverviewWindowValue(args.num_before, "num_before");
          const numAfter = normalizeOverviewWindowValue(args.num_after, "num_after");

          return runCall(
            input,
            ctx,
            "history_browse_messages",
            checkSessionId(args.session_id),
            {
              session_id: args.session_id,
              message_id: messageID,
              num_before: numBefore,
              num_after: numAfter,
            },
            async (browse, config, journal) => {
              return browseData(
                input,
                browse,
                config,
                journal,
                {
                  messageID,
                  numBefore,
                  numAfter,
                },
              );
            },
          );
        },
      }),
      history_pull_message: tool({
        description: `Read a full message from a session's history.

USE WHEN:
- You have a message_id and need detail beyond the preview

DO NOT USE WHEN:
- You don't have a message_id yet -> use history_browse_messages or history_search to find one first
- You only need one truncated section -> use history_pull_part instead

RETURNS: message metadata including turn_index, plus sections[] in conversation order. Long sections are truncated and include a part_id for follow-up`,
        args: {
          session_id: tool.schema
            .string()
            .describe("Target session identifier"),
          message_id: tool.schema
            .string()
            .describe(
              "Message identifier",
            ),
        },
        async execute(args, ctx) {
          const sessionID = checkSessionId(args.session_id);
          checkMessageId(args.message_id);
          const messageID = args.message_id.trim();

          return runCall(
            input,
            ctx,
            "history_pull_message",
            sessionID,
            {
              session_id: args.session_id,
              message_id: args.message_id,
            },
            async (browse, config, journal) => {
              return readData(
                input,
                browse,
                config,
                messageID,
                undefined,
                journal,
              );
            },
          );
        },
      }),
      history_pull_part: tool({
        description: `Read the full content of a specific truncated section from a session message.

USE WHEN:
- A prior read returned a truncated section with a part_id and you need the full content
- A search hit includes a part_id and you want that exact section without reading the whole message

DO NOT USE WHEN:
- You don't have both message_id and part_id yet -> use history_browse_messages, history_pull_message, or history_search first
- You need the full message context -> use history_pull_message instead

RETURNS: full content of that single section only`,
        args: {
          session_id: tool.schema
            .string()
            .describe("Target session identifier"),
          message_id: tool.schema
            .string()
            .describe(
              "Message identifier",
            ),
          part_id: tool.schema
            .string()
            .describe(
              "Part identifier from a truncated section",
            ),
        },
        async execute(args, ctx) {
          const sessionID = checkSessionId(args.session_id);
          checkMessageId(args.message_id);
          const messageID = args.message_id.trim();
          const partID = normalizePartId(args.part_id);

          return runCall(
            input,
            ctx,
            "history_pull_part",
            sessionID,
            {
              session_id: args.session_id,
              message_id: args.message_id,
              part_id: args.part_id,
            },
            async (browse, config, journal) => {
              return readData(
                input,
                browse,
                config,
                messageID,
                partID,
                journal,
              );
            },
          );
        },
      }),
      history_search: tool({
        description: `Search a session's history by keywords. Returns matching messages with context snippets.

USE WHEN:
- You need to find specific information (facts, plans, identifiers, errors, etc.) in a session history
- You need to check whether specific information exists in a session history

DO NOT USE WHEN:
- You want to scan messages in order or navigate to a specific range -> use history_browse_messages (search locates by content; browse navigates by position)

RETURNS: Matching messages grouped by relevance. Each message includes role, turn_index, message_id, and hits[] with context snippets around matches. Search and results can be filtered by content type. Use history_pull_part to expand a specific hit, or history_pull_message to read the full message.`,
        args: {
          session_id: tool.schema
            .string()
            .describe("Target session identifier"),
          query: tool.schema
            .string()
            .describe(
              "Search keywords. Short specific terms work best — an identifier like 'computeTurns' beats a generic word like 'function'",
            ),
          literal: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, match the query as an exact case-sensitive substring. Use for file paths, identifiers, error codes. Default false uses BM25 fulltext search",
            ),
          type: tool.schema
            .string()
            .optional()
            .describe("Searchable content types to include as a pipe-delimited string. One or more of text, tool, reasoning. Default text|tool"),
        },
        async execute(args, ctx) {
          return runCall(
            input,
            ctx,
            "history_search",
            checkSessionId(args.session_id),
            {
              session_id: args.session_id,
              query: args.query,
              literal: args.literal,
              type: args.type,
            },
            async (browse, config, journal) => {
              const query = checkSearchQuery(args.query);
              const literal = normalizeSearchLiteral(args.literal);
              const types = normalizeSearchTypes(args.type);
              const searchInput = buildSearchInput(query, literal, types, config);

              return searchData(
                input,
                browse,
                config,
                searchInput,
                journal,
              );
            },
          );
        },
      }),
    },
  };
};

export default EngramPlugin;
