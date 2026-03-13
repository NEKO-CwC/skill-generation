# Configuration Reference

The Skill Evolution plugin is configured through OpenClaw's plugin config at `plugins.entries.skill-evolution.config`. All fields have defaults; the plugin works with zero configuration.

## Top-level

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch. When `false`, no hooks are registered. |

## `review`

Controls how session evidence is reviewed at session end.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `review.engine` | `'deterministic'` \| `'llm'` | `'deterministic'` | Review strategy. `deterministic` uses rule-based heuristics (error count, correction count, overlay count). `llm` sends evidence to an LLM for structured review, with automatic fallback to deterministic if auth fails or LLM is unavailable. |
| `review.minEvidenceCount` | integer (>= 0) | `2` | Minimum number of feedback events required before a review produces a modification recommendation. |
| `review.allowAutoMergeOnLowRiskOnly` | boolean | `false` | When `true`, auto-merge is only allowed for low-risk patches. Medium and high risk patches are forced to manual review. |

## `llm`

Controls LLM auth resolution and client configuration. Only relevant when `review.engine=llm`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `llm.mode` | `'disabled'` \| `'inherit-or-fallback'` \| `'explicit'` | `'disabled'` | Auth resolution strategy. See "Auth resolution modes" below. |
| `llm.provider` | `'anthropic'` \| `'openai-compatible'` \| `'custom'` | `'anthropic'` | LLM provider. Determines which API format is used for completions. |
| `llm.authProfileRef` | string \| null | `null` | Profile ID referencing an entry in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`. Used by `inherit-or-fallback` and `explicit` modes to look up stored credentials. |
| `llm.keyRef` | SecretRef \| null | `null` | Direct secret reference for API key resolution. See "SecretRef format" below. |
| `llm.allowExecSecretRef` | boolean | `false` | Safety gate. Must be `true` for `keyRef.source=exec` to be accepted. Prevents accidental command execution. |
| `llm.allowGatewayFallback` | boolean | `false` | When `true` and `mode=inherit-or-fallback`, allows falling back to the OpenClaw gateway for auth if all other methods fail. |
| `llm.inheritPrimaryConfig` | boolean | `true` | Whether to inherit model settings from the agent's primary config. |
| `llm.modelOverride` | string \| null | `null` | Override the model ID used for review completions. |
| `llm.thinkingOverride` | boolean \| null | `null` | Override whether the LLM uses extended thinking. |
| `llm.baseUrlOverride` | string \| null | `null` | Override the base URL for the LLM API endpoint. |

### Auth resolution modes

**`disabled`** (default)

No LLM client is created. The plugin uses deterministic review only. This is the safest default -- no external API calls are made.

**`inherit-or-fallback`**

The plugin attempts to resolve auth in this priority order:

1. `authProfileRef` -- look up the referenced profile in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
2. Agent's current auth profile -- inherit from the running agent's own credentials
3. Gateway fallback -- if `allowGatewayFallback=true`, attempt to use the OpenClaw gateway

If all steps return null, the plugin falls back to deterministic review and logs the reason.

**`explicit`**

The plugin uses exactly the credentials provided:

1. `keyRef` -- resolve the API key from env var, file, or exec command
2. `authProfileRef` -- look up the referenced profile

No inheritance, no gateway fallback. If neither `keyRef` nor `authProfileRef` resolves, the plugin falls back to deterministic review.

### SecretRef format

`keyRef` uses the `SecretRef` type to resolve an API key at runtime:

```typescript
interface SecretRef {
  source: 'env' | 'file' | 'exec';
  id: string;
  args?: string[];
}
```

| `source` | Behavior | `id` meaning | `args` |
|----------|----------|-------------|--------|
| `env` | Read from environment variable | Variable name (e.g., `ANTHROPIC_API_KEY`) | Not used |
| `file` | Read from file on disk | File path | Not used |
| `exec` | Execute a command and use stdout | Command to run | Command arguments |

**Security:** `source=exec` requires `llm.allowExecSecretRef=true` in config. This is a safety gate to prevent accidental command execution from config files.

Example configs:

```yaml
# From environment variable
keyRef:
  source: env
  id: ANTHROPIC_API_KEY

# From a file
keyRef:
  source: file
  id: /home/user/.secrets/anthropic.key

# From a command (requires allowExecSecretRef: true)
keyRef:
  source: exec
  id: op
  args: ["read", "op://vault/anthropic/api-key"]
```

## `merge`

Controls merge policy and rollback behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `merge.requireHumanMerge` | boolean | `true` | When `true`, all patches go to `.skill-patches/` for human review. No auto-merge occurs regardless of risk level. |
| `merge.maxRollbackVersions` | integer (>= 1) | `5` | Maximum number of backup versions kept per skill. Oldest version is dropped on overflow. |

## `sessionOverlay`

Controls session-local overlay behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionOverlay.enabled` | boolean | `true` | Whether to create and inject session overlays. |
| `sessionOverlay.storageDir` | string | `'.skill-overlays'` | Directory for overlay storage, relative to workspace root. |
| `sessionOverlay.injectMode` | `'system-context'` \| `'tool-description'` | `'system-context'` | How overlays are injected into prompts. `system-context` prepends to the system prompt. |
| `sessionOverlay.clearOnSessionEnd` | boolean | `true` | Whether to delete session overlays after the session ends and review completes. |

## `triggers`

Controls which feedback signals the plugin responds to.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `triggers.onToolError` | boolean | `true` | Capture tool errors via `after_tool_call`. |
| `triggers.onUserCorrection` | boolean | `true` | Detect user corrections via `message_received`. |
| `triggers.onSessionEndReview` | boolean | `true` | Run review pipeline at session end. |
| `triggers.onPositiveFeedback` | boolean | `true` | Capture positive feedback signals. |

## `queue`

Controls the background review worker.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `queue.pollIntervalMs` | integer (>= 1000) | `30000` | How often the review worker polls for new tasks, in milliseconds. |
| `queue.leaseMs` | integer (>= 10000) | `300000` | Lease duration for a dequeued task, in milliseconds (default 5 minutes). If the worker crashes, the task becomes eligible for re-dequeue after lease expiry. |
| `queue.maxAttempts` | integer (>= 1) | `3` | Maximum retry attempts before a task is moved to `failed/`. |

## Auth resolution priority chain

When `review.engine=llm` and `llm.mode` is not `disabled`, the plugin resolves auth in this order:

1. **`keyRef`** -- if provided and resolves successfully, use it directly
2. **`authProfileRef`** -- if provided, look up the profile in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
3. **Agent auth profile** (inherit-or-fallback only) -- inherit from the running agent
4. **Gateway fallback** (inherit-or-fallback only, if `allowGatewayFallback=true`) -- use OpenClaw gateway

If all steps return null, the plugin logs the failure reason and falls back to deterministic review. The session still completes normally; only the review quality is affected.

The resolved auth is represented as:

```typescript
interface ResolvedAuth {
  apiKey: string;
  provider: 'anthropic' | 'openai-compatible' | 'custom';
  baseUrl?: string;
  profileId?: string;
  source: 'authProfileRef' | 'keyRef' | 'agent-auth-profile' | 'gateway-fallback';
}
```
