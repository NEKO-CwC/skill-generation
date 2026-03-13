import { homedir } from 'node:os';
import { isAbsolute, resolve, join } from 'node:path';
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
    feedbackDir: rel('.skill-feedback'),
    globalDir: rel('.skill-global'),
    globalToolsDir: rel('.skill-global/tools'),
    reviewQueueDir: rel('.skill-review-queue'),
    reviewQueueFailedDir: rel('.skill-review-queue/failed')
  };
}

/**
 * Resolves the workspace root directory from multiple sources.
 * Priority: ctxWorkspaceDir → configWorkspaceRoot → OPENCLAW_HOME → OPENCLAW_PROFILE → fallback.
 */
export function resolveWorkspaceRoot(
  ctxWorkspaceDir?: string,
  configWorkspaceRoot?: string
): string {
  if (ctxWorkspaceDir) return ctxWorkspaceDir;
  if (configWorkspaceRoot) return configWorkspaceRoot;

  const openclawHome = process.env['OPENCLAW_HOME'];
  if (openclawHome) return resolve(openclawHome, 'workspace');

  const profile = process.env['OPENCLAW_PROFILE'];
  const home = homedir();
  if (profile && profile !== 'default') {
    return join(home, '.openclaw', `workspace-${profile}`);
  }

  return join(home, '.openclaw', 'workspace');
}
