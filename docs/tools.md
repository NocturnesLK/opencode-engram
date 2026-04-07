# Engram Tool Interface

This document describes the tool interface and return contracts currently exposed by the plugin.

## Tool List

The following tools are always registered:

- `history_browse_turns`
- `history_browse_messages`
- `history_pull_message`
- `history_pull_part`
- `history_search`

## Target Session Rules

- All `history_*` tools require an explicit `session_id` parameter.
- These tools read the history of the session you specify, not implicitly bound to any upstream session.
- When the current session has a parent session and `upstream_history.enable=true`, the plugin injects a system prompt into the child session, guiding the agent to use the parent session ID as `session_id`.

## Shared Return Conventions

- `history_browse_turns`, `history_browse_messages`, and `history_search` return only the page/result payload on success.
- `history_pull_message` returns the message object directly.
- `history_pull_part` returns a single part's content directly.
- Message timestamps are output as ISO 8601 strings; outputs `"unknown"` when unparseable.
- Long content in `history_pull_message` output is truncated and annotated with a `part_id` for subsequent precise retrieval.
- Truncation markers in pull section content use the format `"[N chars more]"`.

## `history_browse_messages`

Inspect a chronological message window around a specific message.

### Parameters

- `session_id`: Required. Target session ID.
- `message_id`: Optional. Anchor `message_id`. Omit to use the latest visible message.
- `num_before`: Optional. Default `0`. Number of earlier visible messages to include.
- `num_after`: Optional. Default `0`. Number of later visible messages to include.

### Behavior

- Returns a single chronological window centered on `message_id`.
- Without `message_id`: returns a window anchored at the latest visible message.
- Messages are always sorted in chronological order for direct sequential reading.
- `before_message_id` is the visible message immediately before this window, or `null` if there is none.
- `after_message_id` is the visible message immediately after this window, or `null` if there is none.
- In the current session, hidden summary/compaction artifacts and post-summary messages are not returned. If `message_id` points to a hidden message in that view, the tool errors and asks the caller to retry with a nearby visible message.
- `preview` is taken from the first visible text segment in the message.
- If no visible text exists, `preview` may fall back to a bracketed semantic label for non-text messages (for example tool calls, attachments, or compaction triggers).
- `message_id` is always included; use it for a follow-up `history_pull_message` when the preview is insufficient.

User messages may additionally include:

- `attachment`: Combined attachment list containing image summary labels and file references.
  - Image summary label format: `"1 image"` or `"N images"`
  - File references keep original path strings

Assistant messages may additionally include:

- `tool`: Tool summary block `{ "calls": string[], "outcome": "completed" | "recovered" | "error" | "running" }` (omitted when no tool calls).

### Return Example

```json
{
  "before_message_id": "msg_010",
  "messages": [
    {
      "role": "user",
      "turn_index": 6,
      "message_id": "msg_011",
      "preview": "Please split the overview doc.",
      "attachment": ["1 image", "docs/engram-overview.md"]
    },
    {
      "role": "assistant",
      "turn_index": 6,
      "message_id": "msg_012",
      "preview": "I'll move the tool contract to a separate document.",
      "tool": {
        "calls": ["2× grep", "1× edit"],
        "outcome": "completed"
      }
    }
  ],
  "after_message_id": "msg_013"
}
```

## `history_browse_turns`

Returns a turn-level index of the session history.

### Parameters

- `session_id`: Required. Target session ID.
- `turn_index`: Optional. Target visible turn number. Omit to start from the latest visible turn.
- `num_before`: Optional. Default `0`. Number of visible turns before `turn_index` to include.
- `num_after`: Optional. Default `0`. Number of visible turns after `turn_index` to include.

### Behavior

- Returns `turns[]` only.
- `turns[]` is sorted in ascending turn order.
- Each turn entry contains: `turn_index`, `user`, `assistant`.
- Turn previews use the same text-first, semantic-fallback logic as browse previews. A preview may still be `null` when that role is absent from the turn or no preview signal can be derived.
- `user.message_id` is the unique user message ID for that turn.
- `user.attachment` follows the same rules as `history_browse_messages` user `attachment`, and is omitted when empty.
- `assistant.total_messages` counts only assistant messages in that turn.
- `assistant.tool` uses the same tool summary block shape as `history_browse_messages` assistant `tool`, and is omitted when no tool calls are present in the turn.
- `assistant.modified` contains unique file paths modified by completed write-type tool calls in that turn, and is omitted when no modified file paths are detected.
- For the current session, hidden compaction-only turns are omitted from the result while visible turns keep their original turn numbers.
- If `turn_index` points to a hidden turn, the tool errors and asks the caller to retry with a nearby visible turn.

### Return Example

```json
{
  "turns": [
    {
      "turn_index": 5,
      "user": {
        "preview": "Please split the overview doc.",
        "message_id": "msg_011"
      },
      "assistant": {
        "preview": "I'll verify the current implementation before splitting the doc.",
        "total_messages": 2,
        "tool": {
          "calls": ["2× grep", "1× edit"],
          "outcome": "completed"
        },
        "modified": ["docs/tools.md"]
      }
    }
  ]
}
```

## `history_pull_message`

Read a single message.

### Parameters

- `session_id`: Required. Target session ID.
- `message_id`: Required. Target message ID.

### Behavior

Returns message metadata and `sections[]`.

Example:

