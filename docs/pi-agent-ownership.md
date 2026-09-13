# Pi Agent Ownership Map

**Date:** 2026-04-29  
**Runtime inspected:** `/Users/scottblodgett/.pi/agent`  
**Repo:** `Neural-Partners/np-tooling`

This is the working map of what Neural Partners currently owns in Scott's local Pi agent install, what belongs in this repo, and what should stay local/private runtime state.

## Executive summary

`~/.pi/agent` is a mixed runtime directory:

- **Packageable NP assets**: extensions, skills, CLIs, templates, docs, bridge code.
- **Local operating config**: settings, bridge roster/policy, model config, global `AGENTS.md`.
- **Runtime state**: IPC sockets/mailboxes, session transcripts, reviews, tool usage logs.
- **Secrets**: `auth.json` and any token-bearing local files.

`np-tooling` should become the source of truth for packageable/reusable assets, not for secrets or generated state.

Publishing rule:

- **Public packages**: publish/register on npm. Example: `@neuralpartners/pi-yo`.
- **Internal NP packages**: ship/install as git packages. Do **not** publish internal-only packages to npm.

## Current repo state

Root package:

- `package.json`: private workspace repo, Node `>=22`, workspaces under `packages/*`.
- `packages/pi-yo`: current public package source in this checkout.
- `local/`: gitignored local experiments.
- `private/`: gitignored internal/customer-specific work.
- `.claude/`: local agent session scaffold; currently gitignored.

Important branch/version context:

- Current checkout branch: `fix/pi-yo-key-guides`.
- Current checkout `packages/pi-yo/package.json`: `@neuralpartners/pi-yo@0.1.6`.
- Local worktree `.worktrees/pi-yo-usage-skill`: `@neuralpartners/pi-yo@0.2.0`, adds bundled `skills/pi-yo/SKILL.md`.
- Globally installed package: `@neuralpartners/pi-yo@0.2.0`.
- npm latest: `@neuralpartners/pi-yo@0.2.0`, MIT.

Translation: the installed/public package is ahead of this active branch. Merge/rebase the `skill/pi-yo-usage` work before treating this checkout as canonical for `pi-yo`.

## Installed Pi package set

From `~/.pi/agent/settings.json`:

| Package                            | Owner                        | Notes                                      |
| ---------------------------------- | ---------------------------- | ------------------------------------------ |
| `npm:pi-ask-user`                  | third-party/local dependency | Interactive `ask_user` decision gate.      |
| `npm:@tmustier/pi-files-widget`    | third-party                  | File browser/viewer.                       |
| `npm:@tmustier/pi-usage-extension` | third-party                  | Usage dashboard.                           |
| `npm:@tmustier/extending-pi`       | third-party                  | Pi extension/skill/package authoring docs. |
| `git:github.com/obra/superpowers`  | third-party                  | Superpowers process skills.                |
| `npm:@injaneity/pi-computer-use`   | third-party                  | macOS computer-use tools.                  |
| `npm:@neuralpartners/pi-yo`        | **Neural Partners public**   | Inter-session messaging package.           |

Other local config:

- `defaultProvider`: `openai-codex`
- `defaultModel`: `gpt-5.5`
- `defaultThinkingLevel`: `xhigh`
- `models.json`: local Ollama provider with `sidekick:latest` / `gemma4:e4b`

## NP-owned packageable assets in `~/.pi/agent`

### Public package already owned by `np-tooling`

#### `@neuralpartners/pi-yo`

Local/runtime paths:

- `~/.pi/agent/bin/pimsg`
- `~/.pi/agent/bin/pi-cc-bridge`
- `~/.pi/agent/lib/pi-bridge-core.js`
- `~/.pi/agent/tests/pi-bridge-core.test.js`
- `~/.pi/agent/extensions-disabled/pi-bridge.ts.pre-pi-yo-0.1.2` (old pre-package copy)
- `~/.pi/agent/bridge-policy.json` (local config)
- `~/.pi/agent/bridge-roster.json` (local NP/Scott roster)

Repo source paths:

- `packages/pi-yo/bin/pimsg`
- `packages/pi-yo/bin/pi-cc-bridge`
- `packages/pi-yo/extensions/pi-bridge.ts`
- `packages/pi-yo/lib/pi-bridge-core.js`
- `packages/pi-yo/tests/pi-bridge-core.test.js`
- `packages/pi-yo/skills/pi-yo/SKILL.md` exists in the `skill/pi-yo-usage` worktree / global install, not this active branch.

Purpose:

- Trusted-local Unix-socket messaging between Pi and Claude Code sessions.
- Pi tools: `list_sessions`, `send_to_session`, `reply_to_session`.
- Pi commands: `/bridge-list`, `/bridge-send`, `/bridge-mailbox`, `/bridge-ping`, `/yo`.
- CLI: `pimsg`, `pi-cc-bridge`.
- Policy: `auto-inject` vs `mailbox-only`, allowlist, per-sender rate limit.

