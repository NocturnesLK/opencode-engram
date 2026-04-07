import { relative } from "node:path";
import { performance } from "node:perf_hooks";

import { composeContentWithToolInputSignature, json, type PluginInput, type ToolContext } from "../common/common.ts";
import {
  loadEngramConfig,
  resolveVisibleToolNames,
  type EngramConfig,
} from "../common/config.ts";
import { normalizeParts, summarizePreviewFallbackHints } from "../domain/adapter.ts";
import { computeTurns, buildMessageMeta, buildSections, computeOutcome, computeModifiedFiles, formatToolCallSummaries, computeToolCalls, computeAttachments, type TurnComputeItem } from "../domain/domain.ts";
import { computePreview, computeLastPreview, computePreviewFallback } from "../domain/preview.ts";
import { clearTurnCache, getTurnMapWithCache } from "../core/turn-index.ts";
import {
  serializeBrowseItem,
  serializeBrowse,
  serializeOverviewTurn,
  serializeOverview,
  serializeMessageRead,
  serializePartRead,
  serializeSearch,
  serializeSearchMessage,
  serializeSearchHit,
} from "../domain/serialize.ts";
import {
  type SearchInput,
  type SearchCacheEntry,
  type SearchMessageInput,
  type ToolSearchVisibility,
  getSearchCacheEntry,
  setSearchCacheEntry,
  buildSearchCacheEntry,
  getSearchCacheInflight,
  setSearchCacheInflight,
  clearSearchCacheInflight,
  executeSearch,
} from "./search.ts";
import type { BrowseItemOutput, SectionConvertContext, NormalizedToolPart, OverviewOutput, OverviewTurnOutput, OverviewAssistantOutput, SearchOutput } from "../domain/types.ts";
import {
  type BrowseContext,
  type SessionTarget,
  createBrowseContext,
  computeCacheFingerprint,
  resolveSessionTarget,
} from "../core/index.ts";
import {
  transientSearchErrorMessage,
  isToolCallLoggingEnabled,
  isDebugDirectoryNeeded,
  estimateCallDurationMs,
  recordToolCall,
  ensureDebugGitIgnore,
} from "./debug.ts";
import { type MessageBundle, type MessagePage, toNormalizedMessage, sortMessagesChronological, sortMessagesNewestFirst, getMessagePage, getMessage, getAllMessages, internalScanPageSize } from "./message-io.ts";
import { getSessionFingerprint, fetchTurnItems, getTurnMapWithFallback } from "./turn-resolve.ts";
import { type Logger, log } from "./logger.ts";

const internalSearchCacheTtlMs = 60000;

export interface OverviewRequest {
  turnIndex?: number;
  numBefore: number;
  numAfter: number;
}

export interface OverviewStateTurn {
  turn: number;
  output: OverviewTurnOutput;
  lastVisibleMessageId: string;
  visibleMessageCount: number;
}

export interface OverviewState {
  allTurns: number[];
  turns: OverviewStateTurn[];
}

export interface BrowseRequest {
  messageID?: string;
  numBefore: number;
  numAfter: number;
}

function getSessionCacheFingerprint(root: SessionTarget["session"]): string | undefined {
  return computeCacheFingerprint(root);
}

function isCompactionTriggerMessage(msg: MessageBundle) {
  return msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction");
}

function filterSelfSessionVisibleMessages(msgs: MessageBundle[]) {
  return msgs.filter((msg) => msg.info.summary !== true && !isCompactionTriggerMessage(msg));
}

/**
 * Filter messages to only include those before the most recent compaction summary.
 *
 * Used when the target session is the caller's own session. This avoids mixing
 * compacted summaries with the raw history that they already cover.
 */
