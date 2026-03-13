import { describe, expect, it } from 'vitest';
import { ProviderAdapterImpl, joinUrl } from '../../src/review/provider_adapter.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import type { ResolvedAuth, SkillEvolutionConfig } from '../../src/shared/types.ts';

const makeResolved = (overrides: Partial<ResolvedAuth> = {}): ResolvedAuth => ({
  apiKey: 'sk-test-key',
  provider: 'anthropic',
  source: 'keyRef',
  ...overrides
});

const makeConfig = (overrides: Partial<SkillEvolutionConfig['llm']> = {}): SkillEvolutionConfig => {
  const config = getDefaultConfig();
  config.llm = { ...config.llm, ...overrides };
  return config;
};

describe('review/provider_adapter - joinUrl', () => {
  it('joins base and path', () => {
    expect(joinUrl('https://api.example.com', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('trims trailing slash from base', () => {
    expect(joinUrl('https://api.example.com/', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('trims multiple trailing slashes', () => {
    expect(joinUrl('https://api.example.com///', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('adds leading slash to path if missing', () => {
    expect(joinUrl('https://api.example.com', 'v1/chat')).toBe('https://api.example.com/v1/chat');
  });
});

describe('review/provider_adapter - ProviderAdapterImpl', () => {
  const adapter = new ProviderAdapterImpl();

  describe('buildRequest', () => {
    it('builds correct anthropic request', () => {
      const resolved = makeResolved({ provider: 'anthropic' });
      const config = makeConfig({ provider: 'anthropic' });
      const { url, headers, body } = adapter.buildRequest('Hello', 'Be helpful', resolved, config);

      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(headers['x-api-key']).toBe('sk-test-key');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['anthropic-version']).toBe('2023-06-01');

      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('claude-sonnet-4-20250514');
      expect(parsed.max_tokens).toBe(4096);
      expect(parsed.system).toBe('Be helpful');
      expect(parsed.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('builds correct openai-compatible request', () => {
      const resolved = makeResolved({ provider: 'openai-compatible' });
      const config = makeConfig({ provider: 'openai-compatible' });
      const { url, headers, body } = adapter.buildRequest('Hello', 'Be helpful', resolved, config);

      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(headers['Authorization']).toBe('Bearer sk-test-key');
      expect(headers['content-type']).toBe('application/json');

      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('gpt-4o');
      expect(parsed.messages).toEqual([
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' }
      ]);
    });

    it('uses baseUrl override when provided for anthropic', () => {
      const resolved = makeResolved({
        provider: 'anthropic',
        baseUrl: 'https://custom-proxy.example.com'
      });
      const config = makeConfig({ provider: 'anthropic' });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://custom-proxy.example.com/v1/messages');
    });

    it('uses baseUrl override when provided for openai-compatible', () => {
      const resolved = makeResolved({
        provider: 'openai-compatible',
        baseUrl: 'https://my-openai-proxy.example.com'
      });
      const config = makeConfig({ provider: 'openai-compatible' });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://my-openai-proxy.example.com/v1/chat/completions');
    });

    it('custom provider uses resolved.baseUrl', () => {
      const resolved = makeResolved({
        provider: 'custom',
        baseUrl: 'https://my-custom-llm.example.com'
      });
      const config = makeConfig({ provider: 'custom', baseUrlOverride: 'https://my-custom-llm.example.com' });
      const { url, headers } = adapter.buildRequest('Hello', 'System', resolved, config);

      expect(url).toBe('https://my-custom-llm.example.com/chat/completions');
      expect(headers['Authorization']).toBe('Bearer sk-test-key');
    });

    it('omits system field in anthropic body when systemPrompt is undefined', () => {
      const resolved = makeResolved({ provider: 'anthropic' });
      const config = makeConfig({ provider: 'anthropic' });
      const { body } = adapter.buildRequest('Hello', undefined, resolved, config);

      const parsed = JSON.parse(body);
      expect(parsed.system).toBeUndefined();
    });

    it('omits system message in openai body when systemPrompt is undefined', () => {
      const resolved = makeResolved({ provider: 'openai-compatible' });
      const config = makeConfig({ provider: 'openai-compatible' });
      const { body } = adapter.buildRequest('Hello', undefined, resolved, config);

      const parsed = JSON.parse(body);
      expect(parsed.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    // ── OpenRouter tests ──────────────────────────────────────────

    it('7.1a: openrouter with no override → correct URL (no double /v1)', () => {
      const resolved = makeResolved({ provider: 'openrouter' });
      const config = makeConfig({ provider: 'openrouter' });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('7.1b: openrouter with explicit baseUrl=https://openrouter.ai/api/v1 → same URL', () => {
      const resolved = makeResolved({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1'
      });
      const config = makeConfig({ provider: 'openrouter' });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('7.2: openai-compatible with default baseUrl → /v1/chat/completions', () => {
      const resolved = makeResolved({
        provider: 'openai-compatible',
        baseUrl: 'https://api.openai.com'
      });
      const config = makeConfig({ provider: 'openai-compatible' });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('7.3: custom with baseUrl and pathOverride', () => {
      const resolved = makeResolved({
        provider: 'custom',
        baseUrl: 'https://gw.example.com/openai'
      });
      const config = makeConfig({
        provider: 'custom',
        baseUrlOverride: 'https://gw.example.com/openai',
        chatCompletionsPathOverride: '/chat/completions'
      });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://gw.example.com/openai/chat/completions');
    });

    it('openrouter uses default model openai/gpt-4o', () => {
      const resolved = makeResolved({ provider: 'openrouter' });
      const config = makeConfig({ provider: 'openrouter' });
      const { body } = adapter.buildRequest('Hello', undefined, resolved, config);

      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('openai/gpt-4o');
    });

    it('openrouter respects modelOverride from config', () => {
      const resolved = makeResolved({ provider: 'openrouter' });
      const config = makeConfig({ provider: 'openrouter', modelOverride: 'anthropic/claude-sonnet-4-20250514' });
      const { body } = adapter.buildRequest('Hello', undefined, resolved, config);

      const parsed = JSON.parse(body);
      expect(parsed.model).toBe('anthropic/claude-sonnet-4-20250514');
    });

    it('openrouter sets HTTP-Referer when openrouterSiteUrl configured', () => {
      const resolved = makeResolved({ provider: 'openrouter' });
      const config = makeConfig({
        provider: 'openrouter',
        openrouterSiteUrl: 'https://myapp.example.com'
      });
      const { headers } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(headers['HTTP-Referer']).toBe('https://myapp.example.com');
    });

    it('openrouter sets X-Title when openrouterAppName configured', () => {
      const resolved = makeResolved({ provider: 'openrouter' });
      const config = makeConfig({
        provider: 'openrouter',
        openrouterAppName: 'My Skill Evolution'
      });
      const { headers } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(headers['X-Title']).toBe('My Skill Evolution');
    });

    it('openrouter omits referer/title headers when not configured', () => {
      const resolved = makeResolved({ provider: 'openrouter' });
      const config = makeConfig({ provider: 'openrouter' });
      const { headers } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
    });

    it('config.llm.baseUrlOverride takes priority over resolved.baseUrl', () => {
      const resolved = makeResolved({
        provider: 'openai-compatible',
        baseUrl: 'https://resolved.example.com'
      });
      const config = makeConfig({
        provider: 'openai-compatible',
        baseUrlOverride: 'https://override.example.com'
      });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://override.example.com/v1/chat/completions');
    });

    it('anthropic messagesPathOverride works', () => {
      const resolved = makeResolved({ provider: 'anthropic' });
      const config = makeConfig({
        provider: 'anthropic',
        messagesPathOverride: '/v2/messages'
      });
      const { url } = adapter.buildRequest('Hello', undefined, resolved, config);

      expect(url).toBe('https://api.anthropic.com/v2/messages');
    });
  });

  describe('parseResponse', () => {
    it('parses anthropic response correctly', () => {
      const raw = JSON.stringify({
        content: [{ type: 'text', text: 'Hello from Claude' }]
      });
      const result = adapter.parseResponse(raw, 'anthropic');

      expect(result).toBe('Hello from Claude');
    });

    it('parses openai-compatible response correctly', () => {
      const raw = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hello from GPT' } }]
      });
      const result = adapter.parseResponse(raw, 'openai-compatible');

      expect(result).toBe('Hello from GPT');
    });

    it('parses custom response using openai format', () => {
      const raw = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hello from custom' } }]
      });
      const result = adapter.parseResponse(raw, 'custom');

      expect(result).toBe('Hello from custom');
    });

    it('parses openrouter response using openai format', () => {
      const raw = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hello from OpenRouter' } }]
      });
      const result = adapter.parseResponse(raw, 'openrouter');

      expect(result).toBe('Hello from OpenRouter');
    });

    it('throws on invalid JSON', () => {
      expect(() => adapter.parseResponse('not json', 'anthropic')).toThrow();
    });

    it('throws on missing content field for anthropic', () => {
      const raw = JSON.stringify({ id: 'msg_1' });
      expect(() => adapter.parseResponse(raw, 'anthropic')).toThrow();
    });

    it('throws on missing choices field for openai-compatible', () => {
      const raw = JSON.stringify({ id: 'chatcmpl-1' });
      expect(() => adapter.parseResponse(raw, 'openai-compatible')).toThrow();
    });
  });
});
