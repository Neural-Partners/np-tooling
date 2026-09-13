#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const core = require("../lib/pi-bridge-core.js");
const bridge = path.resolve(__dirname, "..", "bin", "pi-cc-bridge");

const temporaryPaths = [];
test.after(() => { for (const dir of temporaryPaths) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join("/tmp", prefix));
  temporaryPaths.push(dir);
  return dir;
}
function tempHome() { return tempDir("yc-"); }

function runBridge(home, cwd, args) {
  return spawnSync(process.execPath, [bridge, ...args], {
    cwd,
    env: { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), PATH: process.env.PATH, TMPDIR: os.tmpdir() },
    timeout: 5000,
    encoding: "utf-8",
  });
}

function ccReaderKey(cwd) {
  const realCwd = fs.realpathSync(cwd);
  return core.sessionReaderKey({ name: `${path.basename(realCwd)} (CC)`, cwd: realCwd });
}

function ccMailboxFile(home, cwd) {
  const hash = crypto.createHash("sha256").update(fs.realpathSync(cwd)).digest("hex").slice(0, 8);
  return path.join(core.buildPaths(home).ipcDir, `cc-${hash}.mailbox`);
}

async function startBridge(t, home, cwd) {
  const started = runBridge(home, cwd, ["start"]);
  assert.equal(started.status, 0, started.stderr);
  t.after(async () => {
    const pid = core.readRegistry(core.buildPaths(home).registryFile).sessions.find(entry => entry.cwd === fs.realpathSync(cwd))?.pid;
    runBridge(home, cwd, ["stop"]);
    for (let attempt = 0; pid && core.isProcessAlive(pid) && attempt < 100; attempt++) await delay(20);
    if (pid && core.isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      assert.fail(`test daemon ${pid} did not stop`);
    }
  });

  const session = core.readRegistry(core.buildPaths(home).registryFile).sessions.find(entry => entry.cwd === fs.realpathSync(cwd) && entry.lifecycle === "adopted");
  assert.ok(session, "start success must mean adopted registry membership immediately");
  assert.ok(fs.existsSync(session.socketPath));
  return session;
}

test("pi-cc-bridge inbox reads retained events and consume advances only its cursor", () => {
  const home = tempHome();
  const cwd = tempDir("cc-cwd-");
  const paths = core.buildPaths(home);
  const readerKey = ccReaderKey(cwd);

  core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_1",
    from: { pid: 111, name: "agent", cwd: "/repo/agent" },
    to: { pid: 222, name: `${path.basename(cwd)} (CC)`, cwd, readerKey },
    content: "first retained message",
    acceptedAt: 1000,
  }, { eventsFile: paths.eventsFile });

  const first = runBridge(home, cwd, ["inbox", "--consume"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /first retained message/);
  assert.match(first.stdout, /Message-ID: msg_1/);

  const second = runBridge(home, cwd, ["inbox"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /\(no new messages\)/);

  const all = runBridge(home, cwd, ["inbox", "--all"]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /first retained message/);
});

test("pi-cc-bridge inbox hook format emits valid Claude hook JSON", () => {
  const home = tempHome();
  const cwd = tempDir("cc-cwd-");
  const paths = core.buildPaths(home);
  const readerKey = ccReaderKey(cwd);

  core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_hook",
    from: { pid: 111, name: "agent", cwd: "/repo/agent" },
    to: { pid: 222, name: `${path.basename(cwd)} (CC)`, cwd, readerKey },
    content: "hook message",
    acceptedAt: 1000,
  }, { eventsFile: paths.eventsFile });

  const result = runBridge(home, cwd, ["inbox", "--format", "hook", "--consume"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /hook message/);

  const empty = runBridge(home, cwd, ["inbox", "--format", "hook", "--consume"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "");
});

