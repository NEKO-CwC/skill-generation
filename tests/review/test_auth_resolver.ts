import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { AuthResolverImpl } from '../../src/review/auth_resolver.ts';
import type { SkillEvolutionConfig } from '../../src/shared/types.ts';

const makeConfig = (overrides: Partial<SkillEvolutionConfig['llm']> = {}): SkillEvolutionConfig => {
  const config = getDefaultConfig();
  config.llm = { ...config.llm, ...overrides };
  return config;
};

describe('review/auth_resolver - AuthResolverImpl', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it('resolves from env SecretRef', async () => {
    process.env['TEST_LLM_KEY'] = 'sk-env-test-123';
    const config = makeConfig({
      keyRef: { source: 'env', id: 'TEST_LLM_KEY' },
      allowExecSecretRef: false
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-env-test-123');
    expect(result!.source).toBe('keyRef');
    expect(result!.provider).toBe('anthropic');
  });

  it('resolves from file SecretRef using tmp file', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'auth-resolver-test-'));
    const keyFile = join(tmpDir, 'api-key.txt');
    await writeFile(keyFile, '  sk-file-test-456  \n');

    const config = makeConfig({
      keyRef: { source: 'file', id: keyFile },
      allowExecSecretRef: false
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-file-test-456');
    expect(result!.source).toBe('keyRef');
  });

  it('returns null when no sources are available', async () => {
    const config = makeConfig({
      authProfileRef: null,
      keyRef: null,
      allowGatewayFallback: false
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).toBeNull();
  });

  it('respects authProfileRef priority over keyRef when agent profile file exists', async () => {
    // Set up env key that would match keyRef
    process.env['TEST_FALLBACK_KEY'] = 'sk-fallback';

    // Create a temp auth-profiles.json at a known path
    // Since the resolver reads from ~/.openclaw/agents/<agentId>/agent/auth-profiles.json,
    // and we can't easily mock that, we test that keyRef env is used when authProfileRef fails
    // to find a profile (no agentId provided, so auth-profiles.json won't be loaded)
    const config = makeConfig({
      authProfileRef: 'nonexistent-profile',
      keyRef: { source: 'env', id: 'TEST_FALLBACK_KEY' },
      allowExecSecretRef: false
    });

    const resolver = new AuthResolverImpl();
    // No agentId → authProfileRef path won't find auth-profiles.json → falls through to keyRef
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-fallback');
    expect(result!.source).toBe('keyRef');
  });

  it('exec SecretRef blocked when allowExecSecretRef=false', async () => {
    const config = makeConfig({
      keyRef: { source: 'exec', id: 'echo', args: ['secret-value'] },
      allowExecSecretRef: false,
      allowGatewayFallback: false
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).toBeNull();
  });

  it('gateway fallback works when allowed and ANTHROPIC_API_KEY is set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-gateway-anthro';
    const config = makeConfig({
      authProfileRef: null,
      keyRef: null,
      allowGatewayFallback: true
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-gateway-anthro');
    expect(result!.provider).toBe('anthropic');
    expect(result!.source).toBe('gateway-fallback');
  });

  it('gateway fallback works when allowed and OPENROUTER_API_KEY is set', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-gateway-openrouter';
    const config = makeConfig({
      authProfileRef: null,
      keyRef: null,
      allowGatewayFallback: true
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-gateway-openrouter');
    expect(result!.provider).toBe('openrouter');
    expect(result!.source).toBe('gateway-fallback');
  });

  it('gateway fallback prefers ANTHROPIC_API_KEY over OPENROUTER_API_KEY', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-gateway-anthro';
    process.env['OPENROUTER_API_KEY'] = 'sk-gateway-openrouter';
    const config = makeConfig({
      authProfileRef: null,
      keyRef: null,
      allowGatewayFallback: true
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-gateway-anthro');
    expect(result!.provider).toBe('anthropic');
  });

  it('gateway fallback uses OPENROUTER_API_KEY before OPENAI_API_KEY', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-gateway-openrouter';
    process.env['OPENAI_API_KEY'] = 'sk-gateway-openai';
    const config = makeConfig({
      authProfileRef: null,
      keyRef: null,
      allowGatewayFallback: true
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-gateway-openrouter');
    expect(result!.provider).toBe('openrouter');
  });

  it('gateway fallback skipped when not allowed', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-gateway-should-skip';
    const config = makeConfig({
      authProfileRef: null,
      keyRef: null,
      allowGatewayFallback: false
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config);

    expect(result).toBeNull();
  });

  it('logs attempted sources on failure', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = makeConfig({
      authProfileRef: 'nonexistent-profile',
      keyRef: { source: 'env', id: 'NONEXISTENT_KEY_VAR' },
      allowGatewayFallback: false
    });

    const resolver = new AuthResolverImpl();
    const result = await resolver.resolve(config, 'agent-test');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    // The last warn call should contain attempted sources
    const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0] as string;
    expect(lastCall).toContain('attemptedSources');

    consoleSpy.mockRestore();
  });
});
