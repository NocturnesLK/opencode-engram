import type { Plugin } from "@opencode-ai/plugin";

export type Logger = ReturnType<typeof log>;

export function log(client: Parameters<Plugin>[0]["client"], sessionID: string) {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) =>
    client.app
      .log({
        body: {
          service: "engram-plugin",
          level,
          message,
          extra: { sessionID, ...extra },
        },
      })
      .catch(() => undefined);

  return {
    trace: (message: string, extra?: Record<string, unknown>) =>
      write("debug", message, extra),
    debug: (message: string, extra?: Record<string, unknown>) =>
      write("debug", message, extra),
    info: (message: string, extra?: Record<string, unknown>) =>
      write("info", message, extra),
    warn: (message: string, extra?: Record<string, unknown>) =>
      write("warn", message, extra),
    error: (message: string, extra?: Record<string, unknown>) =>
      write("error", message, extra),
  };
}
