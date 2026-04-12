# Engram Configuration

This document describes the current configuration structure and behavior corresponding to the implementation in this repository.

## Config File Locations

Engram loads `opencode-engram.json` or `opencode-engram.jsonc` from the following locations in order:

1. The local global config directory: `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`
2. On Windows, additionally checks: `%APPDATA%/opencode`, `%LOCALAPPDATA%/opencode`
3. The current project root directory

Later-loaded configs override earlier results, so the project root config has the highest priority.

## File Format

- Both `json` and `jsonc` are supported.
- `jsonc` supports comments and trailing commas.
- UTF-8 BOM, UTF-16 LE BOM, and UTF-16 BE BOM are all accepted.
- The config root must be a JSON object.

## Full Configuration Structure

```jsonc
{
  "debug_mode": {
    "enable": false,
    "log_tool_calls": true
  },
  "upstream_history": {
    "enable": true,
    "disable_for_agents": []
  },
  "context_charting": {
    "enable": true,
    "recent_turns": 10,
    "recent_messages": 5
  },
  // Controls preview length for turn-level browsing
  "browse_turns": {
    "user_preview_length": 280,
    "assistant_preview_length": 140
  },
  // Controls preview lengths for message-level browsing.
  // message_limit is currently reserved for compatibility.
  "browse_messages": {
    "message_limit": 100,
    "user_preview_length": 280,
    "assistant_preview_length": 140
  },
  "pull_message": {
    "text_length": 400,
    "reasoning_length": 200,
    "tool_output_length": 400,
    "tool_input_length": 140
  },
  "search": {
    "max_hits_per_message": 5,
    "max_snippets_per_hit": 5,
    "snippet_length": 140,
    "message_limit": 5
  },
  // Selector strings like "*", "!bash", or "session_*" control which tool
  // inputs/outputs appear in pull_message results and search hits.
  "show_tool_input": [],
  "show_tool_output": []
}
```

## Field Reference

### `debug_mode`

- `enable`: Default `false`. Master switch for debug features.
- `log_tool_calls`: Default `true`. Only takes effect when `enable=true`. Logs tool call inputs and outputs.

When `debug_mode.enable=true` and `debug_mode.log_tool_calls=true`:

- Call logs are written to `.engram/log_tool_calls/{session_id}`.
- File names follow the pattern `YYMMDD_HHMMSSmmm-{tool}-{uuid8}.json`.
- Each log additionally contains `estimated_tokens` and `duration_ms`.
- The plugin ensures `.engram/.gitignore` contains at least the following two lines:

```text
log_tool_calls
.gitignore
```

### `upstream_history`

- `enable`: Default `true`.
- `disable_for_agents`: Default `[]`. Agent names for which upstream prompt injection is disabled.

This switch controls upstream navigation prompt injection in child sessions: when the current session has a parent session, the plugin injects a system prompt guiding the agent to use `history_*` tools to access the parent session's history.

### `context_charting`

- `enable`: Default `true`.
- `recent_turns`: Default `10`. Controls the `num_before` value used in the chart block's embedded `history_browse_turns` example call.
- `recent_messages`: Default `5`. Controls the `num_before` value used in the chart block's embedded `history_browse_messages` example call.

When enabled, the plugin first replaces OpenCode's default compaction prompt with a minimal instruction so the compaction model returns a very short fallback summary text, then intercepts that text and substitutes a structured chart block containing:

- Lossy-index framing that explains the prior conversation was compacted and only structure plus truncated previews remain
- A `history_browse_turns` walkthrough showing the recent turn overview JSON window used for orientation
- A `history_browse_messages` walkthrough showing the latest turn's surrounding message window JSON
- Retrieval guidance for paging with `before_message_id` / `after_message_id`, and for escalating to `history_pull_message` or `history_search` when previews are insufficient

This does not fully skip the compaction model call — OpenCode does not currently expose a skip API — but it minimizes the compaction generation cost before replacing the emitted text. If replacement fails, the short generated fallback summary remains instead of an empty placeholder.

