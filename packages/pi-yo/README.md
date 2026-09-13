# pi-yo

Trusted-local inter-session messaging for Pi agents.

Source repository: <https://github.com/Neural-Partners/np-tooling/tree/main/packages/pi-yo>

> **Release hold:** npm `latest` is **0.3.0**. Published **0.4.0 is deprecated**: “Room prototype is temporarily held back; use @neuralpartners/pi-yo@0.3.0 until the 0.4.x room release is re-cut.” This working tree is an **unreleased hardening pass, not release-ready**. Room examples below describe source-only/held-back functionality, not latest. The original deprecation cause is not established; passing QA does not authorize a release.

### Source compatibility (deliberate change)

This source targets **Node >=22.19.0** and **@earendil-works/pi-coding-agent 0.85.1 only**. Legacy `@mariozechner/pi-coding-agent` support is no longer declared; no broader host-version compatibility is claimed. The exact host peer is optional so standalone CLI installation does not automatically install Pi. The extension still requires the supported host. Development pins that host for types and offline integration checks. Published 0.3.0 has its own older dependency/support metadata; these fixes are not present there.

### Required quiesced upgrade (lock/CC ownership format changed)

**Stop every old CC bridge daemon and every Pi instance that loaded the old core before upgrading.** Upgrade the package, synchronize local shims (`pimsg doctor --sync-shims`), then restart those processes. Do not run mixed old/new writers or downgrade against the new IPC tree.

New `${resource}.lock` paths are **persistent directories**, not disposable lock files. A legacy regular `.lock` file—even empty or old—or a symlink/non-directory is refused with recovery instructions. Legacy `cc-<cwd-hash>.pid`, `.json`, and shared `.sock` daemon files are also refused, never automatically deleted or used to signal a PID. Manual legacy recovery requires independently confirming **all old writers are quiesced**; never delete locks or daemon files while clients run. Persistent directories exclude old `open("wx")` lock writers and must not be removed during normal operation.

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

`mailbox-only` policy holds inbound Pi messages and retained Claude Code hook originals for manual review instead of automatic model context.

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
- persistent lock roots, unique ownership claims, ticket directories: `0700`
- registry, sockets, mailboxes, generation metadata/log files: `0600` where the platform allows it

### Crash recovery and daemon readiness

All existing synchronous mutations use process-owned bakery claims under persistent lock roots. The unique claim directory atomically publishes a positive PID before metadata or an immutable BigInt ticket exists; a missing ticket means **choosing**, not unowned. After ticket publication, a fresh contender scan waits for choosing owners and lower `(ticket, bytewise claim ID)` pairs. Claim IDs combine PID, random 128-bit process incarnation and monotonic counter. Reentrancy on the same resource is rejected; nested different-resource locks retain their existing ordering.

Only a PID probe returning **ESRCH** permits reclamation of that never-reused unique claim. Live, reused, EPERM or unknown PIDs are never evicted by age. Concurrent reclaimers cannot address a successor's claim; shared roots are never removed. Acquisition uses monotonic deadlines and bounded layout enumeration (1024 claims, two allowed entries per claim, 128-digit tickets); malformed/oversized layouts fail closed. A dead CC claim also allows removal of its uniquely derived socket, but never a regular file or symlink at that pathname. Interrupted metadata does not prevent dead-owner recovery.

The CC daemon holds one lifetime claim per cwd hash through startup, serving and cleanup. It compares full cwd values to reject hash collisions and publishes generation metadata inside its claim, not shared PID files. Discovery and stop verify a versioned generation-bound endpoint; PID/command metadata is diagnostic only, **never stop authority**. Endpoints are short `cg-<24 hex>.sock` names; Pi `<pid>.sock` compatibility is retained. Full encoded Unix socket paths are limited to **103 bytes** for Linux/macOS portability. An overly long HOME path is explicitly rejected, never truncated or redirected elsewhere.

`pi-cc-bridge start` succeeds only after listening, registry and state initialization, parent verification of the generation response/registry, and a private-IPC adoption/ack handshake. Messages are not delivered before adoption. Concurrent launchers either verify an adopted incumbent or fail nonzero; a losing launcher withdraws rather than becoming an unsolicited replacement later. The first observed preceding live claim (including choosing, before metadata) binds duplicate intent across parent/child startup; disappearance or later stopping requires an explicit retry, never silent replacement. Before adoption, launcher disconnect, startup failure or a three-second monotonic deadline cancels the child. A paused child can leave **cancellation pending**, retaining its claim until it resumes and cancels before serving. Normal parent disconnect after adoption leaves the daemon running.

Stop addresses a specific generation, never `kill(pid)`. Cleanup disables delivery/heartbeats, publishes generation-qualified `stopping`, closes/drains connections with a bounded policy, removes generation-matched registry membership and its own endpoint/metadata, and releases lifetime ownership **last**. A start whose first observation verifies `stopping` may queue an explicit restart: matching live claim, generation metadata and registry cwd/socket identify this trusted-local state even after endpoint closure. This is not adversarial authentication. Missing/mismatched state or failed stopping publication requires retry. `Stopped` means generation membership/claim removal was observed; a timeout reports `stopping`/`cancellation pending`, not completed shutdown. Unknown or unreachable state never triggers destructive PID/file fallback.