test("pi-cc-bridge state reports target state", () => {
  const home = tempHome();
  const cwd = tempDir("cc-cwd-");
  const paths = core.buildPaths(home);
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "agent", cwd, socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: Date.now(), readerKey: `pi:${process.pid}` },
  ] }, paths.registryFile);
  core.updateSessionStatus({
    pid: process.pid,
    name: "agent",
    cwd,
    status: "blocked",
    blockedOn: "waiting on deploy",
  }, { stateFile: paths.stateFile });

  const result = runBridge(home, cwd, ["state", "agent"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: blocked/);
  assert.match(result.stdout, /blockedOn: waiting on deploy/);
});

test("pi-cc-bridge ACKs duplicate retries without replaying raw mailbox content", async (t) => {
  const home = tempHome();
  const cwd = tempDir("cc-cwd-");
  const session = await startBridge(t, home, cwd);
  const message = {
    id: "msg_duplicate_retry",
    type: "message",
    fromPid: 12345,
    fromName: "agent",
    fromCwd: "/repo/agent",
    content: "duplicate raw body",
    timestamp: Date.now(),
    isReply: false,
  };

  const first = await core.sendToSocket(session.socketPath, message, { requireAck: true });
  const second = await core.sendToSocket(session.socketPath, message, { requireAck: true });
  assert.equal(first.response.duplicate, false);
  assert.equal(second.response.duplicate, true);

  const mailbox = runBridge(home, cwd, ["mailbox"]);
  assert.equal(mailbox.status, 0, mailbox.stderr);
  assert.equal((mailbox.stdout.match(/duplicate raw body/g) || []).length, 1);
  assert.match(mailbox.stdout, /\[duplicate\] msg_duplicate_retry/);
});

test("pi-cc-bridge direct mailbox delivery survives retained journal failures", async (t) => {
  const home = tempHome();
  const cwd = tempDir("cc-cwd-");
  const paths = core.buildPaths(home);
  core.ensureIpcDir(paths.ipcDir);
  const symlinkTarget = path.join(home, "events-target.jsonl");
  fs.writeFileSync(symlinkTarget, "");
  fs.symlinkSync(symlinkTarget, paths.eventsFile);
  const session = await startBridge(t, home, cwd);

  const receipt = await core.sendToSocket(session.socketPath, {
    id: "msg_journal_failure",
    type: "message",
    fromPid: 12345,
    fromName: "agent",
    fromCwd: "/repo/agent",
    content: "deliver despite journal failure",
    timestamp: Date.now(),
    isReply: false,
  }, { requireAck: true, ackTimeoutMs: 250 });

  assert.equal(receipt.acked, true);
  assert.equal(receipt.response.journalRecorded, false);
  assert.match(receipt.response.warning, /journal/i);

  const mailbox = fs.readFileSync(ccMailboxFile(home, cwd), "utf-8");
  assert.match(mailbox, /deliver despite journal failure/);
});

test("CC streaming UTF-8 and terminal-safe review preserve stored content", async (t) => {
  const net = require("node:net");
  const home = tempHome(), cwd = tempDir("cc-cwd-");
  const session = await startBridge(t, home, cwd);
  const content = "é中😀\nnormal\ttab\x1b]52;c;bad\x07\x9b2J";
  for (let split = 1; split < Buffer.byteLength("é中😀"); split++) {
    const frame = Buffer.from(JSON.stringify({ id: `split-${split}`, type: "message", fromPid: 123, fromName: "sender", fromCwd: cwd, content, timestamp: Date.now() }) + "\n");
    const start = frame.indexOf(Buffer.from("é中😀"));
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(session.socketPath);
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("ACK timeout")); });
      socket.on("error", reject);
      socket.once("data", () => { socket.destroy(); resolve(); });
      socket.on("connect", () => {
        socket.write(frame.subarray(0, start + split));
        setTimeout(() => socket.write(frame.subarray(start + split)), 10);
      });
    });
  }
  const events = core.readBridgeEvents({ eventsFile: core.buildPaths(home).eventsFile });
  assert.equal(events.length, 8);
  assert.ok(events.every(event => event.content === content));
  for (const command of ["inbox", "mailbox"]) {
    const output = runBridge(home, cwd, [command]);
    assert.equal(output.status, 0, output.stderr);
    assert.doesNotMatch(output.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    assert.match(output.stdout, /é中😀\nnormal\ttab/);
  }
});

