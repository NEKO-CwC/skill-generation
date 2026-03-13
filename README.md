# OpenClaw Skill Evolution Plugin

A TypeScript plugin that enables SKILL.md files to evolve based on real usage feedback. The plugin captures tool errors, user corrections, and positive signals during sessions, then reviews accumulated evidence to propose safe, incremental improvements to skill documents.

## How It Works

The plugin operates through a **dual-chain architecture**:

### Real-time chain (session hooks)

During an active session, three hooks collect feedback and inject learned context:

```
after_tool_call → ErrorNormalizer → NoiseFilter → TargetResolver → FeedbackCollector → OverlayStore
message_received → FeedbackClassifier → FeedbackCollector → OverlayStore
before_prompt_build → OverlayStore.listBySession → OverlayInjector → augmented prompt
                    → PendingHintStore.getHints → hint injection
```

- `after_tool_call` captures tool errors, normalizes them, filters noise, resolves targets, and creates session overlays
- `message_received` detects user corrections and positive feedback via regex classifiers (English + Chinese patterns)
- `before_prompt_build` injects accumulated overlays and pending hints into the prompt so the agent learns within the session

### Background chain (review service)

> **Lazy initialization:** The review queue and worker are **not** created at plugin registration time. They are initialized only after `captureWorkspaceDir()` resolves a valid `workspaceDir` from hook context for the first time. If the workspace is never resolved (e.g., the host never provides `ctx.workspaceDir`), real-time hooks still function (overlays fall back to `process.cwd()`), but the background review queue does not start.

When a session ends, the plugin enqueues review tasks that a background worker processes asynchronously:

```
session_end → enqueue ReviewTask → ReviewQueue (.skill-review-queue/)
                                         ↓
ReviewWorker polls → dequeue task → review (deterministic or LLM)
                                         ↓
                   PatchGenerator.generateSplit → PatchOutput { reportPatch, mergeableDocument }
                                         ↓
                   MergeManager.mergeWithTarget → target path (or .skill-patches/ for manual)
```

The worker runs on a configurable poll interval (default 30s), acquires a lease on each task, and handles retries up to `queue.maxAttempts` before moving failed tasks to `.skill-review-queue/failed/`.

## Target Model

Feedback is routed to one of four target kinds based on the tool name and skill key:

| Kind | Key example | Storage path | Merge mode |
|------|-------------|-------------|------------|
| `skill` | `my-deploy-skill` | `skills/{key}/SKILL.md` | `skill-doc` |
| `builtin` | `Bash`, `Read`, `Write` | `.skill-global/tools/{tool}.md` | `global-doc` |
| `global` | `default` | `.skill-global/DEFAULT_SKILL.md` | `global-doc` |
| `unresolved` | `unknown-tool` | `.skill-patches/{key}/` (queue only) | `queue-only` |

- Builtin and global learnings go to `.skill-global/`, not `skills/`
- Unresolved targets are queued for human review but never auto-merged
- User corrections bind to the most recent session target

## Review Modes

### Deterministic review (default)

```yaml
review:
  engine: deterministic
```

Rule-based heuristics evaluate accumulated evidence (error count, correction count, overlay count). No external dependencies required. Risk level is computed from combined error and correction counts.

> **Note on positive feedback:** Positive feedback (`positive_feedback` events) is collected, counted, and included in review justification text (e.g., "3 positive signals"). However, positive feedback **alone does not trigger patch generation**. The deterministic reviewer requires at least one of: `totalErrors > 0`, `correctionCount > 0`, or `overlayCount > 0`. A session with only positive signals will produce a review with `isModificationRecommended: false`.

### LLM review

```yaml
review:
  engine: llm
```

An LLM evaluates session evidence and produces a candidate document. If the LLM client is unavailable or auth resolution returns null, the plugin automatically falls back to deterministic review. LLM review requires configuring auth via the `llm` section.

### LLM providers

| `llm.provider` | Default base URL | Auth | Response format |
|----------------|-----------------|------|-----------------|
| `anthropic` (default) | `https://api.anthropic.com` | `x-api-key` | Anthropic Messages |
| `openai-compatible` | `https://api.openai.com` | `Bearer` | OpenAI Chat Completions |
| `openrouter` | `https://openrouter.ai/api/v1` | `Bearer` | OpenAI Chat Completions |
| `custom` | (requires `baseUrlOverride`) | `Bearer` | OpenAI Chat Completions |

### LLM auth modes

| `llm.mode` | Behavior |
|-------------|----------|
| `disabled` (default) | No LLM client created. Deterministic review only. |
| `inherit-or-fallback` | Attempt to inherit the current agent's auth profile. Fall back to gateway if `allowGatewayFallback=true`. |
| `explicit` | Use `keyRef` (SecretRef) or `authProfileRef` to provide credentials directly. |

## Configuration

Config is provided through OpenClaw's plugin config mechanism at `plugins.entries.skill-evolution.config`:

> **`enabled: false` is a true master switch.** When disabled, `register()` returns immediately -- no hooks are registered, no services are created, no background workers start, and no side effects occur. The plugin is completely inert.

```yaml
skillEvolution:
  enabled: true
  review:
    engine: llm
    minEvidenceCount: 2
  llm:
    mode: inherit-or-fallback
    provider: anthropic
  merge:
    requireHumanMerge: true
    maxRollbackVersions: 5
  queue:
    pollIntervalMs: 30000
    leaseMs: 300000
    maxAttempts: 3
```

See [docs/config.md](./docs/config.md) for the full configuration reference and [examples/config.example.yaml](./examples/config.example.yaml) for copy-pasteable examples.

## Commands

```bash
npm install          # Install dependencies
npm run build        # TypeScript compilation to dist/
npm run test         # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run lint         # Type check only (tsc --noEmit)
```

Run a single test file:

```bash
npx vitest run tests/plugin/test_config.ts
```

## Installation

```bash
git clone https://github.com/NEKO-CwC/skill-generation.git
cd skill-generation
npm install
npm run build

openclaw plugins install -l .
openclaw plugins enable skill-evolution
```

Then add your config to the OpenClaw main config under `plugins.entries.skill-evolution.config`.

## Verification

After installation, verify the plugin is working:

```bash
# Check plugin is registered and enabled
openclaw plugins list
openclaw plugins info skill-evolution

# Run plugin diagnostics
openclaw plugins doctor
```

During a session, look for structured JSON log lines prefixed with `[skill-evolution]`. Key indicators:

- `"Workspace bound from runtime context"` -- plugin has resolved the workspace directory
- `"Feedback collected"` -- tool errors or user corrections are being captured
- `"Overlay created"` / `"Overlay injected"` -- session overlays are active
- `"Review worker started"` -- background review service is polling
- `"Task enqueued"` / `"Task completed"` -- review tasks are being processed

If overlay injection is not appearing in prompts, check that `plugins.entries.skill-evolution.hooks.allowPromptInjection` is not set to `false` in your OpenClaw config.

## Runtime Storage

All paths are relative to the resolved workspace root:

```
.skill-overlays/<session-id>/<skill-key>.json   -- ephemeral session overlays
.skill-backups/<skill-key>/<version-id>.json    -- rollback history (max 5 per skill)
.skill-patches/<storage-key>/<patch-id>.md      -- pending manual merge patches / audit reports
.skill-feedback/<session-id>.jsonl              -- feedback audit trail
.skill-global/DEFAULT_SKILL.md                  -- global default learnings
.skill-global/tools/<tool>.md                   -- builtin tool learnings
.skill-review-queue/<task-id>.json              -- pending review tasks
.skill-review-queue/failed/<task-id>.json       -- exhausted review tasks
```
