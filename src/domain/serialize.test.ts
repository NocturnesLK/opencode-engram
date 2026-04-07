import { describe, expect, test } from "vitest";

import {
  serializeBrowse,
  serializeBrowseItem,
  serializeMessageRead,
  serializeOverview,
  serializeOverviewTurn,
  serializePartRead,
  serializeSearch,
  serializeSearchHit,
  serializeSearchMessage,
} from "./serialize.ts";
import type { AnyMessageMeta, Section } from "./types.ts";

describe("serialize/browse", () => {
  test("omits optional fields when empty", () => {
    const meta: AnyMessageMeta = {
      id: "m1",
      role: "user",
      turn: 1,
      time: 1,
      notes: [],
      attachments: [],
    };
    const withoutPreview = serializeBrowseItem(meta, undefined);
    expect(withoutPreview).toEqual({
      role: "user",
      turn_index: 1,
      message_id: "m1",
    });
    expect(Object.keys(withoutPreview)).toEqual(["role", "turn_index", "message_id"]);

    const out = serializeBrowse(null, [serializeBrowseItem(meta, "hi")], null);
    expect(out).toEqual({
      before_message_id: null,
      messages: [
        {
          role: "user",
          turn_index: 1,
          message_id: "m1",
          preview: "hi",
        },
      ],
      after_message_id: null,
    });
    expect(Object.keys(out.messages[0]!)).toEqual(["role", "turn_index", "message_id", "preview"]);
  });

  test("omits browse anchors when not requested", () => {
    const meta: AnyMessageMeta = {
      id: "m1",
      role: "user",
      turn: 1,
      time: 1,
      notes: [],
      attachments: [],
    };

    expect(serializeBrowse(undefined, [serializeBrowseItem(meta, "hi")], undefined, false, false)).toEqual({
      messages: [
        {
          role: "user",
          turn_index: 1,
          message_id: "m1",
          preview: "hi",
        },
      ],
    });
  });

  test("keeps message_id in browse items", () => {
    const userMeta: AnyMessageMeta = {
      id: "u1",
      role: "user",
      turn: 1,
      time: 1,
      notes: [],
      attachments: ["1 image", "a.ts"],
    };
    const assistantMeta: AnyMessageMeta = {
      id: "a1",
      role: "assistant",
      turn: 1,
      time: 2,
      notes: [],
      toolCalls: [{ tool: "bash", total: 2, errors: 1 }],
      toolOutcome: "recovered",
    };

    const userOut = serializeBrowseItem(userMeta, "hello");
    expect(userOut).toEqual({
      role: "user",
      turn_index: 1,
      message_id: "u1",
      preview: "hello",
      attachment: ["1 image", "a.ts"],
    });
    expect(Object.keys(userOut)).toEqual(["role", "turn_index", "message_id", "preview", "attachment"]);

    const assistantOut = serializeBrowseItem(assistantMeta, undefined);
    expect(assistantOut).toEqual({
      role: "assistant",
      turn_index: 1,
      message_id: "a1",
      tool: {
        calls: ["2× bash: 1× error"],
        outcome: "recovered",
      },
    });
    expect(Object.keys(assistantOut)).toEqual(["role", "turn_index", "message_id", "tool"]);
  });

  test("uses completed as default tool.outcome when missing", () => {
    const assistantMeta: AnyMessageMeta = {
      id: "a2",
      role: "assistant",
      turn: 2,
      time: 3,
      notes: [],
      toolCalls: [{ tool: "grep", total: 1, errors: 0 }],
    };

    expect(serializeBrowseItem(assistantMeta, "done")).toEqual({
      role: "assistant",
      turn_index: 2,
      message_id: "a2",
      preview: "done",
      tool: {
        calls: ["1× grep"],
        outcome: "completed",
      },
    });
  });
});

