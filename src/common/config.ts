import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DebugModeConfig = {
  enable?: boolean;
  log_tool_calls?: boolean;
};

export type BrowseConfig = {
  message_limit?: number;
  user_preview_length?: number;
  assistant_preview_length?: number;
};

export type OverviewConfig = {
  user_preview_length?: number;
  assistant_preview_length?: number;
};

export type SearchConfig = {
  max_hits_per_message?: number;
  max_snippets_per_hit?: number;
  snippet_length?: number;
  message_limit?: number;
};

export type PullConfig = {
  text_length?: number;
  reasoning_length?: number;
  tool_output_length?: number;
  tool_input_length?: number;
};

export type UpstreamHistoryConfig = {
  enable?: boolean;
  disable_for_agents?: string[];
};

export type ChartingConfig = {
  enable?: boolean;
  recent_turns?: number;
  recent_messages?: number;
};

type RawDebugModeConfig = DebugModeConfig | undefined;
type RawUpstreamHistoryConfig = UpstreamHistoryConfig | undefined;
type RawChartingConfig = ChartingConfig | undefined;
type RawBrowseConfig = BrowseConfig | undefined;
type RawOverviewConfig = OverviewConfig | undefined;
type RawSearchConfig = SearchConfig | undefined;
type RawPullConfig = PullConfig | undefined;

type RawConfig = {
  debug_mode?: RawDebugModeConfig;
  upstream_history?: RawUpstreamHistoryConfig;
  context_charting?: RawChartingConfig;
  browse_turns?: RawOverviewConfig;
  browse_messages?: RawBrowseConfig;
  search?: RawSearchConfig;
  pull_message?: RawPullConfig;
  show_tool_input?: string[];
  show_tool_output?: string[];
};

type ConfigIssueReporter = (message: string) => void;

export type ResolvedDebugModeConfig = {
  enable: boolean;
  log_tool_calls: boolean;
};

export type ResolvedBrowseConfig = {
  message_limit: number;
  user_preview_length: number;
  assistant_preview_length: number;
};

export type ResolvedOverviewConfig = {
  user_preview_length: number;
  assistant_preview_length: number;
};

export type ResolvedSearchConfig = {
  max_hits_per_message: number;
  max_snippets_per_hit: number;
  snippet_length: number;
  message_limit: number;
};

export type ResolvedPullConfig = {
  text_length: number;
  reasoning_length: number;
  tool_output_length: number;
  tool_input_length: number;
};

export type ResolvedUpstreamHistoryConfig = {
  enable: boolean;
  disable_for_agents: string[];
};

export type ResolvedChartingConfig = {
  enable: boolean;
  recent_turns: number;
  recent_messages: number;
};

export type EngramConfig = {
  debug_mode: ResolvedDebugModeConfig;
  upstream_history: ResolvedUpstreamHistoryConfig;
  context_charting: ResolvedChartingConfig;
  browse_turns: ResolvedOverviewConfig;
  browse_messages: ResolvedBrowseConfig;
  pull_message: ResolvedPullConfig;
  search: ResolvedSearchConfig;
  show_tool_input: string[];
  show_tool_output: string[];
};

const configNames = ["opencode-engram.json", "opencode-engram.jsonc"];
const SHOW_TOOL_INPUT_BUILTINS = [
  "bash",
  "grep",
  "glob",
  "task",
  "websearch",
  "webfetch",
  "question",
  "skill",
] as const;
const SHOW_TOOL_OUTPUT_BUILTINS = [
  "question",
  "bash",
  "task",
  "apply_patch",
  "grep",
  "todowrite",
  "edit",
  "glob",
] as const;
const noopConfigIssueReporter: ConfigIssueReporter = () => undefined;

