/**
 * types.ts - Shared domain types and output contracts
 *
 * This module defines all domain model types for the upstream history refactor.
 * It serves as the stable boundary between adapter, domain, and serialize layers.
 */

// =============================================================================
// Basic Types
// =============================================================================

export type MessageRole = "user" | "assistant";

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type ToolOutcome = "completed" | "recovered" | "error" | "running";

export type ReadablePartType = "text" | "reasoning" | "tool";

// =============================================================================
// History Backend Raw Types
// =============================================================================

export interface HistoryMessage {
  id: string;
  role: MessageRole;
  time?: {
    created?: number;
  };
  summary?: unknown;
}

export interface HistoryFileSource {
  path: string;
}

export interface HistoryFilePart {
  type: "file";
  id: string;
  messageID: string;
  mime: string;
  source?: HistoryFileSource;
  filename?: string;
  url?: string;
}

export interface HistoryToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
}

export interface HistoryToolStateRunning {
  status: "running";
  title?: string;
  input: Record<string, unknown>;
}

export interface HistoryToolStateCompleted {
  status: "completed";
  title: string;
  input: Record<string, unknown>;
  output: string;
  attachments?: HistoryFilePart[];
}

export interface HistoryToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
}

export type HistoryToolState =
  | HistoryToolStatePending
  | HistoryToolStateRunning
  | HistoryToolStateCompleted
  | HistoryToolStateError;

export interface HistoryTextPart {
  type: "text";
  id: string;
  messageID: string;
  text: string;
  ignored?: boolean;
}

export interface HistoryReasoningPart {
  type: "reasoning";
  id: string;
  messageID: string;
  text: string;
}

export interface HistoryToolPart {
  type: "tool";
  id: string;
  messageID: string;
  tool: string;
  state: HistoryToolState;
}

export interface HistoryCompactionPart {
  type: "compaction";
  id: string;
  messageID: string;
  auto?: boolean;
}

export interface HistorySubtaskPart {
  type: "subtask";
  id: string;
  messageID: string;
}

export interface HistoryUnknownPart {
  type: string;
  id: string;
  messageID: string;
  originalType?: string;
}

export type HistoryPart =
  | HistoryTextPart
  | HistoryReasoningPart
  | HistoryToolPart
  | HistoryFilePart
  | HistoryCompactionPart
  | HistorySubtaskPart
  | HistoryUnknownPart;

export interface HistoryMessageBundle {
  info: HistoryMessage;
  parts: HistoryPart[];
}

// =============================================================================
// Normalized Message (Adapter Output -> Domain Input)
// =============================================================================

export interface NormalizedMessage {
  id: string;
  role: MessageRole;
  time: number | undefined;
  summary: boolean;
}

// =============================================================================
// Tool Call Summary
// =============================================================================

/**
 * Aggregated statistics for a single tool name within a message.
 */
export interface ToolCallSummary {
  tool: string;
  total: number;
  errors: number;
}

// =============================================================================
// Message Metadata
// =============================================================================

export interface MessageMetaBase {
  id: string;
  role: MessageRole;
  turn: number;
  time: number | undefined;
  notes: string[];
}

export interface UserMessageMeta extends MessageMetaBase {
  role: "user";
  attachments: string[];
}

export interface AssistantMessageMeta extends MessageMetaBase {
  role: "assistant";
  toolCalls: ToolCallSummary[];
  toolOutcome?: ToolOutcome;
}

export type AnyMessageMeta = UserMessageMeta | AssistantMessageMeta;

// =============================================================================
// Section Types (Domain Model)
// =============================================================================

export interface TextSection {
  type: "text";
  partId: string;
  content: string;
  truncated: boolean;
}

export interface ReasoningSection {
  type: "reasoning";
  partId: string;
  content: string;
  truncated: boolean;
}

export interface ToolSection {
  type: "tool";
  partId: string;
  tool: string;
  title: string | null;
  status: ToolStatus;
  input?: Record<string, unknown>;
  content?: string;
  truncated: boolean;
}

export interface ImageSection {
  type: "image";
  partId: string;
  mime: string;
}

export interface FileSection {
  type: "file";
  partId: string;
  path: string;
  mime: string;
}

export type Section =
  | TextSection
  | ReasoningSection
  | ToolSection
  | ImageSection
  | FileSection;

// =============================================================================
// Normalized Part (Adapter Output -> Domain Input)
// =============================================================================

export type NormalizedTextPart = {
  type: "text";
  partId: string;
  messageId: string;
  text: string;
  ignored: boolean;
};

