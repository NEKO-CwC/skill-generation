/**
 * Custom domain error classes for plugin-level failure handling.
 */

/**
 * Raised when a patch cannot be applied due to merge conflicts.
 */
export class MergeConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

/**
 * Raised when rollback history exceeds configured limits.
 */
export class RollbackLimitExceeded extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RollbackLimitExceeded';
  }
}

/**
 * Raised when an expected session overlay cannot be found.
 */
export class OverlayNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OverlayNotFoundError';
  }
}

/**
 * Raised when review execution fails or cannot complete safely.
 */
export class ReviewFailedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReviewFailedError';
  }
}

/**
 * Raised when plugin configuration is missing fields or invalid.
 */
export class InvalidConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

/**
 * Raised when auth resolution cannot find valid credentials.
 */
export class AuthResolutionError extends Error {
  public readonly attemptedSources: string[];

  public constructor(message: string, attemptedSources: string[] = []) {
    super(message);
    this.name = 'AuthResolutionError';
    this.attemptedSources = attemptedSources;
  }
}

/**
 * Raised when an LLM API call fails.
 */
export class LlmCallError extends Error {
  public readonly statusCode?: number;
  public readonly provider?: string;
  public readonly resolvedUrl?: string;

  public constructor(message: string, statusCode?: number, provider?: string, resolvedUrl?: string) {
    super(message);
    this.name = 'LlmCallError';
    this.statusCode = statusCode;
    this.provider = provider;
    this.resolvedUrl = resolvedUrl;
  }
}

/**
 * Raised when review queue operations fail.
 */
export class ReviewQueueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReviewQueueError';
  }
}
