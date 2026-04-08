import type { PluginInput } from "../common/common.ts";
import type { HistoryBackend, HistoryMessagePage } from "../core/history-backend.ts";
import type {
  HistoryMessage,
  HistoryMessageBundle,
  MessageRole,
  NormalizedMessage,
} from "../domain/types.ts";

import { resolveHistoryBackend } from "./backends/index.ts";

export const defaultCount = 20;
export const internalScanPageSize = 100;

/**
 * Backward-compatible alias used throughout runtime/tests.
 */
export type MessageBundle = HistoryMessageBundle;

/**
 * Backward-compatible alias for paged reads.
 */
export type MessagePage = {
  msgs: MessageBundle[];
  next_cursor: string | undefined;
};

function describeUnsupportedRole(value: string | undefined): string {
  return value === undefined ? "undefined" : value;
}

export function requireMessageRole(value: string | undefined): MessageRole {
  if (value === "user" || value === "assistant") {
    return value;
  }
  throw new Error(`Unsupported message role '${describeUnsupportedRole(value)}'`);
}

function requireMessageBundleRole(bundle: MessageBundle): MessageBundle {
  requireMessageRole(bundle.info.role);
  return bundle;
}

function toMessagePage(page: HistoryMessagePage): MessagePage {
  return {
    msgs: page.msgs.map(requireMessageBundleRole),
    next_cursor: page.nextCursor,
  };
}

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
 * Convert a backend message to a NormalizedMessage for domain layer consumption.
 */
export function toNormalizedMessage(msg: HistoryMessage): NormalizedMessage {
  return {
    id: msg.id,
    role: requireMessageRole(msg.role),
    time: msg.time?.created,
    summary: msg.summary === true,
  };
}

export function sortMessagesChronological(msgs: MessageBundle[]) {
  return msgs
    .map((msg, index) => ({ msg, index }))
    .sort((left, right) => {
      const leftTime = left.msg.info.time?.created ?? Number.POSITIVE_INFINITY;
      const rightTime = right.msg.info.time?.created ?? Number.POSITIVE_INFINITY;
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
      const leftTime = left.msg.info.time?.created;
      const rightTime = right.msg.info.time?.created;

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

      return left.index - right.index;
    })
    .map((entry) => entry.msg);
}

export async function getMessagePage(
  input: PluginInput,
  sessionID: string,
  limit: number,
  cursor?: string,
  backend?: HistoryBackend,
) {
  const page = await resolveHistoryBackend(input, backend).listMessages(sessionID, {
    limit,
    before: cursor,
  });
  return toMessagePage(page);
}

export async function getMessage(
  input: PluginInput,
  sessionID: string,
  messageID: string,
  backend?: HistoryBackend,
) {
  return requireMessageBundleRole(await resolveHistoryBackend(input, backend).getMessage(sessionID, messageID));
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
  backend?: HistoryBackend,
) {
  const messages: MessageBundle[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  if (seedPage) {
    messages.push(...seedPage.msgs.map(requireMessageBundleRole));
    cursor = seedPage.next_cursor;
    if (!cursor) {
      return messages;
    }
    seenCursors.add(cursor);
  }

  while (true) {
    const page = await getMessagePage(input, sessionID, pageSize, cursor, backend);
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
