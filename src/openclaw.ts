import type {
  AgentEndEvent,
  AfterToolCallEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  MessageReceivedEvent,
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookMessageContext,
  PluginHookToolContext,
  ProviderConfigSource,
  SessionEndEvent,
  SkillEvolutionConfig
} from './shared/types.js';
import { fromOpenClawPluginConfig } from './plugin/config.js';
import { SkillEvolutionPlugin } from './plugin/index.js';
import { ConsoleLogger } from './shared/logger.js';

const HOOK_PRIORITY = 50;

/**
 * Resolves session ID from any hook context type with a consistent priority chain.
 * Priority: sessionId → sessionKey → conversationId → channelId → 'unknown-session'
 */
function resolveSessionId(ctx: Record<string, unknown>): string {
  if (typeof ctx.sessionId === 'string' && ctx.sessionId) return ctx.sessionId;
  if (typeof ctx.sessionKey === 'string' && ctx.sessionKey) return ctx.sessionKey;
  if (typeof ctx.conversationId === 'string' && ctx.conversationId) return ctx.conversationId;
  if (typeof ctx.channelId === 'string' && ctx.channelId) return ctx.channelId;
  return 'unknown-session';
}

/**
 * Captures workspace directory from hook context if available.
 * Used to bind the plugin to the real workspace on first hook invocation.
 */
function captureWorkspaceDir(plugin: SkillEvolutionPlugin, ctx: Record<string, unknown>): void {
  if (typeof ctx.workspaceDir === 'string' && ctx.workspaceDir) {
    plugin.logger.debug('captureWorkspaceDir called', { 
      workspaceDir: ctx.workspaceDir, 
      cwd: process.cwd()
    });
    plugin.ensureWorkspaceDir(ctx.workspaceDir);
  } else {
    plugin.logger.debug('captureWorkspaceDir called but no workspaceDir in context', { 
      ctxKeys: Object.keys(ctx)
    });
  }
}

/**
 * Registers the Skill Evolution plugin hooks with OpenClaw.
 */
export default function register(api: OpenClawPluginApi): void {
  const logger = new ConsoleLogger('openclaw.adapter');
  const rawConfig = api.pluginConfig;

  let config: SkillEvolutionConfig | undefined;
  try {
    config = fromOpenClawPluginConfig(rawConfig ?? {});
  } catch (err: unknown) {
    logger.warn('Failed to parse plugin config, using defaults', {
      error: err instanceof Error ? err.message : String(err)
    });
    config = undefined;
  }

  const plugin = new SkillEvolutionPlugin(config);
  logger.info('Skill Evolution plugin registered', { enabled: plugin.config.enabled });

  // Extract provider config from host and inject into plugin for LLM resolution
  const providerConfigSource = extractProviderConfigSource(rawConfig ?? {});
  if (providerConfigSource) {
    plugin.setProviderConfigSource(providerConfigSource);
    logger.debug('Injected provider config source', {
      providers: Object.keys(providerConfigSource.providers ?? {})
    });
  }

  if (!plugin.config.enabled) {
    logger.info('Plugin is disabled by config, skipping hook registration');
    return;
  }

  api.on(
    'before_prompt_build',
    async (
      event: BeforePromptBuildEvent,
      ctx: PluginHookAgentContext
    ): Promise<BeforePromptBuildResult | undefined> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const eventRecord = event as unknown as Record<string, unknown>;
      const ctxSkillKey = typeof ctxRecord.skillKey === 'string' ? ctxRecord.skillKey : undefined;
      const eventSkillKey = typeof eventRecord.skillKey === 'string' ? eventRecord.skillKey : undefined;
      const knownSkillKey = plugin.getSessionSkillKey(sessionId);
      const fallbackSkillKey = knownSkillKey === 'unknown-skill' ? 'default-skill' : knownSkillKey;
      const skillKey = ctxSkillKey ?? eventSkillKey ?? fallbackSkillKey;
      const currentPrompt = typeof event.prompt === 'string' ? event.prompt : '';

      const result = await plugin.before_prompt_build(sessionId, skillKey, currentPrompt);
      if (result === currentPrompt) {
        return undefined;
      }

      const overlayText = result.endsWith(currentPrompt)
        ? result.slice(0, result.length - currentPrompt.length)
        : result;

      return { prependSystemContext: overlayText };
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'after_tool_call',
    async (event: AfterToolCallEvent, ctx: PluginHookToolContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const toolName = event.toolName;
      const output = String(event.result ?? event.error ?? '');
      const isError = !!event.error;

      await plugin.after_tool_call(sessionId, toolName, output, isError, event.result);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'message_received',
    async (event: MessageReceivedEvent, ctx: PluginHookMessageContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const message = event.content;

      await plugin.message_received(sessionId, message);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'agent_end',
    async (_event: AgentEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      await plugin.agent_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'session_end',
    async (_event: SessionEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      await plugin.session_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  logger.info('Note: if allowPromptInjection is disabled in OpenClaw config (plugins.entries.skill-evolution.hooks.allowPromptInjection=false), overlay injection via before_prompt_build will be silently ignored by OpenClaw. The plugin will still collect feedback and run reviews, but session overlays will not appear in prompts.');
}

/**
 * Extracts provider configuration from the raw plugin config or host config.
 * Looks for models.providers in the config object.
 */
function extractProviderConfigSource(rawConfig: Record<string, unknown>): ProviderConfigSource | null {
  // Try direct models.providers path
  const models = rawConfig.models as Record<string, unknown> | undefined;
  if (models?.providers && typeof models.providers === 'object') {
    return { providers: models.providers as ProviderConfigSource['providers'] };
  }

  // Try nested skillEvolution.models.providers
  const skillEvolution = rawConfig.skillEvolution as Record<string, unknown> | undefined;
  const seModels = skillEvolution?.models as Record<string, unknown> | undefined;
  if (seModels?.providers && typeof seModels.providers === 'object') {
    return { providers: seModels.providers as ProviderConfigSource['providers'] };
  }

  return null;
}
