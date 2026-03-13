import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingHintStoreImpl } from '../../src/shared/pending_hint_store.ts';
import type { EvolutionTarget } from '../../src/shared/types.ts';

const target = (
  kind: 'skill' | 'builtin' | 'global' | 'unresolved' = 'skill'
): EvolutionTarget => ({
  kind,
  key: 'test',
  storageKey: 'test',
  mergeMode: 'skill-doc'
});

describe('shared/pending_hint_store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('record stores a new hint with count=1', () => {
    const store = new PendingHintStoreImpl(1);

    store.record(target(), 'fp-1', 'first error', 'first instruction');

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.fingerprint).toBe('fp-1');
    expect(hints[0]?.count).toBe(1);
  });

  it('record increments count for duplicate fingerprint', () => {
    const store = new PendingHintStoreImpl(1);

    store.record(target(), 'fp-dup', 'error 1', 'instruction 1');
    store.record(target(), 'fp-dup', 'error 2', 'instruction 2');

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.count).toBe(2);
  });

  it('record updates lastError and instruction for duplicate fingerprint', () => {
    const store = new PendingHintStoreImpl(1);

    store.record(target(), 'fp-update', 'old error', 'old instruction');
    store.record(target(), 'fp-update', 'new error', 'new instruction');

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.lastError).toBe('new error');
    expect(hints[0]?.instruction).toBe('new instruction');
  });

  it('getHints returns empty array when no hints recorded', () => {
    const store = new PendingHintStoreImpl();

    const hints = store.getHints();
    expect(hints).toEqual([]);
  });

  it('getHints returns empty when all hints are below default threshold', () => {
    const store = new PendingHintStoreImpl();

    store.record(target(), 'fp-threshold', 'only once', 'instruction');

    const hints = store.getHints();
    expect(hints).toEqual([]);
  });

  it('getHints returns hints that meet default threshold', () => {
    const store = new PendingHintStoreImpl();

    store.record(target(), 'fp-2', 'err 1', 'instruction');
    store.record(target(), 'fp-2', 'err 2', 'instruction');

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.fingerprint).toBe('fp-2');
    expect(hints[0]?.count).toBe(2);
  });

  it('getHints with custom threshold=1 returns hints immediately', () => {
    const store = new PendingHintStoreImpl(1);

    store.record(target('builtin'), 'fp-now', 'instant error', 'instant instruction');

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.target.kind).toBe('builtin');
  });

  it('clearExpired removes expired hints', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const store = new PendingHintStoreImpl(1, 50);
    store.record(target(), 'fp-expired', 'error', 'instruction');

    vi.advanceTimersByTime(60);
    store.clearExpired();

    expect(store.getHints()).toEqual([]);
  });

  it('clearExpired keeps non-expired hints', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const store = new PendingHintStoreImpl(1, 50);
    store.record(target('global'), 'fp-live', 'error', 'instruction');

    vi.advanceTimersByTime(30);
    store.clearExpired();

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.target.kind).toBe('global');
  });

  it('clear removes all hints regardless of expiration', () => {
    const store = new PendingHintStoreImpl(1);

    store.record(target(), 'fp-a', 'error a', 'instruction a');
    store.record(target('unresolved'), 'fp-b', 'error b', 'instruction b');
    store.clear();

    expect(store.getHints()).toEqual([]);
  });

  it('integration: recording three times returns one hint with count=3', () => {
    const store = new PendingHintStoreImpl();

    store.record(target(), 'fp-integration', 'e1', 'i1');
    store.record(target(), 'fp-integration', 'e2', 'i2');
    store.record(target(), 'fp-integration', 'e3', 'i3');

    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.count).toBe(3);
    expect(hints[0]?.lastError).toBe('e3');
    expect(hints[0]?.instruction).toBe('i3');
  });

  it('integration: with threshold=3, hint appears only after three records', () => {
    const store = new PendingHintStoreImpl(3);

    store.record(target(), 'fp-th3', 'e1', 'i1');
    expect(store.getHints()).toEqual([]);

    store.record(target(), 'fp-th3', 'e2', 'i2');
    expect(store.getHints()).toEqual([]);

    store.record(target(), 'fp-th3', 'e3', 'i3');
    const hints = store.getHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]?.count).toBe(3);
  });
});