**Limits:** trusted same-user processes, a local filesystem with completed directory operations visible to fresh enumeration, and a shared PID namespace are required. NFS/distributed locks, restored/live-shared IPC trees and foreign PID namespaces are unsupported. Random claim identity and truncated socket-hash collisions remain negligible probabilistic limits. A reused PID or permanently hung live owner can block recovery indefinitely; safety wins over availability. Locks do not make interrupted journal/data writes transactional. There is an unavoidable adoption/ack/terminal-output crash window: verified readiness and cancellation before adoption are promised, not exactly-once CLI output or atomic output/daemon-survival guarantees.

## Bridge policy

Policy lives outside the package:

```txt
~/.pi/agent/bridge-policy.json
```

Delivery policy applies to the Pi receiver and the opt-in Claude Code retained-inbox hook. CC socket reception still appends to its mailbox; policy controls automatic hook context, not unrestricted manual inspection. Hook decisions use the original recorded sender fields.

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

Quota is per declared sender PID in a fixed 10-second processing-time window (default five admitted checks). Policy-held originals count when the rate check admits them; pings and transport duplicate receipts do not. Denied attempts neither increase counters nor extend windows. Lowering a limit preserves usage and applies immediately; raising it exposes only the additional allowance. At most 1024 live PID buckets exist per receiver/reader; expired buckets are removed, never live-evicted to admit new keys. Clock rollback denies until the prior window resumes/expires. Pi counters are session-local and reset on restart; hook counters persist with the scan watermark. Historical acceptance timestamps do not bypass hook quotas.

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

Bridge and room journals retain the current segment plus three backups, rotating at approximately 1 MiB per segment. Reads and deduplication include those retained segments in append order (not sender timestamp order). Older events, including unread ones, can expire. An expired inbox cursor warns and recovers from retained beginning rather than silently skipping history; some records may replay. Manual text `--consume` acknowledges the returned set; hooks recover in bounded batches.

Deduplication is recipient-scoped and only records acceptance after synchronous local mailbox/queue delivery succeeds. A failed local delivery remains retryable; a journal failure can still ACK direct delivery with a retention warning. A crash between delivery and journal recording, failed recording, or retention expiry can replay a message. This is **not exactly-once or durable task completion**. File replacement is atomic against interrupted writes, not a promise of power-loss durability. Legacy accepted records remain readable; historical records made before a failed delivery cannot retroactively be identified.

**Optional policy-controlled Claude Code hook usage:**

```bash
pi-cc-bridge inbox --format hook --consume
```

- `pi-cc-bridge inbox` prints manually unread retained records, including duplicate receipts.
- Text `--consume` suppresses subsequent hook delivery through the manual watermark.
- Hook `--consume` commits a **separate scan watermark**, never the manual cursor. For allowed A → blocked B → allowed C, the hook emits A/C; manual inbox retains A/B/C until explicit manual consumption. Scanned policy/rate-held originals remain manual-only even after policy repair.
- Only valid `message.accepted` originals can become automatic context. Duplicate receipts/unknown shapes never inject or spend quota.
- `--format hook` without `--consume` starts after the later valid manual/hook watermark and may re-render originals; each actual output attempt spends persisted quota, but neither watermark moves. A non-consuming held decision is not a permanent scan acknowledgement.
- Hook batches examine at most **64 addressed records**, emit at most **64 originals**, and serialize at most **64 KiB including JSON escaping, wrappers and final newline**. The next eligible record that exceeds the remaining budget stays pending, uncharged. An otherwise policy-eligible original too large alone is never truncated, emitted, charged, or consumed, even when quota is exhausted: stderr names it and requests manual text inspection/consumption to unblock. Policy-blocked originals retain ordinary held-record scan semantics.
- First use explicitly migrates a validated manual/legacy cursor; no cursor starts at retained beginning. Expired anchors warn. Older positive timestamp-only/empty-ID cursors cannot safely migrate across append-order inversions: hooks/consuming reads refuse them without changing bytes. Read-only text `inbox --all` still works despite unsupported/malformed cursor or hook state; inspect it, independently quiesce readers, then perform explicit cursor recovery. Empty-ID/zero-time state starts oldest retained. Malformed/oversized committed cursor/rate state fails closed with stderr. Earlier shared hook/human acknowledgements cannot be retrospectively separated; `inbox --all` remains manual inspection. `--all --format hook` is rejected.
- Same-reader hooks and consuming text reads acquire crash-safe reader ownership asynchronously (2-second acquisition bound). Lock order is reader → cursor file → journal snapshot. Journal ownership is released before output. A 2-second output handoff bound includes backpressure/errors; errors/timeouts leave cursors and quota uncommitted. After awaited transaction cleanup, the CC inbox/mailbox CLI exits nonzero on output failure rather than letting a pending Node stdio write keep it alive. Already-written partial output may replay. Successful held-only batches can commit silently.
- Hook state is versioned `bridge-hook-<SHA256 reader>.json` (at most 128 KiB), with one bounded `.next` stage under reader ownership. Overflow markers similarly have one at-most-1-KiB stage. Stages are never loaded/promoted as committed state; interrupted stages can only be overwritten under the same ownership. Atomic rename prevents partial committed replacements, not power-loss/fsync loss.
- This is serialized **at-least-once crash replay**, not exactly-once delivery. Output success is not Claude ingestion/model execution. Death after output but before persistence, or a visible commit error, may replay and repeat quota exposure.

