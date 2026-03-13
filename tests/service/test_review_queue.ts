import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile as nodeReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewQueueImpl } from '../../src/service/review_queue.ts';
import { fileExists } from '../../src/shared/fs.ts';
import type { EvolutionTarget, ReviewResult, ReviewTask, SessionSummary } from '../../src/shared/types.ts';

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

function makeReviewResult(): ReviewResult {
  return {
    isModificationRecommended: true,
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

describe('service/review_queue', () => {
  let tempDir: string;
  let queueDir: string;
  let failedDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-queue-test-'));
    queueDir = join(tempDir, 'queue');
    failedDir = join(tempDir, 'queue', 'failed');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('enqueue creates JSON file in queue dir', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task = makeTask({ taskId: 'enqueue-test-1' });

    await queue.enqueue(task);

    const filePath = join(queueDir, 'enqueue-test-1.json');
    await expect(fileExists(filePath)).resolves.toBe(true);

    const raw = await nodeReadFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ReviewTask;
    expect(parsed.taskId).toBe('enqueue-test-1');
    expect(parsed.status).toBe('queued');
  });

  it('enqueue with duplicate idempotencyKey is skipped', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task1 = makeTask({ taskId: 'dup-1', idempotencyKey: 'key-abc' });
    const task2 = makeTask({ taskId: 'dup-2', idempotencyKey: 'key-abc' });

    await queue.enqueue(task1);
    await queue.enqueue(task2);

    const files = (await readdir(queueDir)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('dup-1.json');

    const secondPath = join(queueDir, 'dup-2.json');
    await expect(fileExists(secondPath)).resolves.toBe(false);
  });

  it('dequeue returns queued task and sets reviewing status', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task = makeTask({ taskId: 'dequeue-test-1' });

    await queue.enqueue(task);

    const dequeued = await queue.dequeue('worker-1', 60000);
    expect(dequeued).not.toBeNull();
    expect(dequeued!.taskId).toBe('dequeue-test-1');
    expect(dequeued!.status).toBe('reviewing');
    expect(dequeued!.workerId).toBe('worker-1');
    expect(dequeued!.attempts).toBe(1);
    expect(typeof dequeued!.leaseUntil).toBe('number');

    // Verify file on disk also has updated status
    const raw = await nodeReadFile(join(queueDir, 'dequeue-test-1.json'), 'utf8');
    const persisted = JSON.parse(raw) as ReviewTask;
    expect(persisted.status).toBe('reviewing');
  });

  it('dequeue recovers stale lease (expired leaseUntil)', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task = makeTask({
      taskId: 'stale-1',
      status: 'reviewing',
      workerId: 'old-worker',
      leaseUntil: Date.now() - 10000,
      attempts: 1
    });

    await queue.enqueue(task);

    const dequeued = await queue.dequeue('new-worker', 60000);
    expect(dequeued).not.toBeNull();
    expect(dequeued!.taskId).toBe('stale-1');
    expect(dequeued!.workerId).toBe('new-worker');
    expect(dequeued!.attempts).toBe(2);
    expect(dequeued!.leaseUntil!).toBeGreaterThan(Date.now());
  });

  it('dequeue returns null when queue is empty', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);

    const dequeued = await queue.dequeue('worker-1', 60000);
    expect(dequeued).toBeNull();
  });

  it('complete sets status to done with result', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task = makeTask({ taskId: 'complete-1' });

    await queue.enqueue(task);
    await queue.dequeue('worker-1', 60000);

    const result = makeReviewResult();
    await queue.complete('complete-1', result);

    const raw = await nodeReadFile(join(queueDir, 'complete-1.json'), 'utf8');
    const completed = JSON.parse(raw) as ReviewTask;
    expect(completed.status).toBe('done');
    expect(completed.result).toBeDefined();
    expect(completed.result!.justification).toBe('test justification');
  });

  it('fail resets to queued when attempts < maxAttempts', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task = makeTask({ taskId: 'retry-1', attempts: 1 });

    await queue.enqueue(task);
    await queue.dequeue('worker-1', 60000);

    await queue.fail('retry-1', 'transient error', 3);

    const raw = await nodeReadFile(join(queueDir, 'retry-1.json'), 'utf8');
    const retried = JSON.parse(raw) as ReviewTask;
    expect(retried.status).toBe('queued');
    expect(retried.error).toBe('transient error');
    expect(retried.leaseUntil).toBeUndefined();
    expect(retried.workerId).toBeUndefined();
  });

  it('fail moves to failed/ when attempts >= maxAttempts', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);
    const task = makeTask({ taskId: 'fail-1', attempts: 2 });

    await queue.enqueue(task);
    // Dequeue increments attempts to 3
    await queue.dequeue('worker-1', 60000);

    await queue.fail('fail-1', 'permanent error', 3);

    // Should be removed from queue dir
    await expect(fileExists(join(queueDir, 'fail-1.json'))).resolves.toBe(false);

    // Should be in failed dir
    const failedPath = join(failedDir, 'fail-1.json');
    await expect(fileExists(failedPath)).resolves.toBe(true);

    const raw = await nodeReadFile(failedPath, 'utf8');
    const failed = JSON.parse(raw) as ReviewTask;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('permanent error');
  });

  it('listPending returns queued and active reviewing tasks', async () => {
    const queue = new ReviewQueueImpl(queueDir, failedDir);

    const task1 = makeTask({ taskId: 'pending-1', status: 'queued' });
    const task2 = makeTask({
      taskId: 'pending-2',
      status: 'reviewing',
      workerId: 'worker-x',
      leaseUntil: Date.now() + 60000
    });
    const task3 = makeTask({ taskId: 'done-1', status: 'done' });
    const task4 = makeTask({
      taskId: 'stale-2',
      status: 'reviewing',
      workerId: 'old-worker',
      leaseUntil: Date.now() - 10000
    });

    await queue.enqueue(task1);
    await queue.enqueue(task2);
    await queue.enqueue(task3);
    await queue.enqueue(task4);

    const pending = await queue.listPending();
    const pendingIds = pending.map((t) => t.taskId);

    expect(pendingIds).toContain('pending-1');
    expect(pendingIds).toContain('pending-2');
    expect(pendingIds).not.toContain('done-1');
    // Stale lease is NOT included in listPending (it's expired, not active)
    expect(pendingIds).not.toContain('stale-2');
  });
});
