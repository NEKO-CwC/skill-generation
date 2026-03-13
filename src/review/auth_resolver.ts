/**
 * AuthResolverImpl — resolves LLM credentials via a priority chain:
 * authProfileRef → keyRef → agent default profile → gateway fallback.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import ConsoleLogger from '../shared/logger.js';
import type { AuthResolver, ResolvedAuth, SecretRef, SkillEvolutionConfig } from '../shared/types.js';

interface AuthProfile {
  id: string;
  provider?: ResolvedAuth['provider'];
  apiKey?: string;
  baseUrl?: string;
  default?: boolean;
}

const GATEWAY_ENV_MAP: Array<{ envVar: string; provider: ResolvedAuth['provider'] }> = [
  { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { envVar: 'OPENAI_API_KEY', provider: 'openai-compatible' }
];

const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 1024;

export class AuthResolverImpl implements AuthResolver {
  private readonly logger = new ConsoleLogger('auth_resolver');

  public async resolve(
    config: SkillEvolutionConfig,
    agentId?: string
  ): Promise<ResolvedAuth | null> {
    const attemptedSources: string[] = [];

    // 1. authProfileRef — explicit profile reference
    if (config.llm.authProfileRef) {
      attemptedSources.push(`authProfileRef:${config.llm.authProfileRef}`);
      const result = this.resolveAuthProfileRef(config.llm.authProfileRef, config.llm.provider, agentId);
      if (result) {
        this.logger.info('Resolved auth via authProfileRef', {
          profileId: config.llm.authProfileRef,
          provider: result.provider
        });
        return result;
      }
    }

    // 2. keyRef — SecretRef resolution
    if (config.llm.keyRef) {
      attemptedSources.push(`keyRef:${config.llm.keyRef.source}:${config.llm.keyRef.id}`);
      const result = this.resolveKeyRef(config.llm.keyRef, config);
      if (result) {
        this.logger.info('Resolved auth via keyRef', {
          source: config.llm.keyRef.source,
          provider: result.provider
        });
        return result;
      }
    }

    // 3. Agent default profile
    if (agentId) {
      attemptedSources.push(`agent-default-profile:${agentId}`);
      const result = this.resolveAgentDefaultProfile(config.llm.provider, agentId);
      if (result) {
        this.logger.info('Resolved auth via agent default profile', {
          agentId,
          provider: result.provider
        });
        return result;
      }
    }

    // 4. Gateway fallback
    if (config.llm.allowGatewayFallback) {
      attemptedSources.push('gateway-fallback');
      const result = this.resolveGatewayFallback();
      if (result) {
        this.logger.info('Resolved auth via gateway fallback', {
          provider: result.provider
        });
        return result;
      }
    }

    // 5. All sources exhausted
    this.logger.warn('Auth resolution failed: no valid credentials found', {
      attemptedSources
    });
    return null;
  }

  private resolveAuthProfileRef(
    profileId: string,
    provider: ResolvedAuth['provider'],
    agentId?: string
  ): ResolvedAuth | null {
    const profiles = this.loadAuthProfiles(agentId);
    if (!profiles) return null;

    const profile = profiles.find((p) => p.id === profileId);
    if (!profile || !profile.apiKey) return null;

    return {
      apiKey: profile.apiKey,
      provider: profile.provider ?? provider,
      baseUrl: profile.baseUrl,
      profileId: profile.id,
      source: 'authProfileRef'
    };
  }

  private resolveKeyRef(
    keyRef: SecretRef,
    config: SkillEvolutionConfig
  ): ResolvedAuth | null {
    let apiKey: string | null = null;

    if (keyRef.source === 'env') {
      apiKey = process.env[keyRef.id] ?? null;
    } else if (keyRef.source === 'file') {
      try {
        apiKey = readFileSync(keyRef.id, 'utf8').trim();
      } catch {
        this.logger.warn('Failed to read secret from file', { path: keyRef.id });
        return null;
      }
    } else if (keyRef.source === 'exec') {
      if (!config.llm.allowExecSecretRef) {
        this.logger.warn('exec SecretRef blocked by allowExecSecretRef=false');
        return null;
      }
      try {
        const result = spawnSync(keyRef.id, keyRef.args ?? [], {
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: EXEC_MAX_BUFFER,
          encoding: 'utf8'
        });
        if (result.status === 0 && result.stdout) {
          apiKey = result.stdout.trim();
        } else {
          this.logger.warn('exec SecretRef returned non-zero or empty', {
            status: result.status
          });
          return null;
        }
      } catch {
        this.logger.warn('exec SecretRef execution failed', { command: keyRef.id });
        return null;
      }
    }

    if (!apiKey) return null;

    return {
      apiKey,
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrlOverride ?? undefined,
      source: 'keyRef'
    };
  }

  private resolveAgentDefaultProfile(
    provider: ResolvedAuth['provider'],
    agentId: string
  ): ResolvedAuth | null {
    const profiles = this.loadAuthProfiles(agentId);
    if (!profiles || profiles.length === 0) return null;

    const defaultProfile = profiles.find((p) => p.default === true) ?? profiles[0];
    if (!defaultProfile.apiKey) return null;

    return {
      apiKey: defaultProfile.apiKey,
      provider: defaultProfile.provider ?? provider,
      baseUrl: defaultProfile.baseUrl,
      profileId: defaultProfile.id,
      source: 'agent-auth-profile'
    };
  }

  private resolveGatewayFallback(): ResolvedAuth | null {
    for (const entry of GATEWAY_ENV_MAP) {
      const value = process.env[entry.envVar];
      if (value) {
        return {
          apiKey: value,
          provider: entry.provider,
          source: 'gateway-fallback'
        };
      }
    }
    return null;
  }

  private loadAuthProfiles(agentId?: string): AuthProfile[] | null {
    if (!agentId) return null;

    const profilesPath = join(
      homedir(),
      '.openclaw',
      'agents',
      agentId,
      'agent',
      'auth-profiles.json'
    );

    try {
      const raw = readFileSync(profilesPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      return parsed as AuthProfile[];
    } catch {
      this.logger.debug('Auth profiles file not found or unreadable', { path: profilesPath });
      return null;
    }
  }
}

export default AuthResolverImpl;
