import { describe, expect, it } from 'vitest';
import { ProviderAdapterImpl } from '../../src/review/provider_adapter.ts';
import type { ResolvedAuth } from '../../src/shared/types.ts';

const makeResolved = (overrides: Partial<ResolvedAuth> = {}): ResolvedAuth => ({
  apiKey: 'sk-test-key',
  provider: 'anthropic',
  source: 'keyRef',
  ...overrides
});

describe('review/provider_adapter - ProviderAdapterImpl', () => {
  const adapter = new ProviderAdapterImpl();

  describe('buildRequest', () => {
    it('builds correct anthropic request', () => {
      const resolved = makeResolved({ provider: 'anthropic' });
      const { url, headers, body } = adapter.buildRequest('Hello', 'Be helpful', resolved);

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
      const { url, headers, body } = adapter.buildRequest('Hello', 'Be helpful', resolved);

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
      const { url } = adapter.buildRequest('Hello', undefined, resolved);

      expect(url).toBe('https://custom-proxy.example.com/v1/messages');
    });

    it('uses baseUrl override when provided for openai-compatible', () => {
      const resolved = makeResolved({
        provider: 'openai-compatible',
        baseUrl: 'https://my-openai-proxy.example.com'
      });
      const { url } = adapter.buildRequest('Hello', undefined, resolved);

      expect(url).toBe('https://my-openai-proxy.example.com/v1/chat/completions');
    });

    it('custom provider uses resolved.baseUrl', () => {
      const resolved = makeResolved({
        provider: 'custom',
        baseUrl: 'https://my-custom-llm.example.com'
      });
      const { url, headers } = adapter.buildRequest('Hello', 'System', resolved);

      expect(url).toBe('https://my-custom-llm.example.com/v1/chat/completions');
      expect(headers['Authorization']).toBe('Bearer sk-test-key');
    });

    it('omits system field in anthropic body when systemPrompt is undefined', () => {
      const resolved = makeResolved({ provider: 'anthropic' });
      const { body } = adapter.buildRequest('Hello', undefined, resolved);

      const parsed = JSON.parse(body);
      expect(parsed.system).toBeUndefined();
    });

    it('omits system message in openai body when systemPrompt is undefined', () => {
      const resolved = makeResolved({ provider: 'openai-compatible' });
      const { body } = adapter.buildRequest('Hello', undefined, resolved);

      const parsed = JSON.parse(body);
      expect(parsed.messages).toEqual([{ role: 'user', content: 'Hello' }]);
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
