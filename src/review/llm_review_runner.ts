import { ReviewFailedError } from '../shared/errors.js';
import ConsoleLogger from '../shared/logger.js';
import type {
  EvolutionTarget,
  LlmClient,
  ReviewResult,
  ReviewRunner,
  SessionSummary,
  SkillEvolutionConfig
} from '../shared/types.js';
import { getDefaultConfig } from '../plugin/config.js';

const DEFAULT_CONFIG: SkillEvolutionConfig = getDefaultConfig();

const SYSTEM_PROMPT = `You are a skill document reviewer for an AI agent framework. Your task is to review evidence from a coding session and produce an updated skill document.

Rules:
- Only output the final target document content (no patch reports, no metadata headers)
- If evidence is insufficient, respond with exactly: NO_MODIFICATION
- Make only minimal changes supported by the evidence
- Preserve the original document's structure and tone
- For builtin/global targets, write tool-specific or general behavioral guidance
- Output must be valid markdown`;

export class LlmReviewRunner implements ReviewRunner {
  private readonly config: SkillEvolutionConfig;
  private readonly llmClient: LlmClient | null;
  private readonly deterministicFallback: ReviewRunner;
  private readonly logger = new ConsoleLogger('llm_review_runner');

  public constructor(
    config: SkillEvolutionConfig = DEFAULT_CONFIG,
    llmClient: LlmClient | null = null,
    deterministicFallback?: ReviewRunner
  ) {
    this.config = config;
    this.llmClient = llmClient;
    this.deterministicFallback = deterministicFallback ?? new DeterministicReviewRunner(config);
  }

  public async runReview(summary: SessionSummary): Promise<ReviewResult> {
    if (!this.llmClient) {
      this.logger.info('No LLM client available, using deterministic fallback', {
        sessionId: summary.sessionId
      });
      return this.deterministicFallback.runReview(summary);
    }

    try {
      return await this.runLlmReview(summary);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('LLM review failed, falling back to deterministic', {
        sessionId: summary.sessionId,
        error: message
      });
      return this.deterministicFallback.runReview(summary);
    }
  }

  private async runLlmReview(summary: SessionSummary): Promise<ReviewResult> {
    const prompt = this.buildPrompt(summary);
    const response = await this.llmClient!.complete(prompt, SYSTEM_PROMPT);

    const isNoModification = response.trim() === 'NO_MODIFICATION';
    const overlayCount = summary.overlays.length;
    const correctionCount = summary.events.filter((e) => e.eventType === 'user_correction').length;
    const riskLevel = this.getRiskLevel(summary.totalErrors, correctionCount);
    const mergeMode = this.config.merge.requireHumanMerge ? 'manual' : 'auto';
    const patchId = `patch_${Date.now()}`;

    const primaryTarget = this.getPrimaryTarget(summary);
    const evidenceSummary = this.buildEvidenceSummary(summary);
    const proposedDiff = summary.overlays.map((entry) => entry.content).join('\n\n');

    const result: ReviewResult = {
      isModificationRecommended: !isNoModification,
      justification: isNoModification
        ? 'LLM review determined insufficient evidence for modification.'
        : `LLM review recommended changes based on ${summary.totalErrors} errors and ${correctionCount} corrections.`,
      proposedDiff,
      proposedDocument: isNoModification ? undefined : response.trim(),
      changeSummary: isNoModification ? undefined : `LLM-generated document update for ${primaryTarget.kind}:${primaryTarget.key}`,
      evidenceSummary,
      target: primaryTarget,
      riskLevel,
      reviewSource: 'llm',
      metadata: {
        skillKey: summary.skillKey,
        patchId,
        baseVersion: 'latest',
        sourceSessionId: summary.sessionId,
        mergeMode,
        riskLevel,
        rollbackChainDepth: 0
      }
    };

    this.logger.info('LLM review completed', {
      sessionId: summary.sessionId,
      recommended: result.isModificationRecommended,
      riskLevel,
      patchId,
      target: `${primaryTarget.kind}:${primaryTarget.key}`
    });

    return result;
  }

