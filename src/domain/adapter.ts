/**
 * adapter.ts - SDK Adaptation Layer
 *
 * This module handles the conversion from SDK types to normalized domain types.
 * It extracts facts from SDK structures without deciding presentation logic.
 *
 * Responsibilities:
 * - Type guards for SDK Part union
 * - ToolState status branch extraction
 * - Tool attachments extraction for completed tool states
 * - File path extraction from various source types
 * - SDK Part -> NormalizedPart conversion
 */

import type {
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
} from "@opencode-ai/sdk";

import type {
  ToolStatus,
  NormalizedPart,
  NormalizedTextPart,
  NormalizedReasoningPart,
  NormalizedToolPart,
  NormalizedImagePart,
  NormalizedFilePart,
  PreviewFallbackHints,
} from "./types.ts";

// =============================================================================
// Type Guards
// =============================================================================

export function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning";
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === "file";
}

/**
 * Check if a file part represents an image based on MIME type.
 */
export function isImageFilePart(part: Part): part is FilePart {
  return part.type === "file" && part.mime.startsWith("image/");
}

// =============================================================================
// ToolState Extraction
// =============================================================================

export interface ToolStateExtract {
  status: ToolStatus;
  title: string | null;
  input: Record<string, unknown>;
  content: string | undefined;
}

function isPending(state: ToolState): state is ToolStatePending {
  return state.status === "pending";
}

function isRunning(state: ToolState): state is ToolStateRunning {
  return state.status === "running";
}

function isCompleted(state: ToolState): state is ToolStateCompleted {
  return state.status === "completed";
}

function isError(state: ToolState): state is ToolStateError {
  return state.status === "error";
}

/**
 * Extract normalized state information from a ToolPart's state.
 *
 * SDK ToolState branches:
 * - pending: no title, no content
 * - running: optional title, no content
 * - completed: required title, output as content
 * - error: no title, error as content
 */
export function extractToolState(part: ToolPart): ToolStateExtract {
  const state = part.state;

  if (isCompleted(state)) {
    return {
      status: "completed",
      title: state.title,
      input: state.input,
      content: state.output,
    };
  }

  if (isError(state)) {
    return {
      status: "error",
      title: null,
      input: state.input,
      content: state.error,
    };
  }

  if (isRunning(state)) {
    return {
      status: "running",
      title: state.title ?? null,
      input: state.input,
      content: undefined,
    };
  }

  // pending state
  if (isPending(state)) {
    return {
      status: "pending",
      title: null,
      input: state.input,
      content: undefined,
    };
  }

  const unexpectedStatus =
    state && typeof state === "object" && "status" in state
      ? String((state as { status: unknown }).status)
      : typeof state;
  throw new Error(`Unsupported tool state '${unexpectedStatus}'`);
}

// =============================================================================
// File Path Extraction
// =============================================================================

/**
 * Extract the display path from a FilePart.
 *
 * Priority:
 * 1. source.path (for file/symbol sources)
 * 2. filename property
 * 3. normalized url path
 * 4. "unknown-file" fallback
 */
export function extractFilePath(part: FilePart): string {
  if (part.source) {
    // Both FileSource and SymbolSource have a `path` property
    return part.source.path;
  }

  if (part.filename) {
    return part.filename;
  }

  if (part.url) {
    return normalizeUrlPath(part.url);
  }

  return "unknown-file";
}

function normalizeUrlPath(value: string): string {
  const input = value.trim();
  if (!input) {
    return "unknown-file";
  }

  try {
    const parsed = new URL(input);
    const pathname = decodeURIComponent(parsed.pathname);
    if (!pathname) {
      return input;
    }

    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
      return pathname.slice(1);
    }

    return pathname;
  } catch {
    return input;
  }
}

// =============================================================================
// Part Normalization
// =============================================================================

function normalizeTextPart(part: TextPart): NormalizedTextPart {
  return {
    type: "text",
    partId: part.id,
    messageId: part.messageID,
    text: part.text,
    ignored: part.ignored === true,
  };
}