Claude Code hook snippet (opt-in; nothing installs hooks or edits settings automatically):

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

`--sync-shims` copies the installed package's `pimsg`, `pi-cc-bridge`, `piroom`, `pi-bridge-core.js`, and `bridge-cli-options.js` into `~/.pi/agent`. It is never run automatically.

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

Human-facing slash commands use nonmodal Pi notifications with next-step hints, not custom closable views. They do not override keyboard behavior or advertise terminal keys in RPC mode. `/bridge-mailbox` requires TUI/RPC notifications and clears only after local notification handoff; headless/no-UI calls retain content. Notifications are fire-and-forget, not proof of viewing or RPC client ingestion. Raw journal/mailbox payloads remain distinct from human-display text and the Pi injection representation, which escape active C0/C1 terminal controls while preserving ordinary Unicode, newlines and tabs. Physical TUI rendering has not been independently tested.

## Mailbox and socket resource limits

Mailboxes reject whole new entries beyond **1 MiB**; existing unread bytes are never rotated/discarded. A rejected new delivery produces a matched negative ACK (`ok:false`) and no acceptance/dedupe record. Upgraded senders fail even without `requireAck`; genuinely missing legacy ACKs retain compatibility. **Upgrade senders and receivers together:** old clients ignore `ok` and may misreport rejection as success. A bounded persistent overflow marker remains visible in CC status/mailbox and Pi mailbox review, with sender retry-after-manual-drain guidance. Already-accepted retries still ACK duplicates; an optional duplicate notice that cannot fit is omitted with receipt/marker warning, never raw replay.

Mailbox consumers serialize with their own ownership (2-second wait). Under the short append lock they replay one fixed `.reading` recovery before detaching another active mailbox; concurrent delivery can append to the new active file. Successful local output handoff deletes recovery; failure/crash preserves it and reports its path. Normal envelope: **1 MiB active + 1 MiB recovery + 1 KiB overflow marker + 1 KiB marker stage**, plus bounded ownership metadata. Repeated crashes never create additional random recovery copies. A marker clears only after successful drain leaves no active/recovery payload and no newer rejection raced the handoff. A random 128-bit rejection generation distinguishes same-time saturated counters (negligible, not impossible, collision risk). Legacy random recovery files or oversized active/recovery files are preserved, reported for manual recovery, and block growth.

Both receivers enforce **32 accepted sockets**, **2-second idle timeout**, **5-second absolute lifetime** (not reset by trickle/pings/output). Each wire frame remains at most **64 KiB excluding newline**; queued input is at most **2 × (64 KiB + newline)** to accommodate a partial frame plus the next Node chunk, and queued output is at most **64 KiB + newline**. Backpressure pauses reads/frame dispatch; processing yields every 16 frames and checks the monotonic deadline before another delivery. Readable EOF preserves the writable half until bounded complete frames/responses drain, then closes it; an incomplete non-newline-terminated tail is discarded without delivery. Shutdown destroys tracked sockets. These are trusted-local bounds, not hard real-time guarantees against blocked filesystem calls or malicious same-UID peers.

## Strict CLI options

`piroom` and CC commands reject unknown/duplicate flags (including booleans), missing/blank values, invalid enums, unexpected positionals, and numeric junk before registry pruning, state creation/consumption, daemonization, or terminal setup. Manager intervals must be whole integers from 251 to 2147483647 ms. Existing omitted defaults remain. Post options can surround ordinary text; hyphen-leading literal messages require the delimiter, after which option parsing never resumes:

```sh
piroom post project --name worker -- "- first point" "--literal-text" "--urgent" "-123"
```

## Remaining release gates and limitations

- Ownership/startup, hook policy/cursor separation, mailbox/socket/limiter bounds, and strict CLI parsing are implemented in this working tree, pending independent review and the full supported CI matrix. The release hold remains.
- Ownership recovery depends on local filesystem/same PID namespace assumptions described above; live/reused/unknown PIDs fail closed, never age-evicted. Ordinary process crashes are recoverable, not guaranteed power-loss durability.
- Hook unread history can expire with finite journal retention; successful output and Pi notifications are not evidence of model ingestion or task execution.
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
