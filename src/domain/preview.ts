import { clipPreviewText } from "./clip-text.ts";
import { computeToolCalls } from "./domain.ts";

import type {
  NormalizedMessage,
  NormalizedPart,
  PreviewFallbackHints,
} from "./types.ts";

function clipPreviewTextInfo(text: string, maxLength: number) {
  const body = text.replace(/\r?\n/g, " ").trim();
  return {
    preview: clipPreviewText(body, maxLength),
  };
}

/**
 * Compute a preview string from normalized parts.
 *
 * Returns the first visible text part as a single-line clipped preview.
 */
export function computePreview(
  parts: NormalizedPart[],
  maxLength: number,
): string | undefined {
  for (const part of parts) {
    if (part.type === "text" && !part.ignored && part.text.trim()) {
      return clipPreviewTextInfo(part.text, maxLength).preview;
    }
  }

  return undefined;
}

/**
 * Compute a preview string from the LAST visible text part.
 *
 * Used for assistant overview previews where the conclusion (last text)
 * has higher orientation value than the intent (first text).
 */
export function computeLastPreview(
  parts: NormalizedPart[],
  maxLength: number,
): string | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.type === "text" && !part.ignored && part.text.trim()) {
      return clipPreviewTextInfo(part.text, maxLength).preview;
    }
  }

  return undefined;
}

function buildToolFallbackLabel(parts: NormalizedPart[]) {
  if (computeToolCalls(parts).length === 0) {
    return undefined;
  }

  const hasReasoning = parts.some((part) => part.type === "reasoning");
  const hasAttachments = parts.some((part) => part.type === "image" || part.type === "file");

  if (!hasReasoning && !hasAttachments) {
    return "[tool calls only]";
  }

  let prefix = "[tool calls";

  if (hasReasoning) {
    prefix += " + reasoning";
  }

  if (hasAttachments) {
    prefix += " + attachments";
  }

  return `${prefix}]`;
}

/**
 * Compute a bracketed semantic fallback when no visible text exists.
 *
 * Higher priority means the fallback is more specific and should win when a turn
 * needs to choose among multiple non-text messages for the same role.
 */
export function computePreviewFallback(
  msg: NormalizedMessage,
  parts: NormalizedPart[],
  hints: PreviewFallbackHints,
  maxLength: number,
): { preview: string; priority: number } | undefined {
  function fallback(preview: string, priority: number) {
    return {
      preview: clipPreviewTextInfo(preview, maxLength).preview,
      priority,
    };
  }

  if (msg.role === "assistant" && msg.summary === true) {
    return fallback("[compacted summary]", 60);
  }

  if (hints.hasCompaction) {
    return fallback("[compaction trigger]", 50);
  }

  const toolLabel = buildToolFallbackLabel(parts);
  if (toolLabel !== undefined) {
    return fallback(toolLabel, 40);
  }

  if (hints.hasSubtask) {
    return fallback("[subtask request]", 35);
  }

  const hasReasoning = parts.some((part) => part.type === "reasoning");
  const hasAttachments = parts.some((part) => part.type === "image" || part.type === "file");

  if (hasReasoning && hasAttachments) {
    return fallback("[reasoning + attachments]", 30);
  }

  if (hasReasoning) {
    return fallback("[reasoning only]", 20);
  }

  if (hasAttachments) {
    return fallback("[attachments only]", 15);
  }

  return undefined;
}
