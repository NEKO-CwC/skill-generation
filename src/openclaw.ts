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
  SessionEndEvent,
  SkillEvolutionConfig
} from './shared/types.js';
import { fromOpenClawPluginConfig } from './plugin/config.js';
import { SkillEvolutionPlugin } from './plugin/index.js';
import { ConsoleLogger } from './shared/logger.js';

const HOOK_PRIORITY = 50;

/**
 * Registers the Skill Evolution plugin hooks with OpenClaw.
 */
export default function register(api: OpenClawPluginApi): void {
  const logger = new ConsoleLogger('openclaw.adapter');
  const rawConfig = api.pluginConfig;
  const workspaceOverride = typeof rawConfig?.workspaceDir === 'string' ? rawConfig.workspaceDir : undefined;

  let config: SkillEvolutionConfig | undefined;
  try {
    config = fromOpenClawPluginConfig(rawConfig ?? {});
  } catch (err: unknown) {
    logger.warn('Failed to parse plugin config, using defaults', {
      error: err instanceof Error ? err.message : String(err)
    });
    config = undefined;
  }

  const plugin = new SkillEvolutionPlugin(config, workspaceOverride);
  logger.info('Skill Evolution plugin registered', { enabled: plugin.config.enabled });

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
      const sessionId = ctx.sessionId ?? ctx.sessionKey ?? 'unknown-session';
      const ctxRecord = ctx as unknown as Record<string, unknown>;
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
      const sessionId = ctx.sessionId ?? 'unknown-session';
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
      const sessionId = ctx.conversationId ?? ctx.channelId ?? 'unknown-session';
      const message = event.content;

      await plugin.message_received(sessionId, message);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'agent_end',
    async (_event: AgentEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const sessionId = ctx.sessionId ?? ctx.sessionKey ?? 'unknown-session';
      await plugin.agent_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'session_end',
    async (_event: SessionEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const sessionId = ctx.sessionId ?? ctx.sessionKey ?? 'unknown-session';
      await plugin.session_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  logger.info('Note: if allowPromptInjection is disabled in OpenClaw config (plugins.entries.skill-evolution.hooks.allowPromptInjection=false), overlay injection via before_prompt_build will be silently ignored by OpenClaw. The plugin will still collect feedback and run reviews, but session overlays will not appear in prompts.');
}
