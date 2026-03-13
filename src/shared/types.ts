/**
 * Shared domain types and module interfaces for the skill evolution plugin.
 */

export interface SkillEvolutionConfig {
  enabled: boolean;
  merge: {
    requireHumanMerge: boolean;
    maxRollbackVersions: number;
  };
  sessionOverlay: {
    enabled: boolean;
    storageDir: string;
    injectMode: 'system-context' | 'tool-description';
    clearOnSessionEnd: boolean;
  };
  triggers: {
    onToolError: boolean;
    onUserCorrection: boolean;
    onSessionEndReview: boolean;
    onPositiveFeedback: boolean;
  };
  llm: {
    inheritPrimaryConfig: boolean;
    modelOverride: string | null;
    thinkingOverride: boolean | null;
    mode: 'inherit-or-fallback' | 'explicit' | 'disabled';
    provider: 'anthropic' | 'openai-compatible' | 'custom';
    baseUrlOverride: string | null;
    authProfileRef: string | null;
    keyRef: SecretRef | null;
    allowExecSecretRef: boolean;
    allowGatewayFallback: boolean;
  };
  review: {
    engine: 'deterministic' | 'llm';
    minEvidenceCount: number;
    allowAutoMergeOnLowRiskOnly: boolean;
  };
  queue: {
    pollIntervalMs: number;
    leaseMs: number;
    maxAttempts: number;
  };
}

export interface FeedbackEvent {
  sessionId: string;
  skillKey: string;
  timestamp: number;
  eventType: 'tool_error' | 'user_correction' | 'positive_feedback' | 'retry_pattern';
  severity: 'low' | 'medium' | 'high';
  toolName?: string;
  messageExcerpt?: string;
  proposedOverlay?: string;
  target?: EvolutionTarget;
  normalizedError?: NormalizedToolError;
  noiseDisposition?: NoiseDisposition;
}

export interface PatchMetadata {
  skillKey: string;
  patchId: string;
  baseVersion: string;
  sourceSessionId: string;
  mergeMode: 'auto' | 'manual';
  riskLevel: 'low' | 'medium' | 'high';
  rollbackChainDepth: number;
}

export interface OverlayEntry {
  sessionId: string;
  skillKey: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  reasoning: string;
}

export interface SessionSummary {
  sessionId: string;
  skillKey: string;
  events: FeedbackEvent[];
  overlays: OverlayEntry[];
  durationMs: number;
  totalErrors: number;
  targets?: EvolutionTarget[];
}

export interface ReviewResult {
  isModificationRecommended: boolean;
  justification: string;
  proposedDiff: string;
  proposedDocument?: string;
  changeSummary?: string;
  evidenceSummary?: string;
  target?: EvolutionTarget;
  riskLevel: 'low' | 'medium' | 'high';
  metadata: PatchMetadata;
  reviewSource: 'llm' | 'deterministic';
}

// ── Evolution Target Types ─────────────────────────────────────────

export interface EvolutionTarget {
  kind: 'skill' | 'builtin' | 'global' | 'unresolved';
  key: string;
  storageKey: string;
  mergeMode: 'skill-doc' | 'global-doc' | 'queue-only';
}

export interface NormalizedToolError {
  status: 'error';
  toolName: string;
  message: string;
  errorType?: string;
  exitCode?: number;
  stderr?: string;
  rawExcerpt: string;
  fingerprint: string;
  source: 'event.error' | 'result.status' | 'result.error' | 'text-pattern' | 'unknown';
}

export interface PendingHint {
  target: EvolutionTarget;
  fingerprint: string;
  count: number;
  lastError: string;
  instruction: string;
  expiresAt: number;
}

export type NoiseDisposition = 'ignore' | 'low-signal' | 'normal';

// ── Secret / Auth Types ───────────────────────────────────────────

export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  id: string;
  args?: string[];
}

export interface ResolvedAuth {
  apiKey: string;
  provider: 'anthropic' | 'openai-compatible' | 'custom';
  baseUrl?: string;
  profileId?: string;
  source: 'authProfileRef' | 'keyRef' | 'agent-auth-profile' | 'gateway-fallback';
}

export interface AuthResolver {
  resolve(config: SkillEvolutionConfig, agentId?: string): Promise<ResolvedAuth | null>;
}

// ── Review Task / Queue Types ─────────────────────────────────────

export interface ReviewTask {
  taskId: string;
  sessionId: string;
  agentId: string;
  target: EvolutionTarget;
  summary: SessionSummary;
  status: 'queued' | 'reviewing' | 'done' | 'failed';
  createdAt: number;
  updatedAt: number;
  leaseUntil?: number;
  workerId?: string;
  attempts?: number;
  idempotencyKey?: string;
  baseVersionHash?: string;
  result?: ReviewResult;
  error?: string;
}

export interface ReviewQueue {
  enqueue(task: ReviewTask): Promise<void>;
  dequeue(workerId: string, leaseMs: number): Promise<ReviewTask | null>;
  complete(taskId: string, result: ReviewResult): Promise<void>;
  fail(taskId: string, error: string, maxAttempts: number): Promise<void>;
  listPending(): Promise<ReviewTask[]>;
}

// ── Plugin Service Types ──────────────────────────────────────────

