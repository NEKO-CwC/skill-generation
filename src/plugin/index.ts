/**
 * Plugin entry point that wires core modules and exposes runtime hooks.
 */

import type {
  FeedbackClassifier,
  FeedbackCollector,
  MergeManager,
  OverlayInjector,
  OverlayStore,
  PatchGenerator,
  PluginHooks,
  ReviewRunner,
  RollbackManager,
  SkillEvolutionConfig,
  Logger
} from '../shared/types.js';
import { getDefaultConfig } from './config.js';
import { after_tool_call } from './hooks/after_tool_call.js';
import { agent_end } from './hooks/agent_end.js';
import { before_prompt_build } from './hooks/before_prompt_build.js';
import { message_received } from './hooks/message_received.js';
import FeedbackClassifierImpl from './feedback/classifiers.js';
import FeedbackCollectorImpl from './feedback/collector.js';
import OverlayInjectorImpl from './overlay/overlay_injector.js';
import OverlayStoreImpl from './overlay/overlay_store.js';
import MergeManagerImpl from '../review/merge_manager.js';
import PatchGeneratorImpl from '../review/patch_generator.js';
import ReviewRunnerImpl from '../review/review_runner.js';
import RollbackManagerImpl from '../review/rollback_manager.js';
import { ConsoleLogger } from '../shared/logger.js';

/**
 * Concrete plugin composition root and hook implementation.
 */
export class SkillEvolutionPlugin implements PluginHooks {
  public readonly config: SkillEvolutionConfig;

  public readonly logger: Logger;

  public readonly overlayStore: OverlayStore;

  public readonly overlayInjector: OverlayInjector;

  public readonly feedbackCollector: FeedbackCollector;

  public readonly feedbackClassifier: FeedbackClassifier;

  public readonly reviewRunner: ReviewRunner;

  public readonly patchGenerator: PatchGenerator;

  public readonly mergeManager: MergeManager;

  public readonly rollbackManager: RollbackManager;

  private readonly sessionSkillKeys: Map<string, string>;

  private readonly sessionStartedAt: Map<string, number>;

  /**
   * Initializes plugin dependencies with defaults for v1 skeleton.
   */
  public constructor(config: SkillEvolutionConfig = getDefaultConfig()) {
    this.config = config;
    this.logger = new ConsoleLogger('plugin.index');
    this.overlayStore = new OverlayStoreImpl(this.config.sessionOverlay.storageDir);
    this.overlayInjector = new OverlayInjectorImpl();
    this.feedbackCollector = new FeedbackCollectorImpl();
    this.feedbackClassifier = new FeedbackClassifierImpl();
    this.reviewRunner = new ReviewRunnerImpl();
    this.patchGenerator = new PatchGeneratorImpl();
    this.mergeManager = new MergeManagerImpl();
    this.rollbackManager = new RollbackManagerImpl();
    this.sessionSkillKeys = new Map<string, string>();
    this.sessionStartedAt = new Map<string, number>();
  }

  /**
   * Runs prompt-build hook.
   */
  public async before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string> {
    return before_prompt_build(this, sessionId, skillKey, currentPrompt);
  }

  /**
   * Runs post-tool-call hook.
   */
  public async after_tool_call(sessionId: string, toolName: string, output: string, isError: boolean): Promise<void> {
    return after_tool_call(this, sessionId, toolName, output, isError);
  }

  /**
   * Runs message-received hook.
   */
  public async message_received(sessionId: string, message: string): Promise<void> {
    return message_received(this, sessionId, message);
  }

  /**
   * Runs agent-end hook.
   */
  public async agent_end(sessionId: string): Promise<void> {
    return agent_end(this, sessionId);
  }

  public ensureSessionStarted(sessionId: string): void {
    if (!this.sessionStartedAt.has(sessionId)) {
      this.sessionStartedAt.set(sessionId, Date.now());
      this.logger.debug('Session started', { sessionId });
    }
  }

  public setSessionSkillKey(sessionId: string, skillKey: string): void {
    this.sessionSkillKeys.set(sessionId, skillKey);
  }

  public getSessionSkillKey(sessionId: string): string {
    return this.sessionSkillKeys.get(sessionId) ?? 'unknown-skill';
  }

  public getSessionStartTime(sessionId: string): number {
    return this.sessionStartedAt.get(sessionId) ?? Date.now();
  }

  public endSession(sessionId: string): void {
    this.sessionSkillKeys.delete(sessionId);
    this.sessionStartedAt.delete(sessionId);
    this.logger.debug('Session ended', { sessionId });
  }
}

export default SkillEvolutionPlugin;
