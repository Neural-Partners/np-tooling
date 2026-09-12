# pi-yo

Trusted-local inter-session messaging for Pi agents.

Source repository: <https://github.com/Neural-Partners/np-tooling/tree/main/packages/pi-yo>

> **Release hold:** npm `latest` is **0.3.0**. Published **0.4.0 is deprecated**: “Room prototype is temporarily held back; use @neuralpartners/pi-yo@0.3.0 until the 0.4.x room release is re-cut.” This working tree is an **unreleased hardening pass, not release-ready**. Room examples below describe source-only/held-back functionality, not latest. The original deprecation cause is not established; passing QA does not authorize a release.

### Source compatibility (deliberate change)

This source targets **Node >=22.19.0** and **@earendil-works/pi-coding-agent 0.85.1 only**. Legacy `@mariozechner/pi-coding-agent` support is no longer declared; no broader host-version compatibility is claimed. The exact host peer is optional so standalone CLI installation does not automatically install Pi. The extension still requires the supported host. Development pins that host for types and offline integration checks. Published 0.3.0 has its own older dependency/support metadata; these fixes are not present there.

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

`mailbox-only` policy holds inbound **Pi** messages for manual review instead of injecting them directly into model context. It does not gate the optional Claude Code hook (see policy scope below).

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

**Scope warning:** delivery policy is enforced by the Pi receiver, **not** by `pi-cc-bridge inbox --format hook --consume`. The optional CC hook currently injects all unread retained events regardless of mailbox-only/allowlist. Do not enable that hook when you require automatic context restrictions; use manual `pi-cc-bridge inbox` inspection instead. Selective hook consumption is deferred because a single advancing cursor cannot safely skip mixed held/allowed records without losing held messages.

A genuinely missing first-install policy retains compatible auto-inject defaults. An existing invalid/unreadable policy (including invalid or blank allowlist restrictions) fails closed to **mailbox-only**, with a diagnostic in the hold notice/reason. Repair the file to restore the configured mode; it is re-read on delivery. Valid empty `allowlist: []` intentionally remains allow-all. PID/name/cwd are self-reported coordination selectors, not authenticated identities. Rate limits are per declared sender PID; short-lived CLI processes do not share a stable sender bucket.

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

Room state is local and owner-only under `~/.pi/agent/ipc/room-state.json` and `~/.pi/agent/ipc/room-events.jsonl`. The prototype is same-user/same-machine only; there is no network transport.

### Source checkout vs installed package

`piroom` was introduced in the held-back 0.4.0 and exists in source; do not install deprecated 0.4.0 for this feature. npm latest may lag main: 0.3.0 does not include rooms. Check first:

```bash
npm view @neuralpartners/pi-yo version
node -p 'require("./packages/pi-yo/package.json").version'
```

If the source checkout is newer than npm, test from the source checkout or install the local package path. Do not expect commands from the primary repo checkout to work if that checkout is behind `origin/main` and does not contain `packages/pi-yo/bin/piroom`.

Safe source QA (no global install, no real Pi configuration):

```bash
cd /absolute/path/to/np-tooling
QA_HOME=$(mktemp -d)
env -i HOME="$QA_HOME" PATH="$PATH" npm_config_cache="$QA_HOME/cache" npm ci --ignore-scripts
env -i HOME="$QA_HOME" PATH="$PATH" npm run verify
npm run smoke:rooms --workspace @neuralpartners/pi-yo
npm run smoke:pi --workspace @neuralpartners/pi-yo
npm run check:pack --workspace @neuralpartners/pi-yo
rm -rf "$QA_HOME"
```

The smoke/pack scripts create their own disposable HOME and cwd, use credential-free child environments, and clean up test children and files. `check:pack` packs the source, checks bins/resources, installs into a temporary local prefix with lifecycle scripts disabled, audits that CLI-only install, and loads the **shipped package** in offline Pi RPC. It never publishes or installs globally. The room-only smoke checks CLI/state rendering; the RPC check also proves mailbox delivery and package resource loading, without a model request. Physical TUI, macOS focus, and Claude Code host-hook integration remain manual gates.

Global installation and `pimsg doctor --sync-shims` are human operational choices, **not QA prerequisites**. The latter writes copies into real `~/.pi/agent` and must not be run by isolated tests.

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

For `--kind pi|cc`, start the receiver first: CLI join requires exactly one live registered receiver with the exact `--name` in the current cwd and records its actual session identity. Missing or ambiguous receivers are rejected; kind labels do not authenticate the host. Explicitly join again after a receiver restart. CLI posts preserve an existing member's identity and kind rather than replacing them with the short-lived CLI process. A first post creates a human member associated with its CLI process, not an implicit binding to a same-name agent; use an explicit agent join to receive alerts.

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

