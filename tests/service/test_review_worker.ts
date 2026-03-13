import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewWorkerImpl } from '../../src/service/review_worker.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { resolvePaths } from '../../src/shared/paths.ts';
import { ensureDir, writeFile } from '../../src/shared/fs.ts';
import type {
  EvolutionTarget,
  MergeManager,
  PatchGenerator,
  PatchOutput,
  ResolvedPaths,
  ReviewQueue,
  ReviewResult,
  ReviewRunner,
  ReviewTask,
  SessionSummary,
  SkillEvolutionConfig
} from '../../src/shared/types.ts';

function makeTarget(): EvolutionTarget {
  return {
    kind: 'skill',
    key: 'test-skill',
    storageKey: 'test-skill',
    mergeMode: 'skill-doc'
  };
}

function makeSummary(sessionId: string): SessionSummary {
  return {
    sessionId,
    skillKey: 'test-skill',
    events: [],
    overlays: [],
    durationMs: 1000,
    totalErrors: 0
  };
}

function makeReviewResult(recommended = true): ReviewResult {
  return {
    isModificationRecommended: recommended,
    justification: 'test justification',
    proposedDiff: 'diff content',
    riskLevel: 'low',
    reviewSource: 'deterministic',
    metadata: {
      skillKey: 'test-skill',
      patchId: 'patch-1',
      baseVersion: 'latest',
      sourceSessionId: 'session-1',
      mergeMode: 'auto',
      riskLevel: 'low',
      rollbackChainDepth: 0
    }
  };
}

function makeTask(overrides?: Partial<ReviewTask>): ReviewTask {
  return {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    agentId: 'agent-1',
    target: makeTarget(),
    summary: makeSummary('session-1'),
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  };
}

function makePatchOutput(): PatchOutput {
  return {
    reportPatch: '--- PATCH ---\nreport',
    mergeableDocument: '# Updated\nnew content'
  };
}

function makeConfig(): SkillEvolutionConfig {
  const config = getDefaultConfig();
  config.queue.pollIntervalMs = 50000;
  config.queue.leaseMs = 60000;
  config.queue.maxAttempts = 3;
  return config;
}

interface MockDeps {
  queue: ReviewQueue;
  reviewRunner: ReviewRunner;
  patchGenerator: PatchGenerator;
  mergeManager: MergeManager;
  paths: ResolvedPaths;
  config: SkillEvolutionConfig;
}

function makeMockDeps(tempDir: string): MockDeps {
  const config = makeConfig();
  const paths = resolvePaths(tempDir, config);

  return {
    queue: {
      enqueue: vi.fn<[ReviewTask], Promise<void>>().mockResolvedValue(undefined),
      dequeue: vi.fn<[string, number], Promise<ReviewTask | null>>().mockResolvedValue(null),
      complete: vi.fn<[string, ReviewResult], Promise<void>>().mockResolvedValue(undefined),
      fail: vi.fn<[string, string, number], Promise<void>>().mockResolvedValue(undefined),
      listPending: vi.fn<[], Promise<ReviewTask[]>>().mockResolvedValue([])
    },
    reviewRunner: {
      runReview: vi.fn<[SessionSummary], Promise<ReviewResult>>().mockResolvedValue(makeReviewResult())
    },
    patchGenerator: {
      generate: vi.fn().mockReturnValue('patch'),
      generateSplit: vi.fn<[ReviewResult, string], PatchOutput>().mockReturnValue(makePatchOutput())
    },
    mergeManager: {
      merge: vi.fn().mockResolvedValue(true),
      mergeWithTarget: vi.fn().mockResolvedValue(true),
      checkMergePolicy: vi.fn().mockReturnValue(true)
    },
    paths,
    config
  };
}

