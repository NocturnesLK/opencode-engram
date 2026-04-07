import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "12345678-1234-1234-1234-123456789abc"),
}));

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
}));

import {
  debugFileName,
  ensureDebugGitIgnore,
  estimateCallDurationMs,
  estimateSerializedTokens,
  formatDebugTimestamp,
  getToolCallLogDirectory,
  getLoggedResponsePayload,
  isDebugDirectoryNeeded,
  isToolCallLoggingEnabled,
  recordToolCall,
} from "./debug.ts";
import type { ResolvedDebugModeConfig } from "../common/config.ts";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

const baseDebug: ResolvedDebugModeConfig = {
  enable: true,
  log_tool_calls: true,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("debug flags", () => {
  test("enable=false disables regardless of log_tool_calls", () => {
    expect(isToolCallLoggingEnabled({ ...baseDebug, enable: false })).toBe(false);
    expect(isDebugDirectoryNeeded({ ...baseDebug, enable: false })).toBe(false);
  });

  test("enable=true follows log_tool_calls", () => {
    expect(isToolCallLoggingEnabled({ ...baseDebug, log_tool_calls: true })).toBe(true);
    expect(isToolCallLoggingEnabled({ ...baseDebug, log_tool_calls: false })).toBe(false);
  });
});

describe("debug estimators", () => {
  test("estimateSerializedTokens matches serialized size heuristic", () => {
    expect(estimateSerializedTokens(null)).toBe(2);
    expect(estimateSerializedTokens({ ok: true })).toBe(6);
  });

  test("estimateCallDurationMs rounds elapsed milliseconds and clamps negatives", () => {
    const nowSpy = vi.spyOn(performance, "now")
      .mockReturnValueOnce(112.7)
      .mockReturnValueOnce(10);

    expect(estimateCallDurationMs(100)).toBe(13);
    expect(estimateCallDurationMs(20)).toBe(0);

    nowSpy.mockRestore();
  });
});

describe("debug payload selection", () => {
  test("prefers output", () => {
    expect(getLoggedResponsePayload({
      tool: "t",
      sessionID: "s",
      messageID: "m",
      args: {},
      output: { ok: true },
      time: "x",
    })).toEqual({ ok: true });
  });

  test("uses error when output undefined", () => {
    expect(getLoggedResponsePayload({
      tool: "t",
      sessionID: "s",
      messageID: "m",
      args: {},
      error: "bad",
      time: "x",
    })).toEqual({ error: "bad" });
  });

  test("null when neither output nor error", () => {
    expect(getLoggedResponsePayload({
      tool: "t",
      sessionID: "s",
      messageID: "m",
      args: {},
      time: "x",
    })).toBeNull();
  });
});

describe("debug timestamp/name", () => {
  test("formatDebugTimestamp uses UTC YYMMDD_HHMMSSmmm", () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    expect(formatDebugTimestamp(date)).toBe("260102_030405006");
  });

  test("getToolCallLogDirectory nests logs under session id", () => {
    expect(getToolCallLogDirectory("/project", "sess-1")).toBe(
      "/project/.engram/log_tool_calls/sess-1",
    );
  });

  test("debugFileName includes tool name", () => {
    const dateSpy = vi.setSystemTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)));
    const name = debugFileName("grep");
    expect(name).toBe("260102_030405006-grep-12345678.json");
    dateSpy;
  });
});

describe("debug filesystem helpers", () => {
  test("recordToolCall writes normalized log file when enabled", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)));

    await recordToolCall(
      {
        tool: "grep",
        sessionID: "session-1",
        messageID: "m",
        args: { q: "x" },
        output: { ok: true },
        time: "2026-01-02T03:04:05.006Z",
      },
      true,
      42,
      "/project",
    );

    expect(mkdir).toHaveBeenCalledWith("/project/.engram/log_tool_calls/session-1", { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      "/project/.engram/log_tool_calls/session-1/260102_030405006-grep-12345678.json",
      JSON.stringify({
        tool: "grep",
        sessionID: "session-1",
        messageID: "m",
        args: { q: "x" },
        output: { ok: true },
        time: "2026-01-02T03:04:05.006Z",
        estimated_tokens: 6,
        duration_ms: 42,
      }, null, 2),
      "utf8",
    );
  });

  test("ensureDebugGitIgnore appends missing entries only once", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("log_tool_calls\n");

    await ensureDebugGitIgnore("/project");

    expect(mkdir).toHaveBeenCalledWith("/project/.engram", { recursive: true });
    expect(appendFile).toHaveBeenCalledWith(
      "/project/.engram/.gitignore",
      ".gitignore\n",
      "utf8",
    );
  });
});
