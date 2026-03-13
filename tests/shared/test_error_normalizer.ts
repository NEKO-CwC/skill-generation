import { describe, expect, it } from 'vitest';
import { ErrorNormalizerImpl } from '../../src/shared/error_normalizer.ts';

describe('shared/error_normalizer', () => {
  it('safeStringify returns empty string for null and undefined', () => {
    const normalizer = new ErrorNormalizerImpl();

    expect(normalizer.safeStringify(null)).toBe('');
    expect(normalizer.safeStringify(undefined)).toBe('');
  });

  it('safeStringify returns string as-is and truncates by maxLength', () => {
    const normalizer = new ErrorNormalizerImpl();
    const value = 'abcdefghijklmnopqrstuvwxyz';

    expect(normalizer.safeStringify(value)).toBe(value);
    expect(normalizer.safeStringify(value, 5)).toBe('abcde');
  });

  it('safeStringify coerces numbers and booleans to string', () => {
    const normalizer = new ErrorNormalizerImpl();

    expect(normalizer.safeStringify(42)).toBe('42');
    expect(normalizer.safeStringify(true)).toBe('true');
    expect(normalizer.safeStringify(false)).toBe('false');
  });

  it('safeStringify serializes plain objects as JSON', () => {
    const normalizer = new ErrorNormalizerImpl();
    const value = { code: 500, message: 'boom' };

    expect(normalizer.safeStringify(value)).toBe('{"code":500,"message":"boom"}');
  });

  it('safeStringify replaces circular references with [Circular]', () => {
    const normalizer = new ErrorNormalizerImpl();
    const value: { name: string; self?: unknown } = { name: 'node' };
    value.self = value;

    expect(normalizer.safeStringify(value)).toContain('[Circular]');
  });

  it('safeStringify truncates serialized output by maxLength', () => {
    const normalizer = new ErrorNormalizerImpl();
    const value = { text: 'x'.repeat(200) };

    expect(normalizer.safeStringify(value, 20).length).toBe(20);
  });

  it('safeStringify falls back to String(value) when stringify throws', () => {
    const normalizer = new ErrorNormalizerImpl();
    const value = {
      toJSON: () => {
        throw new Error('cannot serialize');
      },
      toString: () => 'fallback-value'
    };

    expect(normalizer.safeStringify(value)).toBe('fallback-value');
  });

  it('normalize returns event.error source when event.error is provided', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('bash', { error: 'permission denied' });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('event.error');
    expect(result?.toolName).toBe('bash');
    expect(result?.message).toBe('permission denied');
  });

  it('normalize returns result.status source when status is error', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('grep', {
      result: { status: 'error', message: 'failed to parse input' }
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('result.status');
    expect(result?.message).toBe('failed to parse input');
  });

  it('normalize falls back to stderr for result.status branch message extraction', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('bash', {
      result: { status: 'error', stderr: 'command timed out' }
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('result.status');
    expect(result?.message).toBe('command timed out');
  });

  it('normalize returns result.error source when result.error is non-empty string', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('write', {
      result: { error: 'disk full' }
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('result.error');
    expect(result?.message).toBe('disk full');
  });

  it('normalize uses safeStringify for non-string result.error', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('write', {
      result: { error: { detail: 'nested failure', code: 7 } }
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('result.error');
    expect(result?.message).toContain('nested failure');
  });

  it('normalize returns text-pattern source when output text contains error signal words', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('fetch', {
      result: 'request failed due to timeout while connecting'
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('text-pattern');
  });

  it('normalize returns null when no error signal is found', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('read', {
      result: { status: 'ok', message: 'all good' }
    });

    expect(result).toBeNull();
  });

  it('normalize returns a 12-character hex fingerprint', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('bash', { error: 'permission denied' });

    expect(result).not.toBeNull();
    expect(result?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('fingerprint is stable for the same tool and message', () => {
    const normalizer = new ErrorNormalizerImpl();
    const a = normalizer.normalize('bash', { error: 'timeout on attempt 1' });
    const b = normalizer.normalize('bash', { error: 'timeout on attempt 1' });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });

  it('fingerprint normalizes numbers and hex ids to the same value', () => {
    const normalizer = new ErrorNormalizerImpl();
    const first = normalizer.normalize('bash', {
      error: 'Request 123 failed for 9f86d081884c7d659a2feaa0'
    });
    const second = normalizer.normalize('bash', {
      error: 'Request 999 failed for deadbeefcafebabe12345678'
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.fingerprint).toBe(second?.fingerprint);
  });

  it('normalize truncates message to 500 chars', () => {
    const normalizer = new ErrorNormalizerImpl();
    const longMessage = 'x'.repeat(800);
    const result = normalizer.normalize('bash', { error: longMessage });

    expect(result).not.toBeNull();
    expect(result?.message.length).toBe(500);
  });

  it('normalize truncates rawExcerpt to 2000 chars', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('bash', {
      result: {
        status: 'error',
        message: 'short',
        payload: 'y'.repeat(5000)
      }
    });

    expect(result).not.toBeNull();
    expect(result?.rawExcerpt.length).toBe(2000);
  });

  it('normalize extracts errorType, exitCode, and stderr from result object', () => {
    const normalizer = new ErrorNormalizerImpl();
    const result = normalizer.normalize('bash', {
      result: {
        status: 'error',
        message: 'execution failed',
        errorType: 'ProcessError',
        exitCode: 127,
        stderr: 'command not found'
      }
    });

    expect(result).not.toBeNull();
    expect(result?.errorType).toBe('ProcessError');
    expect(result?.exitCode).toBe(127);
    expect(result?.stderr).toBe('command not found');
  });
});