function filterPreCompactionMessages(
  msgs: MessageBundle[],
  hideSummaries = true,
  hideCompactionTrigger = true,
): MessageBundle[] {
  const newestFirst = sortMessagesNewestFirst([...msgs]);
  const summaryIndex = newestFirst.findIndex((msg) => msg.info.summary === true);
  const preCompactionMessages = summaryIndex < 0
    ? msgs
    : msgs.filter((msg) => {
      const preCompactionIds = new Set(
        newestFirst.slice(summaryIndex + 1).map((entry) => entry.info.id),
      );
      return preCompactionIds.has(msg.info.id);
    });

  if (!hideSummaries) {
    return preCompactionMessages;
  }

  const withoutSummaries = preCompactionMessages.filter((msg) => msg.info.summary !== true);
  if (!hideCompactionTrigger || summaryIndex < 0) {
    return withoutSummaries;
  }

  return withoutSummaries.filter((msg) => !isCompactionTriggerMessage(msg));
}

export async function runCall<TOutput extends object>(
  input: PluginInput,
  ctx: ToolContext,
  tool: string,
  sessionId: string,
  args: Record<string, unknown>,
  execute: (
    browse: BrowseContext,
    config: EngramConfig,
    journal: Logger,
  ) => Promise<TOutput>,
) {
  const journal = log(input.client, ctx.sessionID);
  const startedAt = performance.now();
  const projectRoot = input.directory;
  let targetSessionID: string | undefined;
  let config: EngramConfig | undefined;

  try {
    config = await loadEngramConfig(projectRoot, (message) => {
      journal.error("engram config issue", {
        tool,
        error: message,
      });
    }, input.client);
    if (isDebugDirectoryNeeded(config.debug_mode)) {
      await ensureDebugGitIgnore(projectRoot);
    }

    const target = await resolveSessionTarget(input.client, sessionId, input.directory);

    targetSessionID = target.session.id;
    const isSelf = sessionId === ctx.sessionID;
    const browse = createBrowseContext(target, isSelf);

    journal.debug(`${tool} target resolved`, {
      targetSessionID,
    });

    ctx.metadata({
      title: tool,
      metadata: {
        targetSessionId: targetSessionID,
        tool,
      },
    });

    journal.debug(`${tool} request`, {
      targetSessionID,
    });

    const output = await execute(browse, config, journal);
    await recordToolCall(
      {
        tool,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        targetSessionID,
        args,
        output,
        time: new Date().toISOString(),
      },
      isToolCallLoggingEnabled(config.debug_mode),
      estimateCallDurationMs(startedAt),
      projectRoot,
    );

    return json(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    journal.error(`${tool} failed`, {
      targetSessionID,
      error: message,
    });
    await recordToolCall(
      {
        tool,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        targetSessionID,
        args,
        error: message,
        time: new Date().toISOString(),
      },
      config !== undefined && isToolCallLoggingEnabled(config.debug_mode),
      estimateCallDurationMs(startedAt),
      projectRoot,
    );

    if (err instanceof Error) {
      throw err;
    }
    throw new Error(message);
  }
}

function buildBrowseItems(
  msgs: MessageBundle[],
  previewLengths: {
    user: number;
    assistant: number;
  },
  turnMap: Map<string, number>,
  logger?: {
    log: (msg: string, extra?: Record<string, unknown>) => void;
  },
): BrowseItemOutput[] {
  return msgs.map((msg) => {
    const previewLength = msg.info.role === "user"
      ? previewLengths.user
      : previewLengths.assistant;
    const previewInfo = computeMessagePreview(msg, previewLength);
    const turn = turnMap.get(msg.info.id);

    if (turn === undefined) {
      logger?.log("Internal error: turn not found in turnMap", {
        messageId: msg.info.id,
      });
      throw new Error("Internal error (do not retry).");
    }

    const meta = buildMessageMeta(previewInfo.normalizedMsg, turn, previewInfo.normalizedParts);
    return serializeBrowseItem(meta, previewInfo.preview);
  });
}

function computeMessagePreview(
  msg: MessageBundle,
  previewLength: number,
) {
  const normalizedMsg = toNormalizedMessage(msg.info);
  const normalizedParts = normalizeParts(msg.parts);
  const textPreview = computePreview(normalizedParts, previewLength);
  const fallback = textPreview === undefined
    ? computePreviewFallback(
      normalizedMsg,
      normalizedParts,
      summarizePreviewFallbackHints(msg.parts),
      previewLength,
    )
    : undefined;

  return {
    normalizedMsg,
    normalizedParts,
    textPreview,
    fallbackPreview: fallback?.preview,
    fallbackPriority: fallback?.priority ?? 0,
    preview: textPreview ?? fallback?.preview,
  };
}

export async function browseData(
  input: PluginInput,
  browse: BrowseContext,
  config: EngramConfig,
  journal: Logger,
  request: BrowseRequest,
) {
  const target = browse.target;
  const targetSession = target.session;
  const allRaw = await getAllMessages(input, targetSession.id, internalScanPageSize);
  const visibleMessages = browse.selfSession
    ? filterPreCompactionMessages(allRaw)
    : allRaw;
  const ordered = sortMessagesChronological(visibleMessages);
  const anchorMessageID = request.messageID ?? ordered.at(-1)?.info.id;

  if (request.messageID !== undefined && anchorMessageID === undefined) {
    throw new Error(`Message '${request.messageID}' not found in history. It may be an invalid message_id.`);
  }

  const anchorIndex = anchorMessageID === undefined
    ? -1
    : ordered.findIndex((msg) => msg.info.id === anchorMessageID);

  if (anchorMessageID !== undefined && anchorIndex < 0) {
    if (browse.selfSession && allRaw.some((msg) => msg.info.id === anchorMessageID)) {
      throw new Error(`Message '${anchorMessageID}' is hidden in this session view. Try a nearby visible message instead.`);
    }
    throw new Error(`Message '${anchorMessageID}' not found in history. It may be an invalid message_id.`);
  }

  const startIndex = anchorIndex < 0 ? 0 : Math.max(0, anchorIndex - request.numBefore);
  const endIndex = anchorIndex < 0 ? -1 : Math.min(ordered.length - 1, anchorIndex + request.numAfter);
  const windowMessages = anchorIndex < 0 ? [] : ordered.slice(startIndex, endIndex + 1);
  const beforeMessageID = startIndex > 0 ? ordered[startIndex - 1]!.info.id : null;
  const afterMessageID = endIndex >= 0 && endIndex < ordered.length - 1 ? ordered[endIndex + 1]!.info.id : null;
  let seedPage: MessagePage | undefined;

  const fingerprint = getSessionFingerprint(targetSession);
  const requiredIds = windowMessages.map((msg) => msg.info.id);
  const { turnMap } = await getTurnMapWithCache(
    targetSession.id,
    fingerprint,
    () => fetchTurnItems(input, targetSession.id, internalScanPageSize, seedPage),
    computeTurns,
    journal,
  );

  const missingIds = requiredIds.filter((id) => turnMap.get(id) === undefined);
  if (missingIds.length > 0) {
    journal.debug("turn map missing required ids in browse, rebuilding", {
      targetSessionID: targetSession.id,
      missingCount: missingIds.length,
    });
    clearTurnCache(targetSession.id);
  }

  const finalTurnMap = missingIds.length > 0
    ? await getTurnMapWithFallback(input, target, seedPage, requiredIds, journal)
    : turnMap;

  const logger = {
    log: (msg: string, extra?: Record<string, unknown>) => {
      journal.error(msg, extra);
    },
  };

  const messages = buildBrowseItems(
    windowMessages,
    {
      user: config.browse_messages.user_preview_length,
      assistant: config.browse_messages.assistant_preview_length,
    },
    finalTurnMap,
    logger,
  );
  return serializeBrowse(
    beforeMessageID,
    messages,
    afterMessageID,
    request.numBefore > 0,
    request.numAfter > 0,
  );
}

interface TurnAggregation {
  turn: number;
  visibleMessageCount: number;
  lastVisibleMessageId: string;
  userMessageId: string | null;
  assistantMessageCount: number;
  userSeen: boolean;
  assistantSeen: boolean;
  userPreview: string | null;
  assistantPreview: string | null;
  userFallback?: string;
  assistantFallback?: string;
  userAttachments: string[];
  userFallbackPriority: number;
  assistantFallbackPriority: number;
  assistantToolParts: NormalizedToolPart[];
}

function computeTurnAggregations(
  msgsWithTurns: Array<{ msg: MessageBundle; turn: number }>,
  previewLengths: {
    user: number;
    assistant: number;
  },
): TurnAggregation[] {
  const turnMap = new Map<number, TurnAggregation>();

  for (const { msg, turn } of msgsWithTurns) {
    const existing = turnMap.get(turn);
    if (existing) {
      existing.visibleMessageCount += 1;
      existing.lastVisibleMessageId = msg.info.id;
    } else {
      turnMap.set(turn, {
        turn,
        visibleMessageCount: 1,
        lastVisibleMessageId: msg.info.id,
        userMessageId: null,
        assistantMessageCount: 0,
        userSeen: false,
        assistantSeen: false,
        userPreview: null,
        assistantPreview: null,
        userFallback: undefined,
        assistantFallback: undefined,
        userAttachments: [],
        userFallbackPriority: 0,
        assistantFallbackPriority: 0,
        assistantToolParts: [],
      });
    }

    if (msg.info.role === "user") {
      const agg = turnMap.get(turn)!;
      agg.userSeen = true;
      agg.userMessageId = msg.info.id;
      const previewInfo = computeMessagePreview(msg, previewLengths.user);
      if (agg.userPreview === null && previewInfo.textPreview !== undefined) {
        agg.userPreview = previewInfo.textPreview;
      }
      if (
        agg.userPreview === null
        && previewInfo.fallbackPreview !== undefined
        && previewInfo.fallbackPriority > agg.userFallbackPriority
      ) {
        agg.userFallback = previewInfo.fallbackPreview;
        agg.userFallbackPriority = previewInfo.fallbackPriority;
      }

      agg.userAttachments = computeAttachments(previewInfo.normalizedParts);
    }

    if (msg.info.role === "assistant") {
      const agg = turnMap.get(turn)!;
      agg.assistantSeen = true;
      agg.assistantMessageCount += 1;

      const normalizedParts = normalizeParts(msg.parts);

      // Collect tool parts for outcome and modified files computation
      for (const part of normalizedParts) {
        if (part.type === "tool") {
          agg.assistantToolParts.push(part);
        }
      }

      // Last preview: overwrite so last message's last text part wins
      const lastPreview = computeLastPreview(normalizedParts, previewLengths.assistant);
      if (lastPreview !== undefined) {
        agg.assistantPreview = lastPreview;
      }

      // Fallback when no text preview found
      if (lastPreview === undefined) {
        const normalizedMsg = toNormalizedMessage(msg.info);
        const fallback = computePreviewFallback(
          normalizedMsg,
          normalizedParts,
          summarizePreviewFallbackHints(msg.parts),
          previewLengths.assistant,
        );
        if (
          fallback !== undefined
          && fallback.priority > agg.assistantFallbackPriority
        ) {
          agg.assistantFallback = fallback.preview;
          agg.assistantFallbackPriority = fallback.priority;
        }
      }
    }
  }

  for (const agg of turnMap.values()) {
    if (agg.userPreview === null && agg.userSeen) {
      agg.userPreview = agg.userFallback ?? null;
    }
    if (agg.assistantPreview === null && agg.assistantSeen) {
      agg.assistantPreview = agg.assistantFallback ?? null;
    }
  }

  return Array.from(turnMap.values()).sort((a, b) => a.turn - b.turn);
}

function buildTurnItems(msgs: MessageBundle[]): TurnComputeItem[] {
  return msgs.map((msg) => ({
    id: msg.info.id,
    role: msg.info.role as "user" | "assistant",
    time: msg.info.time.created,
  }));
}

function relativizeModifiedPath(filePath: string, workspaceDirectory: string | undefined): string {
  if (!workspaceDirectory || !filePath.startsWith("/")) {
    return filePath;
  }

  const relativePath = relative(workspaceDirectory, filePath);
  if (
    relativePath.length === 0
    || relativePath === ""
    || relativePath.startsWith("../")
    || relativePath === ".."
  ) {
    return filePath;
  }

  return relativePath;
}

function buildOverviewTurns(
  aggregations: TurnAggregation[],
  workspaceDirectory: string | undefined,
): OverviewStateTurn[] {
  return aggregations.map((agg) => {
    // Build assistant output with tool block and modified files
    let assistantOutput: OverviewAssistantOutput | null = null;
    if (agg.assistantSeen) {
      const toolCalls = computeToolCalls(agg.assistantToolParts);
      const formattedCalls = formatToolCallSummaries(toolCalls);
      const modifiedFiles = computeModifiedFiles(agg.assistantToolParts)
        .map((filePath) => relativizeModifiedPath(filePath, workspaceDirectory));

      assistantOutput = {
        total_messages: agg.assistantMessageCount,
        preview: agg.assistantPreview,
      };

      if (modifiedFiles.length > 0) {
        assistantOutput.modified = modifiedFiles;
      }

      if (formattedCalls.length > 0) {
        assistantOutput.tool = {
          calls: formattedCalls,
          outcome: computeOutcome(agg.assistantToolParts),
        };
      }
    }

    const userOutput = agg.userSeen && agg.userMessageId !== null
      ? {
        message_id: agg.userMessageId,
        preview: agg.userPreview,
        ...(agg.userAttachments.length > 0 ? { attachment: agg.userAttachments } : {}),
      }
      : null;

    return {
      turn: agg.turn,
      output: serializeOverviewTurn(
        agg.turn,
        userOutput,
        assistantOutput,
      ),
      lastVisibleMessageId: agg.lastVisibleMessageId,
      visibleMessageCount: agg.visibleMessageCount,
    };
  });
}

export async function loadOverviewState(
  input: PluginInput,
  browse: BrowseContext,
  config: EngramConfig,
  journal: Logger,
): Promise<OverviewState> {
  const target = browse.target;
  const targetSession = target.session;
  const allRaw = await getAllMessages(input, targetSession.id, internalScanPageSize);

  const turnSourceMessages = browse.selfSession
    ? filterPreCompactionMessages(allRaw, false, false)
    : allRaw;
  const visibleMessages = browse.selfSession
    ? filterSelfSessionVisibleMessages(turnSourceMessages)
    : turnSourceMessages;
  const stableMessages = sortMessagesChronological(turnSourceMessages);
  const stableTurnMap = computeTurns(buildTurnItems(stableMessages));
  const visibleTurns = Array.from(new Set(stableTurnMap.values())).sort((a, b) => a - b);
  const msgsWithTurns = sortMessagesChronological(visibleMessages).map((msg) => ({
    msg,
    turn: stableTurnMap.get(msg.info.id)!,
  }));
  const aggregations = computeTurnAggregations(msgsWithTurns, {
    user: config.browse_turns.user_preview_length,
    assistant: config.browse_turns.assistant_preview_length,
  });

  journal.debug("overview state built", {
    targetSessionID: targetSession.id,
    stableTurnCount: visibleTurns.length,
    visibleTurnCount: aggregations.length,
  });

  return {
    allTurns: visibleTurns,
    turns: buildOverviewTurns(aggregations, input.directory),
  };
}

function buildOverviewTurnWindow(
  state: OverviewState,
  request: OverviewRequest,
): OverviewStateTurn[] {
  if (state.turns.length === 0) {
    if (request.turnIndex !== undefined) {
      if (state.allTurns.includes(request.turnIndex)) {
        throw new Error(`Turn ${request.turnIndex} is hidden in this session view. Try a nearby visible turn instead.`);
      }
      throw new Error(`Turn ${request.turnIndex} not found in history.`);
    }
    return [];
  }

  const targetTurn = request.turnIndex ?? state.turns.at(-1)!.turn;
  const visibleTurn = state.turns.find((turn) => turn.turn === targetTurn);
  if (!visibleTurn) {
    if (state.allTurns.includes(targetTurn)) {
      throw new Error(`Turn ${targetTurn} is hidden in this session view. Try a nearby visible turn instead.`);
    }
    throw new Error(`Turn ${targetTurn} not found in history.`);
  }

  const minTurn = targetTurn - request.numBefore;
  const maxTurn = targetTurn + request.numAfter;
  return state.turns.filter((turn) => turn.turn >= minTurn && turn.turn <= maxTurn);
}

export async function overviewData(
  input: PluginInput,
  browse: BrowseContext,
  config: EngramConfig,
  journal: Logger,
  request: OverviewRequest,
): Promise<OverviewOutput> {
  const state = await loadOverviewState(input, browse, config, journal);
  const turns = buildOverviewTurnWindow(state, request).map((turn) => turn.output);
  return serializeOverview(turns);
}

function getSectionContext(
  config: EngramConfig,
  toolNames: Iterable<string>,
): SectionConvertContext {
  return {
    maxTextLength: config.pull_message.text_length,
    maxReasoningLength: config.pull_message.reasoning_length,
    maxToolOutputLength: config.pull_message.tool_output_length,
    maxToolInputLength: config.pull_message.tool_input_length,
    visibleToolInputs: new Set(resolveVisibleToolNames(toolNames, config.show_tool_input)),
    visibleToolOutputs: new Set(resolveVisibleToolNames(toolNames, config.show_tool_output)),
  };
}

function shouldShowToolInput(tool: string, config: EngramConfig) {
  return resolveVisibleToolNames([tool], config.show_tool_input).includes(tool);
}

function shouldShowToolOutput(tool: string, config: EngramConfig) {
  return resolveVisibleToolNames([tool], config.show_tool_output).includes(tool);
}

async function readMessageDetail(
  input: PluginInput,
  target: SessionTarget,
  config: EngramConfig,
  messageID: string,
  journal: Logger,
): Promise<Record<string, unknown>> {
  const targetSession = target.session;
  const msg = await getMessage(input, targetSession.id, messageID);
  const normalizedMsg = toNormalizedMessage(msg.info);
  const normalizedParts = normalizeParts(msg.parts);
  const turnMap = await getTurnMapWithFallback(input, target, undefined, [messageID], journal);
  const turn = turnMap.get(messageID);

  if (turn === undefined) {
    journal.error("Internal error: turn not found in turnMap", { messageID });
    throw new Error("Internal error (do not retry).");
  }

  const meta = buildMessageMeta(normalizedMsg, turn, normalizedParts);
  const sections = buildSections(
    normalizedParts,
    getSectionContext(
      config,
      normalizedParts
        .filter((part) => part.type === "tool")
        .map((part) => part.tool),
    ),
  );
  return serializeMessageRead(meta, sections);
}

async function readPartDetail(
  input: PluginInput,
  target: SessionTarget,
  config: EngramConfig,
  messageID: string,
  partID: string,
): Promise<Record<string, unknown>> {
  const targetSession = target.session;
  const msg = await getMessage(input, targetSession.id, messageID);
  const normalizedParts = normalizeParts(msg.parts);
  const targetPart = normalizedParts.find((p) => p.partId === partID);

  if (!targetPart) {
    throw new Error("Requested part not found. Please ensure the part_id is correct.");
  }

  if (targetPart.type === "text" && (targetPart.ignored || !targetPart.text.trim())) {
    throw new Error("Requested part has no readable text content. It may be empty or ignored.");
  }

  let content: string;
  let type: "text" | "reasoning" | "tool";
  switch (targetPart.type) {
    case "text":
      type = "text";
      content = targetPart.text;
      break;
    case "reasoning":
      type = "reasoning";
      content = targetPart.text;
      break;
    case "tool": {
      type = "tool";
      const toolInput = shouldShowToolInput(targetPart.tool, config) ? targetPart.input : undefined;
      const toolContent = shouldShowToolOutput(targetPart.tool, config) ? targetPart.content : undefined;
      const contentWithHeader = composeContentWithToolInputSignature(targetPart.tool, toolInput, toolContent);

      if (contentWithHeader === undefined) {
        if (!shouldShowToolOutput(targetPart.tool, config)) {
          throw new Error(`Section '${partID}' content is hidden by show_tool_output.`);
        }
        if (targetPart.status === "running" || targetPart.status === "pending") {
          throw new Error(`Section '${partID}' has no content yet (status: ${targetPart.status}).`);
        }
        throw new Error(`Section '${partID}' has no content.`);
      }

      return serializePartRead(type, contentWithHeader);
    }
    default:
      throw new Error("Requested part not found. Please ensure the part_id is correct.");
  }

  return serializePartRead(type, content);
}

export async function readData(
  input: PluginInput,
  browse: BrowseContext,
  config: EngramConfig,
  messageID: string,
  partID: string | undefined,
  journal: Logger,
): Promise<Record<string, unknown>> {
  const target = browse.target;
  if (!partID) {
    return readMessageDetail(input, target, config, messageID, journal);
  }

  return readPartDetail(input, target, config, messageID, partID);
}

function buildSearchMessageInputs(
  msgs: MessageBundle[],
  turnMap: Map<string, number>,
  logger?: {
    log: (msg: string, extra?: Record<string, unknown>) => void;
  },
): SearchMessageInput[] {
  return msgs.map((msg) => {
    const turn = turnMap.get(msg.info.id);
    if (turn === undefined) {
      logger?.log("Internal error: turn not found in turnMap", {
        messageId: msg.info.id,
      });
      throw new Error("Internal error (do not retry).");
    }

    return {
      id: msg.info.id,
      role: msg.info.role as "user" | "assistant",
      time: msg.info.time.created,
      parts: normalizeParts(msg.parts),
      turn,
    };
  });
}

function collectToolNames(msgs: MessageBundle[]): string[] {
  const toolNames: string[] = [];
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type !== "tool") {
        continue;
      }
      toolNames.push(part.tool);
    }
  }
  return toolNames;
}

