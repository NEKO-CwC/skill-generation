/**
 * File-system backed review queue with atomic writes and lease-based dequeue.
 */

import { readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewQueueError } from '../shared/errors.js';
import { ensureDir, readFile, writeFile, fileExists } from '../shared/fs.js';
import ConsoleLogger from '../shared/logger.js';
import type { ReviewQueue, ReviewResult, ReviewTask } from '../shared/types.js';

const logger = new ConsoleLogger('review_queue');

export class ReviewQueueImpl implements ReviewQueue {
  private readonly queueDir: string;
  private readonly failedDir: string;

  public constructor(queueDir: string, failedDir: string) {
    this.queueDir = queueDir;
    this.failedDir = failedDir;
  }

  public async enqueue(task: ReviewTask): Promise<void> {
    try {
      await ensureDir(this.queueDir);

      if (task.idempotencyKey) {
        const existing = await this.listAllFiles();
        for (const file of existing) {
          const filePath = join(this.queueDir, file);
          const raw = await readFile(filePath);
          const parsed = JSON.parse(raw) as ReviewTask;
          if (parsed.idempotencyKey === task.idempotencyKey) {
            logger.info('Skipping duplicate enqueue: idempotency key already exists', {
              taskId: task.taskId,
              idempotencyKey: task.idempotencyKey
            });
            return;
          }
        }
      }

      const tmpPath = join(this.queueDir, `${task.taskId}.tmp.json`);
      const finalPath = join(this.queueDir, `${task.taskId}.json`);

      await writeFile(tmpPath, JSON.stringify(task, null, 2));
      await rename(tmpPath, finalPath);

      logger.info('Task enqueued', { taskId: task.taskId });
    } catch (error: unknown) {
      if (error instanceof ReviewQueueError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewQueueError(`Failed to enqueue task ${task.taskId}: ${message}`);
    }
  }

  public async dequeue(workerId: string, leaseMs: number): Promise<ReviewTask | null> {
    try {
      await ensureDir(this.queueDir);
      const files = await this.listAllFiles();
      const now = Date.now();

      for (const file of files) {
        const filePath = join(this.queueDir, file);
        const raw = await readFile(filePath);
        const task = JSON.parse(raw) as ReviewTask;

        const isQueued = task.status === 'queued';
        const isStaleLease = task.status === 'reviewing' &&
          typeof task.leaseUntil === 'number' &&
          task.leaseUntil < now;

        if (!isQueued && !isStaleLease) continue;

        task.status = 'reviewing';
        task.workerId = workerId;
        task.leaseUntil = now + leaseMs;
        task.attempts = (task.attempts ?? 0) + 1;
        task.updatedAt = now;

        const tmpPath = join(this.queueDir, `${task.taskId}.tmp.json`);
        const finalPath = filePath;

        await writeFile(tmpPath, JSON.stringify(task, null, 2));
        await rename(tmpPath, finalPath);

        logger.info('Task dequeued', { taskId: task.taskId, workerId });
        return task;
      }

      return null;
    } catch (error: unknown) {
      if (error instanceof ReviewQueueError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewQueueError(`Failed to dequeue task: ${message}`);
    }
  }

  public async complete(taskId: string, result: ReviewResult): Promise<void> {
    try {
      const filePath = join(this.queueDir, `${taskId}.json`);
      if (!(await fileExists(filePath))) {
        throw new ReviewQueueError(`Task file not found: ${taskId}`);
      }

      const raw = await readFile(filePath);
      const task = JSON.parse(raw) as ReviewTask;

      task.status = 'done';
      task.result = result;
      task.updatedAt = Date.now();

      const tmpPath = join(this.queueDir, `${taskId}.tmp.json`);
      await writeFile(tmpPath, JSON.stringify(task, null, 2));
      await rename(tmpPath, filePath);

      logger.info('Task completed', { taskId });
    } catch (error: unknown) {
      if (error instanceof ReviewQueueError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewQueueError(`Failed to complete task ${taskId}: ${message}`);
    }
  }

  public async fail(taskId: string, error: string, maxAttempts: number): Promise<void> {
    try {
      const filePath = join(this.queueDir, `${taskId}.json`);
      if (!(await fileExists(filePath))) {
        throw new ReviewQueueError(`Task file not found: ${taskId}`);
      }

      const raw = await readFile(filePath);
      const task = JSON.parse(raw) as ReviewTask;

      task.error = error;
      task.updatedAt = Date.now();

      if ((task.attempts ?? 0) >= maxAttempts) {
        task.status = 'failed';

        await ensureDir(this.failedDir);
        const failedPath = join(this.failedDir, `${taskId}.json`);
        const tmpPath = join(this.failedDir, `${taskId}.tmp.json`);

        await writeFile(tmpPath, JSON.stringify(task, null, 2));
        await rename(tmpPath, failedPath);

        await unlink(filePath);

        logger.info('Task moved to failed', { taskId, attempts: task.attempts });
      } else {
        task.status = 'queued';
        task.leaseUntil = undefined;
        task.workerId = undefined;

        const tmpPath = join(this.queueDir, `${taskId}.tmp.json`);
        await writeFile(tmpPath, JSON.stringify(task, null, 2));
        await rename(tmpPath, filePath);

        logger.info('Task reset for retry', { taskId, attempts: task.attempts });
      }
    } catch (error_: unknown) {
      if (error_ instanceof ReviewQueueError) throw error_;
      const message = error_ instanceof Error ? error_.message : String(error_);
      throw new ReviewQueueError(`Failed to fail task ${taskId}: ${message}`);
    }
  }

  public async listPending(): Promise<ReviewTask[]> {
    try {
      await ensureDir(this.queueDir);
      const files = await this.listAllFiles();
      const now = Date.now();
      const pending: ReviewTask[] = [];

      for (const file of files) {
        const filePath = join(this.queueDir, file);
        const raw = await readFile(filePath);
        const task = JSON.parse(raw) as ReviewTask;

        const isQueued = task.status === 'queued';
        const isActiveReview = task.status === 'reviewing' &&
          typeof task.leaseUntil === 'number' &&
          task.leaseUntil >= now;

        if (isQueued || isActiveReview) {
          pending.push(task);
        }
      }

      return pending;
    } catch (error: unknown) {
      if (error instanceof ReviewQueueError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewQueueError(`Failed to list pending tasks: ${message}`);
    }
  }

  private async listAllFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.queueDir);
      return entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp.json'));
    } catch {
      return [];
    }
  }
}

export default ReviewQueueImpl;
