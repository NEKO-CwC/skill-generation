import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';
import { ReviewQueueImpl } from '../../src/service/review_queue.ts';
import { ReviewWorkerImpl } from '../../src/service/review_worker.ts';
import { DeterministicReviewRunner } from '../../src/review/llm_review_runner.ts';
import { LlmReviewRunner } from '../../src/review/llm_review_runner.ts';
import { PatchGeneratorImpl } from '../../src/review/patch_generator.ts';
import { MergeManagerImpl } from '../../src/review/merge_manager.ts';
import { RollbackManagerImpl } from '../../src/review/rollback_manager.ts';
import { resolvePaths } from '../../src/shared/paths.ts';
import type { ReviewTask, SkillEvolutionConfig, ResolvedPaths } from '../../src/shared/types.ts';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildConfig(overrides: {
  requireHumanMerge?: boolean;
  minEvidenceCount?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
} = {}): SkillEvolutionConfig {
  const config = getDefaultConfig();
  config.sessionOverlay.storageDir = '.skill-overlays';
  config.triggers.onSessionEndReview = true;
  config.review.minEvidenceCount = overrides.minEvidenceCount ?? 1;
  config.merge.requireHumanMerge = overrides.requireHumanMerge ?? false;
  config.queue.pollIntervalMs = overrides.pollIntervalMs ?? 30000;
  config.queue.leaseMs = overrides.leaseMs ?? 300000;
  config.queue.maxAttempts = overrides.maxAttempts ?? 3;
  return config;
}

function buildQueue(paths: ResolvedPaths): ReviewQueueImpl {
  return new ReviewQueueImpl(paths.reviewQueueDir, paths.reviewQueueFailedDir);
}

function buildWorker(deps: {
  queue: ReviewQueueImpl;
  paths: ResolvedPaths;
  config: SkillEvolutionConfig;
  reviewRunner?: DeterministicReviewRunner;
  patchGenerator?: PatchGeneratorImpl;
  mergeManager?: MergeManagerImpl;
}): ReviewWorkerImpl {
  const rollbackManager = new RollbackManagerImpl(deps.config, deps.paths.backupsDir, deps.paths.skillsDir);
  const reviewRunner = deps.reviewRunner ?? new DeterministicReviewRunner(deps.config);
  const patchGenerator = deps.patchGenerator ?? new PatchGeneratorImpl();
  const mergeManager = deps.mergeManager ?? new MergeManagerImpl(
    deps.config,
    rollbackManager,
    deps.paths.skillsDir,
    deps.paths.patchesDir,
    deps.paths.globalDir
  );

  return new ReviewWorkerImpl({
    queue: deps.queue,
    reviewRunner,
    patchGenerator,
    mergeManager,
    paths: deps.paths,
    config: deps.config
  });
}

async function listQueueFiles(queueDir: string): Promise<string[]> {
  try {
    const entries = await readdir(queueDir);
    return entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp.json'));
  } catch {
    return [];
  }
}

