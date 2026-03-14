# AGENTS.md -- Agent Contract Rules

Rules and invariants that any agent (human or AI) working on this codebase must follow.

## LLM Review Handling

- **Never assume LLM review is available.** Auth resolution (`AuthResolver.resolve()`) can return `null`. All code paths that use an LLM client must handle the null case by falling back to deterministic review.
- **If auth fails, keep deterministic review and log why.** The `LlmReviewRunner` already implements this: if the LLM client is null or throws, it delegates to `DeterministicReviewRunner`. Do not change this fallback behavior.
- **`review.engine=llm` does not guarantee LLM execution.** It only means "attempt LLM review." The actual execution depends on `llm.mode` not being `disabled` and auth resolution succeeding.

## Patch vs. Mergeable Document

- **Report patches and mergeable documents are separate outputs.** `PatchGenerator.generateSplit()` returns `PatchOutput { reportPatch, mergeableDocument }`.
- **Report patch** (audit trail) always goes to `.skill-patches/<storage-key>/<patch-id>.md`. This is never written into the target skill document.
- **Mergeable document** (candidate content) goes to the target path only when merge policy allows it (`mergeMode=auto` and `requireHumanMerge=false`). Otherwise it is included in the patch file for human review.
- Never confuse these two outputs. Auto-merge must never write the report patch into `SKILL.md` or any target document.

## Target Routing

- **Builtin and global learnings go to `.skill-global/`, not `skills/`.** Builtin tools (Bash, Read, Write, etc.) route to `.skill-global/tools/<tool>.md`. Global defaults route to `.skill-global/DEFAULT_SKILL.md`.
- **Unresolved targets are queue-only.** They produce patches at `.skill-patches/` but are never auto-merged.
- **`TargetResolver.resolve()` must return a valid `EvolutionTarget`** for every input. The `unresolved` kind exists as the catch-all.

## Configuration Contract

- **New config fields must be added in three places:**
  1. `openclaw.plugin.json` -- the JSON Schema under `configSchema`
  2. `src/plugin/config.ts` -- `getDefaultConfig()` return value and `validateConfig()` checks
  3. Documentation (`docs/config.md` and this file if it affects agent behavior)
- **All config fields must have defaults** in `getDefaultConfig()`. The plugin must function correctly with zero user-provided config.
- **Validation is strict.** `validateConfig()` throws `InvalidConfigError` for any out-of-range or wrong-type value. Do not add config fields without adding validation.

## Path Resolution

- **Paths are derived from `workspaceRoot` formulas, not hardcoded.** Use `resolvePaths()` from `src/shared/paths.ts`. The workspace root is resolved at runtime from hook context (`ctx.workspaceDir`), falling back through `OPENCLAW_HOME`, `OPENCLAW_PROFILE`, and `~/.openclaw/workspace`.
- **Never construct storage paths manually.** Always use `ResolvedPaths` properties: `overlaysDir`, `patchesDir`, `backupsDir`, `skillsDir`, `feedbackDir`, `globalDir`, `globalToolsDir`, `reviewQueueDir`, `reviewQueueFailedDir`.
- **Plugin must be told workspace directory at runtime.** `ensureWorkspaceDir()` is called on first hook invocation. Before that, paths use `process.cwd()` as fallback.

## Session Overlay Invariant

- **Session-local overlays never directly edit SKILL.md.** Overlays are ephemeral JSON files stored at `.skill-overlays/<session-id>/<skill-key>.json`. They are injected into prompts via `before_prompt_build` and cleared when the session ends (if `clearOnSessionEnd=true`).
- **The only path from feedback to SKILL.md is: review -> patch -> merge.** No shortcutting.

## Review Queue Contract

- **Review queue tasks are idempotent.** Each task carries an `idempotencyKey`. The queue's `enqueue()` method checks for duplicates and silently skips if a matching key already exists.
- **`baseVersionHash` mismatch degrades to manual review.** When the worker picks up a task, it hashes the current target document. If the hash does not match `task.baseVersionHash`, `mergeMode` is forced to `manual` regardless of policy. This prevents stale patches from overwriting concurrent changes.
- **`queue.maxAttempts` exhaustion moves tasks to `failed/`.** After the configured number of retry attempts (default 3), a task is moved from `.skill-review-queue/` to `.skill-review-queue/failed/` with `status: 'failed'`. It is not retried again automatically.
- **Lease-based dequeue prevents duplicate processing.** Each dequeue acquires a time-limited lease (`queue.leaseMs`). Stale leases (expired `leaseUntil`) are eligible for re-dequeue by another worker.

## Merge and Rollback

- **`requireHumanMerge=true` must block auto-merge.** When this flag is set, all patches go to `.skill-patches/` for human review, regardless of risk level.
- **Rollback chain is capped at 5 versions per skill** (configurable via `merge.maxRollbackVersions`). Oldest version is dropped on overflow.
- **Backups are created before every auto-merge write.** The rollback manager snapshots the current content before any target document is overwritten.

## Code Conventions

- ESM only. All imports use `.js` extensions.
- All interfaces live in `src/shared/types.ts`. No `any` in public APIs.
- Custom error classes from `src/shared/errors.ts`. No empty catch blocks.
- Files use `snake_case.ts`. Tests use `test_` prefix.
- Run `npm run test` after any change.