test("CC failed mailbox delivery stays retryable and recipient dedupe is scoped", async (t) => {
  const home = tempHome(), cwd = tempDir("cc-cwd-");
  const otherCwd = tempDir("cc-other-");
  const a = await startBridge(t, home, cwd), b = await startBridge(t, home, otherCwd);
  const message = { id: "retry-after-repair", type: "message", fromPid: 123, fromName: "sender", fromCwd: cwd, content: "must arrive", timestamp: Date.now() };
  const file = ccMailboxFile(home, cwd);
  fs.mkdirSync(file);
  await assert.rejects(core.sendToSocket(a.socketPath, message, { requireAck: true, ackTimeoutMs: 100 }), /ACK/);
  assert.equal(core.readBridgeEvents({ eventsFile: core.buildPaths(home).eventsFile }).length, 0);
  fs.rmdirSync(file);
  for (const receiver of [a, b]) {
    assert.equal((await core.sendToSocket(receiver.socketPath, message, { requireAck: true })).response.duplicate, false);
    assert.equal((await core.sendToSocket(receiver.socketPath, message, { requireAck: true })).response.duplicate, true);
  }
  assert.match(fs.readFileSync(file, "utf8"), /must arrive/);
  assert.match(fs.readFileSync(ccMailboxFile(home, otherCwd), "utf8"), /must arrive/);
});

test("CC mailbox overflow negatively ACKs both send modes, drain/retry and full duplicate notices", async t => {
  const home = tempHome(), cwd = tempDir("cc-cwd-");
  const session = await startBridge(t, home, cwd);
  const file = ccMailboxFile(home, cwd), paths = core.buildPaths(home);
  const message = { id: "overflow-retry", type: "message", fromPid: 123, fromName: "sender", fromCwd: cwd, content: "retry-body", timestamp: Date.now() };
  core.appendMailbox(file, "x".repeat(core.MAILBOX_MAX_BYTES));
  for (const requireAck of [false, true]) await assert.rejects(core.sendToSocket(session.socketPath, message, { requireAck }), /Negative ACK.*full/);
  assert.equal(core.readBridgeEvents({ eventsFile: paths.eventsFile }).length, 0);
  assert.equal(fs.statSync(file).size, core.MAILBOX_MAX_BYTES);
  assert.match(runBridge(home, cwd, ["status"]).stdout, /overflow/);
  await core.consumeMailbox(file, content => assert.equal(content.length, core.MAILBOX_MAX_BYTES));
  assert.equal((await core.sendToSocket(session.socketPath, message, { requireAck: true })).response.duplicate, false);
  core.appendMailbox(file, "x".repeat(core.MAILBOX_MAX_BYTES - fs.statSync(file).size));
  const duplicate = await core.sendToSocket(session.socketPath, message, { requireAck: true });
  assert.equal(duplicate.response.duplicate, true); assert.equal(duplicate.response.noticeOmitted, true); assert.match(duplicate.response.warning, /omitted/);
  assert.equal((fs.readFileSync(file, "utf8").match(/retry-body/g) || []).length, 1);
  assert.match(core.mailboxOverflowStatus(file), /notice omitted/);
});

test("CC actual receiver enforces socket count, idle/absolute lifetime and nonreading peer limits", { timeout: 22000 }, async t => {
  const home = tempHome(), cwd = tempDir("cc-cwd-");
  const session = await startBridge(t, home, cwd);
  await require("./fixtures/socket-limits.cjs")(session.socketPath, frames => {
    const accepted = core.readBridgeEvents({ eventsFile: core.buildPaths(home).eventsFile }).filter(event => event.kind === "message.accepted");
    assert.deepEqual(accepted.map(event => event.messageId), frames.map(frame => frame.id));
    const content = fs.readFileSync(ccMailboxFile(home, cwd), "utf8");
    for (const frame of frames) assert.ok(content.includes(frame.content + "\n"), frame.id);
  });
});
