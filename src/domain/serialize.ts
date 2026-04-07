/**
 * serialize.ts - Response Serialization Layer
 *
 * This module handles the conversion from domain models to final JSON response structures.
 * It is responsible for:
 * - Field naming mappings (camelCase -> snake_case / template field names)
 * - Field omission rules (empty arrays, null values)
 * - Output contract enforcement
 */

import type {
  AnyMessageMeta,
  BrowseItemOutput,
  BrowseOutput,
  BrowseUserItemOutput,
  BrowseAssistantItemOutput,
  OverviewTurnOutput,
  OverviewOutput,
  Section,
  SectionOutput,
  ReadablePartType,
  SearchPartType,
  SearchHitOutput,
  SearchMessageOutput,
  SearchOutput,
} from "./types.ts";

import {
  formatToolCallSummaries,
} from "./domain.ts";

// =============================================================================
// Browse Item Serialization
// =============================================================================

/**
 * Serialize a user message metadata into a browse item output.
 */
function serializeUserBrowseItem(
  meta: AnyMessageMeta & { role: "user" },
  preview: string | undefined,
): BrowseUserItemOutput {
  const result: BrowseUserItemOutput = {
    role: "user",
    turn_index: meta.turn,
    message_id: meta.id,
  };

  // preview: omit only when no text or semantic fallback is available
  if (preview !== undefined) {
    result.preview = preview;
  }

  // attachment: omit if empty
  if (meta.attachments.length > 0) {
    result.attachment = meta.attachments;
  }

  return result;
}

/**
 * Serialize an assistant message metadata into a browse item output.
 */
function serializeAssistantBrowseItem(
  meta: AnyMessageMeta & { role: "assistant" },
  preview: string | undefined,
): BrowseAssistantItemOutput {
  const result: BrowseAssistantItemOutput = {
    role: "assistant",
    turn_index: meta.turn,
    message_id: meta.id,
  };

  // preview: omit only when no text or semantic fallback is available
  if (preview !== undefined) {
    result.preview = preview;
  }

  // tool: include when there are tool calls
  if (meta.toolCalls.length > 0) {
    result.tool = {
      calls: formatToolCallSummaries(meta.toolCalls),
      outcome: meta.toolOutcome ?? "completed",
    };
  }

  return result;
}

/**
 * Serialize message metadata into a browse item output.
 *
 * @param meta Message metadata (user or assistant)
 * @param preview Preview string or undefined
 * @returns Browse item output with proper field omissions
 */
export function serializeBrowseItem(
  meta: AnyMessageMeta,
  preview: string | undefined,
): BrowseItemOutput {
  if (meta.role === "user") {
    return serializeUserBrowseItem(meta, preview);
  }
  return serializeAssistantBrowseItem(meta, preview);
}

/**
 * Serialize a turn summary for overview output.
 *
 * @param turnIndex Turn number
 * @param user Serialized user summary for this turn, or null if hidden/absent
 * @param assistant Serialized assistant summary for this turn, or null if absent
 * @returns Serialized turn output
 */
export function serializeOverviewTurn(
  turnIndex: number,
  user: OverviewTurnOutput["user"],
  assistant: OverviewTurnOutput["assistant"],
): OverviewTurnOutput {
  return {
    turn_index: turnIndex,
    user,
    assistant,
  };
}

// =============================================================================
// Overview Tool Serialization
// =============================================================================

/**
 * Serialize a full overview response for the history_browse_turns tool.
 *
 * @param turns Turn summaries in ascending turn order
 * @returns Complete overview output object
 */
export function serializeOverview(
  turns: OverviewTurnOutput[],
): OverviewOutput {
  return {
    turns,
  };
}

// =============================================================================
// Full Browse Serialization
// =============================================================================

/**
 * Serialize a full browse response.
 *
 * @param beforeMessageID message_id of the visible message immediately before this window
 * @param messages Array of browse items
 * @param afterMessageID message_id of the visible message immediately after this window
 * @returns Complete browse output object
 */
export function serializeBrowse(
  beforeMessageID: string | null | undefined,
  messages: BrowseItemOutput[],
  afterMessageID: string | null | undefined,
  includeBefore = true,
  includeAfter = true,
): BrowseOutput {
  const result: BrowseOutput = {
    messages,
  };

  if (includeBefore && beforeMessageID !== undefined) {
    result.before_message_id = beforeMessageID;
  }

  if (includeAfter && afterMessageID !== undefined) {
    result.after_message_id = afterMessageID;
  }

  return result;
}