const supportedTopLevelKeys = [
  "debug_mode",
  "upstream_history",
  "context_charting",
  "browse_turns",
  "browse_messages",
  "pull_message",
  "search",
  "show_tool_input",
  "show_tool_output",
];
const supportedDebugModeKeys = ["enable", "log_tool_calls"];
const supportedUpstreamHistoryKeys = ["enable", "disable_for_agents"];
const supportedChartingKeys = ["enable", "recent_turns", "recent_messages"];
const supportedBrowseKeys = ["message_limit", "user_preview_length", "assistant_preview_length"];
const supportedOverviewKeys = ["user_preview_length", "assistant_preview_length"];
const supportedSearchKeys = ["max_hits_per_message", "max_snippets_per_hit", "snippet_length", "message_limit"];
const supportedPullKeys = [
  "text_length",
  "reasoning_length",
  "tool_output_length",
  "tool_input_length",
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveWithFallback<T>(
  fallback: T,
  report: ConfigIssueReporter,
  resolve: () => T,
) {
  try {
    return resolve();
  } catch (error) {
    report(errorMessage(error));
    return fallback;
  }
}

function toConfigObject(
  value: unknown,
  label: string,
  report: ConfigIssueReporter,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report(`${label} must be a config object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function reportUnsupportedKeys(
  value: Record<string, unknown>,
  label: string,
  supportedKeys: readonly string[],
  report: ConfigIssueReporter,
) {
  for (const key of Object.keys(value)) {
    if (!supportedKeys.includes(key)) {
      report(`${label}.${key} is not supported`);
    }
  }
}

function reportUnsupportedTopLevelKeys(
  patch: RawConfig,
  source: string,
  report: ConfigIssueReporter,
) {
  for (const key of Object.keys(patch)) {
    if (!supportedTopLevelKeys.includes(key)) {
      report(`${source}: '${key}' is not supported`);
    }
  }
}

function decodeConfigText(bytes: Uint8Array) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return Buffer.from(bytes.subarray(3)).toString("utf8");
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2)).toString("utf16le");
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    const length = body.length - (body.length % 2);
    const swapped = Buffer.alloc(length);

    for (let i = 0; i < length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }

    return swapped.toString("utf16le");
  }

  return Buffer.from(bytes).toString("utf8");
}

function localGlobalConfigRoots() {
  const roots = [join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode")];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;

    if (appData) roots.push(join(appData, "opencode"));
    if (localAppData && localAppData !== appData) {
      roots.push(join(localAppData, "opencode"));
    }
  }

  return roots;
}

function globalConfigRoots() {
  return [...new Set(localGlobalConfigRoots())];
}

function defaultDebugModeConfig(): ResolvedDebugModeConfig {
  return {
    enable: false,
    log_tool_calls: true,
  };
}

function defaultShowToolInputTools(): string[] {
  return [...SHOW_TOOL_INPUT_BUILTINS];
}

function defaultShowToolOutputTools(): string[] {
  return [...SHOW_TOOL_OUTPUT_BUILTINS];
}

function defaults(): EngramConfig {
  return {
    debug_mode: defaultDebugModeConfig(),
    upstream_history: {
      enable: true,
      disable_for_agents: [],
    },
    context_charting: {
      enable: true,
      recent_turns: 10,
      recent_messages: 5,
    },
    browse_turns: {
      user_preview_length: 280,
      assistant_preview_length: 140,
    },
    browse_messages: {
      message_limit: 100,
      user_preview_length: 280,
      assistant_preview_length: 140,
    },
    pull_message: {
      text_length: 400,
      reasoning_length: 200,
      tool_output_length: 400,
      tool_input_length: 140,
    },
    search: {
      max_hits_per_message: 5,
      max_snippets_per_hit: 5,
      snippet_length: 140,
      message_limit: 5,
    },
    show_tool_input: defaultShowToolInputTools(),
    show_tool_output: defaultShowToolOutputTools(),
  };
}

function stripJsonComments(input: string) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      if (i < input.length) out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length - 1) {
        if (input[i] === "*" && input[i + 1] === "/") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += char;
  }

  return out;
}

function stripTrailingCommas(input: string) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (input[j] === "}" || input[j] === "]") continue;
    }

    out += char;
  }

  return out;
}

function parseJsonc(text: string, filePath: string) {
  const normalized = stripTrailingCommas(stripJsonComments(text));
  try {
    return JSON.parse(normalized) as RawConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid engram config at ${filePath}: ${message}`);
  }
}