Current risk:

- `~/.pi/agent/bin/pimsg` and `~/.pi/agent/bin/pi-cc-bridge` are byte-identical to the global `@neuralpartners/pi-yo@0.2.0` bins, but they require `../lib/pi-bridge-core.js` from `~/.pi/agent/lib`.
- `~/.pi/agent/lib/pi-bridge-core.js` is older than the global package copy and lacks notice/key-guide helpers added in `0.2.0`.
- Fix by ensuring local bin/lib/test copies are synchronized from the installed package, or by making local shims call the installed package directly.

### Internal package candidates

These should likely become git-installed internal packages unless deliberately generalized and sanitized for public npm.

#### Neural Partners self-improvement extension

Path:

- `~/.pi/agent/extensions/neural-partners.ts`

Commands/hooks:

- Injects project `.claude/rules.md` and `.claude/lessons.md` into turns.
- Detects explicit corrections and queues a lesson/rule reminder.
- Commands: `/lesson`, `/lessons`, `/rules`, `/pi-review`.
- Logs privacy-minimal usage events to `~/.pi/agent/tool-usage.jsonl`.

Recommendation:

- Internal git package, likely `@neuralpartners/pi-agent-memory` or `@neuralpartners/pi-np-agent-context`.
- Keep NP-specific defaults internal.

#### Dev server manager

Path:

- `~/.pi/agent/extensions/dev-servers.ts`
- Docs: `~/.pi/agent/docs/dev-server-manager.md`

Command:

- `/dev-servers`

Purpose:

- TUI overlay for finding/killing local dev/model servers.
- Detects Vite/Astro/Next/etc., common dev ports, local model servers, and `neural` / `Neural-Partners` markers.
- Confirms destructive actions and protects Pi/system processes.

Recommendation:

- Internal git package as-is because `Neural-ish` behavior is NP-specific.
- Could become public only after extracting NP matching into config.

#### Coordinate picker

Paths:

- `~/.pi/agent/extensions/coord-picker.ts`
- `~/.pi/agent/bin/coord-picker`
- `~/.pi/agent/bin/coord-picker.swift`

Command:

- `/pick-coords`

Purpose:

- Launches a macOS floating HUD; click captures window-relative coordinates and injects them back into Pi.

Recommendation:

- Internal git package first because it includes native macOS binary/source handling.
- Public later if packaging/signing story is cleaned up.

#### Visual companion

Paths:

- `~/.pi/agent/extensions/visual-companion/index.ts`
- `~/.pi/agent/skills/visual-companion/SKILL.md`

Commands/tools:

- `/visual`
- `start_visual_server`
- `write_visual_screen`
- `read_visual_events`
- `push_waiting_screen`
- `stop_visual_server`

Purpose:

- Browser-based visual brainstorming/mockup companion.
- Writes HTML fragments, records option/card clicks, supports Markdown export.

Recommendation:

- Could be public npm eventually; currently safe as internal git package until docs/tests/package metadata exist.
- High value for Scott's visual learning/workflow.

#### Neural Partners brand skill

Path:

- `~/.pi/agent/skills/neural-partners-brand/SKILL.md`

Purpose:

- NP visual identity and voice rules.
- Covers color/typography/spacing/component rules, anti-cliche AI imagery, writing style.

Recommendation:

- Internal git package by default.
- Do not publish unless intentionally making NP brand guidance public.

#### Multi-agent docs generator skill

Paths:

- `~/.pi/agent/skills/multi-agent-docs-generator/`
- Legacy/duplicate path: `~/.pi/agent/multi-agent-docs-generator/`

Purpose:

- Scopes multi-agent documentation initiatives.
- Generates specs, handoff structures, message contracts, feedback docs, ADR/brief/report templates.

Current issue:

- There are two copies with drift:
  - canonical-looking package copy: `~/.pi/agent/skills/multi-agent-docs-generator/`
  - older/alternate copy: `~/.pi/agent/multi-agent-docs-generator/`

Recommendation:

- Internal git package candidate.
- First consolidate duplicate copies and choose one canonical source.

#### Supacode integration

Paths:

- `~/.pi/agent/extensions/supacode/index.ts`
- `~/.pi/agent/skills/supacode-cli/SKILL.md`

Purpose:

- Extension reports Pi lifecycle hooks to Supacode via Supacode-provided Unix socket env vars.
- Skill documents safe Supacode CLI usage and ID tracking.

Recommendation:

- Internal git package or coordinate with Supacode ownership.
- Treat as environment integration, not public NP package unless Supacode wants it public.

## Local docs/templates we own

Paths:

