# Implementation Specification: OpenClaw Skill Evolution Plugin

## Module Responsibilities

### 1. `src/plugin/hooks/` (Lifecycle Event Handling)
- **`before_prompt_build.ts`**: Injects current session overlays into the prompt.
- **`after_tool_call.ts`**: Captures tool results, errors, and performance signals.
- **`message_received.ts`**: Identifies user corrections and feedback patterns.
- **`agent_end.ts`**: Triggers the post-session review subagent.

### 2. `src/plugin/overlay/` (Session-Local Storage)
- **`overlay_store.ts`**: CRUD operations for session-local `.md` files in `.skill-overlays/`.
- **`overlay_injector.ts`**: Logic for merging overlays into OpenClaw's prompt structure.

### 3. `src/plugin/feedback/` (Feedback Logic)
- **`collector.ts`**: Buffers feedback events for review.
- **`classifiers.ts`**: Logic for determining if a feedback signal warrants an overlay or permanent change.

### 4. `src/review/` (Evolution Management)
- **`review_runner.ts`**: Orchestrates spawning the subagent and passing session logs.
- **`patch_generator.ts`**: Extracts structured skill updates from subagent responses.
- **`merge_manager.ts`**: Handles writing patches back to skill files and updating history.
- **`rollback_manager.ts`**: Manages the rolling 5-version backup system.

---

## Configuration Schema (TypeScript)

```typescript
export interface SkillEvolutionConfig {
  enabled: boolean;
  merge: {
    requireHumanMerge: boolean; // Global switch for manual approval
    maxRollbackVersions: number; // Default: 5
  };
  sessionOverlay: {
    enabled: boolean;
    storageDir: string; // Default: ".skill-overlays"
    injectMode: "system-context" | "user-context";
    clearOnSessionEnd: boolean;
  };
  triggers: {
    onToolError: boolean;
    onUserCorrection: boolean;
    onSessionEndReview: boolean;
    onPositiveFeedback: boolean;
  };
  llm: {
    inheritPrimaryConfig: boolean;
    modelOverride?: string;
    thinkingOverride?: boolean;
  };
  review: {
    minEvidenceCount: number; // Minimum events required to trigger review
    allowAutoMergeOnLowRiskOnly: boolean;
  };
}
```

---

## Data Structures (TypeScript)

### FeedbackEvent
Captured during a session to track issues and feedback.
```typescript
export interface FeedbackEvent {
  sessionId: string;
  skillKey: string;
  timestamp: string; // ISO 8601
  eventType: 'user_correction' | 'tool_error' | 'positive_feedback' | 'retry_loop';
  severity: 'low' | 'medium' | 'high';
  toolName?: string;
  messageExcerpt?: string;
  proposedOverlay?: string; // Auto-generated temporary fix
}
```

### PatchMetadata
Records the details of a generated patch.
```typescript
export interface PatchMetadata {
  skillKey: string;
  patchId: string;
  baseVersionHash: string;
  sourceSessionId: string;
  mergeMode: 'auto' | 'manual';
  riskLevel: 'low' | 'medium' | 'high';
  rollbackChainDepth: number;
  timestamp: string;
}
```

---

## Detailed Logic Flow

### A. Trigger Conditions (Feedback Identification)
The plugin must recognize feedback using mixed signals:
1. **Tool Error**: Direct failure from a tool execution (`onToolError`).
2. **Explicit Correction**: Regex or heuristic-based detection of user feedback (e.g., "Don't do that", "Use tool X instead").
3. **Implicit Correction**: Repeating similar tool calls with different parameters after failure.

### B. Session Overlay Lifecycle
1. **Creation**: Triggered by high-severity feedback. Saved to `${storageDir}/${sessionId}/${skillKey}.md`.
2. **Injection**: `before_prompt_build` reads available overlays for the current session and appends them to the prompt.
3. **Cleanup**: If `clearOnSessionEnd` is true, the `SESSION_ID` directory is deleted after the review subagent completes.

### C. Review & Merge Flow
1. **Evidence Gathering**: Summarize all `FeedbackEvent` objects for the session.
2. **Subagent Review**: Spawn a subagent with `review_subagent.md` as the system prompt.
3. **Draft Generation**: Subagent produces a `PATCH.md` containing diffs or updated content.
4. **Merge Decision**:
    - If `requireHumanMerge` is true: Notify user and wait for approval.
    - If `requireHumanMerge` is false: Apply patch.
5. **Finalization**: Update the skill file, save a backup of the previous version, and log to `patch_history.json`.

### D. Rollback Management (Cap at 5)
- Every permanent change triggers a backup of the current `SKILL.md` to `.backups/${skillKey}/v1...v5`.
- If backups exceed 5, the oldest (v1) is deleted, and others are shifted.
- Rollback replaces the active `SKILL.md` with the most recent backup.

---

## Error Handling Requirements
- **Overlay Failure**: If an overlay file cannot be read/written, log a warning but do not crash the session.
- **Review Failure**: If the subagent fails to respond or produces invalid JSON/Markdown, retry once; if it fails again, abort the evolution for that session.
- **Merge Conflict**: If a skill file was manually edited during a session, detect the hash mismatch and mark the patch for manual review (ignoring the auto-merge setting).

---

## Acceptance Criteria per Module

### Plugin Hooks & Feedback
- [ ] Successfully captures tool failures as `FeedbackEvent`.
- [ ] Correctly identifies user corrections in messages.
- [ ] Correctly builds the evidence list for the review runner.

### Overlay System
- [ ] Overlays are isolated per session ID.
- [ ] Overlays are correctly injected into OpenClaw's prompt build process.
- [ ] No pollution occurs between concurrent sessions.

### Review & Patching
- [ ] Subagent generates a valid, non-empty `PATCH.md` based on session evidence.
- [ ] `merge_manager` correctly handles the `requireHumanMerge` flag.
- [ ] Skill files are updated only when intended.

### Rollback & History
- [ ] Backups are created *before* every merge.
- [ ] Version chain is strictly capped at 5.
- [ ] Rollback successfully restores the previous version and increments the version chain correctly.

---

## ⚠️ To Be Verified
- **Injection Priority**: Should overlays be placed at the start or end of the system prompt?
- **Subagent Context Window**: Ensure the session summary doesn't exceed the subagent's token limit.
- **Backup File Format**: Decide whether to store full copies or incremental diffs (full copies are safer for v1).
