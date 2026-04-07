/**
 * domain.ts - Pure Domain Logic
 *
 * This module contains pure functions for computing domain values.
 * It operates on normalized types, not SDK types directly.
 *
 * Responsibilities:
 * - Turn computation (global stable turns)
 * - Notes generation
 * - Tool call summary aggregation
 * - File references extraction
 * - Section building with truncation
 * - Preview computation
 */

import type {
  MessageRole,
  ToolCallSummary,
  ToolOutcome,
  NormalizedMessage,
  NormalizedPart,
  NormalizedToolPart,
  NormalizedFilePart,
  Section,
  SectionConvertContext,
  AnyMessageMeta,
  UserMessageMeta,
  AssistantMessageMeta,
} from "./types.ts";

import { clipText } from "./clip-text.ts";

function shouldShowToolInput(part: NormalizedToolPart, ctx: SectionConvertContext) {
  return ctx.visibleToolInputs.has(part.tool);
}

function shouldShowToolOutput(part: NormalizedToolPart, ctx: SectionConvertContext) {
  return ctx.visibleToolOutputs.has(part.tool);
}

function truncateToolInputValue(
  value: unknown,
  maxLength: number,
): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    if (value.length <= maxLength) {
      return { value, truncated: false };
    }
    return {
      value: clipText(value, maxLength),
      truncated: true,
    };
  }

  if (Array.isArray(value)) {
    let truncated = false;
    const next = value.map((item) => {
      const result = truncateToolInputValue(item, maxLength);
      truncated = truncated || result.truncated;
      return result.value;
    });
    return { value: next, truncated };
  }

  if (value && typeof value === "object") {
    let truncated = false;
    const nextEntries = Object.entries(value).map(([key, item]) => {
      const result = truncateToolInputValue(item, maxLength);
      truncated = truncated || result.truncated;
      return [key, result.value] satisfies [string, unknown];
    });
    return {
      value: Object.fromEntries(nextEntries),
      truncated,
    };
  }

  return { value, truncated: false };
}

function buildToolInputPreview(
  part: NormalizedToolPart,
  ctx: SectionConvertContext,
): { input: Record<string, unknown> | undefined; truncated: boolean } {
  if (!shouldShowToolInput(part, ctx)) {
    return { input: undefined, truncated: false };
  }

  const result = truncateToolInputValue(part.input, ctx.maxToolInputLength);
  return {
    input: result.value as Record<string, unknown>,
    truncated: result.truncated,
  };
}

// =============================================================================
// Turn Computation
// =============================================================================

/**
 * Minimal message info required for turn computation.
 */
export interface TurnComputeItem {
  id: string;
  role: MessageRole;
  time: number | undefined;
}

/**
 * Compute global stable turn numbers for a list of messages.
 *
 * Turn semantics:
 * - Turn increments by 1 each time a "user" message appears
 * - First "user" message is turn 1
 * - Assistant messages share the turn of the preceding user message
 *
 * The input can be in any order. Items are normalized to chronological order first.
 * For equal timestamps, messages use a deterministic tie-break:
 * user before assistant, then message id, then original input order.
 *
 * @param items Messages in any order
 * @returns Map from message id to turn number
 */
export function computeTurns(items: TurnComputeItem[]): Map<string, number> {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftTime = left.item.time ?? Number.POSITIVE_INFINITY;
      const rightTime = right.item.time ?? Number.POSITIVE_INFINITY;
      const timeDiff = leftTime - rightTime;
      if (timeDiff !== 0) {
        return timeDiff;
      }

      if (left.item.role !== right.item.role) {
        return left.item.role === "user" ? -1 : 1;
      }

      const idDiff = left.item.id.localeCompare(right.item.id);
      if (idDiff !== 0) {
        return idDiff;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.item);

  const result = new Map<string, number>();
  let turn = 0;
  const fallbackTurn = 1;

  for (const item of ordered) {
    if (item.role === "user") {
      turn += 1;
    }

    // Preserve stable output for malformed sequences where no user appears yet.
    result.set(item.id, turn === 0 ? fallbackTurn : turn);
  }

  return result;
}

// =============================================================================
// Notes Generation
// =============================================================================

/**
 * Compute short label notes for a message.
 *
 * Notes are derived from:
 * - Compaction summary: "compacted summary"
 * - Image attachments: "N image(s) attached"
 *
 * @param msg Normalized message metadata
 * @param normalizedParts Normalized parts of the message
 * @returns Array of short labels (empty array if no notes)
 */
export function computeNotes(
  msg: NormalizedMessage,
  normalizedParts: NormalizedPart[],
): string[] {
  const notes: string[] = [];

  if (msg.role === "assistant" && msg.summary === true) {
    notes.push("compacted summary");
  }

  // Count image attachments
  const imageCount = normalizedParts.filter((p) => p.type === "image").length;
  if (imageCount > 0) {
    notes.push(imageCount === 1 ? "1 image attached" : `${imageCount} images attached`);
  }

  return notes;
}

