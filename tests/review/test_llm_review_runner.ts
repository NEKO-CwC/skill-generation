import { describe, expect, it, beforeEach } from 'vitest';
import { LLMReviewRunner } from '../../src/review/llm_review_runner.js';
import { getDefaultConfig } from '../../src/plugin/config.js';
import type { ResolvedPaths, SessionSummary } from '../../src/shared/types.js';

describe('review/llm_review_runner', () => {
  // Use actual workspace path
  const workspaceDir = '/home/node/.openclaw/workspace';
  const mockPaths: ResolvedPaths = {
    workspaceDir,
    overlaysDir: `${workspaceDir}/.skill-overlays`,
    patchesDir: `${workspaceDir}/.skill-patches`,
    backupsDir: `${workspaceDir}/.skill-backups`,
    skillsDir: `${workspaceDir}/skills`,
    feedbackDir: `${workspaceDir}/.skill-feedback`
  };

  beforeEach(() => {
    // Reset module cache if needed
  });

  const baseSummary = (totalErrors: number, events: any[] = [], overlaysCount: number = 0): SessionSummary => ({
    sessionId: 'session-1',
    skillKey: 'exa',
    events,
    overlays: Array.from({ length: overlaysCount }, (_, idx) => ({
      sessionId: 'session-1',
      skillKey: 'exa',
      content: `overlay-${idx + 1}`,
      createdAt: idx,
      updatedAt: idx,
      reasoning: 'reason'
    })),
    durationMs: 100,
    totalErrors
  });

  it('recommends modification when errors present and LLM call fails falls back', async () => {
    const config = getDefaultConfig();
    // Use invalid model to force LLM failure and fallback
    config.llm.modelOverride = 'invalid/nonexistent-model';
    config.merge.requireHumanMerge = true;
    const runner = new LLMReviewRunner(config, mockPaths);

    const summary = baseSummary(1, [
      {
        sessionId: 'session-1',
        skillKey: 'exa',
        timestamp: Date.now(),
        eventType: 'tool_error',
        severity: 'high',
        toolName: 'web_search',
        messageExcerpt: 'API error'
      }
    ], 1);

    const result = await runner.runReview(summary);
    expect(result.isModificationRecommended).toBe(true);
    // With 1 error, risk should be low
    expect(result.riskLevel).toBe('low');
    expect(result.metadata.mergeMode).toBe('manual');
    expect(typeof result.proposedDiff).toBe('string');
    // Fallback should include overlay content and LLM unavailable header
    expect(result.proposedDiff).toContain('LLM Unavailable');
    expect(result.proposedDiff).toContain('overlay-1');
  });

  it('does not recommend modification when no issues', async () => {
    const config = getDefaultConfig();
    config.llm.modelOverride = null;
    const runner = new LLMReviewRunner(config, mockPaths);

    const summary = baseSummary(0, []);
    const result = await runner.runReview(summary);
    expect(result.isModificationRecommended).toBe(false);
    expect(result.proposedDiff).toBe('');
  });

  it('gracefully falls back when LLM call fails', async () => {
    const config = getDefaultConfig();
    config.llm.modelOverride = 'invalid/model-not-exist';
    config.merge.requireHumanMerge = true;
    const runner = new LLMReviewRunner(config, mockPaths);

    const summary = baseSummary(1, [
      {
        sessionId: 'session-1',
        skillKey: 'exa',
        timestamp: Date.now(),
        eventType: 'tool_error',
        severity: 'medium',
        toolName: 'read',
        messageExcerpt: 'File not found'
      }
    ], 1);

    const result = await runner.runReview(summary);
    expect(result.isModificationRecommended).toBe(true);
    // Fallback should include overlay content (LLM unavailable)
    expect(result.proposedDiff).toContain('overlay-1');
    expect(result.justification).toContain('fallback');
  });
});
