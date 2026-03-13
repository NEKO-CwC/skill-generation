import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { LlmClientImpl } from '../../src/review/llm_client_impl.ts';
import { LlmCallError } from '../../src/shared/errors.ts';
import type { AuthResolver, ResolvedAuth, SkillEvolutionConfig } from '../../src/shared/types.ts';

const makeConfig = (overrides: Partial<SkillEvolutionConfig['llm']> = {}): SkillEvolutionConfig => {
  const config = getDefaultConfig();
  config.llm = { ...config.llm, ...overrides };
  return config;
};

const makeResolved = (overrides: Partial<ResolvedAuth> = {}): ResolvedAuth => ({
  apiKey: 'sk-test-key-abc',
  provider: 'anthropic',
  source: 'keyRef',
  ...overrides
});

const makeAuthResolver = (result: ResolvedAuth | null): AuthResolver => ({
  resolve: vi.fn().mockResolvedValue(result)
});

const makeOkResponse = (body: unknown): Response => {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' }
  });
};

describe('review/llm_client_impl - LlmClientImpl', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('completes full chain with mock fetch for anthropic', async () => {
    const resolved = makeResolved({ provider: 'anthropic' });
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig({ provider: 'anthropic' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeOkResponse({
        content: [{ type: 'text', text: 'LLM response text' }]
      })
    ));

    const client = new LlmClientImpl(config, authResolver);
    const result = await client.complete('What is 2+2?', 'You are a calculator');

    expect(result).toBe('LLM response text');
    expect(authResolver.resolve).toHaveBeenCalledWith(config);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.anthropic.com/v1/messages');
    const opts = fetchCall[1] as RequestInit;
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key-abc');
  });

  it('completes full chain with mock fetch for openai-compatible', async () => {
    const resolved = makeResolved({ provider: 'openai-compatible' });
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig({ provider: 'openai-compatible' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeOkResponse({
        choices: [{ message: { role: 'assistant', content: 'OpenAI response' } }]
      })
    ));

    const client = new LlmClientImpl(config, authResolver);
    const result = await client.complete('Hello', 'Be helpful');

    expect(result).toBe('OpenAI response');
  });

  it('completes full chain with mock fetch for openrouter', async () => {
    const resolved = makeResolved({ provider: 'openrouter' });
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig({
      provider: 'openrouter',
      openrouterSiteUrl: 'https://myapp.example.com',
      openrouterAppName: 'TestApp'
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeOkResponse({
        choices: [{ message: { role: 'assistant', content: 'OpenRouter response' } }]
      })
    ));

    const client = new LlmClientImpl(config, authResolver);
    const result = await client.complete('Hello', 'Be helpful');

    expect(result).toBe('OpenRouter response');

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const opts = fetchCall[1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key-abc');
    expect(headers['HTTP-Referer']).toBe('https://myapp.example.com');
    expect(headers['X-Title']).toBe('TestApp');

    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe('openai/gpt-4o');
  });

  it('throws LlmCallError when auth resolves null', async () => {
    const authResolver = makeAuthResolver(null);
    const config = makeConfig();

    const client = new LlmClientImpl(config, authResolver);

    await expect(client.complete('Hello')).rejects.toThrow(LlmCallError);
    await expect(client.complete('Hello')).rejects.toThrow('Auth resolution failed');
  });

  it('throws LlmCallError on HTTP error (non-ok response)', async () => {
    const resolved = makeResolved();
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized'
      })
    ));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.statusCode).toBe(401);
      expect(llmErr.provider).toBe('anthropic');
      expect(llmErr.message).toContain('401');
    }
  });

  it('throws LlmCallError on fetch timeout (AbortError simulation)', async () => {
    const resolved = makeResolved();
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig();

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(abortError);
    }));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.message).toContain('timed out');
      expect(llmErr.provider).toBe('anthropic');
    }
  });

  it('throws LlmCallError on fetch network error', async () => {
    const resolved = makeResolved();
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.message).toContain('Fetch failed');
    }
  });

  it('throws LlmCallError on invalid JSON response', async () => {
    const resolved = makeResolved();
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('not valid json at all', {
        status: 200,
        statusText: 'OK'
      })
    ));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.message).toContain('parse');
    }
  });

  it('never includes apiKey in error messages', async () => {
    const resolved = makeResolved({ apiKey: 'sk-super-secret-never-leak' });
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' })
    ));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.message).not.toContain('sk-super-secret-never-leak');
      expect(String(llmErr)).not.toContain('sk-super-secret-never-leak');
    }
  });

  it('7.5: LlmCallError includes resolvedUrl on HTTP failure', async () => {
    const resolved = makeResolved({ provider: 'openrouter' });
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig({ provider: 'openrouter' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    ));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.provider).toBe('openrouter');
      expect(llmErr.statusCode).toBe(403);
      expect(llmErr.resolvedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    }
  });

  it('7.5: LlmCallError includes resolvedUrl on fetch failure', async () => {
    const resolved = makeResolved({ provider: 'anthropic' });
    const authResolver = makeAuthResolver(resolved);
    const config = makeConfig({ provider: 'anthropic' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')));

    const client = new LlmClientImpl(config, authResolver);

    try {
      await client.complete('Hello');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmCallError);
      const llmErr = error as LlmCallError;
      expect(llmErr.resolvedUrl).toBe('https://api.anthropic.com/v1/messages');
    }
  });
});
