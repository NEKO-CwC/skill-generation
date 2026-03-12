/**
 * Feedback collection adapter implementing event persistence contract.
 */

import type { FeedbackCollector, FeedbackEvent } from '../../shared/types.js';

/**
 * Default feedback collector placeholder implementation.
 */
export class FeedbackCollectorImpl implements FeedbackCollector {
  private readonly eventsBySession: Map<string, FeedbackEvent[]>;

  public constructor() {
    this.eventsBySession = new Map<string, FeedbackEvent[]>();
  }

  /**
   * Collects a feedback event.
   */
  public async collect(event: FeedbackEvent): Promise<void> {
    const sessionEvents = this.eventsBySession.get(event.sessionId) ?? [];
    sessionEvents.push({ ...event });
    this.eventsBySession.set(event.sessionId, sessionEvents);
  }

  /**
   * Retrieves all feedback events for a session.
   */
  public async getSessionFeedback(sessionId: string): Promise<FeedbackEvent[]> {
    const events = this.eventsBySession.get(sessionId) ?? [];
    return events.map((event) => ({ ...event }));
  }
}

export default FeedbackCollectorImpl;
