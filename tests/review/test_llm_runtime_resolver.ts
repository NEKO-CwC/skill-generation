import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmRuntimeResolver } from '../../src/review/llm_runtime_resolver.ts';

describe('review/llm_runtime_resolver', () => {
  let tempRoot = '';
  const savedEnv: Record<string, string | undefined> = {};

  const ENV_KEYS = [
    'OPENCLAW_ANYROUTER_BASE_URL', 'OPENCLAW_ANYROUTER_API_KEY',
    'OPENROUTER_BASE_URL', 'OPENROUTER_API_KEY',
    'OPENAI_BASE_URL', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY'
  ];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-resolver-'));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  // ── Env: AnyRouter (requires both base + key) ──

  it('env: OPENCLAW_ANYROUTER resolves when both base and key are set', () => {
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://anyrouter.example.com';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'anyrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('some/model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://anyrouter.example.com');
    expect(result.apiKey).toBe('anyrouter-key');
    expect(result.api).toBe('anthropic-messages');
    expect(result.modelId).toBe('model');
  });

  // ── Env: OpenRouter (key only sufficient, base has default) ──

  it('env: OPENROUTER resolves with key only, using default base URL', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('some/model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.apiKey).toBe('or-key');
    expect(result.api).toBe('openai');
  });

  it('env: OPENROUTER uses custom base URL when provided', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.OPENROUTER_BASE_URL = 'https://custom-openrouter.example.com';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://custom-openrouter.example.com');
  });

  // ── Env: OpenAI (key only sufficient, base has default) ──

  it('env: OPENAI resolves with key only, using default base URL', () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('gpt-4');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://api.openai.com');
    expect(result.apiKey).toBe('sk-test');
    expect(result.api).toBe('openai');
    expect(result.modelId).toBe('gpt-4');
  });

  it('env: OPENAI uses custom base URL when provided', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://custom-openai.example.com/v1';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://custom-openai.example.com/v1');
  });

  // ── Env: Anthropic (key only) ──

  it('env: ANTHROPIC_API_KEY resolves with default base URL', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('claude-3-opus');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(result.apiKey).toBe('sk-ant-test');
    expect(result.api).toBe('anthropic-messages');
  });

  // ── Env priority ordering ──

  it('env priority: AnyRouter > OpenRouter > OpenAI > Anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://anyrouter.example.com';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'anyrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://anyrouter.example.com');
    expect(result.apiKey).toBe('anyrouter-key');
  });

  it('env priority: OpenRouter wins when AnyRouter not set', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.apiKey).toBe('openrouter-key');
  });

  // ── File fallback: openclaw.json ──

  it('file fallback: reads openclaw.json from workspace parent dir', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://file-openrouter.example.com',
            apiKey: 'file-key',
            api: 'openai'
          }
        }
      }
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('openrouter/some-model');

    expect(result.resolvedFrom).toBe('openclaw-config');
    expect(result.baseUrl).toBe('https://file-openrouter.example.com');
    expect(result.apiKey).toBe('file-key');
    expect(result.modelId).toBe('some-model');
  });

  it('file fallback: reads openclaw.json from workspace dir itself as second candidate', async () => {
    const workspaceDir = join(tempRoot, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      models: {
        providers: {
          anyrouter: {
            baseUrl: 'https://ws-config.example.com',
            apiKey: 'ws-key',
            api: 'anthropic-messages'
          }
        }
      }
    };
    // Place config in workspace dir itself (second candidate)
    await writeFile(join(workspaceDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('any/model');

    expect(result.resolvedFrom).toBe('openclaw-config');
    expect(result.baseUrl).toBe('https://ws-config.example.com');
  });

  it('file fallback: env takes priority over file', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({
      models: { providers: { openrouter: { baseUrl: 'https://file.com', apiKey: 'file-key' } } }
    }));

    process.env.OPENROUTER_API_KEY = 'env-key';

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.apiKey).toBe('env-key');
  });

  // ── Error diagnostics ──

  it('throws structured error with workspaceDir, attemptedSources, and configPaths', () => {
    const resolver = new LlmRuntimeResolver(tempRoot);

    expect(() => resolver.resolve('some/model')).toThrow(
      /LLM provider not configured for model "some\/model"/
    );

    try {
      resolver.resolve('test/model');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain(tempRoot);
      expect(message).toContain('OPENCLAW_ANYROUTER');
      expect(message).toContain('OPENROUTER_API_KEY');
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).toContain('openclaw.json');
    }
  });

  // ── Model string parsing ──

  it('model string without slash uses full string as modelId', () => {
    process.env.OPENROUTER_API_KEY = 'key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('plain-model-name');

    expect(result.modelId).toBe('plain-model-name');
  });

  it('model string with slash extracts provider and model', () => {
    process.env.OPENROUTER_API_KEY = 'key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('openrouter/stepfun/step-3.5-flash:free');

    expect(result.modelId).toBe('stepfun/step-3.5-flash:free');
  });
});