### `browse_turns`

- `user_preview_length`: Default `280`. Truncation length for `user_preview` in `history_browse_turns`.
- `assistant_preview_length`: Default `140`. Truncation length for `assistant_preview` in `history_browse_turns`.

### `browse_messages`

- `message_limit`: Default `100`. Reserved compatibility field; currently not used to cap `history_browse_messages` windows.
- `user_preview_length`: Default `280`. Truncation length for user message previews.
- `assistant_preview_length`: Default `140`. Truncation length for assistant message previews.

### `pull_message`

- `text_length`: Default `400`. Message-level truncation length for text sections.
- `reasoning_length`: Default `200`. Message-level truncation length for reasoning sections.
- `tool_output_length`: Default `400`. Message-level truncation length for tool output sections.
- `tool_input_length`: Default `140`. Truncation length applied to string fields when displaying tool input.

### `search`

- `max_hits_per_message`: Default `5`. Maximum number of hit entries shown per message.
- `max_snippets_per_hit`: Default `5`. Maximum number of snippet fragments shown per hit entry.
- `snippet_length`: Default `140`. Maximum length of a single snippet fragment.
- `message_limit`: Default `5`. Maximum number of messages returned by `history_search`.

### `show_tool_input`

- Default `[]`. Controls which tools' inputs are displayed in pull_message results and searchable in `history_search` tool hits/snippets.

### `show_tool_output`

- Default `[]`. Controls which tools' outputs are displayed in pull_message results and searchable in `history_search` tool hits/snippets.

When a config layer explicitly sets either field, Engram re-merges that field's selectors with the corresponding built-in allowlist for that layer.

Built-in allowlist for `show_tool_input`:

- `bash`
- `grep`
- `glob`
- `task`
- `websearch`
- `webfetch`
- `question`
- `skill`

Built-in allowlist for `show_tool_output`:

- `question`
- `bash`
- `task`
- `apply_patch`
- `grep`
- `todowrite`
- `edit`
- `glob`

## Tool Visibility Selector Rules

`show_tool_input` and `show_tool_output` share the same selector syntax:

- Exact tool name, e.g. `"grep"`.
- Wildcard `*`, e.g. `"session_*"`, `"*_pull"`, `"*"`.
- Prefix `!` to exclude, e.g. `"!bash"`.
- `"!"` or `"!*"` alone disables all entries.
- Exclusion rules take priority over inclusion rules, e.g. `["*", "!bash"]` allows all tools except `bash`.
- When a config layer explicitly sets this field, its external selectors replace the previous layer's result and are re-merged with the built-in allowlist.
- To disable even the built-in allowlist, use `["!"]`.

Example:

```jsonc
{
  "show_tool_input": ["*", "!bash"],
  "show_tool_output": ["!"]
}
```

This configuration means:

- Input: show all tool inputs except `bash`.
- Output: show no tool output, including entries in the built-in allowlist.

## Validation and Fallback Behavior

- All fields have default values.
- Unset fields use their defaults.
- Unrecognized keys are ignored and logged as a config warning.
- Invalid values fall back to the current effective value or the default.
- Config read or parse failures do not block tool execution.
- Boolean switches such as `debug_mode.enable`, `upstream_history.enable`, and `context_charting.enable` must be booleans.
- `upstream_history.disable_for_agents` must be an array of strings.

Numeric field requirements:

- `message_limit`, `max_hits_per_message`, `max_snippets_per_hit` must be positive integers.
- `context_charting.recent_turns` and `context_charting.recent_messages` must be non-negative integers.
- All length fields must be integers between `1` and `10000`.
- Selector arrays must contain only non-empty strings.

## Recommended Minimal Config

If you only want the default behavior, no extra fields are required. The most common minimal config is:

```jsonc
{
  "upstream_history": {
    "enable": true
  }
}
```
