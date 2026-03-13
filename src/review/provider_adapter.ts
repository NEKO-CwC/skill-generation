/**
 * ProviderAdapterImpl — builds HTTP requests and parses responses for
 * Anthropic, OpenAI-compatible, and custom LLM providers.
 */

import type { ResolvedAuth } from '../shared/types.js';

export interface ProviderAdapter {
  buildRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth
  ): { url: string; headers: Record<string, string>; body: string };

  parseResponse(rawJson: string, provider: ResolvedAuth['provider']): string;
}

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const OPENAI_MODEL = 'gpt-4o';
const ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

export class ProviderAdapterImpl implements ProviderAdapter {
  public buildRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth
  ): { url: string; headers: Record<string, string>; body: string } {
    if (resolved.provider === 'anthropic') {
      return this.buildAnthropicRequest(prompt, systemPrompt, resolved);
    }
    // openai-compatible and custom share the same format
    return this.buildOpenAiRequest(prompt, systemPrompt, resolved);
  }

  public parseResponse(rawJson: string, provider: ResolvedAuth['provider']): string {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;

    if (provider === 'anthropic') {
      return this.parseAnthropicResponse(parsed);
    }
    // openai-compatible and custom share the same format
    return this.parseOpenAiResponse(parsed);
  }

  private buildAnthropicRequest(
    prompt: string,
    systemPrompt: string | undefined,
    resolved: ResolvedAuth
  ): { url: string; headers: Record<string, string>; body: string } {
    const baseUrl = resolved.baseUrl ?? DEFAULT_ANTHROPIC_BASE;
    const url = `${baseUrl}/v1/messages`;

    const headers: Record<string, string> = {
      'x-api-key': resolved.apiKey,
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION
    };

    const bodyObj: Record<string, unknown> = {
      model: ANTHROPIC_MODEL,
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
    resolved: ResolvedAuth
  ): { url: string; headers: Record<string, string>; body: string } {
    let baseUrl: string;
    if (resolved.provider === 'custom') {
      // custom requires resolved.baseUrl
      baseUrl = resolved.baseUrl!;
    } else {
      baseUrl = resolved.baseUrl ?? DEFAULT_OPENAI_BASE;
    }
    const url = `${baseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${resolved.apiKey}`,
      'content-type': 'application/json'
    };

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt !== undefined) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const bodyObj = {
      model: OPENAI_MODEL,
      messages
    };

    return { url, headers, body: JSON.stringify(bodyObj) };
  }

  private parseAnthropicResponse(parsed: Record<string, unknown>): string {
    const content = parsed.content as Array<{ text: string }>;
    return content[0].text;
  }

  private parseOpenAiResponse(parsed: Record<string, unknown>): string {
    const choices = parsed.choices as Array<{ message: { content: string } }>;
    return choices[0].message.content;
  }
}

export default ProviderAdapterImpl;
