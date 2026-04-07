import type { Message, Part } from "@opencode-ai/sdk";

import type { PluginInput } from "../common/common.ts";
import type { NormalizedMessage } from "../domain/types.ts";

export const defaultCount = 20;
export const internalScanPageSize = 100;

/**
 * MessageBundle from SDK API response.
 */
export type MessageBundle = {
  info: Message;
  parts: Part[];
};

/**
 * A page of messages from getMessagePage.
 */
export type MessagePage = {
  msgs: MessageBundle[];
  next_cursor: string | undefined;
};

export function normalizeCursor(cursor?: string) {
  const value = cursor?.trim();
  if (!value) return undefined;
  return value;
}

export function messageLimit(count: number | undefined, maxMessages: number) {
  const normalized = count === undefined ? defaultCount : count;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(normalized, maxMessages);
}

/**
 * Convert an SDK Message to a NormalizedMessage for domain layer consumption.
 */
export function toNormalizedMessage(msg: Message): NormalizedMessage {
  return {
    id: msg.id,
    role: msg.role as "user" | "assistant",
    time: msg.time.created,
    summary: msg.summary === true,
  };
}

export function sortMessagesChronological(msgs: MessageBundle[]) {
  return msgs
    .map((msg, index) => ({ msg, index }))
    .sort((left, right) => {
      const leftTime = left.msg.info.time.created ?? Number.POSITIVE_INFINITY;
      const rightTime = right.msg.info.time.created ?? Number.POSITIVE_INFINITY;
      const timeDiff = leftTime - rightTime;
      if (timeDiff !== 0) {
        return timeDiff;
      }

      if (left.msg.info.role !== right.msg.info.role) {
        return left.msg.info.role === "user" ? -1 : 1;
      }

      const idDiff = left.msg.info.id.localeCompare(right.msg.info.id);
      if (idDiff !== 0) {
        return idDiff;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.msg);
}

export function sortMessagesNewestFirst(msgs: MessageBundle[]) {
  return msgs
    .map((msg, index) => ({ msg, index }))
    .sort((left, right) => {
      const leftTime = left.msg.info.time.created;
      const rightTime = right.msg.info.time.created;

      // Undefined time should always be placed at the end,
      // even when sorting newest-first.
      if (leftTime === undefined || rightTime === undefined) {
        if (leftTime === undefined && rightTime === undefined) {
          return left.index - right.index;
        }
        return leftTime === undefined ? 1 : -1;
      }

      const timeDiff = rightTime - leftTime;
      if (timeDiff !== 0) {
        return timeDiff;
      }

      // Preserve original relative order for equal timestamps.
      return left.index - right.index;
    })
    .map((entry) => entry.msg);
}

export async function getMessagePage(
  input: PluginInput,
  sessionID: string,
  limit: number,
  cursor?: string,
) {
  const result = await input.client.session.messages({
    path: { id: sessionID },
    query: {
      limit,
      ...(cursor ? { before: cursor } : {}),
    },
    throwOnError: false,
  });

  const status = result.response?.status ?? 0;
  if (result.error || status >= 400 || !result.data) {
    if (cursor && status === 400) {
      throw new Error(`Message '${cursor}' not found in history. It may be an invalid message_id.`);
    }
    throw new Error("Failed to read session messages. This may be a temporary issue — try again.");
  }

  const rawCursor = result.response.headers.get("x-next-cursor");
  // Normalize empty string to undefined (no more pages)
  const nextCursor = rawCursor && rawCursor.trim() ? rawCursor : undefined;

  return {
    msgs: result.data,
    next_cursor: nextCursor,
  };
}

export async function getMessage(
  input: PluginInput,
  sessionID: string,
  messageID: string,
) {
  const result = await input.client.session.message({
    path: {
      id: sessionID,
      messageID,
    },
    throwOnError: false,
  });

  const status = result.response?.status ?? 0;
  if (status === 404) {
    throw new Error("Requested message not found. Please ensure the message_id is correct.");
  }
  if (status >= 500 || status === 0) {
    // 0 typically means network/transport error
    throw new Error(`Failed to read message. This may be a temporary issue — try again.`);
  }
  if (status === 401 || status === 403) {
    throw new Error(`Not authorized to read this message. Please check your permissions.`);
  }
  if (status >= 400) {
    throw new Error(`Invalid request (status ${status}). Please check your parameters.`);
  }
  if (result.error) {
    // SDK returned an error without status (e.g., network error)
    throw new Error(`Failed to read message. This may be a temporary issue — try again.`);
  }
  if (!result.data) {
    throw new Error("Failed to read message. This may be a temporary issue — try again.");
  }

  return result.data;
}

/**
 * Fetch all messages from the upstream history.
 * Optionally accepts a seed page to avoid re-fetching the first page.
 */
export async function getAllMessages(
  input: PluginInput,
  sessionID: string,
  pageSize: number,
  seedPage?: MessagePage,
) {
  const messages: MessageBundle[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  // If seedPage is provided, use it as the first page
  if (seedPage) {
    messages.push(...seedPage.msgs);
    cursor = seedPage.next_cursor;
    // If no more pages, return early
    if (!cursor) {
      return messages;
    }
    seenCursors.add(cursor);
  }

  while (true) {
    const page = await getMessagePage(input, sessionID, pageSize, cursor);
    messages.push(...page.msgs);

    if (!page.next_cursor) {
      break;
    }

    if (seenCursors.has(page.next_cursor)) {
      input.client.app.log({
        body: {
          service: "engram-plugin",
          level: "error",
          message: "Internal error: paging cursor repeated in getAllMessages",
          extra: { sessionID, repeatedCursor: page.next_cursor },
        },
      }).catch(() => undefined);
      throw new Error("Internal error (do not retry).");
    }

    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }

  return messages;
}
