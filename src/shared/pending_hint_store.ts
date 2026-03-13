import type { EvolutionTarget, PendingHint, PendingHintStore } from './types.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_THRESHOLD = 2;

export class PendingHintStoreImpl implements PendingHintStore {
  private readonly hints: Map<string, PendingHint> = new Map();
  private readonly threshold: number;
  private readonly ttlMs: number;

  public constructor(threshold: number = DEFAULT_THRESHOLD, ttlMs: number = DEFAULT_TTL_MS) {
    this.threshold = threshold;
    this.ttlMs = ttlMs;
  }

  public record(
    target: EvolutionTarget,
    fingerprint: string,
    errorMessage: string,
    instruction: string
  ): void {
    const existing = this.hints.get(fingerprint);
    if (existing) {
      existing.count += 1;
      existing.lastError = errorMessage;
      existing.instruction = instruction;
      existing.expiresAt = Date.now() + this.ttlMs;
    } else {
      this.hints.set(fingerprint, {
        target,
        fingerprint,
        count: 1,
        lastError: errorMessage,
        instruction,
        expiresAt: Date.now() + this.ttlMs
      });
    }
  }

  public getHints(_sessionId?: string): PendingHint[] {
    this.clearExpired();
    const results: PendingHint[] = [];
    for (const hint of this.hints.values()) {
      if (hint.count >= this.threshold) {
        results.push(hint);
      }
    }
    return results;
  }

  public clearExpired(): void {
    const now = Date.now();
    for (const [key, hint] of this.hints) {
      if (hint.expiresAt <= now) {
        this.hints.delete(key);
      }
    }
  }

  public clear(): void {
    this.hints.clear();
  }
}

export default PendingHintStoreImpl;
