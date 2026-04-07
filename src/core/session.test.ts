import { describe, expect, test } from "vitest";

import {
  computeCacheFingerprint,
  createBrowseContext,
  createSessionTarget,
  normalizeSessionMetadata,
} from "./session.ts";
import type { SdkSessionData } from "./session.ts";

describe("core/session normalizeSessionMetadata", () => {
  test("normalizes numeric version and updatedAt", () => {
    const sdk: SdkSessionData = {
      id: "s",
      title: "t",
      version: 2,
      time: { updated: 1000 },
      parentID: "p",
    };
    expect(normalizeSessionMetadata(sdk)).toEqual({
      id: "s",
      title: "t",
      version: 2,
      updatedAt: 1000,
      parentId: "p",
    });
  });

  test("parses string version and string date", () => {
    const sdk: SdkSessionData = {
      id: "s",
      title: "t",
      version: "10",
      time: { updated: "2026-04-02T00:00:00.000Z" },
    };
    const out = normalizeSessionMetadata(sdk);
    expect(out.version).toBe(10);
    expect(out.updatedAt).toBe(Date.parse("2026-04-02T00:00:00.000Z"));
  });

  test("returns undefined for invalid version/time", () => {
    const sdk: SdkSessionData = {
      id: "s",
      title: "t",
      version: "nope",
      time: { updated: "not-a-date" },
    };
    expect(normalizeSessionMetadata(sdk)).toEqual({
      id: "s",
      title: "t",
      version: undefined,
      updatedAt: undefined,
      parentId: undefined,
    });
  });
});

describe("core/session target/context", () => {
  test("createSessionTarget normalizes all metadata fields", () => {
    const target = createSessionTarget({
      id: "s",
      title: "t",
      version: "7",
      time: { updated: "2026-04-02T00:00:00.000Z" },
      parentID: "parent",
    });
    expect(target).toEqual({
      session: {
        id: "s",
        title: "t",
        version: 7,
        updatedAt: Date.parse("2026-04-02T00:00:00.000Z"),
        parentId: "parent",
      },
    });
  });

  test("createBrowseContext wraps target", () => {
    const target = createSessionTarget({
      id: "s",
      title: "t",
      version: 1,
      time: { updated: 2 },
      parentID: "p",
    });
    const ctx = createBrowseContext(target);
    expect(ctx).toEqual({
      target: {
        session: {
          id: "s",
          title: "t",
          version: 1,
          updatedAt: 2,
          parentId: "p",
        },
      },
      selfSession: false,
    });
  });

  test("createBrowseContext sets selfSession flag", () => {
    const target = createSessionTarget({
      id: "s",
      title: "t",
      version: 1,
      time: { updated: 2 },
    });
    const ctx = createBrowseContext(target, true);
    expect(ctx.selfSession).toBe(true);
  });
});

describe("core/session computeCacheFingerprint", () => {
  test("returns fingerprint when both fields exist", () => {
    expect(computeCacheFingerprint({
      id: "s",
      title: "t",
      version: 2,
      updatedAt: 3,
      parentId: undefined,
    })).toBe("2:3");
  });

  test("returns undefined when version missing", () => {
    expect(computeCacheFingerprint({
      id: "s",
      title: "t",
      version: undefined,
      updatedAt: 3,
      parentId: undefined,
    })).toBeUndefined();
  });

  test("returns undefined when updatedAt missing", () => {
    expect(computeCacheFingerprint({
      id: "s",
      title: "t",
      version: 2,
      updatedAt: undefined,
      parentId: undefined,
    })).toBeUndefined();
  });
});
