import { describe, it, expect } from 'vitest';
import { FeedbackCollectorImpl } from '../../../src/plugin/feedback/collector.ts';
import type { FeedbackEvent } from '../../../src/shared/types.ts';

describe('plugin/feedback/collector', () => {
  it('collects events and returns only events for the requested session', async () => {
    const collector = new FeedbackCollectorImpl();
    const sessionAEvent: FeedbackEvent = {
      sessionId: 's1',
      skillKey: 'skill.a',
      timestamp: 1,
      eventType: 'tool_error',
      severity: 'high'
    };
    const sessionBEvent: FeedbackEvent = {
      sessionId: 's2',
      skillKey: 'skill.b',
      timestamp: 2,
      eventType: 'positive_feedback',
      severity: 'low'
    };

    await collector.collect(sessionAEvent);
    await collector.collect(sessionBEvent);

    await expect(collector.getSessionFeedback('s1')).resolves.toEqual([sessionAEvent]);
    await expect(collector.getSessionFeedback('s2')).resolves.toEqual([sessionBEvent]);
  });

  it('returns a copy so caller mutations do not affect stored events', async () => {
    const collector = new FeedbackCollectorImpl();
    const event: FeedbackEvent = {
      sessionId: 's1',
      skillKey: 'skill.a',
      timestamp: 1,
      eventType: 'user_correction',
      severity: 'medium',
      messageExcerpt: 'wrong answer'
    };

    await collector.collect(event);
    const events = await collector.getSessionFeedback('s1');
    events[0]!.messageExcerpt = 'mutated externally';

    const reloaded = await collector.getSessionFeedback('s1');
    expect(reloaded[0]!.messageExcerpt).toBe('wrong answer');
  });

  it('returns an empty array for unknown sessions', async () => {
    const collector = new FeedbackCollectorImpl();
    await expect(collector.getSessionFeedback('missing-session')).resolves.toEqual([]);
  });
});