async function getOrBuildSearchCache(
  input: PluginInput,
  target: SessionTarget,
  selfSession: boolean,
  config: EngramConfig,
  journal: Logger,
): Promise<SearchCacheEntry> {
  const targetSession = target.session;
  const fingerprint = getSessionCacheFingerprint(targetSession);
  const visibilitySignature = JSON.stringify([
    config.show_tool_input,
    config.show_tool_output,
  ]);
  const cacheKey = selfSession
    ? `self:${targetSession.id}:${visibilitySignature}`
    : `${targetSession.id}:${visibilitySignature}`;
  const cached = getSearchCacheEntry(cacheKey, fingerprint, internalSearchCacheTtlMs);

  if (cached) {
    journal.debug("search cache hit", {
      targetSessionID: targetSession.id,
      documentCount: cached.documents.length,
      cacheAge: Date.now() - cached.createdAt,
    });
    return cached;
  }

  const inflight = getSearchCacheInflight(cacheKey, fingerprint);
  if (inflight) {
    journal.debug("search cache joining in-flight build", {
      targetSessionID: targetSession.id,
    });
    return inflight;
  }

  journal.debug("search cache miss, building index", {
    targetSessionID: targetSession.id,
  });

  const buildPromise = (async (): Promise<SearchCacheEntry> => {
    const allRaw = await getAllMessages(input, targetSession.id, internalScanPageSize);
    const allMessages = selfSession ? filterPreCompactionMessages(allRaw) : allRaw;
    const sortedMessages = sortMessagesChronological(allMessages);
    const turnItems: TurnComputeItem[] = sortedMessages.map((msg) => ({
      id: msg.info.id,
      role: msg.info.role as "user" | "assistant",
      time: msg.info.time.created,
    }));
    const turnMap = computeTurns(turnItems);
    const logger = {
      log: (msg: string, extra?: Record<string, unknown>) => {
        journal.error(msg, { targetSessionID: targetSession.id, ...extra });
      },
    };
    const toolNames = collectToolNames(allMessages);
    const toolSearchVisibility: ToolSearchVisibility = {
      visibleToolInputs: new Set(resolveVisibleToolNames(toolNames, config.show_tool_input)),
      visibleToolOutputs: new Set(resolveVisibleToolNames(toolNames, config.show_tool_output)),
    };
    const searchInputs = buildSearchMessageInputs(allMessages, turnMap, logger);
    const entry = await buildSearchCacheEntry(cacheKey, fingerprint, searchInputs, toolSearchVisibility);
    setSearchCacheEntry(entry);

    journal.debug("search index built", {
      targetSessionID: targetSession.id,
      documentCount: entry.documents.length,
      messageCount: entry.messageMeta.size,
    });
    return entry;
  })();

  setSearchCacheInflight(cacheKey, fingerprint, buildPromise);
  try {
    return await buildPromise;
  } finally {
    clearSearchCacheInflight(cacheKey, fingerprint, buildPromise);
  }
}