function normalizeReasoningPart(part: ReasoningPart): NormalizedReasoningPart {
  return {
    type: "reasoning",
    partId: part.id,
    messageId: part.messageID,
    text: part.text,
  };
}

function normalizeToolPart(part: ToolPart): NormalizedToolPart {
  const extract = extractToolState(part);
  return {
    type: "tool",
    partId: part.id,
    messageId: part.messageID,
    tool: part.tool,
    title: extract.title,
    status: extract.status,
    input: extract.input,
    content: extract.content,
  };
}

function toolAttachmentPartId(
  toolPartId: string,
  attachmentId: string,
  index: number,
): string {
  const suffix = attachmentId.trim() ? attachmentId : String(index);
  return `${toolPartId}#attachment-${suffix}`;
}

function normalizeToolAttachment(
  toolPart: ToolPart,
  attachment: FilePart,
  index: number,
): NormalizedImagePart | NormalizedFilePart {
  const partId = toolAttachmentPartId(toolPart.id, attachment.id, index);
  if (attachment.mime.startsWith("image/")) {
    return {
      type: "image",
      partId,
      messageId: toolPart.messageID,
      mime: attachment.mime,
    };
  }

  return {
    type: "file",
    partId,
    messageId: toolPart.messageID,
    path: extractFilePath(attachment),
    mime: attachment.mime,
  };
}

function normalizeToolAttachments(part: ToolPart): Array<NormalizedImagePart | NormalizedFilePart> {
  const state = part.state;
  if (!isCompleted(state) || !state.attachments || state.attachments.length === 0) {
    return [];
  }

  return state.attachments.map((attachment, index) =>
    normalizeToolAttachment(part, attachment, index),
  );
}

function normalizeImagePart(part: FilePart): NormalizedImagePart {
  return {
    type: "image",
    partId: part.id,
    messageId: part.messageID,
    mime: part.mime,
  };
}

function normalizeFilePart(part: FilePart): NormalizedFilePart {
  return {
    type: "file",
    partId: part.id,
    messageId: part.messageID,
    path: extractFilePath(part),
    mime: part.mime,
  };
}

/**
 * Convert an SDK Part to a NormalizedPart.
 *
 * Returns null for part types that should not be included in output
 * (e.g., step-start, step-finish, snapshot, patch, agent, subtask, retry, other internal parts).
 */
export function normalizePart(part: Part): NormalizedPart | null {
  if (isTextPart(part)) {
    return normalizeTextPart(part);
  }

  if (isReasoningPart(part)) {
    return normalizeReasoningPart(part);
  }

  if (isToolPart(part)) {
    return normalizeToolPart(part);
  }

  if (isFilePart(part)) {
    // Distinguish image files from other files
    if (isImageFilePart(part)) {
      return normalizeImagePart(part);
    }
    return normalizeFilePart(part);
  }

  // Ignore other unsupported internal part types.
  return null;
}

/**
 * Normalize all parts from a message, filtering out unsupported types.
 */
export function normalizeParts(parts: Part[]): NormalizedPart[] {
  const result: NormalizedPart[] = [];
  for (const part of parts) {
    if (isToolPart(part)) {
      result.push(normalizeToolPart(part));
      result.push(...normalizeToolAttachments(part));
      continue;
    }

    const normalized = normalizePart(part);
    if (normalized !== null) {
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Summarize raw part kinds that may need semantic preview fallbacks.
 */
export function summarizePreviewFallbackHints(parts: Part[]): PreviewFallbackHints {
  const hints: PreviewFallbackHints = {
    hasCompaction: false,
    hasSubtask: false,
    hasUnsupported: false,
  };

  for (const part of parts) {
    switch (part.type) {
      case "compaction":
        hints.hasCompaction = true;
        break;

      case "subtask":
        hints.hasSubtask = true;
        break;

      case "text":
      case "reasoning":
      case "tool":
      case "file":
        break;

      default:
        hints.hasUnsupported = true;
        break;
    }
  }

  return hints;
}