function validateBoolean(value: unknown, label: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function validatePositiveInt(value: unknown, label: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function validateNonNegativeInt(value: unknown, label: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function validatePreviewLength(value: unknown, label: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (value > 10000) {
    throw new Error(`${label} must not exceed 10000`);
  }
  return value;
}

function validateStringArray(value: unknown, label: string, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string") {
      throw new Error(`${label}[${i}] must be a string`);
    }
    const normalized = item.trim();
    if (!normalized) {
      throw new Error(`${label}[${i}] must not be empty`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      resolved.push(normalized);
    }
  }

  return resolved;
}

function validateAgentNameArray(value: unknown, label: string, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  const resolved: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string") {
      throw new Error(`${label}[${i}] must be a string`);
    }
    resolved.push(item);
  }

  return resolved;
}

function validateOptionalPathString(value: unknown, label: string, fallback: string) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value.trim();
}

function selectorPatternToRegex(pattern: string) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesToolSelector(toolName: string, selector: string) {
  if (selector === "*") {
    return true;
  }
  return selectorPatternToRegex(selector).test(toolName);
}

function mergeToolVisibilitySelectors(
  builtins: readonly string[],
  selectors: readonly string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawSelector of [...builtins, ...selectors]) {
    if (rawSelector === "!" || rawSelector === "!*") {
      return ["!"];
    }

    const denied = rawSelector.startsWith("!");
    const selector = denied ? rawSelector.slice(1) : rawSelector;

    if (!selector) {
      throw new Error("tool selector '!' must be used by itself");
    }

    if (!seen.has(rawSelector)) {
      seen.add(rawSelector);
      merged.push(rawSelector);
    }
  }

  return merged;
}

export function resolveVisibleToolNames(
  toolNames: Iterable<string>,
  selectors: readonly string[],
): string[] {
  if (selectors.includes("!") || selectors.includes("!*")) {
    return [];
  }

  let allowAll = false;
  const allowPatterns: string[] = [];
  const denyPatterns: string[] = [];

  for (const rawSelector of selectors) {
    const denied = rawSelector.startsWith("!");
    const selector = denied ? rawSelector.slice(1) : rawSelector;

    if (!selector) {
      throw new Error("tool selector '!' must be used by itself");
    }

    if (selector === "*") {
      if (denied) {
        return [];
      }
      allowAll = true;
      continue;
    }

    if (denied) {
      denyPatterns.push(selector);
      continue;
    }

    allowPatterns.push(selector);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const toolName of toolNames) {
    if (seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);

    const allowed = allowAll || allowPatterns.some((pattern) => matchesToolSelector(toolName, pattern));
    if (!allowed) {
      continue;
    }
    if (denyPatterns.some((pattern) => matchesToolSelector(toolName, pattern))) {
      continue;
    }
    resolved.push(toolName);
  }

  return resolved;
}

