/**
 * adapter.ts - History Part Adaptation Layer
 *
 * This module handles the conversion from backend-neutral history part types
 * to normalized domain types. It extracts facts without deciding presentation logic.
 */

import type {
  HistoryFilePart,
  HistoryPart,
  HistoryReasoningPart,
  HistoryTextPart,
  HistoryToolPart,
  HistoryToolState,
  HistoryToolStateCompleted,
  HistoryToolStatePending,
  HistoryToolStateRunning,
  NormalizedFilePart,
  NormalizedImagePart,
  NormalizedPart,
  NormalizedReasoningPart,
  NormalizedTextPart,
  NormalizedToolPart,
  PreviewFallbackHints,
  ToolStatus,
} from "./types.ts";

// =============================================================================
// Type Guards
// =============================================================================

export function isTextPart(part: HistoryPart): part is HistoryTextPart {
  return part.type === "text";
}

export function isReasoningPart(part: HistoryPart): part is HistoryReasoningPart {
  return part.type === "reasoning";
}

export function isToolPart(part: HistoryPart): part is HistoryToolPart {
  return part.type === "tool";
}

export function isFilePart(part: HistoryPart): part is HistoryFilePart {
  return part.type === "file";
}

/**
 * Check if a file part represents an image based on MIME type.
 */
export function isImageFilePart(part: HistoryPart): part is HistoryFilePart {
  return isFilePart(part) && part.mime.startsWith("image/");
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

function isPending(state: HistoryToolState): state is HistoryToolStatePending {
  return state.status === "pending";
}

function isRunning(state: HistoryToolState): state is HistoryToolStateRunning {
  return state.status === "running";
}

function isCompleted(state: HistoryToolState): state is HistoryToolStateCompleted {
  return state.status === "completed";
}

/**
 * Extract normalized state information from a tool part state.
 */
export function extractToolState(part: HistoryToolPart): ToolStateExtract {
  const state = part.state;

  switch (state.status) {
    case "completed": {
      return {
        status: "completed",
        title: state.title,
        input: state.input,
        content: state.output,
      };
    }

    case "error": {
      return {
        status: "error",
        title: null,
        input: state.input,
        content: state.error,
      };
    }

    case "running": {
      return {
        status: "running",
        title: state.title ?? null,
        input: state.input,
        content: undefined,
      };
    }

    case "pending": {
      return {
        status: "pending",
        title: null,
        input: state.input,
        content: undefined,
      };
    }

    default: {
      const unexpectedStatus = String((state as { status?: unknown }).status ?? "unknown");
      throw new Error(`Unsupported tool state '${unexpectedStatus}'`);
    }
  }
}

// =============================================================================
// File Path Extraction
// =============================================================================

/**
 * Extract the display path from a file part.
 */
export function extractFilePath(part: HistoryFilePart): string {
  if (part.source) {
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

function normalizeTextPart(part: HistoryTextPart): NormalizedTextPart {
  return {
    type: "text",
    partId: part.id,
    messageId: part.messageID,
    text: part.text,
    ignored: part.ignored === true,
  };
}

function normalizeReasoningPart(part: HistoryReasoningPart): NormalizedReasoningPart {
  return {
    type: "reasoning",
    partId: part.id,
    messageId: part.messageID,
    text: part.text,
  };
}

function normalizeToolPart(part: HistoryToolPart): NormalizedToolPart {
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
  toolPart: HistoryToolPart,
  attachment: HistoryFilePart,
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

function normalizeToolAttachments(part: HistoryToolPart): Array<NormalizedImagePart | NormalizedFilePart> {
  const state = part.state;
  if (!isCompleted(state) || !state.attachments || state.attachments.length === 0) {
    return [];
  }

  return state.attachments.map((attachment, index) =>
    normalizeToolAttachment(part, attachment, index),
  );
}

function normalizeImagePart(part: HistoryFilePart): NormalizedImagePart {
  return {
    type: "image",
    partId: part.id,
    messageId: part.messageID,
    mime: part.mime,
  };
}

function normalizeFilePart(part: HistoryFilePart): NormalizedFilePart {
  return {
    type: "file",
    partId: part.id,
    messageId: part.messageID,
    path: extractFilePath(part),
    mime: part.mime,
  };
}

/**
 * Convert a raw history part to a NormalizedPart.
 *
 * Returns null for part types that should not be included in output.
 */
export function normalizePart(part: HistoryPart): NormalizedPart | null {
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
    if (isImageFilePart(part)) {
      return normalizeImagePart(part);
    }
    return normalizeFilePart(part);
  }

  return null;
}

/**
 * Normalize all parts from a message, filtering out unsupported types.
 */
export function normalizeParts(parts: HistoryPart[]): NormalizedPart[] {
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
export function summarizePreviewFallbackHints(parts: HistoryPart[]): PreviewFallbackHints {
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
