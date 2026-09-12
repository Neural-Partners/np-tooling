# pi-yo

Trusted-local inter-session messaging for Pi agents.

Source repository: <https://github.com/Neural-Partners/np-tooling/tree/main/packages/pi-yo>

> **Status:** public npm package published as `@neuralpartners/pi-yo` (unscoped `pi-yo` is blocked by npm similarity rules).

## What it does

`pi-yo` lets local Pi sessions discover each other and send JSONL messages over owner-only Unix sockets. It provides:

- Pi LLM tools: `list_sessions`, `set_session_visibility`, `update_session_status`, `send_to_session`, `reply_to_session`, `join_chat_room`, `post_room_message`, `follow_room_thread`, `set_room_notifications`, `list_chat_rooms`
- slash commands: `/bridge-list`, `/bridge-visibility`, `/bridge-send`, `/bridge-mailbox`, `/bridge-ping`, `/yo`, `/room`
- CLI helpers: `pimsg`, `pi-cc-bridge`, `piroom`
- transport receipts: `ACK received` / `pong` from the recipient process

Use it as the walkie-talkie layer between agents that are already running in different terminals. Common coordination messages include:

- telling another agent a deploy started, finished, failed, or needs smoke testing
- warning that a file, branch, Terraform stack, local port, or package version is being edited
- asking a peer session to avoid a path while another agent owns it
- sharing dependency/API/schema changes before downstream work continues
- sending blockers, review requests, reproduction steps, or handoff notes without switching terminals
- replying with `reply_to_session` / `pimsg --reply` so agents do not create infinite reply loops

Transport ACK means the recipient process validated and accepted the frame for its local path. In the Pi extension path that means it queued the message for `sendUserMessage` or held it in the bridge mailbox; in `pi-cc-bridge` it means the message was appended to the mailbox. It does **not** mean the human or agent completed the work.

## Bundled Pi skill

This package includes the `pi-yo` skill. When installed, Pi can load it for inter-session coordination workflows: discover peers with `list_sessions`, hide/reveal the current Pi session with `set_session_visibility`, send new handoffs with `send_to_session`, and answer inbound bridge messages with `reply_to_session` to avoid reply loops.

## Screenshots

Screenshots are bundled in the npm package under [`assets/`](assets/) and use raw GitHub URLs here so they render on npm.

### Mailbox-only review

`mailbox-only` policy holds inbound messages for manual review instead of injecting them directly into model context.

