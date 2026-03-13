import { SkillEvolutionPlugin } from '../src/plugin/index.js';
import { getDefaultConfig } from '../src/plugin/config.js';
import { resolvePaths } from '../shared/paths.js';
import type { FeedbackEvent, OverlayEntry, SessionSummary } from '../shared/types.js';

async function manualTest() {
  console.log('=== Skill Evolution Integration Test ===\n');

  // Setup plugin with workspace
  const workspace = '/home/node/.openclaw/workspace';
  const config = getDefaultConfig();
  config.llm.modelOverride = 'anyrouter/claude-opus-4-6';
  config.merge.requireHumanMerge = false; // Auto-merge for test
  config.review.minEvidenceCount = 1; // Lower threshold for test

  const plugin = new SkillEvolutionPlugin(config, workspace);

  const sessionId = 'integration-test-session';
  const skillKey = 'default-skill';

  // Simulate tool errors
  console.log('1. Simulating tool errors...');
  await plugin.after_tool_call(
    sessionId,
    'web_search',
    'Error: API quota exceeded',
    false,
    { status: 'error', error: 'rate limit exceeded' }
  );
  await plugin.after_tool_call(
    sessionId,
    'read',
    'ENOENT: file not found',
    false,
    { error: 'file missing' }
  );

  // Check feedback recorded
  const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  console.log(`   Recorded ${events.length} feedback events:`);
  events.forEach(e => {
    console.log(`   - ${e.eventType} (${e.severity}): ${e.messageExcerpt?.slice(0, 80)}...`);
  });

  // Check overlays created
  const overlays = await plugin.overlayStore.listBySession(sessionId);
  console.log(`   Created ${overlays.length} overlays:`);
  overlays.forEach(o => {
    console.log(`   - ${o.content?.slice(0, 80)}...`);
  });

  // End session and trigger review
  console.log('\n2. Ending session to trigger review pipeline...');
  await plugin.session_end(sessionId);

  // Check patches generated
  const fs = await import('node:fs/promises');
  const patchesDir = resolvePaths(workspace, config).patchesDir;
  const skillPatchDir = `${patchesDir}/${skillKey}`;
  try {
    const patchFiles = await fs.readdir(skillPatchDir);
    console.log(`   Generated ${patchFiles.length} patch file(s):`);
    for (const pf of patchFiles) {
      const content = await fs.readFile(`${skillPatchDir}/${pf}`, 'utf8');
      console.log(`   - ${pf}: ${content.length} bytes`);
      console.log(`     Preview: ${content.slice(0, 200)}...`);
    }
  } catch (e) {
    console.log(`   No patches found (expected if LLM failed or no modification recommended)`);
  }

  // Check backups (if auto-merge)
  const backupsDir = resolvePaths(workspace, config).backupsDir;
  const skillBackupDir = `${backupsDir}/${skillKey}`;
  try {
    const backupFiles = await fs.readdir(skillBackupDir);
    console.log(`   Created ${backupFiles.length} backup file(s)`);
  } catch (e) {
    console.log(`   No backups found`);
  }

  console.log('\n=== Test Complete ===');
}

manualTest().catch(console.error);
