# OpenClaw Skill Evolution Plugin

A plugin that helps OpenClaw skills evolve from real usage feedback.

This repository is an **OpenClaw plugin**, **not** a normal skill folder.

- It uses OpenClaw plugin hooks: `before_prompt_build`, `after_tool_call`, `message_received`, `agent_end`, and `session_end`.
- It is discovered as a plugin through `openclaw.plugin.json` and `package.json -> openclaw.extensions`.
- Do **not** install it into `skills/` and do **not** expect it to be discovered via `SKILL.md`.

---

# Installation

## For Humans

Paste this into your LLM agent session:

```bash
Install and configure the OpenClaw plugin "skill-generation" from this repository.

Important constraints:
1. Treat it as an OpenClaw plugin, NOT a skill.
2. Use `openclaw plugins install -l .` for local installation.
3. Configure it under `plugins.entries.skill-evolution.config`.
4. Verify with:
   - `openclaw plugins list`
   - `openclaw plugins info skill-evolution`
   - `openclaw plugins doctor`
5. Do not put this repo into `skills/`.
6. If overlay injection does not appear during sessions, check:
   `plugins.entries.skill-evolution.hooks.allowPromptInjection`
````

### Manual install

Clone the repository and install dependencies:

```bash
git clone https://github.com/NEKO-CwC/skill-generation.git
cd skill-generation
npm install
npm run build
npm run test
```

Install it into OpenClaw as a **linked local plugin**:

```bash
openclaw plugins install -l .
openclaw plugins enable skill-evolution
```

Then restart OpenClaw / the OpenClaw gateway so config and plugin state are reloaded.

### Verify installation

Run:

```bash
openclaw plugins list
openclaw plugins info skill-evolution
openclaw plugins doctor
```

You should see the plugin id `skill-evolution` in the plugin list and info output.

---

## For LLM Agents

### Critical rule

This project is an **OpenClaw plugin**.

It is **not**:

* a `skills/` directory package
* a `SKILL.md`-based skill
* a slash-command-only skill bundle

Never install this repository into `~/.openclaw/skills/` or `{workspace}/skills/`.

### What this repo already contains

Before installing, understand the package shape:

* `openclaw.plugin.json` exists and declares plugin id `skill-evolution`
* `package.json` declares `openclaw.extensions`
* `src/openclaw.ts` exports the OpenClaw plugin entry and registers hooks

That means your job is to:

1. install dependencies
2. link-install the plugin into OpenClaw
3. write plugin config into OpenClaw config
4. restart OpenClaw
5. verify plugin discovery and behavior

### Step 0: Ask the user these configuration questions

Ask the user:

1. **Do you want manual merge or automatic merge?**

   * manual → `requireHumanMerge: true`
   * automatic → `requireHumanMerge: false`

2. **Do you want session overlays enabled?**

   * yes → `sessionOverlay.enabled: true`
   * no → `sessionOverlay.enabled: false`

3. **Should overlays be cleared when the session ends?**

   * yes → `clearOnSessionEnd: true`
   * no → `clearOnSessionEnd: false`

4. **Do you want prompt injection enabled?**

   * usually yes
   * if no, the plugin will still collect feedback and run review, but overlays will not appear in prompts

5. **Do you want the default storage directories?**

   * overlays: `.skill-overlays`
   * patches: `.skill-patches`
   * backups: `.skill-backups`
   * feedback logs: `.skill-feedback`

If the user does not have a specific preference, use the safe default:

* manual merge
* overlay enabled
* clear overlays on session end
* prompt injection enabled

### Step 1: Install the repository

```bash
git clone https://github.com/NEKO-CwC/skill-generation.git
cd skill-generation
npm install
npm run build
npm run test
```

### Step 2: Install into OpenClaw

Use local linked install:

```bash
openclaw plugins install -l .
openclaw plugins enable skill-evolution
```

Do not manually symlink into `skills/`.
Do not check for `SKILL.md`.
Do not use `openclaw skills list`.

### Step 3: Write OpenClaw config

Write plugin config into the OpenClaw config file under:

```jsonc
plugins.entries.skill-evolution
```

Use this template:

```jsonc
{
  "plugins": {
    "entries": {
      "skill-evolution": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        },
        "config": {
          "enabled": true,
          "merge": {
            "requireHumanMerge": true,
            "maxRollbackVersions": 5
          },
          "sessionOverlay": {
            "enabled": true,
            "storageDir": ".skill-overlays",
            "injectMode": "system-context",
            "clearOnSessionEnd": true
          },
          "triggers": {
            "onToolError": true,
            "onUserCorrection": true,
            "onSessionEndReview": true,
            "onPositiveFeedback": true
          },
          "llm": {
            "inheritPrimaryConfig": true,
            "modelOverride": null,
            "thinkingOverride": null
          },
          "review": {
            "minEvidenceCount": 2,
            "allowAutoMergeOnLowRiskOnly": false
          }
        }
      }
    }
  }
}
```

### Step 4: Restart OpenClaw

After changing plugin config, restart the OpenClaw gateway / process.

### Step 5: Verify plugin discovery

Run:

```bash
openclaw plugins list
openclaw plugins info skill-evolution
openclaw plugins doctor
```

### Step 6: Verify plugin behavior

Run a small real test:

1. Start a session that uses a skill
2. Trigger a tool error or give a direct correction
3. Confirm overlay files and feedback logs appear:

   * `.skill-overlays/{session-id}/` (overlays)
   * `.skill-feedback/{session-id}.jsonl` (feedback events)
4. End the session (triggers `session_end` hook)
5. Check the result:

   * manual merge mode → patch file queued in `.skill-patches/`
   * automatic merge mode → skill file updated and backup created in `.skill-backups/`

---

# Configuration Guide

## Recommended defaults

Use these defaults unless the user asks otherwise:

* `enabled: true`
* `requireHumanMerge: true`
* `maxRollbackVersions: 5`
* `sessionOverlay.enabled: true`
* `sessionOverlay.injectMode: "system-context"`
* `clearOnSessionEnd: true`
* `minEvidenceCount: 2`

## What each setting means

### `merge.requireHumanMerge`

* `true`: queue patch files for review, do not auto-write skill files
* `false`: auto-merge patches and keep rollback backups

### `merge.maxRollbackVersions`

Maximum number of previous skill versions to keep per skill.

### `sessionOverlay.enabled`

Whether temporary session-local overlay behavior is enabled.

### `hooks.allowPromptInjection`

This is an OpenClaw plugin setting, not this plugin's own setting.

* `true`: overlays can be injected into prompts through `before_prompt_build`
* `false`: OpenClaw blocks prompt injection; the plugin still collects feedback and runs end-of-session review

### `review.minEvidenceCount`

Minimum number of feedback signals before the plugin recommends a skill update.

---

# How It Works

## During a session

* the plugin listens for tool errors and user corrections
* feedback events are persisted to `.skill-feedback/` for auditability
* it stores temporary overlay data per session
* on the next prompt build, it prepends session-local guidance

## At session end (on the `session_end` hook)

* it builds a session summary
* performs deterministic review
* generates a patch
* either queues that patch for review or auto-merges it
* prunes rollback history to the configured cap

---

# Testing

## Development tests

```bash
npm run test
npm run test:watch
npm run test:single -- tests/workflows
```

## Runtime checks

After installation, verify these behaviors:

1. Plugin appears in `openclaw plugins list`
2. `openclaw plugins info skill-evolution` loads cleanly
3. `openclaw plugins doctor` shows no install/config errors
4. Overlay files appear after a correction or tool error
5. Session-end review produces either:

   * queued patch files
   * or merged skill + rollback backup

---

# Important Notes

## This is not a skill

Do not:

* copy this repo into `skills/`
* look for `SKILL.md`
* run `openclaw skills list` to verify installation

Use plugin commands instead.

## Prompt injection can be disabled globally/per-plugin

If the plugin seems to “collect data but not affect prompts,” check:

```jsonc
plugins.entries.skill-evolution.hooks.allowPromptInjection
```

When that value is `false`, OpenClaw blocks `before_prompt_build` prompt mutation.

## Config belongs under `plugins.entries.skill-evolution.config`

Do not put the production config only at a random top-level key and expect OpenClaw to wire it automatically.

---

# Troubleshooting

## Plugin installed but not visible

Run:

```bash
openclaw plugins doctor
openclaw plugins list
```

Then check:

* the repository was installed with `openclaw plugins install -l .`
* the plugin id is `skill-evolution`
* `openclaw.plugin.json` exists
* `package.json` contains `openclaw.extensions`

## Overlay not appearing in prompts

Check:

* `plugins.entries.skill-evolution.hooks.allowPromptInjection`
* `sessionOverlay.enabled`
* whether the current session actually generated a correction/error signal

## No patch generated at session end

Check:

* `review.minEvidenceCount`
* whether enough feedback signals were captured
* whether the session actually triggered `session_end` (not just `agent_end`)
* whether the session actually ended cleanly

## Auto-merge did not happen

Check:

* `merge.requireHumanMerge`
* if true, patch files are queued instead of auto-applied