export async function searchData(
  input: PluginInput,
  browse: BrowseContext,
  config: EngramConfig,
  searchInput: SearchInput,
  journal: Logger,
): Promise<SearchOutput> {
  const target = browse.target;

  const toError = (error: unknown): Error => {
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  };

  const isKnownTransientSearchError = (error: unknown): boolean => {
    const message = toError(error).message.toLowerCase();
    return message.includes("temporary issue") || message.includes("try again");
  };

  let cache: SearchCacheEntry;
  try {
    cache = await getOrBuildSearchCache(input, target, browse.selfSession, config, journal);
  } catch (error) {
    if (isKnownTransientSearchError(error)) {
      throw new Error(transientSearchErrorMessage);
    }

    const original = toError(error);
    journal.error("search cache build failed", {
      targetSessionID: target.session.id,
      error: original.message,
    });
    throw original;
  }

  journal.debug("search executing query", {
    targetSessionID: target.session.id,
    documentCount: cache.documents.length,
    query: searchInput.query,
    literal: searchInput.literal,
    limit: searchInput.limit,
    types: searchInput.types,
  });

  let result: Awaited<ReturnType<typeof executeSearch>>;
  try {
    result = await executeSearch(
      cache,
      searchInput,
      config.search.snippet_length,
      config.search.max_snippets_per_hit,
    );
  } catch (error) {
    if (isKnownTransientSearchError(error)) {
      throw new Error(transientSearchErrorMessage);
    }

    const original = toError(error);
    journal.error("search execution failed", {
      targetSessionID: target.session.id,
      error: original.message,
    });
    throw original;
  }

  journal.debug("search completed", {
    targetSessionID: target.session.id,
    totalHits: result.totalHits,
    hitsReturned: result.hits.length,
  });

  if (result.totalHits === 0) {
    return serializeSearch(undefined);
  }

  const messageGroups = new Map<
    string,
    {
      meta: { messageId: string; role: "user" | "assistant"; turn: number };
      hits: Array<{
        type: "text" | "reasoning" | "tool";
        partId: string;
        toolName?: string;
        snippets: string[];
      }>;
    }
  >();

  for (const hit of result.hits) {
    const meta = cache.messageMeta.get(hit.messageId);
    if (!meta) {
      continue;
    }

    const existing = messageGroups.get(hit.messageId);
    if (existing) {
      existing.hits.push({
        type: hit.type,
        partId: hit.documentId,
        toolName: hit.toolName,
        snippets: hit.snippets,
      });
      continue;
    }

    messageGroups.set(hit.messageId, {
      meta: {
        messageId: meta.id,
        role: meta.role,
        turn: meta.turn,
      },
      hits: [
        {
          type: hit.type,
          partId: hit.documentId,
          toolName: hit.toolName,
          snippets: hit.snippets,
        },
      ],
    });
  }

  const messages = Array.from(messageGroups.values())
    .slice(0, searchInput.limit)
    .map((group) => {
      const totalHits = group.hits.length;
      const selectedHits = group.hits.slice(0, config.search.max_hits_per_message);
      const remainHits = totalHits - selectedHits.length;

      return serializeSearchMessage(
        group.meta.messageId,
        group.meta.role,
        group.meta.turn,
        selectedHits.map((h) => serializeSearchHit(h.type, h.partId, h.snippets, h.toolName)),
        remainHits,
      );
    });

  return serializeSearch(messages);
}
