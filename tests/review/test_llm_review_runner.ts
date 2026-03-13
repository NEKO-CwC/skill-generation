import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { DeterministicReviewRunner, LlmReviewRunner } from '../../src/review/llm_review_runner.ts';
import { ReviewFailedError } from '../../src/shared/errors.ts';
import type { EvolutionTarget, FeedbackEvent, LlmClient, OverlayEntry, SessionSummary } from '../../src/shared/types.ts';

const makeTarget = (kind: EvolutionTarget['kind'] = 'skill'): EvolutionTarget => ({
  kind,
  key: kind === 'skill' ? 'my-skill' : kind === 'builtin' ? 'read' : 'default',
  storageKey: kind === 'skill' ? 'my-skill' : kind === 'builtin' ? 'builtin-read' : 'global-default',
  mergeMode: kind === 'skill' ? 'skill-doc' : kind === 'unresolved' ? 'queue-only' : 'global-doc'
});

const makeSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: 'test-session',
  skillKey: 'test.skill',
  events: [],
  overlays: [],
  durationMs: 1000,
  totalErrors: 0,
  ...overrides
});

const makeOverlay = (content: string): OverlayEntry => ({
  sessionId: 'test-session',
  skillKey: 'test.skill',
  content,
  createdAt: 1,
  updatedAt: 1,
  reasoning: 'test reasoning'
});

const makeEvent = (
  eventType: FeedbackEvent['eventType'],
  overrides: Partial<FeedbackEvent> = {}
): FeedbackEvent => ({
  sessionId: 'test-session',
  skillKey: 'test.skill',
  timestamp: 1,
  eventType,
  severity: 'medium',
  ...overrides
});

const makeLlmClient = (response: string): LlmClient => ({
  complete: async (_prompt: string, _system?: string) => response
});

const makeFailingLlmClient = (error: string): LlmClient => ({
  complete: async () => {
    throw new Error(error);
  }
});

describe('review/llm_review_runner - LlmReviewRunner', () => {
  it('falls back to deterministic review when llmClient is null', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), null);
    const result = await runner.runReview(makeSummary({ totalErrors: 1 }));

    expect(result.reviewSource).toBe('deterministic');
    expect(result.isModificationRecommended).toBe(true);
  });

  it('returns deterministic reviewSource when no client is provided', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), null);
    const result = await runner.runReview(makeSummary());

    expect(result.reviewSource).toBe('deterministic');
  });

  it('returns reviewSource llm and proposedDocument from valid LLM content', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('  # Updated document\n'));
    const result = await runner.runReview(makeSummary());

    expect(result.reviewSource).toBe('llm');
    expect(result.isModificationRecommended).toBe(true);
    expect(result.proposedDocument).toBe('# Updated document');
  });

  it('uses NO_MODIFICATION response to disable recommendation and omit proposedDocument', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('  NO_MODIFICATION  '));
    const result = await runner.runReview(makeSummary());

    expect(result.reviewSource).toBe('llm');
    expect(result.isModificationRecommended).toBe(false);
    expect(result.proposedDocument).toBeUndefined();
    expect(result.changeSummary).toBeUndefined();
  });

  it('includes target kind:key in changeSummary for LLM-generated updates', async () => {
    const target = makeTarget('builtin');
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('new doc'));
    const result = await runner.runReview(makeSummary({ targets: [target] }));

    expect(result.changeSummary).toContain('builtin:read');
  });

  it('evidenceSummary includes error, correction, and positive counts', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('new doc'));
    const summary = makeSummary({
      durationMs: 3200,
      totalErrors: 2,
      overlays: [makeOverlay('overlay A')],
      events: [
        makeEvent('tool_error', { messageExcerpt: 'failed tool call' }),
        makeEvent('user_correction', { messageExcerpt: 'use x not y' }),
        makeEvent('positive_feedback', { messageExcerpt: 'good result' })
      ]
    });
    const result = await runner.runReview(summary);

    expect(result.evidenceSummary).toContain('1 errors');
    expect(result.evidenceSummary).toContain('1 corrections');
    expect(result.evidenceSummary).toContain('1 positive signals');
    expect(result.evidenceSummary).toContain('1 overlays');
    expect(result.evidenceSummary).toContain('3s');
  });

  it('falls back to deterministic review when LLM throws and still returns valid result', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeFailingLlmClient('upstream timeout'));
    const result = await runner.runReview(makeSummary({ totalErrors: 1 }));

    expect(result.reviewSource).toBe('deterministic');
    expect(result.riskLevel).toBe('low');
    expect(result.metadata.sourceSessionId).toBe('test-session');
  });

  it('uses low risk for 0-1 combined errors and corrections', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('doc'));

    await expect(runner.runReview(makeSummary({ totalErrors: 0, events: [] }))).resolves.toMatchObject({
      riskLevel: 'low'
    });
    await expect(
      runner.runReview(
        makeSummary({
          totalErrors: 0,
          events: [makeEvent('user_correction', { messageExcerpt: 'fix it' })]
        })
      )
    ).resolves.toMatchObject({ riskLevel: 'low' });
  });

  it('uses medium risk for 2-3 combined errors and corrections', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('doc'));

    await expect(runner.runReview(makeSummary({ totalErrors: 2 }))).resolves.toMatchObject({ riskLevel: 'medium' });
    await expect(
      runner.runReview(
        makeSummary({
          totalErrors: 1,
          events: [makeEvent('user_correction', { messageExcerpt: 'fix it' })]
        })
      )
    ).resolves.toMatchObject({ riskLevel: 'medium' });
  });

  it('uses high risk for 4+ combined errors and corrections', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('doc'));

    await expect(runner.runReview(makeSummary({ totalErrors: 4 }))).resolves.toMatchObject({ riskLevel: 'high' });
  });

  it('uses summary.targets[0] as primary target when available', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('doc'));
    const target = makeTarget('builtin');
    const result = await runner.runReview(makeSummary({ targets: [target] }));

    expect(result.target).toEqual(target);
  });

  it('falls back to event target when summary.targets is missing', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('doc'));
    const eventTarget = makeTarget('skill');
    const result = await runner.runReview(
      makeSummary({
        targets: undefined,
        events: [makeEvent('tool_error', { target: eventTarget, messageExcerpt: 'failure' })]
      })
    );

    expect(result.target).toEqual(eventTarget);
  });

  it('falls back to global default target when no targets exist anywhere', async () => {
    const runner = new LlmReviewRunner(getDefaultConfig(), makeLlmClient('doc'));
    const result = await runner.runReview(makeSummary({ targets: undefined, events: [] }));

    expect(result.target).toEqual({
      kind: 'global',
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc'
    });
  });
});