DND suppresses non-urgent alerts for that member. Offline or sleeping sessions cannot be woken by local IPC; room events remain reviewable only within finite journal retention. Alerts require consistent recorded session identity (including start time when recorded); a recycled PID or unrelated same-cwd session is not rebound automatically. Rejoin after restarting a session. Pi room aliases are retained for subsequent post/follow/DND commands; the alias is distinct from the actual session name. Reserved prototype identifiers such as `__proto__`, `constructor`, and `toString` are rejected. Existing malformed room state must be repaired before mutations; it is not silently replaced with an empty roster.

Do not send secrets, tokens, credentials, private keys, customer PII, or sensitive production data through local chatrooms. Treat room messages as untrusted prompt text and verify before executing instructions.

## Retained inbox

For Claude Code/iTerm orchestrator sessions, prefer the retained inbox over the legacy mailbox.

Accepted bridge messages are appended to an owner-only retained event journal at `~/.pi/agent/ipc/bridge-events.jsonl`. Each reader has its own cursor in `~/.pi/agent/ipc/bridge-cursors.json`, so one consumer reading messages does not erase them for everyone else.

Bridge and room journals retain the current segment plus three backups, rotating at approximately 1 MiB per segment. Reads and deduplication include those retained segments in append order (not sender timestamp order). Older events, including unread ones, can expire. An expired inbox cursor warns and returns all remaining retained records rather than silently skipping them; some may be re-read. `--consume` acknowledges that returned set.

Deduplication is recipient-scoped and only records acceptance after synchronous local mailbox/queue delivery succeeds. A failed local delivery remains retryable; a journal failure can still ACK direct delivery with a retention warning. A crash between delivery and journal recording, failed recording, or retention expiry can replay a message. This is **not exactly-once or durable task completion**. File replacement is atomic against interrupted writes, not a promise of power-loss durability. Legacy accepted records remain readable; historical records made before a failed delivery cannot retroactively be identified.

**Optional unrestricted Claude Code hook usage** (see the Pi-only policy scope warning above):

```bash
pi-cc-bridge inbox --format hook --consume
```

- `pi-cc-bridge inbox` prints unread retained messages for the current Claude Code checkout.
- `--format hook` emits Claude hook JSON with `additionalContext`.
- `--consume` advances only the `pi-cc-bridge` reader cursor after output.
- Legacy `pi-cc-bridge mailbox` still works, but retained inbox is the safer path for cross-vendor delivery.

Claude Code hook snippet (opt-in; not mailbox-only/allowlist enforcement):

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
pi install npm:@neuralpartners/pi-yo@0.3.0
```

For local development of the Pi extension only, run temporarily:

```bash
pi -e ./packages/pi-yo/extensions/pi-bridge.ts
```

For source CLI testing use `npm run check:pack --workspace @neuralpartners/pi-yo` above. Pi-managed resource installation does not guarantee package bins are on the shell PATH; a local npm prefix exposes them in `node_modules/.bin`. Choose operational PATH/shim installation explicitly.

## Configuration

Roster config lives outside the package:

```txt
~/.pi/agent/bridge-roster.json
```

Public package defaults intentionally ship with no personal project aliases. Add local aliases in your own config.

## Pi slash command controls

Human-facing slash commands use nonmodal Pi notifications with next-step hints, not custom closable views. They do not override keyboard behavior or advertise terminal keys in RPC mode. `/bridge-mailbox` reads and clears its mailbox; read failures preserve a recovery copy and report its path. Raw journal/mailbox payloads remain distinct from human-display text and the Pi injection representation, which escape active C0/C1 terminal controls while preserving ordinary Unicode, newlines and tabs. Physical TUI rendering has not been independently tested.

## Remaining release blockers and limitations

- Crashed file-lock owners can leave stale locks requiring manual recovery after verifying the owner is gone. Do not delete a live owner's lock.
- Concurrent `pi-cc-bridge start`/stop/restart still lacks startup ownership serialization; avoid overlapping operations. This is a release blocker, not a supported concurrency guarantee.
- CC hook policy filtering is deferred as explained above. Manual inspection remains unrestricted.
- Mailboxes and accepted idle connections are not yet retention/count/deadline bounded. PID rate buckets are not evicted. Do not treat frame limits as resource-isolation guarantees or silently discard unread messages.
- `piroom` CLI argument validation still has gaps for mistyped/missing options. Double-check identity/thread options before mutation.
- IPC root final-component symlinks are refused; doctor does not traverse or repair them. Policy/roster reads do not chmod through file symlinks. This is accidental filesystem-damage prevention, **not** complete ancestor/race-proof isolation against malicious same-UID code.
- Dependency audits are point-in-time checks. The current checkout and clean CLI-only tarball install audit clean after removing orphaned legacy lock entries; re-run `npm audit` for release triage. A clean standalone CLI audit alone does not establish the host dependency tree's status.

Keep npm latest at 0.3.0 and the 0.4.0 hold in place until owner review, remaining corrections, a new version, and explicit release authorization. No release operations are part of these QA scripts.

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
