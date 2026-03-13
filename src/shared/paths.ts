import { isAbsolute, resolve } from 'node:path';
import type { ResolvedPaths } from './types.js';

export type { ResolvedPaths };

export function resolvePaths(
  workspaceDir: string,
  config: { sessionOverlay: { storageDir: string }; skillsDir?: string }
): ResolvedPaths {
  const rel = (pathValue: string): string => (isAbsolute(pathValue) ? pathValue : resolve(workspaceDir, pathValue));
  return {
    workspaceDir,
    overlaysDir: rel(config.sessionOverlay.storageDir),
    patchesDir: rel('.skill-patches'),
    backupsDir: rel('.skill-backups'),
    skillsDir: rel(config.skillsDir ?? 'skills'),
    feedbackDir: rel('.skill-feedback')
  };
}
