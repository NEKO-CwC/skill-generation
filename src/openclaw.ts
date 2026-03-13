import type {
  AgentEndEvent,
  AfterToolCallEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  LlmClient,
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
import { AuthResolverImpl } from './review/auth_resolver.js';
import { LlmClientImpl } from './review/llm_client_impl.js';
import { ReviewQueueImpl } from './service/review_queue.js';
import { ReviewWorkerImpl } from './service/review_worker.js';

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
 * On first successful capture, also initializes background review service.
 */
function captureWorkspaceDir(
  plugin: SkillEvolutionPlugin,
  ctx: Record<string, unknown>,
  api: OpenClawPluginApi,
  llmClient: LlmClient | undefined,
  serviceRegistered: { value: boolean }
): void {
  if (typeof ctx.workspaceDir === 'string' && ctx.workspaceDir) {
    const wasUnbound = !plugin.isWorkspaceBound();
    plugin.ensureWorkspaceDir(ctx.workspaceDir);

    // Initialize background service on first workspace binding
    if (wasUnbound && plugin.isWorkspaceBound() && !serviceRegistered.value) {
      initBackgroundService(plugin, api, llmClient);
      serviceRegistered.value = true;
    }
  }
}

/**
 * Creates and registers the background review queue + worker after workspace is known.
 */
function initBackgroundService(
  plugin: SkillEvolutionPlugin,
  api: OpenClawPluginApi,
  _llmClient: LlmClient | undefined
): void {
  const logger = new ConsoleLogger('openclaw.adapter');

  const reviewQueue = new ReviewQueueImpl(plugin.paths.reviewQueueDir, plugin.paths.reviewQueueFailedDir);
  plugin.reviewQueue = reviewQueue;

  const worker = new ReviewWorkerImpl({
    queue: reviewQueue,
    reviewRunner: plugin.reviewRunner,
    patchGenerator: plugin.patchGenerator,
    mergeManager: plugin.mergeManager,
    paths: plugin.paths,
    config: plugin.config
  });

  api.registerService(worker);

  logger.info('Background review service initialized after workspace binding', {
    workspaceDir: plugin.paths.workspaceDir,
    reviewQueueDir: plugin.paths.reviewQueueDir
  });
}

/**
 * Captures agent ID from hook context if available.
 */
function captureAgentId(plugin: SkillEvolutionPlugin, ctx: Record<string, unknown>): void {
  if (typeof ctx.agentId === 'string' && ctx.agentId) {
    plugin.setAgentId(ctx.agentId);
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

  // P0-2: enabled=false is a true master switch — no hooks, no services, no side effects
  if (!plugin.config.enabled) {
    logger.info('Plugin is disabled by config, skipping all registration');
    return;
  }

  // Build LLM client if engine=llm and mode!=disabled (used later when background service initializes)
  let llmClient: LlmClient | undefined;
  if (plugin.config.review.engine === 'llm' && plugin.config.llm.mode !== 'disabled') {
    const authResolver = new AuthResolverImpl();
    llmClient = new LlmClientImpl(plugin.config, authResolver);
  }

  // Pass llmClient to the review runner now (it's needed for both sync and async paths)
  if (llmClient) {
    plugin.setLlmClient(llmClient);
  }

  // Track whether background service has been registered.
  // It will be initialized lazily on first workspace binding.
  const serviceRegistered = { value: false };

  // If plugin was constructed with an explicit workspace (e.g. in tests),
  // initialize background service immediately.
  if (plugin.isWorkspaceBound()) {
    initBackgroundService(plugin, api, llmClient);
    serviceRegistered.value = true;
  }

  api.on(
    'before_prompt_build',
    async (
      event: BeforePromptBuildEvent,
      ctx: PluginHookAgentContext
    ): Promise<BeforePromptBuildResult | undefined> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord, api, llmClient, serviceRegistered);
      captureAgentId(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const eventRecord = event as unknown as Record<string, unknown>;
      const ctxSkillKey = typeof ctxRecord.skillKey === 'string' ? ctxRecord.skillKey : undefined;
      const eventSkillKey = typeof eventRecord.skillKey === 'string' ? eventRecord.skillKey : undefined;
      const knownSkillKey = plugin.getSessionSkillKey(sessionId);
      const fallbackSkillKey = knownSkillKey === '' ? 'default-skill' : knownSkillKey;
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
      captureWorkspaceDir(plugin, ctxRecord, api, llmClient, serviceRegistered);
      captureAgentId(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const toolName = event.toolName;
      const output = plugin.errorNormalizer.safeStringify(event.result ?? event.error ?? '');
      const isError = !!event.error;

      await plugin.after_tool_call(sessionId, toolName, output, isError, event.result);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'message_received',
    async (event: MessageReceivedEvent, ctx: PluginHookMessageContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord, api, llmClient, serviceRegistered);
      captureAgentId(plugin, ctxRecord);
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
      captureWorkspaceDir(plugin, ctxRecord, api, llmClient, serviceRegistered);
      captureAgentId(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      await plugin.agent_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'session_end',
    async (_event: SessionEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord, api, llmClient, serviceRegistered);
      captureAgentId(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      await plugin.session_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  logger.info('Note: if allowPromptInjection is disabled in OpenClaw config (plugins.entries.skill-evolution.hooks.allowPromptInjection=false), overlay injection via before_prompt_build will be silently ignored by OpenClaw. The plugin will still collect feedback and run reviews, but session overlays will not appear in prompts.');
}
