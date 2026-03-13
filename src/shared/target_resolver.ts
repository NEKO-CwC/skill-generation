import type { EvolutionTarget, TargetResolver } from './types.js';

const BUILTIN_TOOLS = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'browser',
  'exec', 'fetch', 'list', 'search', 'terminal', 'shell',
  'web_search', 'screenshot', 'navigate'
]);

export class TargetResolverImpl implements TargetResolver {
  private readonly builtinTools: Set<string>;

  public constructor(additionalBuiltinTools?: string[]) {
    this.builtinTools = new Set([...BUILTIN_TOOLS, ...(additionalBuiltinTools ?? [])]);
  }

  public resolve(toolName: string, skillKey: string, ctx?: Record<string, unknown>): EvolutionTarget {
    const ctxSkillKey = ctx && typeof ctx.skillKey === 'string' ? ctx.skillKey : undefined;

    const effectiveSkillKey = ctxSkillKey ?? skillKey;

    if (this.isRealSkill(effectiveSkillKey)) {
      return {
        kind: 'skill',
        key: effectiveSkillKey,
        storageKey: effectiveSkillKey,
        mergeMode: 'skill-doc'
      };
    }

    if (this.builtinTools.has(toolName)) {
      return {
        kind: 'builtin',
        key: toolName,
        storageKey: `builtin-${toolName}`,
        mergeMode: 'global-doc'
      };
    }

    if (effectiveSkillKey === 'default-skill' || effectiveSkillKey === 'unknown-skill') {
      return {
        kind: 'global',
        key: 'default',
        storageKey: 'global-default',
        mergeMode: 'global-doc'
      };
    }

    return {
      kind: 'unresolved',
      key: toolName || 'unknown',
      storageKey: `unresolved-${toolName || 'unknown'}`,
      mergeMode: 'queue-only'
    };
  }

  private isRealSkill(skillKey: string): boolean {
    return (
      skillKey !== '' &&
      skillKey !== 'default-skill' &&
      skillKey !== 'unknown-skill' &&
      !skillKey.startsWith('builtin-') &&
      !skillKey.startsWith('global-') &&
      !skillKey.startsWith('unresolved')
    );
  }
}

export default TargetResolverImpl;
