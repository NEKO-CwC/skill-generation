/**
 * Hook invoked before prompt construction to inject session overlays.
 */

import type { SkillEvolutionPlugin } from '../index.js';

export async function before_prompt_build(
  plugin: SkillEvolutionPlugin,
  sessionId: string,
  skillKey: string,
  currentPrompt: string
): Promise<string> {
  plugin.ensureSessionStarted(sessionId);
  plugin.setSessionSkillKey(sessionId, skillKey);

  if (!plugin.config.sessionOverlay.enabled) {
    return currentPrompt;
  }

  const overlays = await plugin.overlayStore.listBySession(sessionId);
  let nextPrompt = currentPrompt;

  for (const overlay of overlays) {
    nextPrompt = plugin.overlayInjector.inject(nextPrompt, overlay);
  }

  const hints = plugin.pendingHintStore.getHints(sessionId);
  if (hints.length > 0) {
    const hintLines = hints.map((h) =>
      `<hint target="${h.target.kind}:${h.target.key}" count="${h.count}">\n${h.instruction}\n</hint>`
    );
    const hintBlock = `<skill_evolution_feedback>\n${hintLines.join('\n')}\n</skill_evolution_feedback>\n\n`;
    nextPrompt = hintBlock + nextPrompt;
  }

  return nextPrompt;
}

export default before_prompt_build;
