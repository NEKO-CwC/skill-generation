# Gap Analysis: Current Implementation vs OpenClaw Plugin Spec

## Summary

The current codebase implements the full **business logic layer** for skill evolution (feedback collection, overlays, review, patch generation, merge, rollback). However, it is not yet packaged as an installable OpenClaw plugin. This document identifies every gap between the current state and a production-ready OpenClaw plugin.

## Current State

| Aspect | Status | Notes |
|--------|--------|-------|
| Business logic (5-step workflow) | Complete | 71 tests passing |
| TypeScript build | Complete | ESM, strict mode, clean |
| Unit + workflow tests | Complete | 13 files, 71 tests |
| YAML config loading | Complete | `loadConfig()` reads from file |
| Plugin composition root | Complete | `SkillEvolutionPlugin` class |

## Gaps

### Gap 1: Missing `openclaw.plugin.json` Manifest

**Required by**: OpenClaw plugin discovery and validation
**Current state**: Does not exist
**What's needed**:
```json
{
  "id": "skill-evolution",
  "name": "Skill Evolution",
  "description": "Evolves OpenClaw skills from real usage feedback via session overlays, deterministic review, and safe merge with rollback.",
  "version": "0.1.0",
  "configSchema": { ... }
}
```
The `configSchema` must be a JSON Schema object that mirrors `SkillEvolutionConfig` from `src/shared/types.ts`. OpenClaw validates this schema **without executing plugin code**.

### Gap 2: Missing `openclaw.extensions` in `package.json`

**Required by**: OpenClaw plugin loader (scans `openclaw.extensions` to find entry points)
**Current state**: `package.json` has no `openclaw` field
**What's needed**:
```json
{
  "openclaw": {
    "extensions": ["./src/openclaw.ts"]
  }
}
```

### Gap 3: Missing Plugin Entry Point (`src/openclaw.ts`)

**Required by**: OpenClaw plugin runtime — the framework calls `register(api)` on the default export
**Current state**: No adapter exists. `src/plugin/index.ts` exports `SkillEvolutionPlugin` as a standalone class with direct method calls.
**What's needed**: A thin adapter that:
1. Exports a default `register(api)` function (or object with `{ id, register }`)
2. Reads config from `api.getConfig()` (OpenClaw's `plugins.entries.skill-evolution.config`)
3. Instantiates `SkillEvolutionPlugin` with that config
4. Registers 4 hooks via `api.on("hook_name", handler, { priority })`

### Gap 4: Hook Signature Mismatch

**Required by**: OpenClaw hook system expects `(event, ctx) => result` signatures
**Current state**: `SkillEvolutionPlugin` methods use custom signatures:

| Hook | Current Signature | OpenClaw Expected |
|------|------------------|-------------------|
| `before_prompt_build` | `(sessionId, skillKey, currentPrompt) => Promise<string>` | `(event, ctx) => { prependSystemContext?, appendSystemContext?, prependContext? }` |
| `after_tool_call` | `(sessionId, toolName, output, isError) => Promise<void>` | `(event, ctx) => void` |
| `message_received` | `(sessionId, message) => Promise<void>` | `(event, ctx) => void` |
| `agent_end` | `(sessionId) => Promise<void>` | `(event, ctx) => void` |

**Adapter must**: Extract `sessionId` from `ctx`, map `event` fields to the existing method parameters, and convert the return value (especially `before_prompt_build` which must return `{ prependSystemContext }` instead of a modified string).

### Gap 5: Config Source Mismatch

**Required by**: OpenClaw provides plugin config via `api.getConfig()` (from `plugins.entries.<id>.config` in `~/.openclaw/openclaw.json`)
**Current state**: Config is loaded from a standalone YAML file via `loadConfig(path)`
**What's needed**: A `fromOpenClawPluginConfig(rawConfig)` adapter that:
1. Takes the raw object from `api.getConfig()` (already parsed, no file I/O needed)
2. Applies defaults via `deepMerge` with `getDefaultConfig()`
3. Validates via existing `validateConfig()`
4. Falls back to YAML file loading for standalone dev/test mode

### Gap 6: Missing OpenClaw API Type Definitions

**Required by**: TypeScript compilation of `src/openclaw.ts`
**Current state**: No OpenClaw API types exist in the project
**What's needed**: Type declarations for:
- `OpenClawPluginAPI` — the `api` object passed to `register()`
- `PluginHookBeforePromptBuildEvent` — event for `before_prompt_build`
- `PluginHookBeforePromptBuildResult` — return type for `before_prompt_build`
- `PluginHookAfterToolCallEvent` — event for `after_tool_call`
- `PluginHookAgentEndEvent` — event for `agent_end`
- `PluginHookAgentContext` — the `ctx` object passed to all hooks

These should be defined locally (not imported from OpenClaw) since the plugin must compile standalone.

### Gap 7: `allowPromptInjection=false` Degradation

**Required by**: OpenClaw security model — when `plugins.entries.<id>.hooks.allowPromptInjection` is `false`, the `before_prompt_build` hook's return value is silently ignored
**Current state**: Not handled. The plugin assumes `before_prompt_build` always works.
**What's needed**: 
- Log a warning on plugin init if `allowPromptInjection` might be disabled
- The overlay system should still **collect** overlays even when injection is blocked
- Documentation must explain this behavior clearly

### Gap 8: README Targeting

**Required by**: End users who want to install the plugin
**Current state**: README is developer-focused, describes internals, doesn't mention `openclaw plugins install`
**What's needed**: User-facing README with:
- Prerequisites (OpenClaw version, Node.js)
- Install command (`openclaw plugins install -l .`)
- Config example (JSON5 format for `~/.openclaw/openclaw.json`)
- Verify command (`openclaw plugins doctor`)
- Common issues (especially `allowPromptInjection`)
- What this plugin is NOT (not a skill package)

## Impact Assessment

| Gap | Effort | Risk if Skipped |
|-----|--------|-----------------|
| 1. Manifest | Low | Plugin cannot be discovered by OpenClaw |
| 2. package.json | Trivial | Plugin entry point not found |
| 3. Entry point | Medium | Plugin cannot register with OpenClaw |
| 4. Hook signatures | Medium | Hooks will crash at runtime |
| 5. Config adapter | Low-Medium | Plugin won't receive user config |
| 6. API types | Low | Won't compile |
| 7. Degradation | Low | Silent failure confuses users |
| 8. README | Medium | Users can't install or troubleshoot |

## Execution Order

1. **Types first** (Gap 6) — needed for everything else to compile
2. **Manifest + package.json** (Gaps 1, 2) — trivial, unblocks discovery
3. **Entry point + hook mapping** (Gaps 3, 4) — core adapter work
4. **Config adapter** (Gap 5) — needed for runtime
5. **Tests** — adapter layer tests
6. **Degradation** (Gap 7) — polish
7. **README** (Gap 8) — final deliverable

## Non-Goals (Explicitly Out of Scope)

- Rewriting business logic — all existing modules stay as-is
- Adding LLM-based review — v1 stays deterministic
- Per-skill merge policy — global switch only
- Complex integration test platform — mock-based tests only
- Publishing to npm — local install only for now
