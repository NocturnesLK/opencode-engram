# AGENTS.md

> Guidance for AI coding agents operating in this repository.

## Project Overview

**opencode-engram** is a pull-based history retrieval plugin for [OpenCode](https://github.com/opencode-ai/opencode). It provides upstream session history browsing, search, and retrieval as tool calls within the OpenCode plugin system.

- **Language:** TypeScript (ES2022 target, ESNext modules, strict mode)
- **Runtime:** Node.js >= 22
- **Module system:** ESM (`"type": "module"` in package.json)
- **Package manager:** npm (use `npm ci` to install)
- **Entry point:** `src/common/plugin.ts`

## Build / Lint / Test Commands

```bash
# Install dependencies
npm ci

# Type-check (no emit, strict)
npm run typecheck          # tsc --noEmit

# Run all tests
npm run test               # vitest run

# Run a single test file
npx vitest run src/common/config.test.ts

# Run tests matching a name pattern
npx vitest run -t "returns defaults"

# Run a single test file in watch mode
npx vitest src/domain/domain.test.ts

# Run all tests in watch mode
npm run test:watch         # vitest

# Run tests with coverage (80% line threshold enforced)
npm run test:coverage      # vitest run --coverage
```

There is no separate build step — the plugin is consumed directly as TypeScript source. There is no linter or formatter configured; follow the existing style.

CI (`.github/workflows/ci.yml`) runs `typecheck` then `test:coverage` on Node 22.

## Architecture / Layer Boundaries

```
src/
  common/    Plugin entry, config loading, shared helpers, prompt templates
  domain/    Pure domain logic, SDK adapter, serialization, shared types
  core/      Session resolution, browse context, turn indexing
  runtime/   Tool execution orchestration, search, message I/O, debug logging
```

- **common** defines the plugin surface and config.
- **domain** contains pure functions — no I/O, no SDK calls.
- **core** provides session/browse primitives used by runtime.
- **runtime** wires SDK calls to core + domain; handles caching and errors.
- **core/index.ts** is the public barrel export for the core layer.

Import direction: `common <- domain <- core <- runtime`. Do not introduce reverse imports.

## Documentation

- When updating any README, synchronize the change across all `README.*.md` files and keep their semantics aligned.

## Code Style

### Imports

- Always use `.ts` file extensions in import paths (`from "./config.ts"`).
- Use `import type` for type-only imports — enforced by `verbatimModuleSyntax` in tsconfig.
- Group imports: Node builtins first, then external packages, then internal modules. Separate groups with blank lines.
- Prefer named exports. The only default export is `EngramPlugin` in `plugin.ts`.

```typescript
import { readFile } from "node:fs/promises";        // Node built-in

import type { Plugin } from "@opencode-ai/plugin";   // External (type-only)

import { json, type PluginInput } from "../common/common.ts";  // Internal
import type { EngramConfig } from "../common/config.ts";        // Internal type-only
```

### Formatting

- 2-space indentation.
- Double quotes for strings.
- Semicolons required.
- Trailing commas in multi-line lists.
- Use `// ===...===` section banners to organize related groups of functions within a file.
- JSDoc comments on public/exported functions; brief inline comments elsewhere.

### Types

- Use `type` for unions, aliases, and simple shapes.
- Use `interface` for object types that represent domain models or contracts.
- Prefer `readonly` / `ReadonlySet` / `Readonly<>` for immutable parameters.
- Output contracts (JSON responses) use `snake_case` field names; internal code uses `camelCase`.
- The `satisfies` operator is used for type-safe config validation.

```typescript
export type MessageRole = "user" | "assistant";

export interface NormalizedMessage {
  id: string;
  role: MessageRole;
  time: number | undefined;
  summary: boolean;
}
```

### Naming Conventions

- **Files:** `kebab-case.ts`, tests co-located as `kebab-case.test.ts`.
- **Functions/variables:** `camelCase`.
- **Types/interfaces:** `PascalCase`.
- **Constants:** `camelCase` (e.g., `searchQueryMaxLength`, `internalScanPageSize`). Module-level `const` arrays use `UPPER_SNAKE_CASE` only for static lookup tables (e.g., `SHOW_TOOL_INPUT_BUILTINS`).
- **Config/JSON keys:** `snake_case` (e.g., `message_limit`, `show_tool_input`).

### Functions & Patterns

- Functional style — no classes anywhere in the codebase.
- Pure functions in domain layer; side effects confined to runtime and common layers.
- Use explicit `switch` with per-case blocks for discriminated unions.
- Prefer `for...of` loops over `.forEach()`.
- Use `Map` and `Set` for collection operations.
- Return `undefined` (not `null`) from functions when value is absent, except in JSON output where `null` is the convention.
- Logging uses the `Logger` type from `runtime/logger.ts` — a thin wrapper over the SDK client log API. Pass `Logger` as a parameter; do not import global loggers.

### Error Handling

- Throw `new Error(message)` with a descriptive user-facing message.
- Use the `invalid(message)` helper from `common.ts` for input validation errors.
- Wrap unknown errors: `err instanceof Error ? err.message : String(err)`.
- Tool handlers catch errors and re-throw as `Error` instances for consistent output.
- Never silently swallow errors — log via the `Logger` interface then rethrow or return fallback.

### Testing

- Framework: Vitest. Tests use `describe` / `test` (not `it`).
- Test files live next to source: `foo.ts` -> `foo.test.ts`.
- Mocking: `vi.mock("module")` **must** appear at the top of the file, **before** importing the mocked module. Vitest hoists `vi.mock` calls, but the source must still follow this ordering convention.
- Imports from vitest: `import { afterEach, describe, expect, test, vi } from "vitest"`.
- Factory helpers (e.g., `makeMessageBundle`, `makeTextPart`) are defined at the top of each test file.
- Clean up mocks in `afterEach` with `vi.clearAllMocks()`.
- Coverage target: >80% line coverage overall (enforced by vitest config thresholds).
- `src/domain/types.ts` is excluded from coverage (pure type definitions).

### Config System

- Config files: `opencode-engram.json` or `opencode-engram.jsonc` (supports comments and trailing commas).
- Config is loaded from global config directories first, then project root (project overrides global).
- All config fields have defaults. Invalid values log a warning and fall back to defaults.
- When adding new config keys, update the `supported*Keys` arrays and add validation in `config.ts`.
