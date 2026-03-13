import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { LlmResolver, Logger, ProviderConfigSource, ResolvedProvider } from '../shared/types.js';
import { ConsoleLogger } from '../shared/logger.js';

/**
 * Resolves LLM provider configuration with strict priority:
 *   1. Injected ProviderConfigSource (from plugin host)
 *   2. Environment variables
 *   3. openclaw.json file (deprecated fallback)
 *   4. Error with structured diagnostics
 */
export class LlmRuntimeResolver implements LlmResolver {
  private readonly logger: Logger;
  private readonly workspaceDir: string;
  private readonly providerConfig: ProviderConfigSource | null;

  public constructor(
    workspaceDir: string,
    providerConfig: ProviderConfigSource | null,
    logger?: Logger
  ) {
    this.workspaceDir = workspaceDir;
    this.providerConfig = providerConfig;
    this.logger = logger ?? new ConsoleLogger('llm_runtime_resolver');
  }

  public resolve(model: string): ResolvedProvider {
    let extractedProviderId: string | null = null;
    let extractedModelId: string = model;

    if (model.includes('/')) {
      const parts = model.split('/');
      extractedProviderId = parts[0];
      extractedModelId = parts.slice(1).join('/');
    }

    this.logger.debug('Resolving LLM provider', {
      model,
      extractedProviderId,
      extractedModelId,
      workspaceDir: this.workspaceDir,
      hasInjectedConfig: !!this.providerConfig
    });

    // Priority 1: Injected provider config
    const injected = this.tryInjectedConfig(extractedProviderId, extractedModelId);
    if (injected) return injected;

    // Priority 2: Environment variables
    const env = this.tryEnvironment(extractedModelId);
    if (env) return env;

    // Priority 3: openclaw.json file (deprecated fallback)
    const file = this.tryOpenClawConfigFile(extractedProviderId, extractedModelId);
    if (file) return file;

    // Priority 4: Error with diagnostics
    const attempted: string[] = [];
    if (this.providerConfig) {
      attempted.push(`injected config (providers: ${Object.keys(this.providerConfig.providers ?? {}).join(', ') || 'none'})`);
    } else {
      attempted.push('injected config (not provided)');
    }
    attempted.push('env: OPENCLAW_ANYROUTER_BASE_URL/API_KEY');
    attempted.push('env: OPENROUTER_BASE_URL/API_KEY');
    attempted.push('env: OPENAI_BASE_URL/API_KEY');
    attempted.push('env: ANTHROPIC_API_KEY');
    attempted.push(`file: ${join(this.workspaceDir, '..', 'openclaw.json')}`);

    const message = `LLM provider not configured for model "${model}". Attempted sources:\n${attempted.map(s => `  - ${s}`).join('\n')}`;
    this.logger.error('LLM provider resolution failed', {
      model,
      extractedProviderId,
      workspaceDir: this.workspaceDir,
      attemptedSources: attempted
    });
    throw new Error(message);
  }

  private tryInjectedConfig(providerId: string | null, modelId: string): ResolvedProvider | null {
    const providers = this.providerConfig?.providers;
    if (!providers || Object.keys(providers).length === 0) {
      return null;
    }

    let match: { baseUrl: string; apiKey: string; api?: 'openai' | 'anthropic-messages' } | undefined;

    if (providerId && providers[providerId]) {
      match = providers[providerId];
      this.logger.debug('Resolved from injected config by provider ID', { providerId });
    } else if (providers['anyrouter']) {
      match = providers['anyrouter'];
      this.logger.debug('Resolved from injected config via anyrouter fallback');
    } else if (providers['openrouter']) {
      match = providers['openrouter'];
      this.logger.debug('Resolved from injected config via openrouter fallback');
    }

    if (!match) return null;

    return {
      baseUrl: match.baseUrl,
      apiKey: match.apiKey,
      api: match.api ?? 'anthropic-messages',
      modelId,
      resolvedFrom: 'injected'
    };
  }

  private tryEnvironment(modelId: string): ResolvedProvider | null {
    // OPENCLAW_ANYROUTER
    const anyrouterUrl = process.env.OPENCLAW_ANYROUTER_BASE_URL;
    const anyrouterKey = process.env.OPENCLAW_ANYROUTER_API_KEY;
    if (anyrouterUrl && anyrouterKey) {
      this.logger.debug('Resolved from env OPENCLAW_ANYROUTER', { baseUrl: anyrouterUrl.substring(0, 30) });
      return { baseUrl: anyrouterUrl, apiKey: anyrouterKey, api: 'anthropic-messages', modelId, resolvedFrom: 'env' };
    }

    // OPENROUTER
    const openrouterUrl = process.env.OPENROUTER_BASE_URL;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openrouterUrl && openrouterKey) {
      this.logger.debug('Resolved from env OPENROUTER', { baseUrl: openrouterUrl.substring(0, 30) });
      return { baseUrl: openrouterUrl, apiKey: openrouterKey, api: 'openai', modelId, resolvedFrom: 'env' };
    }

    // OPENAI
    const openaiUrl = process.env.OPENAI_BASE_URL;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiUrl && openaiKey) {
      this.logger.debug('Resolved from env OPENAI', { baseUrl: openaiUrl.substring(0, 30) });
      return { baseUrl: openaiUrl, apiKey: openaiKey, api: 'openai', modelId, resolvedFrom: 'env' };
    }

    // ANTHROPIC (baseUrl defaults)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.logger.debug('Resolved from env ANTHROPIC_API_KEY');
      return { baseUrl: 'https://api.anthropic.com/v1', apiKey: anthropicKey, api: 'anthropic-messages', modelId, resolvedFrom: 'env' };
    }

    return null;
  }

  private tryOpenClawConfigFile(providerId: string | null, modelId: string): ResolvedProvider | null {
    const configPath = join(this.workspaceDir, '..', 'openclaw.json');

    this.logger.debug('Trying deprecated openclaw.json fallback', { configPath });

    if (!existsSync(configPath)) {
      return null;
    }

    try {
      // Synchronous read for simplicity in resolve()
      const fs = require('node:fs');
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent);
      const providers = config?.models?.providers;

      if (!providers) return null;

      let match: { baseUrl?: string; apiKey?: string; api?: string } | undefined;

      if (providerId && providers[providerId]) {
        match = providers[providerId];
      } else if (providers['anyrouter']) {
        match = providers['anyrouter'];
      } else if (providers['openrouter']) {
        match = providers['openrouter'];
      }

      if (match?.baseUrl && match?.apiKey) {
        this.logger.warn('Resolved from openclaw.json file (deprecated fallback)', {
          configPath,
          providerId: providerId ?? 'anyrouter/openrouter'
        });
        return {
          baseUrl: match.baseUrl,
          apiKey: match.apiKey,
          api: (match.api === 'openai' ? 'openai' : 'anthropic-messages'),
          modelId,
          resolvedFrom: 'openclaw-config'
        };
      }
    } catch (err: unknown) {
      this.logger.warn('Failed to read openclaw.json', {
        configPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return null;
  }
}

export default LlmRuntimeResolver;
