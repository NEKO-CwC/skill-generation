import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile as nodeReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MergeManagerImpl } from '../../src/review/merge_manager.ts';
import RollbackManagerImpl from '../../src/review/rollback_manager.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { ensureDir, fileExists, readFile, writeFile } from '../../src/shared/fs.ts';
import { MergeConflictError } from '../../src/shared/errors.ts';
import type { EvolutionTarget, PatchMetadata, PatchOutput, RollbackManager, SkillVersion } from '../../src/shared/types.ts';

describe('review/merge_manager', () => {
  let tempDir: string;
  let skillsDir: string;
  let patchesDir: string;
  let backupsDir: string;
  let globalDir: string;

  const metadata: PatchMetadata = {
    skillKey: 'skill.alpha',
    patchId: 'patch-1',
    baseVersion: 'latest',
    sourceSessionId: 'session-1',
    mergeMode: 'manual',
    riskLevel: 'low',
    rollbackChainDepth: 0
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-merge-test-'));
    skillsDir = join(tempDir, 'skills');
    patchesDir = join(tempDir, 'patches');
    backupsDir = join(tempDir, 'backups');
    globalDir = join(tempDir, 'global');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('checkMergePolicy blocks auto merge when requireHumanMerge is true', () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = true;
    const manager = new MergeManagerImpl(config);

    expect(manager.checkMergePolicy(metadata)).toBe(false);
  });

  it('checkMergePolicy allows auto merge when requireHumanMerge is false', () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const manager = new MergeManagerImpl(config);

    expect(manager.checkMergePolicy(metadata)).toBe(true);
  });

  it('queues patch file in manual mode and returns false', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = true;
    const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
    const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

    const merged = await manager.merge('skill.alpha', 'patch content', metadata);
    expect(merged).toBe(false);

    const queuedPath = join(patchesDir, 'skill.alpha', 'patch-1.md');
    await expect(fileExists(queuedPath)).resolves.toBe(true);
    await expect(readFile(queuedPath)).resolves.toBe('patch content');
  });

  it('auto merges patch, writes SKILL.md, and creates backup of previous content', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
    const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

    const skillPath = join(skillsDir, 'skill.alpha', 'SKILL.md');
    await ensureDir(dirname(skillPath));
    await writeFile(skillPath, 'old content');

    const merged = await manager.merge('skill.alpha', 'new content', metadata);
    expect(merged).toBe(true);
    await expect(readFile(skillPath)).resolves.toBe('new content');

    const backupFiles = await readdir(join(backupsDir, 'skill.alpha'));
    expect(backupFiles.some((name) => name.endsWith('.json'))).toBe(true);
  });

  it('wraps merge failures into MergeConflictError', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const failingRollback: RollbackManager = {
      backup: async (): Promise<SkillVersion> => {
        throw new Error('forced backup failure');
      },
      restore: async (): Promise<void> => undefined,
      listVersions: async (): Promise<SkillVersion[]> => [],
      pruneOldVersions: async (): Promise<void> => undefined
    };
    const manager = new MergeManagerImpl(config, failingRollback, skillsDir, patchesDir);

    await expect(manager.merge('skill.alpha', 'x', metadata)).rejects.toBeInstanceOf(MergeConflictError);
  });

  describe('mergeWithTarget', () => {
    const skillTarget: EvolutionTarget = {
      kind: 'skill',
      key: 'my-skill',
      storageKey: 'my-skill',
      mergeMode: 'skill-doc'
    };
    const builtinTarget: EvolutionTarget = {
      kind: 'builtin',
      key: 'read',
      storageKey: 'builtin-read',
      mergeMode: 'global-doc'
    };
    const globalTarget: EvolutionTarget = {
      kind: 'global',
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc'
    };
    const unresolvedTarget: EvolutionTarget = {
      kind: 'unresolved',
      key: 'foo',
      storageKey: 'unresolved-foo',
      mergeMode: 'queue-only'
    };

    const patchOutput: PatchOutput = {
      reportPatch: '--- PATCH ---\nreport content',
      mergeableDocument: '# Updated Skill\nnew content'
    };
    const reportOnly: PatchOutput = {
      reportPatch: '--- PATCH ---\nreport content',
      mergeableDocument: null
    };

    const createMockRollback = (): RollbackManager => ({
      backup: async () => ({
        skillKey: 'x',
        versionId: 'v1',
        timestamp: Date.now(),
        content: ''
      }),
      restore: async () => undefined,
      listVersions: async () => [],
      pruneOldVersions: async () => undefined
    });

    it('always saves report patch to .skill-patches/<storageKey>/<patchId>.md regardless of target type', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = true;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);
      const targets: EvolutionTarget[] = [skillTarget, builtinTarget, globalTarget, unresolvedTarget];

      for (const target of targets) {
        const merged = await manager.mergeWithTarget(target, patchOutput, metadata);
        expect(merged).toBe(false);

        const reportPath = join(patchesDir, target.storageKey, `${metadata.patchId}.md`);
        await expect(fileExists(reportPath)).resolves.toBe(true);
        await expect(nodeReadFile(reportPath, 'utf8')).resolves.toBe('--- PATCH ---\nreport content');
      }
    });

    it('queue-only target returns false and does not write to target path', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = false;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(unresolvedTarget, patchOutput, metadata);
      expect(merged).toBe(false);

      const unresolvedQueuedPath = join(patchesDir, unresolvedTarget.storageKey, 'queued.md');
      await expect(fileExists(unresolvedQueuedPath)).resolves.toBe(false);
    });

    it('skill target with no mergeableDocument returns false and saves report only', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = false;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(skillTarget, reportOnly, metadata);
      expect(merged).toBe(false);

      const skillPath = join(skillsDir, skillTarget.key, 'SKILL.md');
      await expect(fileExists(skillPath)).resolves.toBe(false);
      const reportPath = join(patchesDir, skillTarget.storageKey, `${metadata.patchId}.md`);
      await expect(fileExists(reportPath)).resolves.toBe(true);
    });

    it('skill target with mergeableDocument and auto-merge writes SKILL.md and creates backup', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = false;
      const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
      const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(skillTarget, patchOutput, metadata);
      expect(merged).toBe(true);

      const skillPath = join(skillsDir, skillTarget.key, 'SKILL.md');
      await expect(readFile(skillPath)).resolves.toBe('# Updated Skill\nnew content');
      const backupFiles = await readdir(join(backupsDir, skillTarget.storageKey));
      expect(backupFiles.some((name) => name.endsWith('.json'))).toBe(true);
    });

    it('builtin target with mergeableDocument and auto-merge writes to .skill-global/tools/<key>.md', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = false;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(builtinTarget, patchOutput, metadata);
      expect(merged).toBe(true);

      const builtinPath = join(globalDir, 'tools', `${builtinTarget.key}.md`);
      await expect(nodeReadFile(builtinPath, 'utf8')).resolves.toBe('# Updated Skill\nnew content');
    });

    it('global target with mergeableDocument and auto-merge writes to .skill-global/DEFAULT_SKILL.md', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = false;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(globalTarget, patchOutput, metadata);
      expect(merged).toBe(true);

      const globalPath = join(globalDir, 'DEFAULT_SKILL.md');
      await expect(nodeReadFile(globalPath, 'utf8')).resolves.toBe('# Updated Skill\nnew content');
    });

    it('manual merge policy saves report, does not write mergeable document to target, returns false', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = true;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(skillTarget, patchOutput, metadata);
      expect(merged).toBe(false);

      const reportPath = join(patchesDir, skillTarget.storageKey, `${metadata.patchId}.md`);
      await expect(fileExists(reportPath)).resolves.toBe(true);

      const skillPath = join(skillsDir, skillTarget.key, 'SKILL.md');
      await expect(fileExists(skillPath)).resolves.toBe(false);
    });

    it('unresolved target returns false and keeps report saved', async () => {
      const config = getDefaultConfig();
      config.merge.requireHumanMerge = false;
      const manager = new MergeManagerImpl(config, createMockRollback(), skillsDir, patchesDir, globalDir);

      const merged = await manager.mergeWithTarget(unresolvedTarget, patchOutput, metadata);
      expect(merged).toBe(false);

      const reportPath = join(patchesDir, unresolvedTarget.storageKey, `${metadata.patchId}.md`);
      await expect(fileExists(reportPath)).resolves.toBe(true);
      await expect(nodeReadFile(reportPath, 'utf8')).resolves.toBe('--- PATCH ---\nreport content');
    });
  });
});
