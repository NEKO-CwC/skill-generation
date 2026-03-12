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
  };
  review: {
    minEvidenceCount: number;
    allowAutoMergeOnLowRiskOnly: boolean;
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
}

export interface ReviewResult {
  isModificationRecommended: boolean;
  justification: string;
  proposedDiff: string;
  riskLevel: 'low' | 'medium' | 'high';
  metadata: PatchMetadata;
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
}

export interface MergeManager {
  merge(skillKey: string, patchContent: string, metadata: PatchMetadata): Promise<boolean>;
  checkMergePolicy(metadata: PatchMetadata): boolean;
}

export interface RollbackManager {
  backup(skillKey: string, content: string): Promise<SkillVersion>;
  restore(skillKey: string, versionId: string): Promise<void>;
  listVersions(skillKey: string): Promise<SkillVersion[]>;
  pruneOldVersions(skillKey: string): Promise<void>;
}

export interface PluginHooks {
  before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string>;
  after_tool_call(sessionId: string, toolName: string, output: string, isError: boolean): Promise<void>;
  message_received(sessionId: string, message: string): Promise<void>;
  agent_end(sessionId: string): Promise<void>;
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