```json
{
  "message_id": "msg_123",
  "role": "assistant",
  "turn_index": 6,
  "time": "2026-03-20T10:01:00.000Z",
  "sections": [
    {
      "type": "text",
      "content": "I'll start by checking the config and tool contracts."
    },
    {
      "type": "tool",
      "tool": "grep",
      "status": "completed",
      "input": {
        "pattern": "history_pull_message",
        "path": "src"
      },
      "content": "Found 3 matches\n...",
      "part_id": "part_tool_01"
    },
    {
      "type": "file",
      "path": "docs/engram-overview.md",
      "mime": "text/markdown"
    }
  ]
}
```

`sections[]` supports the following types:

- `text`
- `reasoning`
- `tool`
- `image`
- `file`

Field rules:

- `text` and `reasoning` always include `content`; truncated content includes a `part_id`.
- `tool` always includes `tool` and `status`.
- `tool.input` is only present when the tool is permitted by top-level `show_tool_input`.
- `tool.content` is only present when the tool is permitted by top-level `show_tool_output` and readable output exists.
- Any truncated input or output in a `tool` section includes a `part_id`.
- `image` returns only `mime`.
- `file` returns only `path` and `mime`.

`tool.status` values:

- `pending`
- `running`
- `completed`
- `error`

## `history_pull_part`

Read the full content of a single truncated part.

### Parameters

- `session_id`: Required. Target session ID.
- `message_id`: Required. Target message ID.
- `part_id`: Required. Target part ID.

### Behavior

Returns the full content of that part.

Return shapes:

- Text part: `{ "type": "text", "content": "..." }`
- Reasoning part: `{ "type": "reasoning", "content": "..." }`
- Tool part: `{ "type": "tool", "content": "..." }`

Tool part `content` rules:

- When tool input is allowed to be displayed, content is prefixed with a function signature header, e.g. `grep(pattern="foo", path="src")`.
- When both input and output are visible, they are separated by a `---` line.
- When input is visible but output is not, only the signature header is returned.
- When output is visible but there is currently no readable output:
  - If input is visible, the signature header is still returned.
  - If input is not visible, a tool that is running or pending returns `Section '<part_id>' has no content yet (status: running|pending).`
  - Otherwise returns `Section '<part_id>' has no content.`

`image` and `file` parts do not support content retrieval; pulling by `part_id` returns a not-found error.

## `history_search`

Search session history by keyword or literal string.

### Parameters

- `session_id`: Required. Target session ID.
- `query`: Required. Search keywords, maximum length `500`. Short specific terms work best — an identifier like `computeTurns` beats a generic word like `function`.
- `literal`: Optional. Default `false`. If true, match the query as an exact case-sensitive substring. Use for file paths, identifiers, error codes.
- `type`: Optional. Default `["text"]`. One or more of `text`, `tool`, `reasoning`. Only those content types are searched and returned.

### Behavior

- `literal=false`: uses BM25 full-text search, supporting multilingual keywords.
- `literal=true`: uses case-sensitive fixed substring matching.
- Search scope is filtered by `type`.
- `text` searches user and assistant text content.
- `reasoning` searches assistant reasoning content.
- `tool` searches only the tool input/output content that is visible under top-level `show_tool_input` / `show_tool_output`.
- Tool input is searchable only when that tool is permitted by `show_tool_input`.
- Results are sorted by relevance, with message timestamp as a tiebreaker.
- Returns at most `search.message_limit` messages.
- Each message shows at most `search.max_hits_per_message` hits.
- Each hit shows at most `search.max_snippets_per_hit` snippets.
- If a message has more hits not shown, `remain_hits` is returned. Use `history_pull_part` to expand a specific hit, or `history_pull_message` to read the full message.
- The `messages` field is omitted when there are no hits.

### Return Example

```json
{
  "messages": [
    {
      "role": "assistant",
      "turn_index": 5,
      "message_id": "msg_011",
      "hits": [
        {
          "type": "tool",
          "tool_name": "grep",
          "part_id": "part_001",
          "snippets": [
            "...history_pull_part...",
            "...show_tool_output..."
          ]
        }
      ]
    }
  ]
}
```

## Common Errors

### General Parameter Errors

- `session_id is required`
- `message_id is required`
- `part_id is required`
- `num_before must be a non-negative integer`
- `num_after must be a non-negative integer`
- `turn_index must be a non-negative integer`
- `query is required`
- `query is too long. Use shorter, more specific keywords.`
- `type must contain at least one of: text, tool, reasoning`
- `type must contain only: text, tool, reasoning`

### Session and Pagination Errors

- `Session '<session_id>' not found`
- `Failed to load session '<session_id>'. This may be a temporary issue — try again.`
- `Message '<message_id>' not found in history. It may be an invalid message_id.`
- `Message '<message_id>' is hidden in this session view. Try a nearby visible message instead.`
- `Turn <turn_index> not found in history.`
- `Turn <turn_index> is hidden in this session view. Try a nearby visible turn instead.`
- `Failed to read session messages. This may be a temporary issue — try again.`

### Message Read Errors

- `Requested message not found. Please ensure the message_id is correct.`
- `Requested part not found. Please ensure the part_id is correct.`
- `Requested part has no readable text content. It may be empty or ignored.`
- `Not authorized to read this message. Please check your permissions.`
- `Invalid request (status N). Please check your parameters.`
- `Failed to read message. This may be a temporary issue — try again.`

### Tool Part Read Errors

- `Section '<part_id>' content is hidden by show_tool_output.`
- `Section '<part_id>' has no content yet (status: running|pending).`
- `Section '<part_id>' has no content.`

### Search Errors

- `Failed to query messages. Try again or use history_browse_turns to lookup instead.`
