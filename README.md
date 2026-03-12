# OpenClaw Skill Evolution Plugin

## What it does
The Skill Evolution plugin captures tool errors and user corrections during OpenClaw sessions. It creates temporary session-local overlays and runs deterministic end-of-session reviews. After the review, it generates patches and safely merges improvements back into your skills with rollback protection.

## What this is NOT
*   **Not a skill package.** Do not install this via `openclaw skills`. It is a plugin that enhances how skills behave.
*   **Not a set of skills.** It does not include any `SKILL.md` files. Instead, it evolves your existing skills.
*   **No LLMs for review.** This version uses deterministic rules for post-session reviews rather than LLM calls.

## Prerequisites
*   OpenClaw (latest version recommended)
*   Node.js 22+
*   `allowPromptInjection: true` in your plugin configuration. This is required for overlay injection to work.

## Install
```bash
# Clone the plugin
git clone <repo-url> openclaw-skill-evolution
cd openclaw-skill-evolution
npm install

# Register with OpenClaw
openclaw plugins install -l .
```

## Configure
Add this JSON5 block to your `~/.openclaw/openclaw.json` file:

```json5
{
  "plugins": {
    "entries": {
      "skill-evolution": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true  // REQUIRED for overlay injection
        },
        "config": {
          "enabled": true,
          "merge": {
            "requireHumanMerge": true,  // set false for auto-merge
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

## Verify installation
Run these commands to confirm the plugin is active:

```bash
openclaw plugins list          # Should show skill-evolution
openclaw plugins info skill-evolution  # Shows config schema
openclaw plugins doctor        # Health check
```

## How it works
1.  **During session:** The plugin captures tool failures and user corrections. It then creates session-local overlays to adjust behavior immediately.
2.  **Before each prompt:** Overlay hints are injected into the system context via the `before_prompt_build` hook.
3.  **At session end:** A deterministic review evaluates the accumulated feedback.
4.  **Patch generation:** If the review recommends changes, the plugin generates a text patch.
5.  **Merge:** Depending on your `requireHumanMerge` setting, the plugin either auto-merges the patch with a rollback backup or queues it for human review.

## Configuration reference

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `true` | Enables or disables the plugin. |
| `merge.requireHumanMerge` | boolean | `true` | If true, patches are queued for manual review. If false, patches are merged automatically. |
| `merge.maxRollbackVersions` | number | `5` | Maximum number of backups to keep per skill. |
| `sessionOverlay.enabled` | boolean | `true` | Enables session-local temporary skill modifications. |
| `sessionOverlay.storageDir` | string | `.skill-overlays` | Directory for temporary overlay storage. |
| `sessionOverlay.injectMode` | string | `system-context` | Where to inject overlays in the prompt. |
| `sessionOverlay.clearOnSessionEnd` | boolean | `true` | Deletes temporary overlays when the session finishes. |
| `triggers.onToolError` | boolean | `true` | Collect feedback when a tool returns an error. |
| `triggers.onUserCorrection` | boolean | `true` | Collect feedback when a user corrects the agent. |
| `triggers.onSessionEndReview` | boolean | `true` | Run the review process at the end of a session. |
| `triggers.onPositiveFeedback` | boolean | `true` | Track positive signals to validate skill performance. |
| `review.minEvidenceCount` | number | `2` | Minimum number of feedback events required to recommend a change. |
| `review.allowAutoMergeOnLowRiskOnly` | boolean | `false` | Reserved for future risk-based filtering. |

## Common issues / FAQ

**"Plugin seems to have no effect"**
Check that `allowPromptInjection: true` is set in your config. If this is false, OpenClaw blocks overlay injection. The plugin will still collect feedback, but you won't see the overlays in your prompts.

**"Patches are queued but not applied"**
You likely have `requireHumanMerge: true` enabled. Check the `.skill-patches/` directory for pending patches that need manual application.

**"No review happens at session end"**
Ensure `triggers.onSessionEndReview` is true. Also check `review.minEvidenceCount`. A review only triggers if you have at least that many feedback events.

**"Overlays from previous sessions persist"**
Verify that `sessionOverlay.clearOnSessionEnd` is set to true.

## Development
For those looking to contribute, the project uses TypeScript in strict mode. You can find detailed architecture information in the `docs/` folder.

```bash
npm run build   # Build the project
npm run test    # Run the 88 tests via vitest
npm run lint    # Run linting checks
```