// =============================================================================
// Tool Call Summary
// =============================================================================

/**
 * Aggregate tool call statistics from normalized tool parts.
 *
 * @param parts All normalized parts (filters to tool parts internally)
 * @returns Array of tool call summaries in appearance order
 */
export function computeToolCalls(parts: NormalizedPart[]): ToolCallSummary[] {
  const toolParts = parts.filter(
    (p): p is NormalizedToolPart => p.type === "tool",
  );

  if (toolParts.length === 0) {
    return [];
  }

  // Use Map to preserve insertion order while aggregating
  const summaryMap = new Map<string, ToolCallSummary>();

  for (const part of toolParts) {
    const existing = summaryMap.get(part.tool);
    if (existing) {
      existing.total += 1;
      if (part.status === "error") {
        existing.errors += 1;
      }
    } else {
      summaryMap.set(part.tool, {
        tool: part.tool,
        total: 1,
        errors: part.status === "error" ? 1 : 0,
      });
    }
  }

  return Array.from(summaryMap.values());
}

/**
 * Format tool call summaries into display strings.
 *
 * Format:
 * - "{count}× {tool}" when no errors
 * - "{count}× {tool}: {errorCount}× error" when errors exist
 */
export function formatToolCallSummaries(summaries: ToolCallSummary[]): string[] {
  return summaries.map((s) => {
    if (s.errors > 0) {
      return `${s.total}× ${s.tool}: ${s.errors}× error`;
    }
    return `${s.total}× ${s.tool}`;
  });
}

// =============================================================================
// File References
// =============================================================================

/**
 * Extract unique file paths from normalized parts.
 *
 * Only extracts from "file" type parts (not images).
 * Preserves first-occurrence order.
 */
export function computeFileRefs(parts: NormalizedPart[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];

  for (const part of parts) {
    if (part.type === "file") {
      const p = part as NormalizedFilePart;
      if (!seen.has(p.path)) {
        seen.add(p.path);
        refs.push(p.path);
      }
    }
  }

  return refs;
}

/**
 * Extract user-facing attachment labels from normalized parts.
 *
 * Format:
 * - Image attachments summary: "1 image" or "N images"
 * - File references: path strings in first-seen order
 */
export function computeAttachments(parts: NormalizedPart[]): string[] {
  const attachments: string[] = [];
  const imageCount = parts.filter((p) => p.type === "image").length;
  if (imageCount > 0) {
    attachments.push(imageCount === 1 ? "1 image" : `${imageCount} images`);
  }

  attachments.push(...computeFileRefs(parts));
  return attachments;
}

// =============================================================================
// Tool Outcome
// =============================================================================

/**
 * Derive the success trajectory from tool parts in a turn.
 *
 * Algorithm:
 * 1. If the last tool part is pending/running → "running"
 * 2. Filter to settled parts (completed/error).
 *    If none settled → "running" (all pending/running)
 * 3. No errors among settled → "completed"
 * 4. Errors exist, but a completed call follows the last error → "recovered"
 * 5. Otherwise → "error"
 *
 * Caller is responsible for omitting the tool block entirely when
 * there are no tool parts at all.
 */
export function computeOutcome(toolParts: NormalizedToolPart[]): ToolOutcome {
  if (toolParts.length === 0) {
    return "completed";
  }

  const lastPart = toolParts[toolParts.length - 1]!;
  if (lastPart.status === "pending" || lastPart.status === "running") {
    return "running";
  }

  const settled = toolParts.filter(
    (p) => p.status === "completed" || p.status === "error",
  );
  if (settled.length === 0) {
    return "running";
  }

  const hasError = settled.some((p) => p.status === "error");
  if (!hasError) {
    return "completed";
  }

  let lastErrorIndex = -1;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i]!.status === "error") {
      lastErrorIndex = i;
      break;
    }
  }

  const hasCompletedAfterError = settled
    .slice(lastErrorIndex + 1)
    .some((p) => p.status === "completed");

  return hasCompletedAfterError ? "recovered" : "error";
}

// =============================================================================
// Modified Files
// =============================================================================

/** Tool names whose invocations modify files (OpenCode built-ins). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write", "apply_patch"]);

const applyPatchFileHeaderRe = /^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/;

/**
 * Try to extract a file path from a tool call's input parameters.
 *
 * Supports common parameter names across OpenCode built-in tools.
 */
