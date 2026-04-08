import type {
  Message,
  Part,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStateRunning,
  FilePart,
} from "@opencode-ai/sdk";

import type { PluginInput } from "../../common/common.ts";
import type {
  HistoryCompactionPart,
  HistoryFilePart,
  HistoryMessage,
  HistoryMessageBundle,
  HistoryPart,
  HistoryReasoningPart,
  HistorySubtaskPart,
  HistoryTextPart,
  HistoryToolPart,
  HistoryToolState,
} from "../../domain/types.ts";
import type { HistoryBackend, HistoryMessagePage } from "../../core/history-backend.ts";
import type { HistorySessionData } from "../../core/session.ts";

function describeUnsupportedValue(value: unknown): string {
  return value === undefined ? "undefined" : String(value);
}

function toQuery(directory?: string): { directory: string } | undefined {
  if (!directory?.trim()) {
    return undefined;
  }
  return { directory };
}

function toHistoryMessageRole(role: unknown): HistoryMessage["role"] {
  if (role === "user" || role === "assistant") {
    return role;
  }
  throw new Error(`Unsupported message role '${describeUnsupportedValue(role)}'`);
}

function toHistoryMessage(message: Message): HistoryMessage {
  const result: HistoryMessage = {
    id: message.id,
    role: toHistoryMessageRole(message.role),
  };

  if (message.time?.created !== undefined) {
    result.time = {
      created: message.time.created,
    };
  }
  if (message.summary !== undefined) {
    result.summary = message.summary;
  }

  return result;
}

function toHistoryFilePart(part: FilePart): HistoryFilePart {
  return {
    type: "file",
    id: part.id,
    messageID: part.messageID,
    mime: part.mime,
    source: part.source?.path ? { path: part.source.path } : undefined,
    filename: part.filename,
    url: part.url,
  };
}

function toHistoryToolState(state: ToolState): HistoryToolState {
  switch (state.status) {
    case "pending": {
      const pending = state as ToolStatePending;
      return {
        status: "pending",
        input: pending.input,
      };
    }
    case "running": {
      const running = state as ToolStateRunning;
      return {
        status: "running",
        title: running.title,
        input: running.input,
      };
    }
    case "completed": {
      const completed = state as ToolStateCompleted;
      return {
        status: "completed",
        title: completed.title,
        input: completed.input,
        output: completed.output,
        attachments: completed.attachments?.map(toHistoryFilePart),
      };
    }
    case "error": {
      const error = state as ToolStateError;
      return {
        status: "error",
        input: error.input,
        error: error.error,
      };
    }
    default: {
      throw new Error(`Unsupported tool state '${describeUnsupportedValue((state as { status?: unknown }).status)}'`);
    }
  }
}

function toHistoryTextPart(part: Extract<Part, { type: "text" }>): HistoryTextPart {
  return {
    type: "text",
    id: part.id,
    messageID: part.messageID,
    text: part.text,
    ignored: part.ignored === true,
  };
}

function toHistoryReasoningPart(part: Extract<Part, { type: "reasoning" }>): HistoryReasoningPart {
  return {
    type: "reasoning",
    id: part.id,
    messageID: part.messageID,
    text: part.text,
  };
}

function toHistoryToolPart(part: ToolPart): HistoryToolPart {
  return {
    type: "tool",
    id: part.id,
    messageID: part.messageID,
    tool: part.tool,
    state: toHistoryToolState(part.state),
  };
}

function toHistoryCompactionPart(part: Extract<Part, { type: "compaction" }>): HistoryCompactionPart {
  return {
    type: "compaction",
    id: part.id,
    messageID: part.messageID,
    auto: part.auto,
  };
}

function toHistorySubtaskPart(part: Extract<Part, { type: "subtask" }>): HistorySubtaskPart {
  return {
    type: "subtask",
    id: part.id,
    messageID: part.messageID,
  };
}

function toHistoryUnknownPart(part: Part): HistoryPart {
  return {
    type: part.type,
    id: part.id,
    messageID: part.messageID,
    originalType: part.type,
  };
}

function toHistoryPart(part: Part): HistoryPart {
  switch (part.type) {
    case "text":
      return toHistoryTextPart(part);
    case "reasoning":
      return toHistoryReasoningPart(part);
    case "tool":
      return toHistoryToolPart(part);
    case "file":
      return toHistoryFilePart(part);
    case "compaction":
      return toHistoryCompactionPart(part);
    case "subtask":
      return toHistorySubtaskPart(part);
    default:
      return toHistoryUnknownPart(part);
  }
}

function toHistoryMessageBundle(bundle: { info: Message; parts: Part[] }): HistoryMessageBundle {
  return {
    info: toHistoryMessage(bundle.info),
    parts: bundle.parts.map(toHistoryPart),
  };
}

async function getSessionOrThrow(
  input: PluginInput,
  sessionId: string,
): Promise<HistorySessionData> {
  const result = await input.client.session.get({
    path: { id: sessionId },
    query: toQuery(input.directory),
    throwOnError: false,
  });

  const status = result.response?.status ?? 0;
  if (status === 404) {
    throw new Error(`Session '${sessionId}' not found`);
  }
  if (result.error || status >= 400 || !result.data) {
    throw new Error(
      `Failed to load session '${sessionId}'. This may be a temporary issue — try again.`,
    );
  }

  return result.data;
}

async function listMessagesOrThrow(
  input: PluginInput,
  sessionId: string,
  options: {
    limit: number;
    before?: string;
  },
): Promise<HistoryMessagePage> {
  const result = await input.client.session.messages({
    path: { id: sessionId },
    query: {
      limit: options.limit,
      ...(options.before ? { before: options.before } : {}),
    },
    throwOnError: false,
  });

  const status = result.response?.status ?? 0;
  if (result.error || status >= 400 || !result.data) {
    if (options.before && status === 400) {
      throw new Error(`Message '${options.before}' not found in history. It may be an invalid message_id.`);
    }
    throw new Error("Failed to read session messages. This may be a temporary issue — try again.");
  }

  const rawCursor = result.response.headers.get("x-next-cursor");
  const nextCursor = rawCursor && rawCursor.trim() ? rawCursor : undefined;

  return {
    msgs: result.data.map(toHistoryMessageBundle),
    nextCursor,
  };
}

async function getMessageOrThrow(
  input: PluginInput,
  sessionId: string,
  messageId: string,
): Promise<HistoryMessageBundle> {
  const result = await input.client.session.message({
    path: {
      id: sessionId,
      messageID: messageId,
    },
    throwOnError: false,
  });

  const status = result.response?.status ?? 0;
  if (status === 404) {
    throw new Error("Requested message not found. Please ensure the message_id is correct.");
  }
  if (status >= 500 || status === 0) {
    throw new Error("Failed to read message. This may be a temporary issue — try again.");
  }
  if (status === 401 || status === 403) {
    throw new Error("Not authorized to read this message. Please check your permissions.");
  }
  if (status >= 400) {
    throw new Error(`Invalid request (status ${status}). Please check your parameters.`);
  }
  if (result.error || !result.data) {
    throw new Error("Failed to read message. This may be a temporary issue — try again.");
  }

  return toHistoryMessageBundle(result.data);
}

export function createOpenCodeBackend(input: PluginInput): HistoryBackend {
  return {
    getSession(sessionId) {
      return getSessionOrThrow(input, sessionId);
    },
    listMessages(sessionId, options) {
      return listMessagesOrThrow(input, sessionId, options);
    },
    getMessage(sessionId, messageId) {
      return getMessageOrThrow(input, sessionId, messageId);
    },
  };
}
