import type { NoiseDisposition, NoiseFilter, NormalizedToolError } from './types.js';

const STARTUP_NOISE_PATTERNS = [
  /ENOENT.*memory/i,
  /ENOENT.*\.memory/i,
  /no such file.*memory/i,
  /file not found.*memory/i,
  /ENOENT.*\.env/i,
  /ENOENT.*\.config/i,
  /ENOENT.*AGENTS\.md/i,
  /missing.*memory.*file/i,
  /cannot read.*memory/i
];

const ENV_ERROR_PATTERNS = [
  /missing.*api.*key/i,
  /environment.*variable.*not.*set/i,
  /ENOENT.*node_modules/i,
  /MODULE_NOT_FOUND/i
];

const LOW_SIGNAL_PATTERNS = [
  /ENOENT/i,
  /EACCES/i,
  /EPERM/i
];

const LOW_SIGNAL_TOOL_PATTERNS: Array<{ tool: string; pattern: RegExp }> = [
  { tool: 'read', pattern: /ENOENT|no such file|not found/i },
  { tool: 'glob', pattern: /no matches|found 0/i }
];

export class NoiseFilterImpl implements NoiseFilter {
  public assess(
    toolName: string,
    output: string,
    normalizedError?: NormalizedToolError | null
  ): NoiseDisposition {
    const errorText = normalizedError?.message ?? output;

    for (const pattern of STARTUP_NOISE_PATTERNS) {
      if (pattern.test(errorText)) {
        return 'ignore';
      }
    }

    for (const pattern of ENV_ERROR_PATTERNS) {
      if (pattern.test(errorText)) {
        return 'ignore';
      }
    }

    for (const entry of LOW_SIGNAL_TOOL_PATTERNS) {
      if (toolName === entry.tool && entry.pattern.test(errorText)) {
        return 'low-signal';
      }
    }

    for (const pattern of LOW_SIGNAL_PATTERNS) {
      if (pattern.test(errorText) && !this.hasSubstantiveContent(errorText)) {
        return 'low-signal';
      }
    }

    return 'normal';
  }

  private hasSubstantiveContent(text: string): boolean {
    const cleaned = text.replace(/ENOENT|EACCES|EPERM|no such file|permission denied/gi, '').trim();
    return cleaned.length > 50;
  }
}

export default NoiseFilterImpl;
