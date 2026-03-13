import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmRuntimeResolver } from '../../src/review/llm_runtime_resolver.ts';
import type { ProviderConfigSource } from '../../src/shared/types.ts';

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
    // Save and clear all LLM env vars
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    // Restore env vars
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('priority 1: injected provider config takes precedence', () => {
    const source: ProviderConfigSource = {
      providers: {
        openrouter: {
          baseUrl: 'https://injected.example.com/api',
          apiKey: 'injected-key',
          api: 'openai'
        }
      }
    };

    // Set env vars that would match — injected should still win
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://env.example.com/api';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'env-key';

    const resolver = new LlmRuntimeResolver(tempRoot, source);
    const result = resolver.resolve('openrouter/my-model');

    expect(result.resolvedFrom).toBe('injected');
    expect(result.baseUrl).toBe('https://injected.example.com/api');
    expect(result.apiKey).toBe('injected-key');
    expect(result.api).toBe('openai');
    expect(result.modelId).toBe('my-model');
  });

  it('priority 1: injected config matches by provider ID from model string', () => {
    const source: ProviderConfigSource = {
      providers: {
        'custom-provider': {
          baseUrl: 'https://custom.example.com',
          apiKey: 'custom-key',
          api: 'anthropic-messages'
        }
      }
    };

    const resolver = new LlmRuntimeResolver(tempRoot, source);
    const result = resolver.resolve('custom-provider/model-name');

    expect(result.resolvedFrom).toBe('injected');
    expect(result.baseUrl).toBe('https://custom.example.com');
  });

  it('priority 1: injected config falls back to anyrouter provider', () => {
    const source: ProviderConfigSource = {
      providers: {
        anyrouter: {
          baseUrl: 'https://anyrouter.example.com',
          apiKey: 'any-key'
        }
      }
    };

    const resolver = new LlmRuntimeResolver(tempRoot, source);
    const result = resolver.resolve('unknown-provider/some-model');

    expect(result.resolvedFrom).toBe('injected');
    expect(result.baseUrl).toBe('https://anyrouter.example.com');
  });

  it('priority 2: env OPENCLAW_ANYROUTER fallback when no injected config', () => {
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://env-anyrouter.example.com';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'env-anyrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot, null);
    const result = resolver.resolve('some/model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://env-anyrouter.example.com');
    expect(result.apiKey).toBe('env-anyrouter-key');
    expect(result.api).toBe('anthropic-messages');
  });

  it('priority 2: env OPENROUTER fallback', () => {
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const resolver = new LlmRuntimeResolver(tempRoot, null);
    const result = resolver.resolve('some/model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.api).toBe('openai');
  });

  it('priority 2: env OPENAI fallback', () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    process.env.OPENAI_API_KEY = 'sk-test';

    const resolver = new LlmRuntimeResolver(tempRoot, null);
    const result = resolver.resolve('gpt-4');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.api).toBe('openai');
    expect(result.modelId).toBe('gpt-4');
  });

  it('priority 2: env ANTHROPIC_API_KEY with default baseUrl', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const resolver = new LlmRuntimeResolver(tempRoot, null);
    const result = resolver.resolve('claude-3-opus');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(result.apiKey).toBe('sk-ant-test');
    expect(result.api).toBe('anthropic-messages');
  });

  it('priority 3: openclaw.json file fallback', async () => {
    // Create openclaw.json in parent dir of workspace
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    const { mkdir } = await import('node:fs/promises');
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

    const resolver = new LlmRuntimeResolver(workspaceDir, null);
    const result = resolver.resolve('openrouter/some-model');

    expect(result.resolvedFrom).toBe('openclaw-config');
    expect(result.baseUrl).toBe('https://file-openrouter.example.com');
    expect(result.apiKey).toBe('file-key');
  });

  it('throws structured error when no sources available', () => {
    const resolver = new LlmRuntimeResolver(tempRoot, null);

    expect(() => resolver.resolve('some/model')).toThrow(
      /LLM provider not configured for model "some\/model"/
    );

    try {
      resolver.resolve('test/model');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain('injected config');
      expect(message).toContain('OPENCLAW_ANYROUTER');
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).toContain('openclaw.json');
    }
  });

  it('resolvedFrom is correctly tagged for each source type', () => {
    const source: ProviderConfigSource = {
      providers: {
        myp: { baseUrl: 'https://test.com', apiKey: 'k' }
      }
    };
    const resolver = new LlmRuntimeResolver(tempRoot, source);
    const result = resolver.resolve('myp/model');
    expect(result.resolvedFrom).toBe('injected');
  });

  it('model string without provider uses anyrouter/openrouter from injected config', () => {
    const source: ProviderConfigSource = {
      providers: {
        openrouter: { baseUrl: 'https://or.example.com', apiKey: 'k', api: 'openai' }
      }
    };
    const resolver = new LlmRuntimeResolver(tempRoot, source);
    const result = resolver.resolve('plain-model-name');

    expect(result.resolvedFrom).toBe('injected');
    expect(result.modelId).toBe('plain-model-name');
  });

  it('env priority: OPENCLAW_ANYROUTER beats OPENROUTER beats OPENAI beats ANTHROPIC', () => {
    // Set all env vars
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENAI_BASE_URL = 'https://openai.com';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://anyrouter.example.com';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'anyrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot, null);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://anyrouter.example.com');
    expect(result.apiKey).toBe('anyrouter-key');
  });
});