export type NormalizedReasoningPart = {
  type: "reasoning";
  partId: string;
  messageId: string;
  text: string;
};

export type NormalizedToolPart = {
  type: "tool";
  partId: string;
  messageId: string;
  tool: string;
  title: string | null;
  status: ToolStatus;
  input: Record<string, unknown>;
  content?: string;
};

export type NormalizedImagePart = {
  type: "image";
  partId: string;
  messageId: string;
  mime: string;
};

export type NormalizedFilePart = {
  type: "file";
  partId: string;
  messageId: string;
  path: string;
  mime: string;
};

export type NormalizedPart =
  | NormalizedTextPart
  | NormalizedReasoningPart
  | NormalizedToolPart
  | NormalizedImagePart
  | NormalizedFilePart;

// =============================================================================
// Section Conversion Context
// =============================================================================

export interface SectionConvertContext {
  maxTextLength: number;
  maxReasoningLength: number;
  maxToolOutputLength: number;
  maxToolInputLength: number;
  visibleToolInputs: ReadonlySet<string>;
  visibleToolOutputs: ReadonlySet<string>;
}

export interface PreviewFallbackHints {
  hasCompaction: boolean;
  hasSubtask: boolean;
  hasUnsupported: boolean;
}

// =============================================================================
// Serialized Output Types (Final JSON Contracts)
// =============================================================================

export interface BrowseUserItemOutput {
  role: "user";
  turn_index: number;
  message_id: string;
  preview?: string;
  attachment?: string[];
}

export interface BrowseAssistantItemOutput {
  role: "assistant";
  turn_index: number;
  message_id: string;
  preview?: string;
  tool?: ToolBlockOutput;
}

export type BrowseItemOutput =
  | BrowseUserItemOutput
  | BrowseAssistantItemOutput;

export interface OverviewUserOutput {
  message_id: string;
  preview: string | null;
  attachment?: string[];
}

/** Tool activity summary block for assistant outputs. */
export interface ToolBlockOutput {
  calls: string[];
  outcome: ToolOutcome;
}

export interface OverviewAssistantOutput {
  total_messages: number;
  preview: string | null;
  modified?: string[];
  tool?: ToolBlockOutput;
}

/**
 * Turn summary for overview output.
 */
export interface OverviewTurnOutput {
  turn_index: number;
  user: OverviewUserOutput | null;
  assistant: OverviewAssistantOutput | null;
}

export interface OverviewOutput {
  turns: OverviewTurnOutput[];
}

export interface BrowseOutput {
  before_message_id?: string | null;
  messages: BrowseItemOutput[];
  after_message_id?: string | null;
}

export type SectionOutput =
  | { type: "text"; part_id?: string; content: string | null }
  | { type: "reasoning"; part_id?: string; content: string | null }
    | {
      type: "tool";
      part_id?: string;
      tool: string;
      status: ToolStatus;
      input?: Record<string, unknown>;
      content?: string | null;
    }
  | { type: "image"; mime: string }
  | { type: "file"; path: string; mime: string };

// =============================================================================
// Search Output Types (Phase 1: Contracts Only)
// =============================================================================

/**
 * Searchable part type.
 *
 * - "text": user or assistant text content
 * - "reasoning": assistant reasoning content
 * - "tool": tool call output content
 */
export type SearchPartType = "text" | "reasoning" | "tool";

/**
 * A single search hit within a message.
 *
 * - type: part type that matched
 * - part_id: identifier for reading full content
 * - tool_name: present only for tool hits (optional)
 * - snippets: ordered array of highest-priority text contexts around matches
 */
export interface SearchHitOutput {
  type: SearchPartType;
  part_id: string;
  tool_name?: string;
  snippets: string[];
}

/**
 * Search result grouped by message.
 *
 * - role: message role
 * - turn_index: message turn number
 * - message_id: identifier for reading full message
 * - hits: array of hits within this message
 * - remain_hits: omitted when 0; number of omitted low-priority hits
 */
export interface SearchMessageOutput {
  role: MessageRole;
  turn_index: number;
  message_id: string;
  hits: SearchHitOutput[];
  remain_hits?: number;
}

/**
 * Full search response output.
 *
 * - messages: results grouped by message (omitted when no message has hits)
 */
export type SearchNoHitsOutput = Record<string, never>;

export interface SearchHitsOutput {
  messages: SearchMessageOutput[];
}

export type SearchOutput = SearchNoHitsOutput | SearchHitsOutput;
