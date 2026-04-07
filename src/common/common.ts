import type { Plugin } from "@opencode-ai/plugin";

export type PluginInput = Parameters<Plugin>[0];

export type ToolContext = {
  sessionID: string;
  messageID: string;
  metadata(input: { title: string; metadata: Record<string, unknown> }): void;
};

export function json(data: unknown): string {
  const serialized = JSON.stringify(data, null, 2);
  if (serialized === undefined) {
    throw new Error("Failed to serialize response");
  }
  return serialized;
}

function formatToolInputValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    return `${value}n`;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatToolInputSignature(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const args = Object.entries(input)
    .map(([key, value]) => `${key}=${formatToolInputValue(value)}`)
    .join(", ");

  return `${toolName}(${args})`;
}

export function composeContentWithToolInputSignature(
  toolName: string,
  input: Record<string, unknown> | undefined,
  content: string | undefined,
): string | undefined {
  if (input === undefined) {
    return content;
  }

  const header = formatToolInputSignature(toolName, input);
  if (content === undefined || content === "") {
    return header;
  }

  return `${header}\n---\n${content}`;
}

export function invalid(message: string): never {
  throw new Error(message);
}
