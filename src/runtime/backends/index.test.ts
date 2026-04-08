import { afterEach, describe, expect, test, vi } from "vitest";

import type { PluginInput } from "../../common/common.ts";
import type { HistoryBackend } from "../../core/history-backend.ts";

import {
  createHistoryBackend,
  resolveHistoryBackend,
  type HistoryBackendProvider,
} from "./index.ts";

function makeInput() {
  return {
    directory: "/project",
    client: {
      session: {
        get: vi.fn(async ({ path }: { path: { id: string } }) => ({
          data: {
            id: path.id,
            title: "OpenCode Session",
            version: 1,
            time: { updated: 1 },
          },
          error: undefined,
          response: { status: 200 },
        })),
        messages: vi.fn(),
        message: vi.fn(),
      },
      app: {
        log: vi.fn(async () => undefined),
      },
    },
  } as unknown as PluginInput;
}

function makeBackend(name: string): HistoryBackend {
  return {
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      title: `${name} Session`,
      version: 1,
      time: { updated: 1 },
    })),
    listMessages: vi.fn(async () => ({
      msgs: [],
      nextCursor: undefined,
    })),
    getMessage: vi.fn(),
  };
}

function makeProvider(
  backend: HistoryBackend,
  matchesSessionId: (sessionId: string) => boolean,
): HistoryBackendProvider {
  return {
    matchesSessionId: vi.fn(matchesSessionId),
    createBackend: vi.fn(() => backend),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runtime/backends/index", () => {
  test("uses matching provider backend when session id matches", async () => {
    const input = makeInput();
    const providerBackend = makeBackend("Provider");
    const provider = makeProvider(providerBackend, (sessionId) => sessionId === "provider-session");

    const backend = createHistoryBackend(input, "provider-session", {
      providers: [provider],
    });

    await expect(backend.getSession("provider-session")).resolves.toEqual({
      id: "provider-session",
      title: "Provider Session",
      version: 1,
      time: { updated: 1 },
    });
    expect(provider.matchesSessionId).toHaveBeenCalledWith("provider-session");
    expect(provider.createBackend).toHaveBeenCalledWith(input);
    expect(input.client.session.get).not.toHaveBeenCalled();
  });

  test("falls back to OpenCode backend when no provider matches", async () => {
    const input = makeInput();
    const provider = makeProvider(makeBackend("Provider"), () => false);

    const backend = createHistoryBackend(input, "opencode-session", {
      providers: [provider],
    });

    await expect(backend.getSession("opencode-session")).resolves.toEqual({
      id: "opencode-session",
      title: "OpenCode Session",
      version: 1,
      time: { updated: 1 },
    });
    expect(provider.matchesSessionId).toHaveBeenCalledWith("opencode-session");
    expect(provider.createBackend).not.toHaveBeenCalled();
    expect(input.client.session.get).toHaveBeenCalledWith({
      path: { id: "opencode-session" },
      query: { directory: "/project" },
      throwOnError: false,
    });
  });

  test("prefers explicit injected backend over provider routing", () => {
    const input = makeInput();
    const injectedBackend = makeBackend("Injected");
    const provider = makeProvider(makeBackend("Provider"), () => true);

    const backend = resolveHistoryBackend(input, "provider-session", injectedBackend, {
      providers: [provider],
    });

    expect(backend).toBe(injectedBackend);
    expect(provider.matchesSessionId).not.toHaveBeenCalled();
    expect(provider.createBackend).not.toHaveBeenCalled();
  });
});