  private buildPrompt(summary: SessionSummary): string {
    const lines: string[] = [];

    const primaryTarget = this.getPrimaryTarget(summary);
    lines.push(`## Target: ${primaryTarget.kind}:${primaryTarget.key}`);
    lines.push('');

    const originalDoc = summary.overlays.length > 0
      ? summary.overlays.map((o) => o.content).join('\n\n')
      : '(No existing document content)';
    lines.push('## Current Document Content');
    lines.push(originalDoc);
    lines.push('');

    lines.push('## Session Evidence');
    const errors = summary.events.filter((e) => e.eventType === 'tool_error');
    if (errors.length > 0) {
      lines.push(`### Tool Errors (${errors.length})`);
      for (const err of errors.slice(0, 10)) {
        const normalized = err.normalizedError;
        if (normalized) {
          lines.push(`- **${normalized.toolName}**: ${normalized.message} (source: ${normalized.source})`);
        } else {
          lines.push(`- **${err.toolName ?? 'unknown'}**: ${err.messageExcerpt ?? 'no details'}`);
        }
      }
      lines.push('');
    }

    const corrections = summary.events.filter((e) => e.eventType === 'user_correction');
    if (corrections.length > 0) {
      lines.push(`### User Corrections (${corrections.length})`);
      for (const corr of corrections.slice(0, 10)) {
        lines.push(`- ${corr.messageExcerpt ?? 'no details'}`);
      }
      lines.push('');
    }

    const positives = summary.events.filter((e) => e.eventType === 'positive_feedback');
    if (positives.length > 0) {
      lines.push(`### Positive Feedback (${positives.length})`);
      for (const pos of positives.slice(0, 5)) {
        lines.push(`- ${pos.messageExcerpt ?? 'no details'}`);
      }
      lines.push('');
    }

    if (summary.overlays.length > 0) {
      lines.push(`### Session Overlays (${summary.overlays.length})`);
      for (const overlay of summary.overlays) {
        lines.push(`- ${overlay.reasoning}: ${overlay.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    lines.push('## Instructions');
    lines.push('Based on the evidence above, produce an updated version of the target document.');
    lines.push('If the evidence is insufficient to justify changes, respond with exactly: NO_MODIFICATION');

    return lines.join('\n');
  }

  private buildEvidenceSummary(summary: SessionSummary): string {
    const errors = summary.events.filter((e) => e.eventType === 'tool_error').length;
    const corrections = summary.events.filter((e) => e.eventType === 'user_correction').length;
    const positives = summary.events.filter((e) => e.eventType === 'positive_feedback').length;
    return `${errors} errors, ${corrections} corrections, ${positives} positive signals, ${summary.overlays.length} overlays over ${Math.round(summary.durationMs / 1000)}s`;
  }

  private getPrimaryTarget(summary: SessionSummary): EvolutionTarget {
    if (summary.targets && summary.targets.length > 0) {
      return summary.targets[0];
    }

    const eventWithTarget = summary.events.find((e) => e.target);
    if (eventWithTarget?.target) {
      return eventWithTarget.target;
    }

    return {
      kind: 'global',
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc'
    };
  }

  private getRiskLevel(totalErrors: number, correctionCount: number): 'low' | 'medium' | 'high' {
    const combined = totalErrors + correctionCount;
    if (combined <= 1) return 'low';
    if (combined <= 3) return 'medium';
    return 'high';
  }
}

export class DeterministicReviewRunner implements ReviewRunner {
  private readonly config: SkillEvolutionConfig;
  private readonly logger = new ConsoleLogger('deterministic_review_runner');

  public constructor(config: SkillEvolutionConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  public async runReview(summary: SessionSummary): Promise<ReviewResult> {
    try {
      const overlayCount = summary.overlays.length;
      const correctionCount = summary.events.filter((e) => e.eventType === 'user_correction').length;
      const positiveCount = summary.events.filter((e) => e.eventType === 'positive_feedback').length;
      const shouldRecommend = summary.totalErrors > 0 || correctionCount > 0 || overlayCount > 0;

      const riskLevel = this.getRiskLevel(summary.totalErrors, correctionCount);
      const proposedDiff = summary.overlays.map((entry) => entry.content).join('\n\n');
      const mergeMode = this.config.merge.requireHumanMerge ? 'manual' : 'auto';
      const patchId = `patch_${Date.now()}`;

      const primaryTarget = summary.targets?.[0] ?? summary.events.find((e) => e.target)?.target;
      const evidenceSummary = `${summary.totalErrors} errors, ${correctionCount} corrections, ${positiveCount} positive signals, ${overlayCount} overlays`;

      const result: ReviewResult = {
        isModificationRecommended: shouldRecommend,
        justification: `Session had ${summary.totalErrors} errors, ${correctionCount} corrections, ${positiveCount} positive signals, and ${overlayCount} overlays.`,
        proposedDiff,
        evidenceSummary,
        target: primaryTarget,
        riskLevel,
        reviewSource: 'deterministic',
        metadata: {
          skillKey: summary.skillKey,
          patchId,
          baseVersion: 'latest',
          sourceSessionId: summary.sessionId,
          mergeMode,
          riskLevel,
          rollbackChainDepth: 0
        }
      };

      this.logger.info('Review completed', {
        sessionId: summary.sessionId,
        skillKey: summary.skillKey,
        recommended: result.isModificationRecommended,
        riskLevel: result.riskLevel,
        patchId
      });

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewFailedError(`Failed to run deterministic review: ${message}`);
    }
  }

  private getRiskLevel(totalErrors: number, correctionCount: number): 'low' | 'medium' | 'high' {
    const combined = totalErrors + correctionCount;
    if (combined <= 1) return 'low';
    if (combined <= 3) return 'medium';
    return 'high';
  }
}

export default LlmReviewRunner;
