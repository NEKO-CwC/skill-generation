/**
 * Background review worker that polls the review queue and processes tasks.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import ConsoleLogger from '../shared/logger.js';
import { fileExists, readFile } from '../shared/fs.js';
import type {
  EvolutionTarget,
  MergeManager,
  PatchGenerator,
  PluginService,
  ResolvedPaths,
  ReviewQueue,
  ReviewRunner,
  SkillEvolutionConfig
} from '../shared/types.js';

const logger = new ConsoleLogger('review_worker');

export class ReviewWorkerImpl implements PluginService {
  public readonly id = 'skill-evolution-review';

  private readonly queue: ReviewQueue;
  private readonly reviewRunner: ReviewRunner;
  private readonly patchGenerator: PatchGenerator;
  private readonly mergeManager: MergeManager;
  private readonly paths: ResolvedPaths;
  private readonly config: SkillEvolutionConfig;
  private readonly workerId: string;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  public constructor(deps: {
    queue: ReviewQueue;
    reviewRunner: ReviewRunner;
    patchGenerator: PatchGenerator;
    mergeManager: MergeManager;
    paths: ResolvedPaths;
    config: SkillEvolutionConfig;
  }) {
    this.queue = deps.queue;
    this.reviewRunner = deps.reviewRunner;
    this.patchGenerator = deps.patchGenerator;
    this.mergeManager = deps.mergeManager;
    this.paths = deps.paths;
    this.config = deps.config;
    this.workerId = `worker_${Math.random().toString(36).slice(2, 10)}`;

    logger.info('Review worker created', { workerId: this.workerId });
  }

  public start(): void {
    this.intervalHandle = setInterval(() => {
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, this.config.queue.pollIntervalMs);

    logger.info('Review worker started', {
      workerId: this.workerId,
      pollIntervalMs: this.config.queue.pollIntervalMs
    });
  }

  public async stop(): Promise<void> {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.inFlight !== null) {
      await this.inFlight;
    }

    logger.info('Review worker stopped', { workerId: this.workerId });
  }

  private async tick(): Promise<void> {
    const task = await this.queue.dequeue(this.workerId, this.config.queue.leaseMs);

    if (!task) {
      return;
    }

    logger.info('Processing review task', {
      taskId: task.taskId,
      sessionId: task.sessionId,
      target: `${task.target.kind}:${task.target.key}`
    });

    try {
      const currentContent = await this.readOriginalContent(task.target);

      let forcedManual = false;
      if (task.baseVersionHash) {
        const currentHash = createHash('sha256').update(currentContent).digest('hex');
        if (currentHash !== task.baseVersionHash) {
          logger.warn('Base version hash mismatch: degrading to manual merge', {
            taskId: task.taskId,
            expectedHash: task.baseVersionHash,
            actualHash: currentHash
          });
          forcedManual = true;
        }
      }

      const reviewResult = await this.reviewRunner.runReview(task.summary);

      if (!reviewResult.isModificationRecommended) {
        logger.info('Review complete: no modification recommended', {
          taskId: task.taskId,
          justification: reviewResult.justification
        });
        await this.queue.complete(task.taskId, reviewResult);
        return;
      }

      if (forcedManual) {
        reviewResult.metadata.mergeMode = 'manual';
      }

      const patchOutput = this.patchGenerator.generateSplit(reviewResult, currentContent);

      logger.info('Patch generated, attempting merge', {
        taskId: task.taskId,
        patchId: reviewResult.metadata.patchId,
        mergeMode: reviewResult.metadata.mergeMode,
        hasMergeableDocument: patchOutput.mergeableDocument !== null
      });

      await this.mergeManager.mergeWithTarget(task.target, patchOutput, reviewResult.metadata);
      await this.queue.complete(task.taskId, reviewResult);

      logger.info('Review task completed successfully', {
        taskId: task.taskId,
        patchId: reviewResult.metadata.patchId
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Review task failed', {
        taskId: task.taskId,
        error: message
      });
      await this.queue.fail(task.taskId, message, this.config.queue.maxAttempts);
    }
  }

  private async readOriginalContent(target: EvolutionTarget): Promise<string> {
    let targetPath: string;

    switch (target.kind) {
      case 'skill':
        targetPath = join(this.paths.skillsDir, target.key, 'SKILL.md');
        break;
      case 'builtin':
        targetPath = join(this.paths.globalToolsDir, `${target.key}.md`);
        break;
      case 'global':
        targetPath = join(this.paths.globalDir, 'DEFAULT_SKILL.md');
        break;
      default:
        return '';
    }

    if (await fileExists(targetPath)) {
      return readFile(targetPath);
    }
    return '';
  }
}

export default ReviewWorkerImpl;
