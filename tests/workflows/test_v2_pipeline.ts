import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';
import type { EvolutionTarget } from '../../src/shared/types.ts';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildPlugin(
  tempRoot: string,
  overrides: { requireHumanMerge?: boolean; minEvidenceCount?: number } = {}
): SkillEvolutionPlugin {
  const config = getDefaultConfig();
  config.sessionOverlay.storageDir = '.skill-overlays';
  config.triggers.onSessionEndReview = true;
  config.review.minEvidenceCount = overrides.minEvidenceCount ?? 1;
  config.merge.requireHumanMerge = overrides.requireHumanMerge ?? false;
  return new SkillEvolutionPlugin(config, tempRoot);
}

describe('v2 pipeline integration behaviors', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-v2-pipeline-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('noise filtering skips startup noise events', async () => {
    const plugin = buildPlugin(tempRoot, { minEvidenceCount: 1 });
    const sessionId = 'v2-noise-session';

    await plugin.before_prompt_build(sessionId, 'my-project', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'read',
      'ENOENT: no such file or directory .memory',
      true
    );

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    const overlays = await plugin.overlayStore.listBySession(sessionId);

    expect(events).toHaveLength(0);
    expect(overlays).toHaveLength(0);
  });

  it('error normalizer eliminates [object Object] from feedback', async () => {
    const plugin = buildPlugin(tempRoot, { minEvidenceCount: 1 });
    const sessionId = 'v2-normalize-session';

    await plugin.before_prompt_build(sessionId, 'my-project', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'command failed',
      true,
      { status: 'error', message: 'compilation failed', exitCode: 1 }
    );
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'command failed',
      false,
      { status: 'error', message: 'compilation failed', exitCode: 1 }
    );

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events.length).toBeGreaterThan(0);

    const event = events.find((candidate) => candidate.normalizedError?.source === 'result.status');
    expect(event?.normalizedError).toBeDefined();
    expect(event?.normalizedError?.message).toBe('compilation failed');
    expect(event?.normalizedError?.source).toBe('result.status');
    expect(event?.normalizedError?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(event?.messageExcerpt).not.toContain('[object Object]');
  });

  it('target resolver routes builtin tool errors to builtin target', async () => {
    const plugin = buildPlugin(tempRoot, { minEvidenceCount: 1 });
    const sessionId = 'v2-target-session';

    await plugin.before_prompt_build(sessionId, 'my-project', 'BASE_PROMPT');
    plugin.setSessionSkillKey(sessionId, 'unknown-skill');
    await plugin.after_tool_call(
      sessionId,
      'read',
      'Error: EACCES permission denied plus a very long description that has more than fifty characters to make it substantive',
      true
    );

    const targets = plugin.getSessionTargets(sessionId);
    const builtinTarget = targets.find((target) => target.kind === 'builtin' && target.key === 'read');

    expect(builtinTarget).toBeDefined();
    expect(builtinTarget?.storageKey).toBe('builtin-read');
  });

  it('session_end produces split patch with report in .skill-patches', async () => {
    const plugin = buildPlugin(tempRoot, { requireHumanMerge: false, minEvidenceCount: 1 });
    const sessionId = 'v2-session-end';
    const skillKey = 'my-project';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    await plugin.after_tool_call(sessionId, 'bash', 'Error: test failed', true);
    await plugin.session_end(sessionId);

    const patchDir = join('.skill-patches');
    expect(await pathExists(patchDir)).toBe(true);

    const patchTargets = await readdir(patchDir);
    expect(patchTargets.length).toBeGreaterThan(0);

    const firstTargetDir = patchTargets[0] ?? '';
    const patchFiles = (await readdir(join(patchDir, firstTargetDir))).filter((name) => name.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);

    const patchText = await readFile(join(patchDir, firstTargetDir, patchFiles[0] ?? ''), 'utf8');
    expect(patchText).toContain('--- PATCH:');
    expect(patchText).toContain('Review Source: deterministic');

    const skillDocPath = join('skills', skillKey, 'SKILL.md');
    expect(await pathExists(skillDocPath)).toBe(false);
  });

  it('user correction binds to last session target', async () => {
    const plugin = buildPlugin(tempRoot, { minEvidenceCount: 1 });
    const sessionId = 'v2-user-correction';

    await plugin.before_prompt_build(sessionId, 'my-project', 'BASE_PROMPT');
    await plugin.after_tool_call(
      sessionId,
      'bash',
      'Error: build failed with substantive content more than fifty characters long here',
      true
    );
    await plugin.message_received(sessionId, "That's wrong, you should use npm run build instead");

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe('tool_error');
    expect(events[1]?.eventType).toBe('user_correction');

    const firstTarget = events[0]?.target;
    const secondTarget = events[1]?.target;

    expect(firstTarget?.storageKey).toBeDefined();
    expect(secondTarget?.storageKey).toBe(firstTarget?.storageKey);
  });

  it('pending hints injected into before_prompt_build after threshold', async () => {
    const plugin = buildPlugin(tempRoot, { minEvidenceCount: 1 });
    const sessionId = 'v2-pending-hints';

    await plugin.before_prompt_build(sessionId, 'my-project', 'BASE_PROMPT');

    const target: EvolutionTarget = {
      kind: 'skill',
      key: 'my-project',
      storageKey: 'my-project',
      mergeMode: 'skill-doc'
    };

    plugin.pendingHintStore.record(target, 'fp1', 'error msg', 'avoid this');
    plugin.pendingHintStore.record(target, 'fp1', 'error msg', 'avoid this');

    const injectedPrompt = await plugin.before_prompt_build(sessionId, 'my-project', 'BASE_PROMPT');

    expect(injectedPrompt).toMatch(/skill_evolution_feedback|hint/i);
  });
});
