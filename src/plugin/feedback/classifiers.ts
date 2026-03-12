/**
 * Feedback signal classifier implementing event-type and severity logic contract.
 */

import type { FeedbackClassifier, FeedbackEvent } from '../../shared/types.js';

/**
 * Default feedback classifier placeholder implementation.
 */
export class FeedbackClassifierImpl implements FeedbackClassifier {
  private readonly correctionPattern: RegExp;

  private readonly positivePattern: RegExp;

  public constructor() {
    this.correctionPattern = /\b(don't|wrong|incorrect|instead|not that|should have|fix this)\b/i;
    this.positivePattern = /\b(good|great|perfect|thanks|correct|nice)\b/i;
  }

  /**
   * Classifies raw input into a feedback event type.
   */
  public classify(rawInput: string, isError: boolean): FeedbackEvent['eventType'] | null {
    if (isError) {
      return 'tool_error';
    }

    if (this.correctionPattern.test(rawInput)) {
      return 'user_correction';
    }

    if (this.positivePattern.test(rawInput)) {
      return 'positive_feedback';
    }

    return null;
  }

  /**
   * Assesses severity based on accumulated events.
   */
  public assessSeverity(events: FeedbackEvent[]): FeedbackEvent['severity'] {
    const errorCount = events.filter((event) => event.eventType === 'tool_error').length;

    if (errorCount === 0) {
      return 'low';
    }
    if (errorCount <= 2) {
      return 'medium';
    }
    return 'high';
  }
}

export default FeedbackClassifierImpl;
