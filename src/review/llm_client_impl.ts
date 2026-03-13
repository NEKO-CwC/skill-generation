/**
 * LlmClientImpl — orchestrates auth resolution, request building, and
 * response parsing for LLM API calls.
 */

import { LlmCallError } from '../shared/errors.js';
import ConsoleLogger from '../shared/logger.js';
import type { AuthResolver, LlmClient, SkillEvolutionConfig } from '../shared/types.js';
import { ProviderAdapterImpl } from './provider_adapter.js';
import type { ProviderAdapter } from './provider_adapter.js';

const REQUEST_TIMEOUT_MS = 60_000;

export class LlmClientImpl implements LlmClient {
  private readonly config: SkillEvolutionConfig;
  private readonly authResolver: AuthResolver;
  private readonly providerAdapter: ProviderAdapter;
  private readonly logger = new ConsoleLogger('llm_client');

  public constructor(
    config: SkillEvolutionConfig,
    authResolver: AuthResolver,
    providerAdapter?: ProviderAdapter
  ) {
    this.config = config;
    this.authResolver = authResolver;
    this.providerAdapter = providerAdapter ?? new ProviderAdapterImpl();
  }

  public async complete(prompt: string, systemPrompt?: string): Promise<string> {
    // 1. Resolve auth
    const resolved = await this.authResolver.resolve(this.config);
    if (!resolved) {
      throw new LlmCallError('Auth resolution failed: no valid credentials found');
    }

    // 2. Build request
    const { url, headers, body } = this.providerAdapter.buildRequest(prompt, systemPrompt, resolved);

    this.logger.info('Sending LLM request', {
      provider: resolved.provider,
      source: resolved.source,
      url
    });

    // 3. Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmCallError(
          `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          undefined,
          resolved.provider
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmCallError(
        `Fetch failed: ${message}`,
        undefined,
        resolved.provider
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // 4. Check HTTP status
    if (!response.ok) {
      throw new LlmCallError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        resolved.provider
      );
    }

    // 5. Parse response
    let rawJson: string;
    try {
      rawJson = await response.text();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmCallError(
        `Failed to read response body: ${message}`,
        response.status,
        resolved.provider
      );
    }

    let result: string;
    try {
      result = this.providerAdapter.parseResponse(rawJson, resolved.provider);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmCallError(
        `Failed to parse response: ${message}`,
        response.status,
        resolved.provider
      );
    }

    this.logger.info('LLM request completed', {
      provider: resolved.provider,
      responseLength: result.length
    });

    return result;
  }
}

export default LlmClientImpl;
