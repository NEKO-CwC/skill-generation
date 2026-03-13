import { describe, expect, it } from 'vitest';
import { PatchGeneratorImpl } from '../../src/review/patch_generator.ts';
import type { ReviewResult } from '../../src/shared/types.ts';

describe('review/patch_generator', () => {
  it('includes expected patch sections and metadata lines', () => {
    const generator = new PatchGeneratorImpl();
    const result: ReviewResult = {
      isModificationRecommended: true,
      justification: 'errors found',
      proposedDiff: 'replace old guidance with new guidance',
      reviewSource: 'deterministic',
      riskLevel: 'medium',
      metadata: {
        skillKey: 'skill.alpha',
        patchId: 'patch_123',
        baseVersion: 'latest',
        sourceSessionId: 'session_99',
        mergeMode: 'manual',
        riskLevel: 'medium',
        rollbackChainDepth: 0
      }
    };

    const patch = generator.generate(result, '# old skill content');

    expect(patch).toContain('--- PATCH: skill.alpha ---');
    expect(patch).toContain('Patch ID: patch_123');
    expect(patch).toContain('Risk: medium');
    expect(patch).toContain('Source Session: session_99');
    expect(patch).toContain('## Proposed Changes');
    expect(patch).toContain('replace old guidance with new guidance');
    expect(patch).toContain('## Original Content');
    expect(patch).toContain('# old skill content');
  });

  describe('generateSplit', () => {
    const buildResult = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
      isModificationRecommended: true,
      justification: 'reviewed',
      proposedDiff: 'old -> new',
      riskLevel: 'low',
      reviewSource: 'llm',
      metadata: {
        skillKey: 'skill.alpha',
        patchId: 'patch_split_1',
        baseVersion: 'latest',
        sourceSessionId: 'session_split_1',
        mergeMode: 'manual',
        riskLevel: 'low',
        rollbackChainDepth: 0
      },
      ...overrides
    });

    it('returns reportPatch and null mergeableDocument when proposedDocument is absent', () => {
      const generator = new PatchGeneratorImpl();
      const result = buildResult();

      const output = generator.generateSplit(result, '# original');

      expect(output.reportPatch).toContain('--- PATCH: skill.alpha ---');
      expect(output.mergeableDocument).toBeNull();
    });

    it('returns reportPatch and mergeableDocument when proposedDocument exists', () => {
      const generator = new PatchGeneratorImpl();
      const result = buildResult({ proposedDocument: '# Proposed Skill\nupdated content' });

      const output = generator.generateSplit(result, '# original');

      expect(output.reportPatch).toContain('## Proposed Document');
      expect(output.mergeableDocument).toBe('# Proposed Skill\nupdated content');
    });

    it('includes target info, review source, summaries, and proposed document section when provided', () => {
      const generator = new PatchGeneratorImpl();
      const result = buildResult({
        reviewSource: 'deterministic',
        target: { kind: 'builtin', key: 'read', storageKey: 'builtin-read', mergeMode: 'global-doc' },
        changeSummary: 'Updated instructions for tool usage.',
        evidenceSummary: 'Observed repeated user corrections across sessions.',
        proposedDocument: '# New Document\nbody'
      });

      const output = generator.generateSplit(result, '# original');

      expect(output.reportPatch).toContain('Target: builtin:read');
      expect(output.reportPatch).toContain('Review Source: deterministic');
      expect(output.reportPatch).toContain('## Change Summary');
      expect(output.reportPatch).toContain('Updated instructions for tool usage.');
      expect(output.reportPatch).toContain('## Evidence Summary');
      expect(output.reportPatch).toContain('Observed repeated user corrections across sessions.');
      expect(output.reportPatch).toContain('## Proposed Document');
      expect(output.reportPatch).toContain('# New Document\nbody');
    });

    it('includes review source field in report patch output', () => {
      const generator = new PatchGeneratorImpl();
      const result = buildResult({ reviewSource: 'llm' });

      const output = generator.generateSplit(result, '# original');

      expect(output.reportPatch).toContain('Review Source: llm');
    });
  });
});