function extractFilePath(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["file_path", "path", "file"]) {
    const val = input[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * Extract modified file paths from apply_patch patch text.
 */
function extractApplyPatchPaths(input: Readonly<Record<string, unknown>>): string[] {
  const patchText = input.patchText;
  if (typeof patchText !== "string" || patchText.length === 0) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(applyPatchFileHeaderRe);
    if (match === null) {
      continue;
    }

    const filePath = match[1]!.trim();
    if (filePath.length === 0 || seen.has(filePath)) {
      continue;
    }

    seen.add(filePath);
    paths.push(filePath);
  }

  return paths;
}

/**
 * Extract unique file paths modified by write-type tool calls.
 *
 * Only captures paths from completed write tools (edit, write, apply_patch).
 * Preserves first-occurrence order.
 */
export function computeModifiedFiles(toolParts: NormalizedToolPart[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const part of toolParts) {
    if (part.status !== "completed") {
      continue;
    }

    if (!WRITE_TOOL_NAMES.has(part.tool)) {
      continue;
    }

    if (part.tool === "apply_patch") {
      const patchPaths = extractApplyPatchPaths(part.input);
      for (const filePath of patchPaths) {
        if (!seen.has(filePath)) {
          seen.add(filePath);
          paths.push(filePath);
        }
      }

      if (patchPaths.length > 0) {
        continue;
      }
    }

    const filePath = extractFilePath(part.input);
    if (filePath !== undefined && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }
  }

  return paths;
}

// =============================================================================
// Section Building
// =============================================================================

/**
 * Build a Section from a NormalizedPart with truncation handling.
 *
 * @param part Normalized part
 * @param ctx Truncation context with max lengths
 * @returns Section with truncation flag
 */
export function buildSection(
  part: NormalizedPart,
  ctx: SectionConvertContext,
): Section {
  switch (part.type) {
    case "text": {
      const truncated = part.text.length > ctx.maxTextLength;
      return {
        type: "text",
        partId: part.partId,
        content: truncated ? clipText(part.text, ctx.maxTextLength) : part.text,
        truncated,
      };
    }

    case "reasoning": {
      const truncated = part.text.length > ctx.maxReasoningLength;
      return {
        type: "reasoning",
        partId: part.partId,
        content: truncated ? clipText(part.text, ctx.maxReasoningLength) : part.text,
        truncated,
      };
    }

    case "tool": {
      const visibleContent = shouldShowToolOutput(part, ctx) ? part.content : undefined;
      const hasContent = visibleContent !== undefined;
      const contentTruncated = hasContent && visibleContent.length > ctx.maxToolOutputLength;
      const inputPreview = buildToolInputPreview(part, ctx);
      return {
        type: "tool",
        partId: part.partId,
        tool: part.tool,
        title: part.title,
        status: part.status,
        input: inputPreview.input,
        content: hasContent
          ? contentTruncated
            ? clipText(visibleContent, ctx.maxToolOutputLength)
            : visibleContent
          : undefined,
        truncated: contentTruncated || inputPreview.truncated,
      };
    }

    case "image": {
      return {
        type: "image",
        partId: part.partId,
        mime: part.mime,
      };
    }

    case "file": {
      return {
        type: "file",
        partId: part.partId,
        path: part.path,
        mime: part.mime,
      };
    }
  }
}

/**
 * Build all sections from normalized parts.
 *
 * Filters out:
 * - Ignored text parts
 * - Empty text parts
 */
export function buildSections(
  parts: NormalizedPart[],
  ctx: SectionConvertContext,
): Section[] {
  const sections: Section[] = [];

  for (const part of parts) {
    // Skip ignored or empty text
    if (part.type === "text") {
      if (part.ignored || !part.text.trim()) {
        continue;
      }
    }

    sections.push(buildSection(part, ctx));
  }

  return sections;
}

// =============================================================================
// Message Metadata Building
// =============================================================================

/**
 * Build message metadata for a user message.
 */
export function buildUserMessageMeta(
  msg: NormalizedMessage,
  turn: number,
  parts: NormalizedPart[],
): UserMessageMeta {
  return {
    id: msg.id,
    role: "user",
    turn,
    time: msg.time,
    notes: computeNotes(msg, parts),
    attachments: computeAttachments(parts),
  };
}

/**
 * Build message metadata for an assistant message.
 */
export function buildAssistantMessageMeta(
  msg: NormalizedMessage,
  turn: number,
  parts: NormalizedPart[],
): AssistantMessageMeta {
  const toolParts = parts.filter(
    (part): part is NormalizedToolPart => part.type === "tool",
  );
  const toolCalls = computeToolCalls(toolParts);

  const meta: AssistantMessageMeta = {
    id: msg.id,
    role: "assistant",
    turn,
    time: msg.time,
    notes: computeNotes(msg, parts),
    toolCalls,
  };

  if (toolParts.length > 0) {
    meta.toolOutcome = computeOutcome(toolParts);
  }

  return meta;
}

/**
 * Build message metadata based on role.
 */
export function buildMessageMeta(
  msg: NormalizedMessage,
  turn: number,
  parts: NormalizedPart[],
): AnyMessageMeta {
  if (msg.role === "user") {
    return buildUserMessageMeta(msg, turn, parts);
  }
  return buildAssistantMessageMeta(msg, turn, parts);
}
