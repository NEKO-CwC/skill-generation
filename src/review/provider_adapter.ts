/**
 * ProviderAdapterImpl — builds HTTP requests and parses responses for
 * Anthropic, OpenAI-compatible, OpenRouter, and custom LLM providers.
 *
 * URL construction uses per-provider specs so that base URLs and path
 * segments never produce double-`/v1` issues.
 */

import type { LlmProviderType, ResolvedAuth, SkillEvolutionConfig } from '../shared/types.js';

export interface ProviderAdapter {
  buildRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth,
    config: SkillEvolutionConfig
  ): { url: string; headers: Record<string, string>; body: string };

  parseResponse(rawJson: string, provider: LlmProviderType): string;
}

// ── Provider Spec ────────────────────────────────────────────────

interface ProviderSpec {
  defaultBaseUrl: string;
  defaultChatCompletionsPath: string;
  defaultMessagesPath: string;
  defaultModel: string;
  authStyle: 'bearer' | 'x-api-key';
  responseFormat: 'openai' | 'anthropic';
}

const PROVIDER_SPECS: Record<LlmProviderType, ProviderSpec> = {
  anthropic: {
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultChatCompletionsPath: '',
    defaultMessagesPath: '/v1/messages',
    defaultModel: 'claude-sonnet-4-20250514',
    authStyle: 'x-api-key',
    responseFormat: 'anthropic'
  },
  'openai-compatible': {
    defaultBaseUrl: 'https://api.openai.com',
    defaultChatCompletionsPath: '/v1/chat/completions',
    defaultMessagesPath: '',
    defaultModel: 'gpt-4o',
    authStyle: 'bearer',
    responseFormat: 'openai'
  },
  openrouter: {
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultChatCompletionsPath: '/chat/completions',
    defaultMessagesPath: '',
    defaultModel: 'openai/gpt-4o',
    authStyle: 'bearer',
    responseFormat: 'openai'
  },
  custom: {
    defaultBaseUrl: '',
    defaultChatCompletionsPath: '/chat/completions',
    defaultMessagesPath: '/messages',
    defaultModel: 'gpt-4o',
    authStyle: 'bearer',
    responseFormat: 'openai'
  }
};

const ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

// ── URL Helper ───────────────────────────────────────────────────

/**
 * Joins a base URL with a path segment.
 * Trims trailing slashes from base, ensures path starts with `/`.
 */
export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

// ── Adapter Implementation ───────────────────────────────────────

export class ProviderAdapterImpl implements ProviderAdapter {
  public buildRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth,
    config: SkillEvolutionConfig
  ): { url: string; headers: Record<string, string>; body: string } {
    const spec = PROVIDER_SPECS[resolved.provider];

    // Resolve base URL: config override → resolved.baseUrl → spec default
    const baseUrl = config.llm.baseUrlOverride ?? resolved.baseUrl ?? spec.defaultBaseUrl;

    // Resolve model: config override → spec default
    const model = config.llm.modelOverride ?? spec.defaultModel;

    if (spec.responseFormat === 'anthropic') {
      return this.buildAnthropicRequest(prompt, systemPrompt, resolved, config, spec, baseUrl, model);
    }
    return this.buildOpenAiRequest(prompt, systemPrompt, resolved, config, spec, baseUrl, model);
  }

  public parseResponse(rawJson: string, provider: LlmProviderType): string {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const spec = PROVIDER_SPECS[provider];

    if (spec.responseFormat === 'anthropic') {
      const content = parsed.content as Array<{ text: string }>;
      return content[0].text;
    }
    const choices = parsed.choices as Array<{ message: { content: string } }>;
    return choices[0].message.content;
  }

  private buildAnthropicRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth,
    config: SkillEvolutionConfig,
    spec: ProviderSpec,
    baseUrl: string,
    model: string
  ): { url: string; headers: Record<string, string>; body: string } {
    const path = config.llm.messagesPathOverride ?? spec.defaultMessagesPath;
    const url = joinUrl(baseUrl, path);

    const headers: Record<string, string> = {
      'x-api-key': resolved.apiKey,
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION
    };

    const bodyObj: Record<string, unknown> = {
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }]
    };
    if (systemPrompt !== undefined) {
      bodyObj.system = systemPrompt;
    }

    return { url, headers, body: JSON.stringify(bodyObj) };
  }

  private buildOpenAiRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth,
    config: SkillEvolutionConfig,
    spec: ProviderSpec,
    baseUrl: string,
    model: string
  ): { url: string; headers: Record<string, string>; body: string } {
    const path = config.llm.chatCompletionsPathOverride ?? spec.defaultChatCompletionsPath;
    const url = joinUrl(baseUrl, path);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${resolved.apiKey}`,
      'content-type': 'application/json'
    };

    // OpenRouter-specific headers
    if (resolved.provider === 'openrouter') {
      if (config.llm.openrouterSiteUrl) {
        headers['HTTP-Referer'] = config.llm.openrouterSiteUrl;
      }
      if (config.llm.openrouterAppName) {
        headers['X-Title'] = config.llm.openrouterAppName;
      }
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt !== undefined) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const bodyObj = { model, messages };

    return { url, headers, body: JSON.stringify(bodyObj) };
  }
}

export default ProviderAdapterImpl;
