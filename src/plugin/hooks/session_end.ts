import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileExists, readFile } from '../../shared/fs.js';
import type { EvolutionTarget, ReviewQueue, ReviewTask, SessionSummary } from '../../shared/types.js';
import type { SkillEvolutionPlugin } from '../index.js';

async function readOriginalContent(plugin: SkillEvolutionPlugin, target: EvolutionTarget): Promise<string> {
  let targetPath: string;

  switch (target.kind) {
    case 'skill':
      targetPath = join(plugin.paths.skillsDir, target.key, 'SKILL.md');
      break;
    case 'builtin':
      targetPath = join(plugin.paths.globalToolsDir, `${target.key}.md`);
      break;
    case 'global':
      targetPath = join(plugin.paths.globalDir, 'DEFAULT_SKILL.md');
      break;
    default:
      return '';
  }

  if (await fileExists(targetPath)) {
    return readFile(targetPath);
  }
  return '';
}

export async function session_end(plugin: SkillEvolutionPlugin, sessionId: string): Promise<void> {
  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);
  const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  const overlays = await plugin.overlayStore.listBySession(sessionId);

  const filteredEvents = events.filter((e) => e.noiseDisposition !== 'ignore');
  const targets = plugin.getSessionTargets(sessionId);

  const summary: SessionSummary = {
    sessionId,
    skillKey,
    events: filteredEvents,
    overlays,
    durationMs: Date.now() - plugin.getSessionStartTime(sessionId),
    totalErrors: filteredEvents.filter((event) => event.eventType === 'tool_error').length,
    targets
  };

  plugin.logger.info('Session summary collected', {
    sessionId: summary.sessionId,
    skillKey: summary.skillKey,
    eventCount: summary.events.length,
    overlayCount: summary.overlays.length,
    durationMs: summary.durationMs,
    totalErrors: summary.totalErrors,
    targetCount: targets.length,
    filteredOut: events.length - filteredEvents.length
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

  const reviewQueue: ReviewQueue | undefined = (plugin as SkillEvolutionPlugin & { reviewQueue?: ReviewQueue }).reviewQueue;

  if (reviewQueue) {
    await enqueueForAsyncReview(plugin, reviewQueue, summary);
    return;
  }

  await runSynchronousReview(plugin, summary);
}

async function enqueueForAsyncReview(
  plugin: SkillEvolutionPlugin,
  reviewQueue: ReviewQueue,
  summary: SessionSummary
): Promise<void> {
  const { sessionId, skillKey } = summary;
  const targets = summary.targets ?? [];

  try {
    for (const target of targets) {
      const currentContent = await readOriginalContent(plugin, target);
      const baseVersionHash = createHash('sha256').update(currentContent).digest('hex');
      const lastEventTimestamp = summary.events.length > 0
        ? summary.events[summary.events.length - 1]!.timestamp
        : Date.now();
      const idempotencyKey = `${sessionId}:${lastEventTimestamp}:${target.storageKey}`;
      const taskId = `review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const agentId = (plugin as SkillEvolutionPlugin & { agentId?: string }).agentId ?? 'unknown';

      const task: ReviewTask = {
        taskId,
        sessionId,
        agentId,
        target,
        summary,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        idempotencyKey,
        baseVersionHash
      };

      await reviewQueue.enqueue(task);

      plugin.logger.info('Review task enqueued for async processing', {
        sessionId,
        skillKey,
        taskId,
        target: `${target.kind}:${target.key}`,
        idempotencyKey
      });
    }

    if (targets.length === 0) {
      const defaultTarget = {
        kind: 'global' as const,
        key: 'default',
        storageKey: 'global-default',
        mergeMode: 'global-doc' as const
      };

      const currentContent = await readOriginalContent(plugin, defaultTarget);
      const baseVersionHash = createHash('sha256').update(currentContent).digest('hex');
      const lastEventTimestamp = summary.events.length > 0
        ? summary.events[summary.events.length - 1]!.timestamp
        : Date.now();
      const idempotencyKey = `${sessionId}:${lastEventTimestamp}:${defaultTarget.storageKey}`;
      const taskId = `review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const agentId = (plugin as SkillEvolutionPlugin & { agentId?: string }).agentId ?? 'unknown';

      const task: ReviewTask = {
        taskId,
        sessionId,
        agentId,
        target: defaultTarget,
        summary,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        idempotencyKey,
        baseVersionHash
      };

      await reviewQueue.enqueue(task);

      plugin.logger.info('Review task enqueued for async processing (default target)', {
        sessionId,
        skillKey,
        taskId,
        idempotencyKey
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    plugin.logger.error('Failed to enqueue review task, falling back to synchronous review', {
      sessionId,
      skillKey,
      error: message
    });
    await runSynchronousReview(plugin, summary);
  }
}

async function runSynchronousReview(plugin: SkillEvolutionPlugin, summary: SessionSummary): Promise<void> {
  const { sessionId, skillKey } = summary;

  try {
    const reviewResult = await plugin.reviewRunner.runReview(summary);

    if (!reviewResult.isModificationRecommended) {
      plugin.logger.info('Review complete: no modification recommended', {
        sessionId,
        skillKey,
        justification: reviewResult.justification,
        reviewSource: reviewResult.reviewSource
      });
      return;
    }

    const target = reviewResult.target ?? summary.targets?.[0] ?? {
      kind: 'global' as const,
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc' as const
    };

    const currentContent = await readOriginalContent(plugin, target);
    const patchOutput = plugin.patchGenerator.generateSplit(reviewResult, currentContent);

    plugin.logger.info('Split patch generated, attempting merge', {
      sessionId,
      skillKey,
      patchId: reviewResult.metadata.patchId,
      riskLevel: reviewResult.riskLevel,
      mergeMode: reviewResult.metadata.mergeMode,
      reviewSource: reviewResult.reviewSource,
      target: `${target.kind}:${target.key}`,
      hasMergeableDocument: patchOutput.mergeableDocument !== null
    });

    const merged = await plugin.mergeManager.mergeWithTarget(target, patchOutput, reviewResult.metadata);

    plugin.logger.info(merged ? 'Patch auto-merged successfully' : 'Patch queued for human review', {
      sessionId,
      skillKey,
      patchId: reviewResult.metadata.patchId,
      target: `${target.kind}:${target.key}`
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

export default session_end;
