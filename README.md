# OpenClaw Skill Evolution Plugin
A plugin that helps OpenClaw skills evolve from real usage feedback.

## What it does
- Captures tool failures and user corrections during sessions
- Applies session-local skill overlays (temporary modifications)
- Runs a post-session deterministic review
- Generates and merges skill patches
- Keeps up to 5 rollback versions per skill

## Why this exists
- OpenClaw skills are powerful but static by default
- Direct file editing isn't session-local safe (watcher hot-reloads changes)
- This plugin adds a safe feedback loop: overlay, review, patch, merge

## Key ideas
- Temporary session overlay != editing SKILL.md. Overlays are ephemeral, scoped to one session, and injected via before_prompt_build.
- Final changes only happen through patch review and merge.
- Merge policy is a global switch: requireHumanMerge (manual or automatic, no per-skill overrides in v1).
- Every skill has rollback protection (up to 5 versions).

## Configuration
Example configuration from `examples/config.example.yaml`:

```yaml
skillEvolution:
  enabled: true
  merge:
    requireHumanMerge: true
    maxRollbackVersions: 5
  sessionOverlay:
    enabled: true
    storageDir: ".skill-overlays"
    injectMode: "system-context"
    clearOnSessionEnd: true
  triggers:
    onToolError: true
    onUserCorrection: true
    onSessionEndReview: true
    onPositiveFeedback: true
  llm:
    inheritPrimaryConfig: true
    modelOverride: null
    thinkingOverride: null
  review:
    minEvidenceCount: 2
    allowAutoMergeOnLowRiskOnly: false
```

- **merge**: Controls the patching process. `requireHumanMerge: true` queues patches at `.skill-patches/` for manual review. `requireHumanMerge: false` auto-merges patches and backs up old content to `.skill-backups/`.
- **sessionOverlay**: Manages ephemeral session-scoped changes stored at `.skill-overlays/<session-id>/`.
- **triggers**: Defines which events (tool errors, user corrections) trigger feedback collection.
- **llm**: LLM configuration for any future LLM-based operations (v1 review is deterministic).
- **review**: Sets thresholds like `minEvidenceCount` for recommending a skill update.

## Workflow

### During session
```
after_tool_call / message_received
  -> FeedbackClassifier (regex-based event classification)
  -> FeedbackCollector (in-memory buffer)
  -> OverlayStore (file-system JSON at .skill-overlays/<session-id>/<skill-key>.json)

before_prompt_build
  -> OverlayStore.listBySession
  -> OverlayInjector.inject (delimiter-based prepend)
  -> augmented prompt returned to OpenClaw
```

### At session end
```
agent_end hook
  -> Build SessionSummary (events, overlays, duration, error counts)
  -> Check minEvidenceCount threshold
  -> ReviewRunner.runReview (deterministic rule-based, NOT LLM)
  -> PatchGenerator.generate (text-format patch)
  -> MergeManager.merge
    - auto mode: RollbackManager.backup -> write SKILL.md -> RollbackManager.prune
    - manual mode: queue patch file at .skill-patches/<skillKey>/<patchId>.md
  -> Clear session overlays if clearOnSessionEnd=true
```

## Safety model
- **Overlay isolation**: Overlays live in `.skill-overlays/<session-id>/`, never touch shared SKILL.md.
- **Rollback protection**: Every auto-merge backs up current SKILL.md first, pruned to max 5 versions.
- **Global merge switch**: `requireHumanMerge=true` blocks all auto-merges.
- **Structured logging**: All operations produce JSON-formatted log entries for debugging.
- **Error handling**: Custom error classes (OverlayError, MergeConflictError, RollbackError, ConfigError), no silent failures.

## Development
```bash
npm install           # Install dependencies
npm run build         # TypeScript compilation (tsc)
npm run lint          # Type-check without emitting (tsc --noEmit)
npm run test          # Run all tests (vitest run)
npm run test:watch    # Watch mode (vitest)
```

Stack: TypeScript (ESM, strict mode), vitest for testing, yaml for config parsing.

## Tests
- 13 test files, 71 tests, all passing.
- Unit tests cover: errors, fs utils, logger, config, feedback collector, classifiers, overlay store, overlay injector, review runner, patch generator, merge manager, rollback manager.
- 4 mock workflow integration tests:
  1. Tool error -> overlay creation -> overlay injection in next prompt
  2. Session end -> review -> patch -> auto-merge writes SKILL.md
  3. Manual merge blocks auto-write, patch queued
  4. Auto merge writes + backs up + prunes to cap

Run a single test: `npx vitest run tests/shared/test_errors.ts`

## Project structure
```
skill_generation/
├── src/
│   ├── plugin/            # Core plugin logic (hooks, overlay, feedback, config)
│   ├── review/            # Post-session review and merge logic
│   └── shared/            # Common utilities (fs, logger, errors, types)
├── tests/
│   ├── plugin/            # Plugin unit tests
│   ├── review/            # Review unit tests
│   ├── shared/            # Utility unit tests
│   └── workflows/         # End-to-end workflow integration tests
├── docs/                  # Documentation (architecture, spec, acceptance)
├── examples/              # Example configurations
└── prompts/               # Agent role prompts
```
