import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import register from '../../src/openclaw.ts';
import type {
  AgentEndHandler,
  AfterToolCallHandler,
  BeforePromptBuildHandler,
  HookOptions,
  MessageReceivedHandler,
  OpenClawPluginAPI
} from '../../src/shared/types.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

type HookName = 'before_prompt_build' | 'after_tool_call' | 'message_received' | 'agent_end';

type HookHandlerMap = {
  before_prompt_build: BeforePromptBuildHandler;
  after_tool_call: AfterToolCallHandler;
  message_received: MessageReceivedHandler;
  agent_end: AgentEndHandler;
};

type RegisteredHook = {
  name: HookName;
  handler: HookHandlerMap[HookName];
  opts?: HookOptions;
};

class MockOpenClawApi implements OpenClawPluginAPI {
  public readonly hooks: RegisteredHook[] = [];

  private readonly config: Record<string, unknown>;

  public constructor(config: Record<string, unknown> = {}) {
    this.config = config;
  }

  public on(hook: 'before_prompt_build', handler: BeforePromptBuildHandler, opts?: HookOptions): void;

  public on(hook: 'after_tool_call', handler: AfterToolCallHandler, opts?: HookOptions): void;

  public on(hook: 'message_received', handler: MessageReceivedHandler, opts?: HookOptions): void;

  public on(hook: 'agent_end', handler: AgentEndHandler, opts?: HookOptions): void;

  public on(
    hook: HookName,
    handler: BeforePromptBuildHandler | AfterToolCallHandler | MessageReceivedHandler | AgentEndHandler,
    opts?: HookOptions
  ): void {
    if (hook === 'before_prompt_build') {
      this.hooks.push({ name: hook, handler, opts });
      return;
    }
    if (hook === 'after_tool_call') {
      this.hooks.push({ name: hook, handler, opts });
      return;
    }
    if (hook === 'message_received') {
      this.hooks.push({ name: hook, handler, opts });
      return;
    }
    this.hooks.push({ name: hook, handler, opts });
  }

  public getConfig(): Record<string, unknown> {
    return this.config;
  }
}

function getHook(api: MockOpenClawApi, name: 'before_prompt_build'): BeforePromptBuildHandler;
function getHook(api: MockOpenClawApi, name: 'after_tool_call'): AfterToolCallHandler;
function getHook(api: MockOpenClawApi, name: 'message_received'): MessageReceivedHandler;
function getHook(api: MockOpenClawApi, name: 'agent_end'): AgentEndHandler;
function getHook(api: MockOpenClawApi, name: HookName): HookHandlerMap[HookName] {
  const hook = api.hooks.find((entry) => entry.name === name);
  if (!hook) {
    throw new Error(`Missing hook: ${name}`);
  }
  return hook.handler;
}

describe('openclaw adapter', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-openclaw-adapter-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('registers all four hooks when enabled', () => {
    const api = new MockOpenClawApi({ enabled: true });

    register(api);

    expect(api.hooks).toHaveLength(4);
    expect(api.hooks.map((entry) => entry.name)).toEqual([
      'before_prompt_build',
      'after_tool_call',
      'message_received',
      'agent_end'
    ]);
    for (const hook of api.hooks) {
      expect(hook.opts?.priority).toBe(50);
    }
  });

  it('skips registration when enabled=false', () => {
    const api = new MockOpenClawApi({ enabled: false });

    register(api);

    expect(api.hooks).toHaveLength(0);
  });

  it('resolves wrapped OpenClaw config and skips hooks when wrapper sets enabled=false', () => {
    const api = new MockOpenClawApi({
      skillEvolution: {
        enabled: false
      }
    });

    register(api);

    expect(api.hooks).toHaveLength(0);
  });

  it('uses default config when getConfig returns empty object', () => {
    const api = new MockOpenClawApi({});

    expect(() => register(api)).not.toThrow();
    expect(api.hooks).toHaveLength(4);
  });

  it('falls back to defaults on invalid config', () => {
    const api = new MockOpenClawApi({
      merge: {
        maxRollbackVersions: -1
      }
    });

    expect(() => register(api)).not.toThrow();
    expect(api.hooks).toHaveLength(4);
  });

  it('logs allowPromptInjection degradation notice at registration', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const api = new MockOpenClawApi({});

    register(api);

    const messages = infoSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((line) => line.includes('allowPromptInjection'))).toBe(true);
  });

  it('before_prompt_build returns prependSystemContext with overlay', async () => {
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const afterToolCall = getHook(api, 'after_tool_call');
    const sessionId = 'session-overlay';

    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId, skillKey: 'adapter.skill' }
    );

    await afterToolCall(
      { tool: 'shell', result: 'Error: command failed', isError: true },
      { sessionId }
    );

    const result = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(result?.prependSystemContext).toContain('Tool error observed for shell');
    expect(result?.prependSystemContext).not.toContain('BASE_PROMPT');
  });

  it('before_prompt_build returns undefined when no overlays', async () => {
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const result = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId: 'session-no-overlay', skillKey: 'adapter.skill' }
    );

    expect(result).toBeUndefined();
  });

  it('before_prompt_build resolves skillKey from ctx', async () => {
    const beforeSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'before_prompt_build');
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [], skillKey: 'event-skill' },
      { sessionId: 'session-skill-resolution', skillKey: 'my-skill' }
    );

    expect(beforeSpy).toHaveBeenCalledWith('session-skill-resolution', 'my-skill', 'BASE_PROMPT');
  });

  it('after_tool_call maps event fields correctly', async () => {
    const afterSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'after_tool_call').mockResolvedValue();
    const api = new MockOpenClawApi({});
    register(api);

    const afterToolCall = getHook(api, 'after_tool_call');
    await afterToolCall(
      { tool: 'build', result: 'Error: unresolved symbol', isError: true },
      { sessionId: 'session-after-tool' }
    );

    expect(afterSpy).toHaveBeenCalledWith('session-after-tool', 'build', 'Error: unresolved symbol', true);
  });

  it('message_received maps event fields correctly', async () => {
    const messageSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'message_received').mockResolvedValue();
    const api = new MockOpenClawApi({});
    register(api);

    const messageReceived = getHook(api, 'message_received');
    await messageReceived(
      { message: 'you should have done this instead', role: 'user' },
      { sessionId: 'session-message' }
    );

    expect(messageSpy).toHaveBeenCalledWith('session-message', 'you should have done this instead');
  });

  it('agent_end calls plugin.agent_end and performs session cleanup', async () => {
    const api = new MockOpenClawApi({
      review: {
        minEvidenceCount: 999
      }
    });
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const afterToolCall = getHook(api, 'after_tool_call');
    const agentEnd = getHook(api, 'agent_end');
    const sessionId = 'session-end';

    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId, skillKey: 'adapter.skill.cleanup' }
    );

    await afterToolCall(
      { tool: 'test', result: 'Error: first failure', isError: true },
      { sessionId }
    );

    const withOverlay = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(withOverlay?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');

    const agentEndSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'agent_end');
    await agentEnd({}, { sessionId });
    expect(agentEndSpy).toHaveBeenCalledWith(sessionId);

    const afterCleanup = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(afterCleanup).toBeUndefined();
  });
});