- `~/.pi/agent/AGENTS.md`: global Neural Partners agent context.
- `~/.pi/agent/BACKLOG.md`: global backlog, including `/yo`, remote bridge transport, pi-review ideas.
- `~/.pi/agent/docs/review-and-bridge-tools.md`: review/bridge operational docs.
- `~/.pi/agent/docs/dev-server-manager.md`: `/dev-servers` docs.
- `~/.pi/agent/templates/project-AGENTS.md`: starter project context template.
- `~/.pi/agent/pi-bridge-agents-snippet.md`: bridge setup snippet for projects.

Recommendation:

- Move reusable/internal docs and templates into an internal git package or `docs/internal/` if intended as source-controlled NP operating docs.
- Keep customer-specific or machine-specific paths out of public npm packages.

## Runtime/local state that should not be source-controlled

Never commit these to `np-tooling`:

| Path                            | Why                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `~/.pi/agent/auth.json`         | Contains auth credentials/tokens.                                                         |
| `~/.pi/agent/ipc/`              | Runtime sockets, PID files, mailboxes, registry/logs.                                     |
| `~/.pi/agent/sessions/`         | Session transcripts; likely private/customer-sensitive.                                   |
| `~/.pi/agent/reviews/`          | Generated session reviews; may contain private context.                                   |
| `~/.pi/agent/tool-usage.jsonl*` | Local telemetry/history.                                                                  |
| `~/.pi/agent/settings.json`     | Machine-specific package/provider/theme config. Can document shape, not commit live file. |
| `~/.pi/agent/models.json`       | Machine-specific provider/model config.                                                   |
| `.DS_Store`                     | macOS noise.                                                                              |

## Current bridge topology

`pimsg list` shows active local sessions for:

- `neural-bot`
- `neural-partners-website (CC)`
- `droptheneedle (CC)`
- `scottblodgett (CC)`
- `neural-showrooms (CC)` (duplicate cwd)
- `neural-showroom-template` / `(CC)` (duplicate cwd)
- `neural-core-app`
- `np-tooling` (current)

Known duplicate cwd warnings:

- `/Users/scottblodgett/Projects/neural-showrooms`
- `/Users/scottblodgett/Projects/neural-showroom-template`

Operational rule:

- When duplicates exist, target exact PID/name. Do not rely on fuzzy cwd names.

## Recommended `np-tooling` package lanes

### Public npm lane

Keep only registry-safe, broadly useful packages here:

1. `packages/pi-yo` — current public package.
2. Future public candidates only after sanitizing defaults, docs, tests, package metadata, and screenshots.

NPM package criteria:

- no Scott paths in defaults
- no customer/NP-private roster/config
- no secrets
- public README and license
- `npm pack --dry-run` clean
- package-level tests and `npm run verify`

### Internal git package lane

Add internal package work under a tracked internal package path or private repo/package branch, then install with Pi via git URL.

Candidates:

1. NP agent context / self-improvement extension.
2. Neural Partners brand skill.
3. Visual companion extension + skill.
4. Dev server manager.
5. Coordinate picker.
6. Multi-agent docs generator.
7. Supacode integration.
8. Project `AGENTS.md` templates and bridge snippets.

Internal package criteria:

- git-installable by Pi
- can include NP defaults
- still no secrets/tokens/auth files
- can include internal docs/templates
- versioned through git tags/SHAs instead of npm registry releases

## Suggested next moves

1. **Make current repo canonical for `pi-yo@0.2.0`**  
   Merge/rebase the `skill/pi-yo-usage` worktree into the active branch or main.

2. **Sync installed local bridge shims**  
   Ensure `~/.pi/agent/bin/*`, `~/.pi/agent/lib/pi-bridge-core.js`, and tests match the installed `@neuralpartners/pi-yo@0.2.0` package.

3. **Create an internal git package skeleton**  
   Example package name: `@neuralpartners/pi-agent-kit` or `@neuralpartners/pi-internal-tools`.

4. **Move one internal asset at a time**  
   Start with lowest-risk skills (`neural-partners-brand`, `supacode-cli`) before native/tooling extensions.

5. **Consolidate duplicate multi-agent docs generator copies**  
   Pick `~/.pi/agent/skills/multi-agent-docs-generator/` as likely canonical, diff the legacy copy, then package it.

6. **Document install profiles**  
   Public profile: npm packages only.  
   NP internal profile: public npm packages + internal git packages + local config.

## Ownership boundary

`np-tooling` owns:

- reusable NP Pi packages
- public npm packages
- internal git packages
- extension/skill source
- package docs/tests/assets
- package conventions and publishing policy

`~/.pi/agent` owns:

- installed package runtime
- local config
- live sessions/IPC/mailboxes
- local auth
- generated logs/reviews
- machine-specific models/settings