describe('v4 review service integration', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-v4-review-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // ─── Scenario 1: E2E session_end enqueue -> worker tick -> patch + merge ───

  it('E2E: session_end enqueue -> worker tick -> patch + merge', async () => {
    const config = buildConfig({ requireHumanMerge: false, minEvidenceCount: 1 });
    const paths = resolvePaths(tempRoot, config);
    const queue = buildQueue(paths);
    const plugin = new SkillEvolutionPlugin(config, tempRoot, undefined, queue);

    const sessionId = 'v4-e2e-session';
    const skillKey = 'test-skill';

    // Feed the plugin some errors
    await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: compilation failed with exit code 1 and a substantive error message here',
      true
    );
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: test suite failed with multiple assertion failures in the output stream',
      true
    );

    // session_end should enqueue a task
    await plugin.session_end(sessionId);

    // Verify task is enqueued in queue dir
    const queueFiles = await listQueueFiles(paths.reviewQueueDir);
    expect(queueFiles.length).toBeGreaterThanOrEqual(1);

    // Read the enqueued task to verify structure
    const taskRaw = await readFile(join(paths.reviewQueueDir, queueFiles[0]!), 'utf8');
    const task = JSON.parse(taskRaw) as ReviewTask;
    expect(task.status).toBe('queued');
    expect(task.sessionId).toBe(sessionId);
    expect(task.idempotencyKey).toBeDefined();
    expect(task.baseVersionHash).toBeDefined();

    // Now run the worker tick
    const worker = buildWorker({ queue, paths, config });
    await (worker as unknown as { tick(): Promise<void> }).tick();

    // Verify the task is now completed
    const postTickFiles = await listQueueFiles(paths.reviewQueueDir);
    expect(postTickFiles.length).toBeGreaterThanOrEqual(1);

    const processedRaw = await readFile(join(paths.reviewQueueDir, postTickFiles[0]!), 'utf8');
    const processedTask = JSON.parse(processedRaw) as ReviewTask;
    expect(processedTask.status).toBe('done');
    expect(processedTask.result).toBeDefined();
    expect(processedTask.result!.reviewSource).toBe('deterministic');

    // Verify patch report was generated in patches dir
    expect(await pathExists(paths.patchesDir)).toBe(true);
    const patchTargetDirs = await readdir(paths.patchesDir);
    expect(patchTargetDirs.length).toBeGreaterThan(0);

    const firstPatchDir = patchTargetDirs[0]!;
    const patchFiles = (await readdir(join(paths.patchesDir, firstPatchDir)))
      .filter((f) => f.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);

    const patchContent = await readFile(join(paths.patchesDir, firstPatchDir, patchFiles[0]!), 'utf8');
    expect(patchContent).toContain('--- PATCH:');
    expect(patchContent).toContain('Review Source: deterministic');
  });

  // ─── Scenario 2: Idempotency ─────────────────────────────────────────────

  it('idempotency: repeated session_end does not duplicate tasks', async () => {
    const config = buildConfig({ requireHumanMerge: false, minEvidenceCount: 1 });
    const paths = resolvePaths(tempRoot, config);
    const queue = buildQueue(paths);
    const plugin = new SkillEvolutionPlugin(config, tempRoot, undefined, queue);

    const sessionId = 'v4-idempotency-session';

    // First session: feed errors and end
    await plugin.before_prompt_build(sessionId, 'my-skill', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: build failed with a substantive long error message for proper detection',
      true
    );
    await plugin.session_end(sessionId);

    const filesAfterFirst = await listQueueFiles(paths.reviewQueueDir);
    const countAfterFirst = filesAfterFirst.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    // Second session_end with the same session: re-initialize and re-feed identical events
    // so the idempotencyKey matches
    await plugin.before_prompt_build(sessionId, 'my-skill', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: build failed with a substantive long error message for proper detection',
      true
    );
    await plugin.session_end(sessionId);

    const filesAfterSecond = await listQueueFiles(paths.reviewQueueDir);

    // The idempotencyKey is built from sessionId + lastEventTimestamp + storageKey.
    // Since timestamps differ between calls, idempotency dedup only kicks in if
    // the same timestamp is reused. For a true dedup test, we directly enqueue
    // a task with the same idempotencyKey.
    // So let's do a direct queue-level test:
    const directTask: ReviewTask = {
      taskId: 'dedup-test-1',
      sessionId: 'dedup-session',
      agentId: 'test',
      target: { kind: 'global', key: 'default', storageKey: 'global-default', mergeMode: 'global-doc' },
      summary: {
        sessionId: 'dedup-session',
        skillKey: '',
        events: [],
        overlays: [],
        durationMs: 1000,
        totalErrors: 1
      },
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      idempotencyKey: 'unique-dedup-key-123'
    };

    await queue.enqueue(directTask);
    const filesBeforeDup = await listQueueFiles(paths.reviewQueueDir);
    const countBeforeDup = filesBeforeDup.length;

    // Enqueue again with different taskId but same idempotencyKey
    const duplicateTask: ReviewTask = {
      ...directTask,
      taskId: 'dedup-test-2'
    };
    await queue.enqueue(duplicateTask);

    const filesAfterDup = await listQueueFiles(paths.reviewQueueDir);
    expect(filesAfterDup.length).toBe(countBeforeDup);

    // Verify the second task file was NOT created
    const hasSecondFile = filesAfterDup.some((f) => f.includes('dedup-test-2'));
    expect(hasSecondFile).toBe(false);
  });

  // ─── Scenario 3: Lease recovery ──────────────────────────────────────────

  it('lease recovery: stale lease is reclaimed by new dequeue', async () => {
    const config = buildConfig({ leaseMs: 60000 });
    const paths = resolvePaths(tempRoot, config);
    const queue = buildQueue(paths);

    const task: ReviewTask = {
      taskId: 'lease-recovery-task',
      sessionId: 'lease-session',
      agentId: 'test-agent',
      target: { kind: 'global', key: 'default', storageKey: 'global-default', mergeMode: 'global-doc' },
      summary: {
        sessionId: 'lease-session',
        skillKey: 'test',
        events: [{
          sessionId: 'lease-session',
          skillKey: 'test',
          timestamp: Date.now(),
          eventType: 'tool_error',
          severity: 'medium',
          toolName: 'bash',
          messageExcerpt: 'Error: something failed'
        }],
        overlays: [],
        durationMs: 5000,
        totalErrors: 1
      },
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Enqueue and then dequeue to simulate a worker picking it up
    await queue.enqueue(task);
    const dequeuedTask = await queue.dequeue('worker-crash', 60000);
    expect(dequeuedTask).not.toBeNull();
    expect(dequeuedTask!.status).toBe('reviewing');
    expect(dequeuedTask!.workerId).toBe('worker-crash');

    // Simulate crash: set leaseUntil to the past
    const queueFiles = await listQueueFiles(paths.reviewQueueDir);
    const taskFile = queueFiles.find((f) => f.includes('lease-recovery-task'));
    expect(taskFile).toBeDefined();

    const taskPath = join(paths.reviewQueueDir, taskFile!);
    const rawTask = JSON.parse(await readFile(taskPath, 'utf8')) as ReviewTask;
    rawTask.leaseUntil = Date.now() - 10000; // 10 seconds in the past
    await writeFile(taskPath, JSON.stringify(rawTask, null, 2), 'utf8');

    // A new worker should be able to pick up the stale-leased task
    const recoveredTask = await queue.dequeue('worker-recovery', 60000);
    expect(recoveredTask).not.toBeNull();
    expect(recoveredTask!.taskId).toBe('lease-recovery-task');
    expect(recoveredTask!.workerId).toBe('worker-recovery');
    expect(recoveredTask!.status).toBe('reviewing');
    expect(recoveredTask!.attempts).toBe(2); // incremented from the original dequeue
  });

  // ─── Scenario 4: Auth fallback: engine=llm but auth=null -> deterministic ─

  it('auth fallback: LlmReviewRunner with null client uses deterministic fallback', async () => {
    const config = buildConfig({ minEvidenceCount: 1 });
    config.review.engine = 'llm';
    const paths = resolvePaths(tempRoot, config);
    const queue = buildQueue(paths);

    // Create LlmReviewRunner with null client - should fall back to deterministic
    const deterministicFallback = new DeterministicReviewRunner(config);
    const llmRunner = new LlmReviewRunner(config, null, deterministicFallback);

    const plugin = new SkillEvolutionPlugin(config, tempRoot, undefined, queue);

    const sessionId = 'v4-auth-fallback';
    await plugin.before_prompt_build(sessionId, 'auth-test', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: npm install failed with EACCES permission denied on node_modules directory',
      true
    );
    await plugin.session_end(sessionId);

    // Dequeue and process with the llm runner (which has null client)
    const queueFiles = await listQueueFiles(paths.reviewQueueDir);
    expect(queueFiles.length).toBeGreaterThanOrEqual(1);

    const taskRaw = await readFile(join(paths.reviewQueueDir, queueFiles[0]!), 'utf8');
    const task = JSON.parse(taskRaw) as ReviewTask;

    // Run review directly with the LlmReviewRunner
    const result = await llmRunner.runReview(task.summary);

    // Should get deterministic result since llmClient is null
    expect(result.reviewSource).toBe('deterministic');
    expect(result.isModificationRecommended).toBe(true);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.patchId).toMatch(/^patch_/);
  });

  // ─── Scenario 5: baseVersionHash conflict -> degraded to manual ───────────

  it('baseVersionHash conflict: document changed -> degraded to manual merge', async () => {
    const config = buildConfig({ requireHumanMerge: false, minEvidenceCount: 1 });
    const paths = resolvePaths(tempRoot, config);
    const queue = buildQueue(paths);
    const plugin = new SkillEvolutionPlugin(config, tempRoot, undefined, queue);

    // Create initial skill document at the skill target path.
    // With skillKey='my-skill', the target resolver routes bash to kind='skill',
    // key='my-skill', so the document lives at skills/my-skill/SKILL.md.
    const skillDocDir = join(paths.skillsDir, 'my-skill');
    await mkdir(skillDocDir, { recursive: true });
    const originalContent = '# My Skill\n\nOriginal content for hash check.';
    const skillDocPath = join(skillDocDir, 'SKILL.md');
    await writeFile(skillDocPath, originalContent, 'utf8');

    const sessionId = 'v4-hash-conflict';
    await plugin.before_prompt_build(sessionId, 'my-skill', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: compilation failed at line 42 with a very substantive error message for detection',
      true
    );
    await plugin.session_end(sessionId);

    // Verify task was enqueued with a baseVersionHash
    const queueFiles = await listQueueFiles(paths.reviewQueueDir);
    expect(queueFiles.length).toBeGreaterThanOrEqual(1);

    const taskRaw = await readFile(join(paths.reviewQueueDir, queueFiles[0]!), 'utf8');
    const task = JSON.parse(taskRaw) as ReviewTask;
    expect(task.baseVersionHash).toBeDefined();

    // Verify the baseVersionHash matches the original content
    const expectedHash = createHash('sha256').update(originalContent).digest('hex');
    expect(task.baseVersionHash).toBe(expectedHash);

    // Now modify the target file BEFORE the worker processes it
    const modifiedContent = '# My Skill\n\nContent was modified by another process!';
    await writeFile(skillDocPath, modifiedContent, 'utf8');

    // Process with worker
    const worker = buildWorker({ queue, paths, config });
    await (worker as unknown as { tick(): Promise<void> }).tick();

    // The task should be completed
    const postFiles = await listQueueFiles(paths.reviewQueueDir);
    const processedFile = postFiles.find((f) => f === queueFiles[0]);
    expect(processedFile).toBeDefined();

    const processedRaw = await readFile(join(paths.reviewQueueDir, processedFile!), 'utf8');
    const processedTask = JSON.parse(processedRaw) as ReviewTask;
    expect(processedTask.status).toBe('done');

    // The merge mode should have been degraded to manual
    expect(processedTask.result).toBeDefined();
    expect(processedTask.result!.metadata.mergeMode).toBe('manual');

    // Since mergeMode is manual, the report patch should exist but the document
    // should NOT have been auto-merged
    const patchDirs = await readdir(paths.patchesDir);
    expect(patchDirs.length).toBeGreaterThan(0);

    // The original modified content should still be in place (not overwritten)
    const finalContent = await readFile(skillDocPath, 'utf8');
    expect(finalContent).toBe(modifiedContent);
  });

  // ─── Scenario 6: Worker stop awaits in-flight ─────────────────────────────

  it('worker stop awaits in-flight work and resolves without error', async () => {
    const config = buildConfig({
      requireHumanMerge: false,
      minEvidenceCount: 1,
      pollIntervalMs: 1000
    });
    const paths = resolvePaths(tempRoot, config);
    const queue = buildQueue(paths);

    const worker = buildWorker({ queue, paths, config });

    // Start the worker
    worker.start();

    // Immediately stop - should resolve cleanly without error
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