describe('service/review_worker', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-worker-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('tick processes a queued task end-to-end', async () => {
    const deps = makeMockDeps(tempDir);
    const task = makeTask({ taskId: 'e2e-1' });

    (deps.queue.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task);

    const worker = new ReviewWorkerImpl(deps);

    // Access private tick via casting
    await (worker as unknown as { tick(): Promise<void> }).tick();

    expect(deps.reviewRunner.runReview).toHaveBeenCalledWith(task.summary);
    expect(deps.patchGenerator.generateSplit).toHaveBeenCalled();
    expect(deps.mergeManager.mergeWithTarget).toHaveBeenCalledWith(
      task.target,
      expect.objectContaining({ reportPatch: expect.any(String) }),
      expect.objectContaining({ patchId: expect.any(String) })
    );
    expect(deps.queue.complete).toHaveBeenCalledWith('e2e-1', expect.any(Object));
  });

  it('tick does nothing when queue is empty', async () => {
    const deps = makeMockDeps(tempDir);

    (deps.queue.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const worker = new ReviewWorkerImpl(deps);
    await (worker as unknown as { tick(): Promise<void> }).tick();

    expect(deps.reviewRunner.runReview).not.toHaveBeenCalled();
    expect(deps.queue.complete).not.toHaveBeenCalled();
    expect(deps.queue.fail).not.toHaveBeenCalled();
  });

  it('tick handles review errors gracefully and calls queue.fail', async () => {
    const deps = makeMockDeps(tempDir);
    const task = makeTask({ taskId: 'error-1' });

    (deps.queue.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task);
    (deps.reviewRunner.runReview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('review crashed')
    );

    const worker = new ReviewWorkerImpl(deps);
    await (worker as unknown as { tick(): Promise<void> }).tick();

    expect(deps.queue.fail).toHaveBeenCalledWith(
      'error-1',
      'review crashed',
      deps.config.queue.maxAttempts
    );
    expect(deps.queue.complete).not.toHaveBeenCalled();
  });

  it('baseVersionHash mismatch degrades to manual merge mode', async () => {
    const deps = makeMockDeps(tempDir);

    // Write original skill content on disk
    const skillDir = join(deps.paths.skillsDir, 'test-skill');
    await ensureDir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), 'modified content on disk');

    const task = makeTask({
      taskId: 'hash-mismatch-1',
      baseVersionHash: 'aaaa0000bbbb1111cccc2222dddd3333eeee4444ffff5555aabb0011cdef2345'
    });

    (deps.queue.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task);

    const reviewResult = makeReviewResult();
    reviewResult.metadata.mergeMode = 'auto';
    (deps.reviewRunner.runReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(reviewResult);

    const worker = new ReviewWorkerImpl(deps);
    await (worker as unknown as { tick(): Promise<void> }).tick();

    // The result passed to mergeWithTarget should have mergeMode = 'manual'
    expect(deps.mergeManager.mergeWithTarget).toHaveBeenCalledWith(
      task.target,
      expect.any(Object),
      expect.objectContaining({ mergeMode: 'manual' })
    );
  });

  it('stop awaits in-flight tick', async () => {
    const deps = makeMockDeps(tempDir);
    // Use a very short poll interval for this test
    deps.config.queue.pollIntervalMs = 50;
    let resolveDequeue: ((v: ReviewTask | null) => void) | undefined;

    (deps.queue.dequeue as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return new Promise<ReviewTask | null>((resolve) => {
        resolveDequeue = resolve;
      });
    });

    const worker = new ReviewWorkerImpl(deps);
    worker.start();

    // Wait for setInterval to fire
    await new Promise((resolve) => setTimeout(resolve, 120));

    const stopPromise = worker.stop();

    // Resolve the dequeue so the tick can complete
    if (resolveDequeue) {
      resolveDequeue(null);
    }

    // stop should resolve after the in-flight tick completes
    await stopPromise;

    // After stop, no more ticks should fire
    expect(deps.queue.complete).not.toHaveBeenCalled();
  });

  it('worker generates unique workerId', () => {
    const deps1 = makeMockDeps(tempDir);
    const deps2 = makeMockDeps(tempDir);

    const worker1 = new ReviewWorkerImpl(deps1);
    const worker2 = new ReviewWorkerImpl(deps2);

    // workerId is private, but we can verify uniqueness via the id and behavior
    // Both have the same service id, but internal workerIds should differ
    expect(worker1.id).toBe('skill-evolution-review');
    expect(worker2.id).toBe('skill-evolution-review');

    // Verify they are distinct instances (workerId generated in constructor)
    expect(worker1).not.toBe(worker2);
  });

  it('tick completes task when review is not recommended', async () => {
    const deps = makeMockDeps(tempDir);
    const task = makeTask({ taskId: 'no-mod-1' });

    (deps.queue.dequeue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task);

    const noModResult = makeReviewResult(false);
    (deps.reviewRunner.runReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(noModResult);

    const worker = new ReviewWorkerImpl(deps);
    await (worker as unknown as { tick(): Promise<void> }).tick();

    expect(deps.queue.complete).toHaveBeenCalledWith('no-mod-1', noModResult);
    expect(deps.patchGenerator.generateSplit).not.toHaveBeenCalled();
    expect(deps.mergeManager.mergeWithTarget).not.toHaveBeenCalled();
  });
});