![Mailbox-only review screen](https://raw.githubusercontent.com/Neural-Partners/np-tooling/main/packages/pi-yo/assets/mailbox-review.png)

### Pi to Claude Code coordination loop

Pi can send to Claude Code sessions through `pi-cc-bridge`, Claude Code can reply with `pimsg --reply`, and Pi receives the reply without creating an infinite response loop.

![Pi to Claude Code message flow](https://raw.githubusercontent.com/Neural-Partners/np-tooling/main/packages/pi-yo/assets/pi-to-claude-code-flow.png)

## License

`pi-yo` is released under the **MIT License**.

Commercial use, private use, modification, distribution, and forks are allowed under the MIT terms. See [`LICENSE`](LICENSE).

## Trust model

This package is for trusted same-user local IPC only.

- It is not an authentication boundary.
- Do not expose its sockets to remote hosts or untrusted local users.
- Inbound messages can be injected into model context by design when policy allows auto-inject.
- Treat all inbound message content as untrusted prompt-injection text.
- Same-UID malicious processes are out of scope; compromised peer sessions are only partially mitigated.

IPC files are owner-only by default:

- `~/.pi/agent/ipc`: `0700`
- registry, sockets, mailboxes, pid/log files: `0600` where the platform allows it

## Bridge policy

Policy lives outside the package:

```txt
~/.pi/agent/bridge-policy.json
```

Default policy auto-injects allowed local messages and uses smart focus:

```json
{
  "mode": "auto-inject",
  "allowlist": [],
  "rateLimit": { "perSenderPer10s": 5 },
  "focus": {
    "mode": "smart",
    "allowedFrontmostApps": [
      "Supacode",
      "Terminal",
      "iTerm2",
      "Warp",
      "Ghostty",
      "WezTerm",
      "Cursor",
      "Visual Studio Code",
      "Code",
      "Zed",
      "Sublime Text",
      "Antigravity",
      "Kiro",
      "Windsurf",
      "WebStorm",
      "IntelliJ IDEA",
      "Claude",
      "Claude Desktop",
      "Codex"
    ]
  }
}
```

Modes:

- `auto-inject`: inject allowed inbound messages into the receiving Pi conversation.
- `mailbox-only`: hold all inbound messages in the local bridge mailbox for manual review with `/bridge-mailbox`.

Allowlist behavior:

- Empty `allowlist` means any same-user local sender may auto-inject when `mode` is `auto-inject`.
- Non-empty `allowlist` means only matching senders auto-inject; non-matching senders are held in the mailbox.
- Match entries can use exact `pid`, `name`, or `cwd`:

```json
{
  "mode": "auto-inject",
  "allowlist": [{ "name": "backend" }, { "cwd": "/Users/me/project" }],
  "rateLimit": { "perSenderPer10s": 5 }
}
```

If a sender exceeds the per-sender rate limit, messages are held in the mailbox instead of auto-injected.

## Smart focus policy

`pi-yo` can focus the target Supacode tab after a successful bridge send. The default is `smart`, which focuses only when your current frontmost macOS app is an agent/dev app. This keeps the fast dispatch workflow when you are working in Supacode, a terminal, Cursor, an IDE, Claude Desktop, or Codex, but avoids stealing focus when you are in Chrome, Figma, Slack, email, or another non-agent app.

Focus config lives in `~/.pi/agent/bridge-policy.json`:

- `focus.mode: "smart"` — default; focus only when the frontmost app is allowlisted.
- `focus.mode: "always"` — restore the old behavior and focus whenever the target has Supacode metadata.
- `focus.mode: "never"` — disable auto-focus entirely.

In v1, only Supacode targets can be focused because the bridge registry currently stores Supacode tab/worktree IDs. IDE names in `allowedFrontmostApps` mean "it is OK to focus a Supacode target while this app is frontmost"; they do not yet focus Cursor, VS Code, Windsurf, Kiro, or other IDE windows as targets.

## Invisible sessions

A Pi agent can make its own bridge session invisible when duplicate session names or standby terminals would confuse discovery.

Soft-invisible behavior:

- hidden from `list_sessions`, `/bridge-list`, `/yo list`, and `pimsg list`
- ignored for normal name, cwd, and fuzzy target resolution
- still reachable by Exact PID as a manual escape hatch
- still able to send outbound messages normally

Human command:

```bash
/bridge-visibility status
/bridge-visibility invisible
/bridge-visibility visible
```

Agent tool:

```txt
set_session_visibility({ "visibility": "invisible" | "visible" | "status" })
```

CLI diagnostics:

```bash
pimsg list --all
```

`pimsg list --all` includes invisible sessions and labels them with `[invisible]`. Use Exact PID if you intentionally need to message an invisible session.

## Local chatrooms

`piroom` is the local-first chatroom prototype built on top of `pi-yo`. Think Slack-style project rooms without the SaaS bloat: humans and agents can join a project room, post messages, follow threads, and monitor the room from another terminal.

Room state is local and owner-only under `~/.pi/agent/ipc/room-state.json` and `~/.pi/agent/ipc/room-events.jsonl`. The prototype is same-user/same-machine only; cross-network/team Macs are a future transport adapter.

### Source checkout vs installed package

`piroom` exists in `@neuralpartners/pi-yo@0.4.0+`. If npm latest may lag main, `piroom` will not exist after installing the older npm package. Check first:

```bash
npm view @neuralpartners/pi-yo version
node -p 'require("./packages/pi-yo/package.json").version'
```

If the source checkout is newer than npm, test from the source checkout or install the local package path. Do not expect commands from the primary repo checkout to work if that checkout is behind `origin/main` and does not contain `packages/pi-yo/bin/piroom`.

Safe source smoke test with a temporary `HOME` that does not touch real Pi state:

```bash
cd /absolute/path/to/np-tooling
npm install
npm run smoke:rooms --workspace @neuralpartners/pi-yo
```

Expected output:

```txt
piroom smoke passed
temporary HOME: /tmp/piroom-smoke-...
```

Local package install for manual testing before npm publish:

```bash
cd /absolute/path/to/np-tooling
npm install -g /absolute/path/to/np-tooling/packages/pi-yo
pimsg doctor --sync-shims
piroom --help
```

`pimsg doctor --sync-shims` copies `pimsg`, `pi-cc-bridge`, `piroom`, and `lib/pi-bridge-core.js` into `~/.pi/agent` when they are stale or missing.

Rollback to the published package if needed:

```bash
npm install -g @neuralpartners/pi-yo@0.3.0
pimsg doctor --sync-shims
```

### Standalone terminal manager

```bash
piroom join np-tooling --name principal
piroom join np-tooling --name worker-auth --kind pi
piroom post np-tooling "@worker-auth please review !assign @worker-auth"
piroom follow np-tooling <thread-id-from-post-output> --name worker-auth
piroom dnd np-tooling on --name worker-auth
piroom manager np-tooling
piroom manager np-tooling --once
```

`piroom post` prints the created thread id. Use that exact id for `piroom follow`; placeholder ids like `thr_abc123` are examples only.

### Pi command/tool surface

```txt
/room join np-tooling as principal
/room post np-tooling @worker-auth please review
/room follow np-tooling <thread-id-from-post-output>
/room dnd np-tooling on

join_chat_room({ "room": "np-tooling", "name": "principal" })
post_room_message({ "room": "np-tooling", "message": "@worker-auth please review" })
follow_room_thread({ "room": "np-tooling", "threadId": "thr_..." })
set_room_notifications({ "room": "np-tooling", "alertMode": "mentions", "dnd": false })
list_chat_rooms({})
```

Default alerts are **mention/thread/assignment only**. A room post alerts an agent when it mentions the agent, lands in a followed thread, assigns the agent with `!assign @name`, or is marked urgent. Normal room chatter stays in the room log and the `piroom manager` view instead of becoming prompt-injection confetti.

DND suppresses non-urgent alerts for that member. Offline or sleeping sessions cannot be woken by local IPC; room events stay durable and can be reviewed when the session returns.

Do not send secrets, tokens, credentials, private keys, customer PII, or sensitive production data through local chatrooms. Treat room messages as untrusted prompt text and verify before executing instructions.

## Retained inbox

For Claude Code/iTerm orchestrator sessions, prefer the retained inbox over the legacy mailbox.

Accepted bridge messages are appended to an owner-only retained event journal at `~/.pi/agent/ipc/bridge-events.jsonl`. Each reader has its own cursor in `~/.pi/agent/ipc/bridge-cursors.json`, so one consumer reading messages does not erase them for everyone else.

Claude Code hook usage:

```bash
pi-cc-bridge inbox --format hook --consume
```

- `pi-cc-bridge inbox` prints unread retained messages for the current Claude Code checkout.
- `--format hook` emits Claude hook JSON with `additionalContext`.
- `--consume` advances only the `pi-cc-bridge` reader cursor after output.
- Legacy `pi-cc-bridge mailbox` still works, but retained inbox is the safer path for cross-vendor delivery.

Claude Code hook snippet:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.pi/agent/bin/pi-cc-bridge inbox --format hook --consume || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

## Session state

Agents can self-report orchestrator-friendly state with the Pi tool:

```txt
update_session_status({ "status": "working", "currentTask": "implement auth tests", "dispatchId": "dispatch-123" })
```

Status values are `idle`, `working`, `blocked`, `review`, `done`, and `unknown`. The bridge also records session heartbeat metadata so orchestrators can see whether a target process is alive/recent.

CLI state commands:

```bash
pimsg list --with-status
pimsg state <target>
pimsg state --all
pi-cc-bridge state <target>
pi-cc-bridge state --all
```

State reports include PID, cwd, visibility, heartbeat age, self-reported status/task/blocker, and git branch/dirty/head summary when the session cwd is a git repo. This is a coordination aid, not proof that tests passed; verify claims against repo state before risky changes.

## Local shim diagnostics

If `pimsg` on PATH comes from `~/.pi/agent/bin`, it can lag the installed npm package. Check and repair explicitly:

```bash
pimsg doctor
pimsg doctor --sync-shims
```

`--sync-shims` copies the installed package's `pimsg`, `pi-cc-bridge`, `piroom`, and `pi-bridge-core.js` into `~/.pi/agent`. It is never run automatically.

## Install

From Pi:

```bash
pi install npm:@neuralpartners/pi-yo
```

For local development of the Pi extension only, run temporarily:

```bash
pi -e ./packages/pi-yo/extensions/pi-bridge.ts
```

For local development of the package CLI bins (`pimsg`, `pi-cc-bridge`, `piroom`), install the package path:

```bash
npm install -g /absolute/path/to/np-tooling/packages/pi-yo
pimsg doctor --sync-shims
```

## Configuration

Roster config lives outside the package:

```txt
~/.pi/agent/bridge-roster.json
```

Public package defaults intentionally ship with no personal project aliases. Add local aliases in your own config.

## Pi slash command controls

Human-facing Pi slash commands include an in-screen footer with the controls and next-step hint.

Default controls:

- `Esc`: close the current Pi notice/view.
- `Ctrl+C`: exit Pi.

Mailbox behavior:

- `/bridge-mailbox` reads and clears the Pi session mailbox when the notice opens.
- Copy anything you need before closing the mailbox notice.
- If the mailbox is empty, the notice still shows the same close controls so the screen is not a guessing game.

## CLI

```bash
pimsg list
pimsg list --all
pimsg list --with-status
pimsg state <target>
pimsg state --all
pimsg <target> "message"
pimsg --reply <target> "reply"
pimsg doctor --fix
pimsg doctor --sync-shims

piroom join np-tooling --name principal
piroom post np-tooling "@worker please review"
piroom manager np-tooling

pi-cc-bridge start
pi-cc-bridge inbox
pi-cc-bridge inbox --format hook --consume
pi-cc-bridge state <target>
pi-cc-bridge state --all
pi-cc-bridge mailbox
pi-cc-bridge stop
```

`pi-cc-bridge mailbox` prints mailbox contents and exits automatically; there is no interactive view to close.

## Verification

```bash
npm run verify
```