function mergeConfig(
  base: EngramConfig,
  rawPatch: unknown,
  source: string,
  report: ConfigIssueReporter,
) {
  if (typeof rawPatch !== "object" || rawPatch === null || Array.isArray(rawPatch)) {
    report(`${source}: root config must be an object`);
    return base;
  }

  const patch = rawPatch as RawConfig;
  reportUnsupportedTopLevelKeys(patch, source, report);

  const debugMode = toConfigObject(patch.debug_mode, `${source}: debug_mode`, report);
  if (debugMode) {
    reportUnsupportedKeys(debugMode, `${source}: debug_mode`, supportedDebugModeKeys, report);
  }

  const upstreamHistory = toConfigObject(
    patch.upstream_history,
    `${source}: upstream_history`,
    report,
  );
  if (upstreamHistory) {
    reportUnsupportedKeys(
      upstreamHistory,
      `${source}: upstream_history`,
      supportedUpstreamHistoryKeys,
      report,
    );
  }

  const browseTurns = toConfigObject(patch.browse_turns, `${source}: browse_turns`, report);
  if (browseTurns) {
    reportUnsupportedKeys(browseTurns, `${source}: browse_turns`, supportedOverviewKeys, report);
  }

  const browseMessages = toConfigObject(
    patch.browse_messages,
    `${source}: browse_messages`,
    report,
  );
  if (browseMessages) {
    reportUnsupportedKeys(
      browseMessages,
      `${source}: browse_messages`,
      supportedBrowseKeys,
      report,
    );
  }

  const contextCharting = toConfigObject(
    patch.context_charting,
    `${source}: context_charting`,
    report,
  );
  if (contextCharting) {
    reportUnsupportedKeys(
      contextCharting,
      `${source}: context_charting`,
      supportedChartingKeys,
      report,
    );
  }

  const search = toConfigObject(patch.search, `${source}: search`, report);
  if (search) {
    reportUnsupportedKeys(search, `${source}: search`, supportedSearchKeys, report);
  }

  const pullMessage = toConfigObject(patch.pull_message, `${source}: pull_message`, report);
  if (pullMessage) {
    reportUnsupportedKeys(pullMessage, `${source}: pull_message`, supportedPullKeys, report);
  }

  const hasShowToolInput = Object.hasOwn(patch, "show_tool_input");
  const hasShowToolOutput = Object.hasOwn(patch, "show_tool_output");

  return {
    debug_mode: {
      enable: resolveWithFallback(base.debug_mode.enable, report, () =>
        validateBoolean(
          debugMode?.enable,
          `${source}: debug_mode.enable`,
          base.debug_mode.enable,
        )
      ),
      log_tool_calls: resolveWithFallback(base.debug_mode.log_tool_calls, report, () =>
        validateBoolean(
          debugMode?.log_tool_calls,
          `${source}: debug_mode.log_tool_calls`,
          base.debug_mode.log_tool_calls,
        )
      ),
    },
    upstream_history: {
      enable: resolveWithFallback(base.upstream_history.enable, report, () =>
        validateBoolean(
          upstreamHistory?.enable,
          `${source}: upstream_history.enable`,
          base.upstream_history.enable,
        )
      ),
      disable_for_agents: resolveWithFallback(base.upstream_history.disable_for_agents, report, () =>
        validateAgentNameArray(
          upstreamHistory?.disable_for_agents,
          `${source}: upstream_history.disable_for_agents`,
          base.upstream_history.disable_for_agents,
        )
      ),
    },
    context_charting: {
      enable: resolveWithFallback(base.context_charting.enable, report, () =>
        validateBoolean(
          contextCharting?.enable,
          `${source}: context_charting.enable`,
          base.context_charting.enable,
        )
      ),
      recent_turns: resolveWithFallback(base.context_charting.recent_turns, report, () =>
        validateNonNegativeInt(
          contextCharting?.recent_turns,
          `${source}: context_charting.recent_turns`,
          base.context_charting.recent_turns,
        )
      ),
      recent_messages: resolveWithFallback(base.context_charting.recent_messages, report, () =>
        validateNonNegativeInt(
          contextCharting?.recent_messages,
          `${source}: context_charting.recent_messages`,
          base.context_charting.recent_messages,
        )
      ),
    },
    browse_turns: {
      user_preview_length: resolveWithFallback(
        base.browse_turns.user_preview_length,
        report,
        () =>
          validatePreviewLength(
            browseTurns?.user_preview_length,
            `${source}: browse_turns.user_preview_length`,
            base.browse_turns.user_preview_length,
          ),
      ),
      assistant_preview_length: resolveWithFallback(
        base.browse_turns.assistant_preview_length,
        report,
        () =>
          validatePreviewLength(
            browseTurns?.assistant_preview_length,
            `${source}: browse_turns.assistant_preview_length`,
            base.browse_turns.assistant_preview_length,
          ),
      ),
    },
    browse_messages: {
      message_limit: resolveWithFallback(base.browse_messages.message_limit, report, () =>
        validatePositiveInt(
          browseMessages?.message_limit,
          `${source}: browse_messages.message_limit`,
          base.browse_messages.message_limit,
        )
      ),
      user_preview_length: resolveWithFallback(
        base.browse_messages.user_preview_length,
        report,
        () =>
          validatePreviewLength(
            browseMessages?.user_preview_length,
            `${source}: browse_messages.user_preview_length`,
            base.browse_messages.user_preview_length,
          ),
      ),
      assistant_preview_length: resolveWithFallback(
        base.browse_messages.assistant_preview_length,
        report,
        () =>
          validatePreviewLength(
            browseMessages?.assistant_preview_length,
            `${source}: browse_messages.assistant_preview_length`,
            base.browse_messages.assistant_preview_length,
          ),
      ),
    },
    pull_message: {
      text_length: resolveWithFallback(base.pull_message.text_length, report, () =>
        validatePreviewLength(
          pullMessage?.text_length,
          `${source}: pull_message.text_length`,
          base.pull_message.text_length,
        )
      ),
      reasoning_length: resolveWithFallback(base.pull_message.reasoning_length, report, () =>
        validatePreviewLength(
          pullMessage?.reasoning_length,
          `${source}: pull_message.reasoning_length`,
          base.pull_message.reasoning_length,
        )
      ),
      tool_output_length: resolveWithFallback(base.pull_message.tool_output_length, report, () =>
        validatePreviewLength(
          pullMessage?.tool_output_length,
          `${source}: pull_message.tool_output_length`,
          base.pull_message.tool_output_length,
        )
      ),
      tool_input_length: resolveWithFallback(base.pull_message.tool_input_length, report, () =>
        validatePreviewLength(
          pullMessage?.tool_input_length,
          `${source}: pull_message.tool_input_length`,
          base.pull_message.tool_input_length,
        )
      ),
    },
    search: {
      max_hits_per_message: resolveWithFallback(base.search.max_hits_per_message, report, () =>
        validatePositiveInt(
          search?.max_hits_per_message,
          `${source}: search.max_hits_per_message`,
          base.search.max_hits_per_message,
        )
      ),
      max_snippets_per_hit: resolveWithFallback(base.search.max_snippets_per_hit, report, () =>
        validatePositiveInt(
          search?.max_snippets_per_hit,
          `${source}: search.max_snippets_per_hit`,
          base.search.max_snippets_per_hit,
        )
      ),
      snippet_length: resolveWithFallback(base.search.snippet_length, report, () =>
        validatePreviewLength(
          search?.snippet_length,
          `${source}: search.snippet_length`,
          base.search.snippet_length,
        )
      ),
      message_limit: resolveWithFallback(base.search.message_limit, report, () =>
        validatePositiveInt(
          search?.message_limit,
          `${source}: search.message_limit`,
          base.search.message_limit,
        )
      ),
    },
    show_tool_input: hasShowToolInput
      ? resolveWithFallback(base.show_tool_input, report, () =>
        mergeToolVisibilitySelectors(
          SHOW_TOOL_INPUT_BUILTINS,
          validateStringArray(
            patch.show_tool_input,
            `${source}: show_tool_input`,
            [],
          ),
        )
      )
      : base.show_tool_input,
    show_tool_output: hasShowToolOutput
      ? resolveWithFallback(base.show_tool_output, report, () =>
        mergeToolVisibilitySelectors(
          SHOW_TOOL_OUTPUT_BUILTINS,
          validateStringArray(
            patch.show_tool_output,
            `${source}: show_tool_output`,
            [],
          ),
        )
      )
      : base.show_tool_output,
  } satisfies EngramConfig;
}

async function readConfigFile(filePath: string) {
  try {
    const text = decodeConfigText(await readFile(filePath));
    return parseJsonc(text, filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }

    if (error instanceof Error) {
      throw new Error(`Failed to read engram config at ${filePath}: ${error.message}`);
    }

    throw new Error(`Failed to read engram config at ${filePath}: ${String(error)}`);
  }
}

export async function loadEngramConfig(
  projectRoot = process.cwd(),
  reportIssue: ConfigIssueReporter = noopConfigIssueReporter,
) {
  let resolved = defaults();
  const roots = [...globalConfigRoots(), projectRoot];

  for (const root of roots) {
    for (const name of configNames) {
      const filePath = join(root, name);
      try {
        const patch = await readConfigFile(filePath);
        if (!patch) continue;
        resolved = mergeConfig(resolved, patch, filePath, reportIssue);
      } catch (error) {
        reportIssue(errorMessage(error));
      }
    }
  }

  return resolved;
}