export interface PluginService {
  id: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

// ── Review Output Types ────────────────────────────────────────────

/** Separated patch outputs: audit report + mergeable document */
export interface PatchOutput {
  reportPatch: string;
  mergeableDocument: string | null;
}

export interface SkillVersion {
  skillKey: string;
  versionId: string;
  timestamp: number;
  content: string;
  restoredFrom?: string;
}

export interface OverlayStore {
  create(entry: OverlayEntry): Promise<void>;
  read(sessionId: string, skillKey: string): Promise<OverlayEntry | null>;
  update(sessionId: string, skillKey: string, partial: Partial<OverlayEntry>): Promise<void>;
  delete(sessionId: string, skillKey: string): Promise<void>;
  listBySession(sessionId: string): Promise<OverlayEntry[]>;
  clearSession(sessionId: string): Promise<void>;
}

export interface OverlayInjector {
  inject(baseContext: string, overlay: OverlayEntry): string;
}

export interface FeedbackCollector {
  collect(event: FeedbackEvent): Promise<void>;
  getSessionFeedback(sessionId: string): Promise<FeedbackEvent[]>;
}

export interface FeedbackClassifier {
  classify(rawInput: string, isError: boolean): FeedbackEvent['eventType'] | null;
  assessSeverity(events: FeedbackEvent[]): FeedbackEvent['severity'];
}

export interface ReviewRunner {
  runReview(summary: SessionSummary): Promise<ReviewResult>;
}

export interface PatchGenerator {
  generate(result: ReviewResult, originalContent: string): string;
  generateSplit(result: ReviewResult, originalContent: string): PatchOutput;
}

export interface MergeManager {
  merge(skillKey: string, patchContent: string, metadata: PatchMetadata): Promise<boolean>;
  mergeWithTarget(target: EvolutionTarget, patchOutput: PatchOutput, metadata: PatchMetadata): Promise<boolean>;
  checkMergePolicy(metadata: PatchMetadata): boolean;
}

export interface RollbackManager {
  backup(skillKey: string, content: string): Promise<SkillVersion>;
  restore(skillKey: string, versionId: string): Promise<void>;
  listVersions(skillKey: string): Promise<SkillVersion[]>;
  pruneOldVersions(skillKey: string): Promise<void>;
}

export interface TargetResolver {
  resolve(toolName: string, skillKey: string, ctx?: Record<string, unknown>): EvolutionTarget;
}

export interface ErrorNormalizer {
  normalize(toolName: string, event: { result?: unknown; error?: string }): NormalizedToolError | null;
  safeStringify(value: unknown, maxLength?: number): string;
}

export interface NoiseFilter {
  assess(toolName: string, output: string, normalizedError?: NormalizedToolError | null): NoiseDisposition;
}

export interface PendingHintStore {
  record(target: EvolutionTarget, fingerprint: string, errorMessage: string, instruction: string): void;
  getHints(sessionId?: string): PendingHint[];
  clearExpired(): void;
  clear(): void;
}

export interface LlmClient {
  complete(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface PluginHooks {
  before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string>;
  after_tool_call(
    sessionId: string,
    toolName: string,
    output: string,
    isError: boolean,
    rawResult?: unknown
  ): Promise<void>;
  message_received(sessionId: string, message: string): Promise<void>;
  agent_end(sessionId: string): Promise<void>;
  session_end(sessionId: string): Promise<void>;
}

export interface SkillEvolutionConfigFile {
  skillEvolution: SkillEvolutionConfig;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type UnknownRecord = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: UnknownRecord): void;
  info(message: string, context?: UnknownRecord): void;
  warn(message: string, context?: UnknownRecord): void;
  error(message: string, context?: UnknownRecord): void;
}

export interface ResolvedPaths {
  workspaceDir: string;
  overlaysDir: string;
  patchesDir: string;
  backupsDir: string;
  skillsDir: string;
  feedbackDir: string;
  globalDir: string;
  globalToolsDir: string;
  reviewQueueDir: string;
  reviewQueueFailedDir: string;
}

// ── OpenClaw Plugin API Types ──────────────────────────────────────

/** The API object passed to the plugin's register function by OpenClaw. */
export interface OpenClawPluginApi {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: unknown;
  on<K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: HookOptions): void;
  registerService(service: PluginService): void;
}

export type PluginHookName =
  | 'before_prompt_build'
  | 'after_tool_call'
  | 'message_received'
  | 'agent_end'
  | 'session_end';

export interface HookOptions {
  priority?: number;
}

export interface PluginHookAgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

export interface PluginHookToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export interface PluginHookMessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

export interface BeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface BeforePromptBuildResult {
  prependSystemContext?: string;
  appendSystemContext?: string;
  systemPrompt?: string;
  prependContext?: string;
}

export type BeforePromptBuildHandler = (
  event: BeforePromptBuildEvent,
  ctx: PluginHookAgentContext
) => BeforePromptBuildResult | undefined | Promise<BeforePromptBuildResult | undefined>;

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export type AfterToolCallHandler = (
  event: AfterToolCallEvent,
  ctx: PluginHookToolContext
) => void | Promise<void>;

export interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export type MessageReceivedHandler = (
  event: MessageReceivedEvent,
  ctx: PluginHookMessageContext
) => void | Promise<void>;

export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

export type AgentEndHandler = (
  event: AgentEndEvent,
  ctx: PluginHookAgentContext
) => void | Promise<void>;

export interface SessionEndEvent {
  sessionId?: string;
  reason?: 'user_reset' | 'timeout' | 'shutdown' | 'explicit';
  durationMs?: number;
}

export type SessionEndHandler = (
  event: SessionEndEvent,
  ctx: PluginHookAgentContext
) => void | Promise<void>;

export type PluginHookHandlerMap = {
  before_prompt_build: BeforePromptBuildHandler;
  after_tool_call: AfterToolCallHandler;
  message_received: MessageReceivedHandler;
  agent_end: AgentEndHandler;
  session_end: SessionEndHandler;
};
