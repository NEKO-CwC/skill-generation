/**
 * Hook invoked after tool execution for feedback capture.
 */

import type { FeedbackEvent, OverlayEntry } from '../../shared/types.js';
import type { SkillEvolutionPlugin } from '../index.js';

export async function after_tool_call(
  plugin: SkillEvolutionPlugin,
  sessionId: string,
  toolName: string,
  output: string,
  isError: boolean,
  rawResult?: unknown
): Promise<void> {
  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);

  const normalizedError = plugin.errorNormalizer.normalize(toolName, {
    result: rawResult,
    error: isError ? output : undefined
  });

  const safeOutput = plugin.errorNormalizer.safeStringify(rawResult ?? output);
  const detectedError = isError || normalizedError !== null;

  const noiseDisposition = detectedError
    ? plugin.noiseFilter.assess(toolName, safeOutput, normalizedError)
    : 'normal' as const;

  if (noiseDisposition === 'ignore') {
    plugin.logger.debug('Noise filtered: ignoring tool event', { sessionId, toolName, noiseDisposition });
    return;
  }

  const target = plugin.targetResolver.resolve(toolName, skillKey);
  plugin.addSessionTarget(sessionId, target);

  const eventType = plugin.feedbackClassifier.classify(safeOutput, detectedError);
  if (eventType === null) {
    return;
  }

  const priorEvents = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  const event: FeedbackEvent = {
    sessionId,
    skillKey,
    timestamp: Date.now(),
    eventType,
    severity: plugin.feedbackClassifier.assessSeverity(priorEvents),
    toolName,
    messageExcerpt: safeOutput.slice(0, 280),
    target,
    normalizedError: normalizedError ?? undefined,
    noiseDisposition
  };
  await plugin.feedbackCollector.collect(event);

  if (normalizedError && detectedError) {
    plugin.pendingHintStore.record(
      target,
      normalizedError.fingerprint,
      normalizedError.message,
      `Avoid prior failure mode for ${toolName}: ${normalizedError.message.slice(0, 200)}`
    );
  }

  if (noiseDisposition === 'low-signal') {
    return;
  }

  if (!detectedError || !plugin.config.triggers.onToolError || !plugin.config.sessionOverlay.enabled) {
    return;
  }

  const overlayEntry: OverlayEntry = {
    sessionId,
    skillKey: target.storageKey,
    content: `Tool error observed for ${toolName}. Avoid prior failure mode.\nError excerpt: ${safeOutput.slice(0, 400)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reasoning: 'Generated from onToolError trigger after failed tool call.'
  };

  await plugin.overlayStore.create(overlayEntry);
}

export default after_tool_call;