describe("serialize/overview", () => {
  test("serializes turn summaries", () => {
    const turn = serializeOverviewTurn(
      2,
      {
        preview: "u",
        message_id: "msg_2",
      },
      {
        preview: "a",
        total_messages: 2,
      },
    );
    expect(turn).toEqual({
      turn_index: 2,
      user: {
        preview: "u",
        message_id: "msg_2",
      },
      assistant: {
        preview: "a",
        total_messages: 2,
      },
    });
    expect(serializeOverview([turn])).toEqual({
      turns: [turn],
    });
  });
});

describe("serialize/read", () => {
  test("includes part_id only when truncated", () => {
    const meta: AnyMessageMeta = {
      id: "m1",
      role: "assistant",
      turn: 1,
      time: 0,
      notes: [],
      toolCalls: [],
    };
    const sections: Section[] = [
      { type: "text", partId: "p1", content: "hi", truncated: false },
      { type: "reasoning", partId: "p2", content: "r", truncated: true },
      { type: "tool", partId: "p3", tool: "grep", title: null, status: "completed", truncated: true, input: { q: "x" }, content: "out" },
      { type: "image", partId: "p4", mime: "image/png" },
      { type: "file", partId: "p5", path: "a.ts", mime: "text/plain" },
    ];

    const out = serializeMessageRead(meta, sections);
    expect(out).toEqual({
      message_id: "m1",
      role: "assistant",
      turn_index: 1,
      time: "1970-01-01T00:00:00.000Z",
      sections: [
        { type: "text", content: "hi" },
        { type: "reasoning", content: "r", part_id: "p2" },
        {
          type: "tool",
          tool: "grep",
          status: "completed",
          input: { q: "x" },
          content: "out",
          part_id: "p3",
        },
        { type: "image", mime: "image/png" },
        { type: "file", path: "a.ts", mime: "text/plain" },
      ],
    });
  });

  test("serializes unknown time and null/undefined content correctly", () => {
    const meta: AnyMessageMeta = {
      id: "m2",
      role: "user",
      turn: 2,
      time: undefined,
      notes: [],
      attachments: [],
    };

    const out = serializeMessageRead(meta, [
      { type: "text", partId: "p1", content: "", truncated: false },
      { type: "tool", partId: "p2", tool: "bash", title: null, status: "running", truncated: false },
    ]);

    expect(out).toEqual({
      message_id: "m2",
      role: "user",
      turn_index: 2,
      time: "unknown",
      sections: [
        { type: "text", content: null },
        { type: "tool", tool: "bash", status: "running" },
      ],
    });
  });

  test("part read includes content when present", () => {
    expect(serializePartRead("text", "hello")).toEqual({ type: "text", content: "hello" });
  });

  test("part read omits content when undefined", () => {
    expect(serializePartRead("tool", undefined)).toEqual({ type: "tool" });
  });
});

describe("serialize/search", () => {
  test("omits messages when no hits", () => {
    expect(serializeSearch(undefined)).toEqual({});
  });

  test("serializes hits with and without optional fields", () => {
    const textHit = serializeSearchHit("text", "part0", ["...x..."]);
    const toolHit = serializeSearchHit("tool", "part1", ["...x..."], "grep");
    const msgWithoutRemain = serializeSearchMessage("m0", "user", 1, [textHit], 0);
    const msg = serializeSearchMessage("m1", "assistant", 1, [toolHit], 2);
    const out = serializeSearch([msgWithoutRemain, msg]);

    expect(textHit).toEqual({
      type: "text",
      part_id: "part0",
      snippets: ["...x..."],
    });
    expect(msgWithoutRemain).toEqual({
      role: "user",
      turn_index: 1,
      message_id: "m0",
      hits: [textHit],
    });
    expect(out).toEqual({
      messages: [
        {
          role: "user",
          turn_index: 1,
          message_id: "m0",
          hits: [
            {
              type: "text",
              part_id: "part0",
              snippets: ["...x..."],
            },
          ],
        },
        {
          role: "assistant",
          turn_index: 1,
          message_id: "m1",
          hits: [
            {
              type: "tool",
              part_id: "part1",
              tool_name: "grep",
              snippets: ["...x..."],
            },
          ],
          remain_hits: 2,
        },
      ],
    });
  });
});
