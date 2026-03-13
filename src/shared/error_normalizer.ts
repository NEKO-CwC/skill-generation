import { createHash } from 'node:crypto';
import type { ErrorNormalizer, NormalizedToolError } from './types.js';

const MAX_RAW_EXCERPT_LENGTH = 2000;
const MAX_MESSAGE_LENGTH = 500;

export class ErrorNormalizerImpl implements ErrorNormalizer {
  public normalize(
    toolName: string,
    event: { result?: unknown; error?: string }
  ): NormalizedToolError | null {
    if (event.error) {
      return this.build(toolName, event.error, 'event.error', event);
    }

    if (event.result && typeof event.result === 'object') {
      const record = event.result as Record<string, unknown>;

      if (record.status === 'error') {
        const msg = this.extractMessage(record);
        return this.build(toolName, msg, 'result.status', event);
      }

      if ('error' in record && record.error !== undefined && record.error !== null && record.error !== '') {
        const msg = typeof record.error === 'string' ? record.error : this.safeStringify(record.error);
        return this.build(toolName, msg, 'result.error', event);
      }
    }

    const output = this.safeStringify(event.result ?? event.error ?? '');
    if (/\b(error|failed|unauthorized|timeout|missing api key)\b/i.test(output)) {
      return this.build(toolName, output.slice(0, MAX_MESSAGE_LENGTH), 'text-pattern', event);
    }

    return null;
  }

  public safeStringify(value: unknown, maxLength: number = MAX_RAW_EXCERPT_LENGTH): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value.slice(0, maxLength);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    try {
      const seen = new WeakSet();
      const json = JSON.stringify(value, (_key, val: unknown) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) {
            return '[Circular]';
          }
          seen.add(val);
        }
        return val;
      });
      return json.slice(0, maxLength);
    } catch {
      return String(value).slice(0, maxLength);
    }
  }

  private build(
    toolName: string,
    message: string,
    source: NormalizedToolError['source'],
    event: { result?: unknown; error?: string }
  ): NormalizedToolError {
    const rawExcerpt = this.safeStringify(event.result ?? event.error ?? '');
    const record = (event.result && typeof event.result === 'object')
      ? event.result as Record<string, unknown>
      : undefined;

    return {
      status: 'error',
      toolName,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      errorType: record && typeof record.errorType === 'string' ? record.errorType : undefined,
      exitCode: record && typeof record.exitCode === 'number' ? record.exitCode : undefined,
      stderr: record && typeof record.stderr === 'string' ? record.stderr.slice(0, MAX_MESSAGE_LENGTH) : undefined,
      rawExcerpt: rawExcerpt.slice(0, MAX_RAW_EXCERPT_LENGTH),
      fingerprint: this.computeFingerprint(toolName, message),
      source
    };
  }

  private extractMessage(record: Record<string, unknown>): string {
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.stderr === 'string') return record.stderr;
    return this.safeStringify(record, MAX_MESSAGE_LENGTH);
  }

  private computeFingerprint(toolName: string, message: string): string {
    const normalized = message.toLowerCase().replace(/[0-9a-f]{8,}/g, '<id>').replace(/\d+/g, '<n>').trim();
    return createHash('sha256').update(`${toolName}:${normalized}`).digest('hex').slice(0, 12);
  }
}

export default ErrorNormalizerImpl;