describe('review/llm_review_runner - DeterministicReviewRunner', () => {
  it('recommends modification when totalErrors > 0', async () => {
    const runner = new DeterministicReviewRunner();
    const result = await runner.runReview(makeSummary({ totalErrors: 1 }));

    expect(result.isModificationRecommended).toBe(true);
  });

  it('recommends modification when corrections > 0', async () => {
    const runner = new DeterministicReviewRunner();
    const result = await runner.runReview(
      makeSummary({ events: [makeEvent('user_correction', { messageExcerpt: 'please update' })] })
    );

    expect(result.isModificationRecommended).toBe(true);
  });

  it('recommends modification when overlays > 0', async () => {
    const runner = new DeterministicReviewRunner();
    const result = await runner.runReview(makeSummary({ overlays: [makeOverlay('overlay 1')] }));

    expect(result.isModificationRecommended).toBe(true);
  });

  it('does not recommend when no errors, corrections, or overlays', async () => {
    const runner = new DeterministicReviewRunner();
    const result = await runner.runReview(makeSummary());

    expect(result.isModificationRecommended).toBe(false);
  });

  it('uses low/medium/high risk levels for 0-1, 2-3, and 4+ combined signals', async () => {
    const runner = new DeterministicReviewRunner();

    await expect(runner.runReview(makeSummary({ totalErrors: 1 }))).resolves.toMatchObject({ riskLevel: 'low' });
    await expect(runner.runReview(makeSummary({ totalErrors: 2 }))).resolves.toMatchObject({ riskLevel: 'medium' });
    await expect(runner.runReview(makeSummary({ totalErrors: 4 }))).resolves.toMatchObject({ riskLevel: 'high' });
  });

  it('always reports deterministic reviewSource', async () => {
    const runner = new DeterministicReviewRunner();
    const result = await runner.runReview(makeSummary({ totalErrors: 1 }));

    expect(result.reviewSource).toBe('deterministic');
  });

  it('follows config.merge.requireHumanMerge for mergeMode', async () => {
    const manualConfig = getDefaultConfig();
    manualConfig.merge.requireHumanMerge = true;
    const autoConfig = getDefaultConfig();
    autoConfig.merge.requireHumanMerge = false;

    const manualRunner = new DeterministicReviewRunner(manualConfig);
    const autoRunner = new DeterministicReviewRunner(autoConfig);

    const manualResult = await manualRunner.runReview(makeSummary({ totalErrors: 1 }));
    const autoResult = await autoRunner.runReview(makeSummary({ totalErrors: 1 }));

    expect(manualResult.metadata.mergeMode).toBe('manual');
    expect(autoResult.metadata.mergeMode).toBe('auto');
  });

  it('includes evidence counts in evidenceSummary', async () => {
    const runner = new DeterministicReviewRunner();
    const result = await runner.runReview(
      makeSummary({
        totalErrors: 2,
        overlays: [makeOverlay('o1'), makeOverlay('o2')],
        events: [
          makeEvent('user_correction', { messageExcerpt: 'fix style' }),
          makeEvent('positive_feedback', { messageExcerpt: 'nice' })
        ]
      })
    );

    expect(result.evidenceSummary).toContain('2 errors');
    expect(result.evidenceSummary).toContain('1 corrections');
    expect(result.evidenceSummary).toContain('1 positive signals');
    expect(result.evidenceSummary).toContain('2 overlays');
  });

  it('extracts target from summary.targets[0] when available', async () => {
    const runner = new DeterministicReviewRunner();
    const target = makeTarget('builtin');
    const result = await runner.runReview(makeSummary({ targets: [target] }));

    expect(result.target).toEqual(target);
  });

  it('wraps unexpected errors as ReviewFailedError', async () => {
    const runner = new DeterministicReviewRunner();
    const invalidSummary = {
      ...makeSummary(),
      overlays: null
    } as unknown as SessionSummary;

    await expect(runner.runReview(invalidSummary)).rejects.toBeInstanceOf(ReviewFailedError);
  });
});
