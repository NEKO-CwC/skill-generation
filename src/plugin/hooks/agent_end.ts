/**
 * Hook invoked on session termination for review and merge decisions.
 */

import { join } from 'node:path';
import { fileExists, readFile } from '../../shared/fs.js';
import type { SessionSummary } from '../../shared/types.js';
import type { SkillEvolutionPlugin } from '../index.js';

async function readCurrentSkillContent(skillsDir: string, skillKey: string): Promise<string> {
  const skillFilePath = join(skillsDir, skillKey, 'SKILL.md');
  if (await fileExists(skillFilePath)) {
    return readFile(skillFilePath);
  }
  return '';
}

/**
 * Handles end-of-session lifecycle: summary → review → patch → merge pipeline.
 */
export async function agent_end(plugin: SkillEvolutionPlugin, sessionId: string): Promise<void> {
  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);
  const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  const overlays = await plugin.overlayStore.listBySession(sessionId);

  const summary: SessionSummary = {
    sessionId,
    skillKey,
    events,
    overlays,
    durationMs: Date.now() - plugin.getSessionStartTime(sessionId),
    totalErrors: events.filter((event) => event.eventType === 'tool_error').length
  };

  plugin.logger.info('Session summary collected', {
    sessionId: summary.sessionId,
    skillKey: summary.skillKey,
    eventCount: summary.events.length,
    overlayCount: summary.overlays.length,
    durationMs: summary.durationMs,
    totalErrors: summary.totalErrors
  });

  if (plugin.config.triggers.onSessionEndReview) {
    await runReviewPipeline(plugin, summary);
  }

  if (plugin.config.sessionOverlay.clearOnSessionEnd) {
    await plugin.overlayStore.clearSession(sessionId);
  }

  plugin.endSession(sessionId);
}

async function runReviewPipeline(plugin: SkillEvolutionPlugin, summary: SessionSummary): Promise<void> {
  const { sessionId, skillKey } = summary;
  const minEvidence = plugin.config.review.minEvidenceCount;
  const totalEvidence = summary.events.length;

  if (totalEvidence < minEvidence) {
    plugin.logger.info('Skipping review: insufficient evidence', {
      sessionId,
      skillKey,
      totalEvidence,
      minEvidenceRequired: minEvidence
    });
    return;
  }

  try {
    const reviewResult = await plugin.reviewRunner.runReview(summary);

    if (!reviewResult.isModificationRecommended) {
      plugin.logger.info('Review complete: no modification recommended', {
        sessionId,
        skillKey,
        justification: reviewResult.justification
      });
      return;
    }

    const currentContent = await readCurrentSkillContent('skills', skillKey);
    const patchContent = plugin.patchGenerator.generate(reviewResult, currentContent);

    plugin.logger.info('Patch generated, attempting merge', {
      sessionId,
      skillKey,
      patchId: reviewResult.metadata.patchId,
      riskLevel: reviewResult.riskLevel,
      mergeMode: reviewResult.metadata.mergeMode
    });

    const merged = await plugin.mergeManager.merge(skillKey, patchContent, reviewResult.metadata);

    plugin.logger.info(merged ? 'Patch auto-merged successfully' : 'Patch queued for human review', {
      sessionId,
      skillKey,
      patchId: reviewResult.metadata.patchId
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    plugin.logger.error('Review pipeline failed', {
      sessionId,
      skillKey,
      error: message
    });
  }
}

export default agent_end;
