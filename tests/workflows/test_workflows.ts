import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildPlugin(tempRoot: string, requireHumanMerge: boolean, maxRollbackVersions = 5): SkillEvolutionPlugin {
  const config = getDefaultConfig();
  config.sessionOverlay.storageDir = '.skill-overlays';
  config.triggers.onSessionEndReview = true;
  config.review.minEvidenceCount = 1;
  config.merge.requireHumanMerge = requireHumanMerge;
  config.merge.maxRollbackVersions = maxRollbackVersions;
  return new SkillEvolutionPlugin(config, tempRoot);
}

describe('Workflow 1: Tool error -> overlay creation', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-1-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('collects tool_error, writes overlay, and injects overlay into next prompt', async () => {
    const plugin = buildPlugin(tempRoot, false);
    const sessionId = 'workflow-1-session';
    const skillKey = 'skill.workflow.1';

    const firstPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(firstPrompt).toBe('BASE_PROMPT');

    await plugin.after_tool_call(sessionId, 'shell', 'Error: command failed', true);

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tool_error');

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.content).toContain('Tool error observed for shell');

    const overlayPath = join(
      tempRoot,
      '.skill-overlays',
      encodeURIComponent(sessionId),
      `${encodeURIComponent(overlays[0]?.skillKey ?? skillKey)}.json`
    );
    expect(await pathExists(overlayPath)).toBe(true);

    const secondPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(secondPrompt).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(secondPrompt).toContain('Error excerpt: Error: command failed');
    expect(secondPrompt).toContain('BASE_PROMPT');
  });
});

describe('Workflow 2: Session end -> review -> patch generation', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-2-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('runs review on session_end, writes report to .skill-patches, and clears overlays', async () => {
    const plugin = buildPlugin(tempRoot, false);
    const sessionId = 'workflow-2-session';
    const skillKey = 'skill.workflow.2';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'build', 'Error: unresolved symbol', true);
    await plugin.session_end(sessionId);

    const targets = plugin.getSessionTargets(sessionId);
    const storageKey = targets.length > 0 ? targets[0]!.storageKey : skillKey;
    const patchDir = join('.skill-patches', storageKey);
    expect(await pathExists(patchDir)).toBe(true);

    const patchFiles = (await readdir(patchDir)).filter((name) => name.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);

    const patchText = await readFile(join(patchDir, patchFiles[0]!), 'utf8');
    expect(patchText).toContain(`--- PATCH: ${skillKey} ---`);
    expect(patchText).toContain('## Proposed Changes');
    expect(patchText).toContain('Error excerpt: Error: unresolved symbol');

    const overlaysAfterEnd = await plugin.overlayStore.listBySession(sessionId);
    expect(overlaysAfterEnd).toHaveLength(0);
  });
});

describe('Workflow 3: Manual merge blocks auto-write', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-3-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('does not modify SKILL.md and queues patch under .skill-patches', async () => {
    const plugin = buildPlugin(tempRoot, true);
    const sessionId = 'workflow-3-session';
    const skillKey = 'skill.workflow.3';

    const skillDir = join('skills', skillKey);
    const skillFilePath = join(skillDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFilePath, 'ORIGINAL_SKILL_CONTENT', 'utf8');

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'lint', 'Error: style violation', true);
    await plugin.session_end(sessionId);

    const after = await readFile(skillFilePath, 'utf8');
    expect(after).toBe('ORIGINAL_SKILL_CONTENT');

    const targets = plugin.getSessionTargets(sessionId);
    const storageKey = targets.length > 0 ? targets[0]!.storageKey : skillKey;
    const patchDir = join('.skill-patches', storageKey);
    expect(await pathExists(patchDir)).toBe(true);

    const patchFiles = (await readdir(patchDir)).filter((name) => name.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);

    const patchText = await readFile(join(patchDir, patchFiles[0]!), 'utf8');
    expect(patchText).toContain(`--- PATCH: ${skillKey} ---`);
    expect(patchText).toContain('Error excerpt: Error: style violation');
  });
});

describe('Workflow 4: Auto merge with deterministic review saves report patches', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-4-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('saves report patch for each session and does not write report into SKILL.md', async () => {
    const plugin = buildPlugin(tempRoot, false, 3);
    const skillKey = 'skill.workflow.4';

    for (let i = 1; i <= 3; i += 1) {
      const sessionId = `workflow-4-session-${i}`;

      await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
      await plugin.after_tool_call(sessionId, 'test', `Error: iteration-${i}`, true);
      await plugin.session_end(sessionId);
    }

    const targets = plugin.getSessionTargets('workflow-4-session-3');
    const storageKey = targets.length > 0 ? targets[0]!.storageKey : skillKey;
    const patchDir = join('.skill-patches', storageKey);
    expect(await pathExists(patchDir)).toBe(true);

    const patchFiles = (await readdir(patchDir)).filter((name) => name.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThanOrEqual(1);

    for (const patchFile of patchFiles) {
      const patchText = await readFile(join(patchDir, patchFile), 'utf8');
      expect(patchText).toContain(`--- PATCH: ${skillKey} ---`);
      expect(patchText).toContain('Review Source: deterministic');
    }
  });
});

describe('Workflow 5: Multi-turn lifecycle split', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-5-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps overlays across agent_end and saves report at session_end', async () => {
    const plugin = buildPlugin(tempRoot, false);
    const sessionId = 'workflow-5-session';
    const skillKey = 'skill.workflow.5';

    const firstPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(firstPrompt).toBe('BASE_PROMPT');

    await plugin.after_tool_call(sessionId, 'shell', 'Error: command failed first', true);

    await plugin.agent_end(sessionId);

    const overlaysAfterAgentEnd = await plugin.overlayStore.listBySession(sessionId);
    expect(overlaysAfterAgentEnd.length).toBeGreaterThan(0);

    const secondPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(secondPrompt).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(secondPrompt).toContain('Error excerpt: Error: command failed first');

    await plugin.after_tool_call(sessionId, 'shell', 'Error: command failed second', true);

    await plugin.session_end(sessionId);

    const targets = plugin.getSessionTargets(sessionId);
    const storageKey = targets.length > 0 ? targets[0]!.storageKey : skillKey;
    const patchDir = join('.skill-patches', storageKey);
    expect(await pathExists(patchDir)).toBe(true);

    const patchFiles = (await readdir(patchDir)).filter((name) => name.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);

    const patchText = await readFile(join(patchDir, patchFiles[0]!), 'utf8');
    expect(patchText).toContain(`--- PATCH: ${skillKey} ---`);
    expect(patchText).toContain('## Proposed Changes');

    const overlaysAfterSessionEnd = await plugin.overlayStore.listBySession(sessionId);
    expect(overlaysAfterSessionEnd).toHaveLength(0);
  });
});
