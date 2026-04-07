import { afterEach, describe, expect, test, vi } from "vitest";

import { Buffer } from "node:buffer";

vi.mock("node:fs/promises", () => {
  return {
    readFile: vi.fn(),
  };
});

import { readFile } from "node:fs/promises";
import {
  loadEngramConfig,
  resolveVisibleToolNames,
} from "./config.ts";

const defaultShowToolInput = [
  "bash",
  "grep",
  "glob",
  "task",
  "websearch",
  "webfetch",
  "question",
  "skill",
];

type ReadFileMock = typeof readFile & { mockImplementation: (fn: unknown) => void };

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function setReadFileMap(map: Map<string, Buffer>) {
  (readFile as unknown as ReadFileMock).mockImplementation(async (filePath: string) => {
    const hit = map.get(filePath);
    if (!hit) {
      throw enoent(filePath);
    }
    return hit;
  });
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("config/loadEngramConfig", () => {
  test("returns defaults when no config files exist", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    setReadFileMap(new Map());

    const issues: string[] = [];
    const cfg = await loadEngramConfig("/project", (m) => issues.push(m));

    expect(issues).toEqual([]);
    expect(cfg.upstream_history.enable).toBe(true);
    expect(cfg.upstream_history.disable_for_agents).toEqual([]);
    expect(cfg.context_charting.enable).toBe(true);
    expect(cfg.context_charting.recent_turns).toBe(10);
    expect(cfg.context_charting.recent_messages).toBe(5);
    expect(cfg.debug_mode.enable).toBe(false);
    expect(cfg.browse_messages.message_limit).toBe(100);
  });

  test("project config overrides global config", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";

    const globalPath = "/xdg/opencode/opencode-engram.jsonc";
    const projectPath = "/project/opencode-engram.jsonc";

    const map = new Map<string, Buffer>([
      [
        globalPath,
        Buffer.from(
      JSON.stringify({
          upstream_history: { enable: false },
        }),
        "utf8",
      ),
      ],
      [
        projectPath,
        Buffer.from(
          JSON.stringify({
            upstream_history: {
              enable: true,
              disable_for_agents: ["helper", "reviewer"],
            },
            context_charting: {
              enable: true,
              recent_turns: 7,
              recent_messages: 0,
            },
            browse_messages: { message_limit: 3 },
          }),
          "utf8",
        ),
      ],
    ]);
    setReadFileMap(map);

    const issues: string[] = [];
    const cfg = await loadEngramConfig("/project", (m) => issues.push(m));
    expect(cfg.upstream_history.enable).toBe(true);
    expect(cfg.upstream_history.disable_for_agents).toEqual(["helper", "reviewer"]);
    expect(cfg.context_charting.enable).toBe(true);
    expect(cfg.context_charting.recent_turns).toBe(7);
    expect(cfg.context_charting.recent_messages).toBe(0);
    expect(cfg.browse_messages.message_limit).toBe(3);
    expect(issues).toEqual([]);
  });

  test("parses JSONC comments and trailing commas, preserving strings", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";

    const text = `{
      // comment
      "show_tool_input": [
        "http://example.com/a//b", /* not a comment */
      ]
    }`;

    setReadFileMap(
      new Map([
        [projectPath, Buffer.from(text, "utf8")],
      ]),
    );

    const cfg = await loadEngramConfig("/project");
    expect(cfg.show_tool_input).toContain("http://example.com/a//b");
  });

  test("reports unsupported keys and falls back on invalid values", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";

    const text = JSON.stringify({
      unknown_top_level: true,
      debug_mode: { enable: "yes" },
      upstream_history: { enable: true },
      context_charting: {
        enable: "yes",
        recent_turns: -1,
        recent_messages: 1.5,
        unsupported_key: true,
      },
      browse_messages: { message_limit: 0, unknown_key: 1 },
      search: { snippet_length: 20000 },
      show_tool_input: ["bash", 1],
    });

    setReadFileMap(new Map([[projectPath, Buffer.from(text, "utf8")]]));

    const issues: string[] = [];
    const cfg = await loadEngramConfig("/project", (m) => issues.push(m));

    // Invalid boolean falls back to default.
    expect(cfg.debug_mode.enable).toBe(false);
    expect(cfg.context_charting.enable).toBe(true);
    expect(cfg.context_charting.recent_turns).toBe(10);
    expect(cfg.context_charting.recent_messages).toBe(5);
    // Invalid positive int falls back to default.
    expect(cfg.browse_messages.message_limit).toBe(100);
    // Invalid preview length falls back to default.
    expect(cfg.search.snippet_length).toBe(140);
    // Invalid string array falls back to default (builtins).
    expect(cfg.show_tool_input).toEqual(defaultShowToolInput);

    expect(issues.join("\n")).toContain("'unknown_top_level' is not supported");
    expect(issues.join("\n")).toContain("debug_mode.enable must be a boolean");
    expect(issues.join("\n")).toContain("context_charting.enable must be a boolean");
    expect(issues.join("\n")).toContain("context_charting.recent_turns must be a non-negative integer");
    expect(issues.join("\n")).toContain("context_charting.recent_messages must be a non-negative integer");
    expect(issues.join("\n")).toContain("context_charting.unsupported_key is not supported");
    expect(issues.join("\n")).toContain("browse_messages.message_limit must be a positive integer");
    expect(issues.join("\n")).toContain("search.snippet_length must not exceed 10000");
    expect(issues.join("\n")).toContain("browse_messages.unknown_key is not supported");
    expect(issues.join("\n")).toContain("show_tool_input[1] must be a string");
  });

  test("treats pull_message.show_tool_input/output as unsupported keys", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";

    const text = JSON.stringify({
      pull_message: {
        show_tool_input: ["*"],
        show_tool_output: ["*"],
      },
    });

    setReadFileMap(new Map([[projectPath, Buffer.from(text, "utf8")]]));

    const issues: string[] = [];
    const cfg = await loadEngramConfig("/project", (m) => issues.push(m));

    expect(cfg.show_tool_input).toEqual(defaultShowToolInput);
    expect(issues.join("\n")).toContain("pull_message.show_tool_input is not supported");
    expect(issues.join("\n")).toContain("pull_message.show_tool_output is not supported");
  });

  test("accepts upstream_history.disable_for_agents without trimming or deduplication", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";

    const text = JSON.stringify({
      upstream_history: {
        disable_for_agents: [" agent-a ", "agent-a", "", "reviewer"],
      },
    });

    setReadFileMap(new Map([[projectPath, Buffer.from(text, "utf8")]]));

    const cfg = await loadEngramConfig("/project");
    expect(cfg.upstream_history.disable_for_agents).toEqual([" agent-a ", "agent-a", "", "reviewer"]);
  });

  test("invalid JSON reports an issue and returns defaults", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";
    setReadFileMap(new Map([[projectPath, Buffer.from("{not json}", "utf8")]]));

    const issues: string[] = [];
    const cfg = await loadEngramConfig("/project", (m) => issues.push(m));

    expect(cfg.upstream_history.enable).toBe(true);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("Failed to read engram config");
    expect(issues[0]).toContain(projectPath);
  });

  test("decodes UTF-8 BOM", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";
    const body = Buffer.from(JSON.stringify({ debug_mode: { enable: true } }), "utf8");
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    setReadFileMap(new Map([[projectPath, bytes]]));

    const cfg = await loadEngramConfig("/project");
    expect(cfg.debug_mode.enable).toBe(true);
  });

  test("decodes UTF-16LE BOM", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";
    const text = JSON.stringify({ upstream_history: { enable: false } });
    const body = Buffer.from(text, "utf16le");
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
    setReadFileMap(new Map([[projectPath, bytes]]));

    const cfg = await loadEngramConfig("/project");
    expect(cfg.upstream_history.enable).toBe(false);
  });

  test("decodes UTF-16BE BOM", async () => {
    process.env.XDG_CONFIG_HOME = "/xdg";
    const projectPath = "/project/opencode-engram.jsonc";
    const text = JSON.stringify({ upstream_history: { enable: false } });
    const le = Buffer.from(text, "utf16le");
    const be = Buffer.from(le);
    for (let i = 0; i < be.length - 1; i += 2) {
      const a = be[i];
      be[i] = be[i + 1];
      be[i + 1] = a;
    }
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    setReadFileMap(new Map([[projectPath, bytes]]));

    const cfg = await loadEngramConfig("/project");
    expect(cfg.upstream_history.enable).toBe(false);
  });
});

describe("config/resolveVisibleToolNames", () => {
  test("'*' allows all", () => {
    expect(resolveVisibleToolNames(["bash", "grep"], ["*"])).toEqual(["bash", "grep"]);
  });

  test("'!' denies all", () => {
    expect(resolveVisibleToolNames(["bash", "grep"], ["!"])).toEqual([]);
    expect(resolveVisibleToolNames(["bash", "grep"], ["!*"])).toEqual([]);
  });

  test("allow + deny patterns", () => {
    expect(resolveVisibleToolNames(["bash", "grep"], ["*", "!bash"])).toEqual(["grep"]);
  });

  test("glob matching", () => {
    expect(resolveVisibleToolNames(["rip_grep", "bash"], ["*_grep"])).toEqual(["rip_grep"]);
  });
});