// =============================================================================
// Message Read Serialization
// =============================================================================

/**
 * Serialize a section to output format.
 *
 * Rules:
 * - `part_id` only appears when section is truncated (text/reasoning/tool)
 * - `tool.title` is omitted when unavailable
 * - `tool.content` is omitted when hidden or unavailable
 * - image/file sections have no `part_id` or `content`
 */
function emptyToNull(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.length === 0) {
    return null;
  }
  return value;
}

function serializeSection(section: Section): SectionOutput {

  switch (section.type) {
    case "text": {
      const output: Extract<SectionOutput, { type: "text" }> = {
        type: "text",
        content: emptyToNull(section.content) ?? null,
      };
      if (section.truncated) {
        output.part_id = section.partId;
      }
      return output;
    }

    case "reasoning": {
      const output: Extract<SectionOutput, { type: "reasoning" }> = {
        type: "reasoning",
        content: emptyToNull(section.content) ?? null,
      };
      if (section.truncated) {
        output.part_id = section.partId;
      }
      return output;
    }

    case "tool": {
      const output: Extract<SectionOutput, { type: "tool" }> = {
        type: "tool",
        tool: section.tool,
        status: section.status,
      };
      if (section.input !== undefined) {
        output.input = section.input;
      }
      if (section.content === undefined) {
        // omit content
      } else {
        output.content = emptyToNull(section.content) ?? null;
      }
      // part_id only when truncated
      if (section.truncated) {
        output.part_id = section.partId;
      }
      return output;
    }

    case "image": {
      return {
        type: "image",
        mime: section.mime,
      };
    }

    case "file": {
      return {
        type: "file",
        path: section.path,
        mime: section.mime,
      };
    }
  }
}

function toIsoTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "unknown";
  }

  return date.toISOString();
}

/**
 * Serialize a message detail for read response.
 *
 * @param meta Message metadata
 * @param sections Array of sections
 * @returns MessageReadOutput as Record for JSON serialization
 */
export function serializeMessageRead(
  meta: AnyMessageMeta,
  sections: Section[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    message_id: meta.id,
    role: meta.role,
    turn_index: meta.turn,
    time: toIsoTime(meta.time),
    sections: sections.map((section) => serializeSection(section)),
  };

  return result;
}

// =============================================================================
// Section Read Serialization
// =============================================================================

/**
 * Serialize a part read response for full content retrieval.
 *
 * @param type Part type
 * @param content Full content (not truncated)
 * @returns PartReadOutput as Record for JSON serialization
 */
export function serializePartRead(
  type: ReadablePartType,
  content: string | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type,
  };

  if (content !== undefined) {
    result.content = content;
  }

  return result;
}

// =============================================================================
// Search Serialization (Phase 1: Contracts Only)
// =============================================================================

/**
 * Serialize a single search hit.
 *
 * @param type Part type that matched
 * @param partId Part identifier
 * @param snippets Array of snippet strings
 * @param toolName Optional tool name (only for tool hits)
 * @returns Serialized search hit output
 */
export function serializeSearchHit(
  type: SearchPartType,
  partId: string,
  snippets: string[],
  toolName?: string,
): SearchHitOutput {
  const result: SearchHitOutput = {
    type,
    part_id: partId,
    snippets,
  };

  // tool_name only present for tool hits
  if (toolName !== undefined) {
    result.tool_name = toolName;
  }

  return result;
}

/**
 * Serialize a search message result (grouped hits by message).
 *
 * @param messageId Message identifier
 * @param role Message role
 * @param turnIndex Turn number
 * @param hits Array of serialized hits
 * @param remainHits Number of omitted low-priority hits
 * @returns Serialized search message output
 */
export function serializeSearchMessage(
  messageId: string,
  role: "user" | "assistant",
  turnIndex: number,
  hits: SearchHitOutput[],
  remainHits: number,
): SearchMessageOutput {
  const result: SearchMessageOutput = {
    role,
    turn_index: turnIndex,
    message_id: messageId,
    hits,
  };

  if (remainHits > 0) {
    result.remain_hits = remainHits;
  }

  return result;
}

/**
 * Serialize a full search response.
 *
 * @param messages Array of message results (omit when there are no hits)
 * @returns Complete search output object
 */
export function serializeSearch(
  messages: SearchMessageOutput[] | undefined,
): SearchOutput {
  if (!messages || messages.length === 0) {
    return {};
  }

  const result: SearchOutput = {
    messages,
  };

  return result;
}
