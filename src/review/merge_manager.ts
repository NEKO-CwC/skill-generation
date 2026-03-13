/**
 * Merge manager implementing patch-application and policy-check contracts.
 */

import { join } from 'node:path';
import { MergeConflictError } from '../shared/errors.js';
import { ensureDir, fileExists, readFile, writeFile } from '../shared/fs.js';
import ConsoleLogger from '../shared/logger.js';
import RollbackManagerImpl from './rollback_manager.js';
import type { EvolutionTarget, MergeManager, PatchMetadata, PatchOutput } from '../shared/types.js';
import type { RollbackManager, SkillEvolutionConfig } from '../shared/types.js';
import { getDefaultConfig } from '../plugin/config.js';

const DEFAULT_CONFIG: SkillEvolutionConfig = getDefaultConfig();

export class MergeManagerImpl implements MergeManager {
  private readonly config: SkillEvolutionConfig;

  private readonly rollbackManager: RollbackManager;

  private readonly skillsDir: string;

  private readonly patchesDir: string;

  private readonly globalDir: string;

  private readonly logger = new ConsoleLogger('merge_manager');

  public constructor(
    config: SkillEvolutionConfig = DEFAULT_CONFIG,
    rollbackManager?: RollbackManager,
    skillsDir = 'skills',
    patchesDir = '.skill-patches',
    globalDir = '.skill-global'
  ) {
    this.config = config;
    this.skillsDir = skillsDir;
    this.patchesDir = patchesDir;
    this.globalDir = globalDir;
    this.rollbackManager = rollbackManager ?? new RollbackManagerImpl(config, '.skill-backups', skillsDir);
  }

  public async merge(skillKey: string, patchContent: string, metadata: PatchMetadata): Promise<boolean> {
    try {
      const autoMergeAllowed = this.checkMergePolicy(metadata);
      if (!autoMergeAllowed) {
        const patchDir = join(this.patchesDir, skillKey);
        await ensureDir(patchDir);

        const patchPath = join(patchDir, `${metadata.patchId}.md`);
        await writeFile(patchPath, patchContent);

        this.logger.info('Patch queued for human review', {
          skillKey,
          patchId: metadata.patchId,
          patchPath
        });
        return false;
      }

      const skillFilePath = this.getSkillFilePath(skillKey);
      const skillDir = this.getSkillDir(skillKey);
      await ensureDir(skillDir);

      const currentContent = (await fileExists(skillFilePath)) ? await readFile(skillFilePath) : '';
      await this.rollbackManager.backup(skillKey, currentContent);

      await writeFile(skillFilePath, patchContent);
      await this.rollbackManager.pruneOldVersions(skillKey);

      this.logger.info('Patch auto-merged successfully', {
        skillKey,
        patchId: metadata.patchId,
        skillFilePath
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MergeConflictError(`Failed to merge patch ${metadata.patchId} for skill ${skillKey}: ${message}`);
    }
  }

  public async mergeWithTarget(
    target: EvolutionTarget,
    patchOutput: PatchOutput,
    metadata: PatchMetadata
  ): Promise<boolean> {
    try {
      const reportDir = join(this.patchesDir, target.storageKey);
      await ensureDir(reportDir);
      const reportPath = join(reportDir, `${metadata.patchId}.md`);
      await writeFile(reportPath, patchOutput.reportPatch);

      this.logger.info('Report patch saved', {
        target: `${target.kind}:${target.key}`,
        patchId: metadata.patchId,
        reportPath
      });

      if (target.mergeMode === 'queue-only' || !patchOutput.mergeableDocument) {
        this.logger.info('Merge skipped: queue-only target or no mergeable document', {
          target: `${target.kind}:${target.key}`,
          mergeMode: target.mergeMode
        });
        return false;
      }

      const autoMergeAllowed = this.checkMergePolicy(metadata);
      if (!autoMergeAllowed) {
        this.logger.info('Mergeable document queued for human review (report already saved)', {
          target: `${target.kind}:${target.key}`,
          patchId: metadata.patchId
        });
        return false;
      }

      const targetPath = this.resolveTargetPath(target);
      const targetDir = join(targetPath, '..');
      await ensureDir(targetDir);

      const currentContent = (await fileExists(targetPath)) ? await readFile(targetPath) : '';
      await this.rollbackManager.backup(target.storageKey, currentContent);

      await writeFile(targetPath, patchOutput.mergeableDocument);
      await this.rollbackManager.pruneOldVersions(target.storageKey);

      this.logger.info('Mergeable document auto-merged', {
        target: `${target.kind}:${target.key}`,
        patchId: metadata.patchId,
        targetPath
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MergeConflictError(
        `Failed to merge patch ${metadata.patchId} for target ${target.kind}:${target.key}: ${message}`
      );
    }
  }

  public checkMergePolicy(metadata: PatchMetadata): boolean {
    void metadata;
    return this.config.merge.requireHumanMerge === false;
  }

  private resolveTargetPath(target: EvolutionTarget): string {
    switch (target.kind) {
      case 'skill':
        return join(this.skillsDir, target.key, 'SKILL.md');
      case 'builtin':
        return join(this.globalDir, 'tools', `${target.key}.md`);
      case 'global':
        return join(this.globalDir, 'DEFAULT_SKILL.md');
      default:
        return join(this.patchesDir, target.storageKey, 'queued.md');
    }
  }

  private getSkillDir(skillKey: string): string {
    return join(this.skillsDir, skillKey);
  }

  private getSkillFilePath(skillKey: string): string {
    return join(this.getSkillDir(skillKey), 'SKILL.md');
  }
}

export default MergeManagerImpl;
