import { describe, expect, it } from 'vitest';
import { NoiseFilterImpl } from '../../src/shared/noise_filter.ts';
import type { NormalizedToolError } from '../../src/shared/types.ts';

describe('shared/noise_filter', () => {
  const filter = new NoiseFilterImpl();

  it('returns ignore for ENOENT with memory in message', () => {
    const disposition = filter.assess('bash', 'ENOENT: missing memory file');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for ENOENT with .memory path', () => {
    const disposition = filter.assess('bash', 'ENOENT: open /tmp/.memory/cache.json');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for no such file memory pattern', () => {
    const disposition = filter.assess('bash', 'no such file or directory: memory snapshot');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for ENOENT with .env', () => {
    const disposition = filter.assess('bash', 'ENOENT: cannot open .env file');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for ENOENT with .config', () => {
    const disposition = filter.assess('bash', 'ENOENT: failed reading .config/settings');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for ENOENT with AGENTS.md', () => {
    const disposition = filter.assess('bash', 'ENOENT: AGENTS.md does not exist');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for missing api key error', () => {
    const disposition = filter.assess('bash', 'fatal: missing API key in environment');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for environment variable not set error', () => {
    const disposition = filter.assess('bash', 'environment variable not set: OPENCLAW_TOKEN');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for MODULE_NOT_FOUND', () => {
    const disposition = filter.assess('bash', 'Error: MODULE_NOT_FOUND for optional package');
    expect(disposition).toBe('ignore');
  });

  it('returns ignore for ENOENT with node_modules', () => {
    const disposition = filter.assess('bash', 'ENOENT: no such file node_modules/pkg/index.js');
    expect(disposition).toBe('ignore');
  });

  it('returns low-signal for read tool with ENOENT', () => {
    const disposition = filter.assess('read', 'ENOENT: file missing');
    expect(disposition).toBe('low-signal');
  });

  it('returns low-signal for read tool with no such file', () => {
    const disposition = filter.assess('read', 'no such file or directory');
    expect(disposition).toBe('low-signal');
  });

  it('returns low-signal for glob tool with no matches', () => {
    const disposition = filter.assess('glob', 'no matches found for pattern');
    expect(disposition).toBe('low-signal');
  });

  it('returns low-signal for generic ENOENT without substantive content', () => {
    const disposition = filter.assess('bash', 'ENOENT');
    expect(disposition).toBe('low-signal');
  });

  it('returns low-signal for EACCES without substantive content', () => {
    const disposition = filter.assess('bash', 'EACCES: permission denied');
    expect(disposition).toBe('low-signal');
  });

  it('returns normal for regular non-noise error message', () => {
    const disposition = filter.assess('bash', 'TypeError: cannot read property x of undefined');
    expect(disposition).toBe('normal');
  });

  it('returns normal for ENOENT with substantial additional content', () => {
    const substantive =
      'ENOENT while loading project file but parser also reported schema mismatch with unexpected token near deeply nested field in config payload';
    const disposition = filter.assess('bash', substantive);
    expect(disposition).toBe('normal');
  });

  it('returns normal for non-matching tool name with ENOENT and substantive message', () => {
    const substantive =
      'ENOENT occurred, but request also failed because the remote endpoint returned malformed response and validation details include required fields and constraints';
    const disposition = filter.assess('write', substantive);
    expect(disposition).toBe('normal');
  });

  it('uses normalizedError.message when provided', () => {
    const normalized: NormalizedToolError = {
      status: 'error',
      toolName: 'bash',
      message: 'missing api key for provider',
      rawExcerpt: 'raw',
      fingerprint: 'fp-1',
      source: 'text-pattern'
    };

    const disposition = filter.assess('bash', 'TypeError: cannot read property x of undefined', normalized);
    expect(disposition).toBe('ignore');
  });
});
