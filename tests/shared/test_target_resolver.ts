import { describe, expect, it } from 'vitest';
import { TargetResolverImpl } from '../../src/shared/target_resolver.ts';

describe('shared/target_resolver', () => {
  it('resolves real skill key to skill target with skill-doc merge mode', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('custom-tool', 'my-project');

    expect(target).toEqual({
      kind: 'skill',
      key: 'my-project',
      storageKey: 'my-project',
      mergeMode: 'skill-doc'
    });
  });

  it('resolves builtin tool to builtin target regardless of default skill key', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('read', 'default-skill');

    expect(target).toEqual({
      kind: 'builtin',
      key: 'read',
      storageKey: 'builtin-read',
      mergeMode: 'global-doc'
    });
  });

  it('resolves builtin tool to builtin target regardless of unknown skill key', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('bash', 'unknown-skill');

    expect(target).toEqual({
      kind: 'builtin',
      key: 'bash',
      storageKey: 'builtin-bash',
      mergeMode: 'global-doc'
    });
  });

  it('resolves default-skill with non-builtin tool to global target', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('custom-tool', 'default-skill');

    expect(target).toEqual({
      kind: 'global',
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc'
    });
  });

  it('resolves unknown-skill with non-builtin tool to global target', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('custom-tool', 'unknown-skill');

    expect(target).toEqual({
      kind: 'global',
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc'
    });
  });

  it('resolves unknown tool and non-special unknown skill to unresolved queue-only target', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('foo', 'unresolved-skill');

    expect(target).toEqual({
      kind: 'unresolved',
      key: 'foo',
      storageKey: 'unresolved-foo',
      mergeMode: 'queue-only'
    });
  });

  it('ctx.skillKey overrides skillKey parameter', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('custom-tool', 'default-skill', { skillKey: 'my-overridden-skill' });

    expect(target).toEqual({
      kind: 'skill',
      key: 'my-overridden-skill',
      storageKey: 'my-overridden-skill',
      mergeMode: 'skill-doc'
    });
  });

  it('additionalBuiltinTools extends builtin set', () => {
    const resolver = new TargetResolverImpl(['custom-builtin']);
    const target = resolver.resolve('custom-builtin', 'default-skill');

    expect(target).toEqual({
      kind: 'builtin',
      key: 'custom-builtin',
      storageKey: 'builtin-custom-builtin',
      mergeMode: 'global-doc'
    });
  });

  it('storageKey format is correct for skill, builtin, global, and unresolved targets', () => {
    const resolver = new TargetResolverImpl();

    const skillTarget = resolver.resolve('x-tool', 'x-skill');
    const builtinTarget = resolver.resolve('grep', 'default-skill');
    const globalTarget = resolver.resolve('x-tool', 'default-skill');
    const unresolvedTarget = resolver.resolve('foo', 'global-custom');

    expect(skillTarget.storageKey).toBe('x-skill');
    expect(builtinTarget.storageKey).toBe('builtin-grep');
    expect(globalTarget.storageKey).toBe('global-default');
    expect(unresolvedTarget.storageKey).toBe('unresolved-foo');
  });

  it('empty tool name with default-skill resolves to global target', () => {
    const resolver = new TargetResolverImpl();
    const target = resolver.resolve('', 'default-skill');

    expect(target).toEqual({
      kind: 'global',
      key: 'default',
      storageKey: 'global-default',
      mergeMode: 'global-doc'
    });
  });
});
