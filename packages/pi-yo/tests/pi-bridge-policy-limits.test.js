"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const core = require("../lib/pi-bridge-core.js");
const cc = path.resolve(__dirname, "../bin/pi-cc-bridge");
const room = path.resolve(__dirname, "../bin/piroom");
function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync("/tmp/yl-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = core.buildPaths(home), readerKey = core.sessionReaderKey({ name: "test (CC)", cwd: home });
  const env = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PATH: process.env.PATH, TMPDIR: "/tmp" };
  const policyFile = path.join(home, ".pi/agent/bridge-policy.json");
  const stateFile = core.hookStateFile(readerKey, paths.cursorsFile);
  function run(args, bin = cc) { return spawnSync(process.execPath, [bin, ...args], { cwd: home, env, timeout: 6000, encoding: "utf8" }); }
  async function runAsync(args) { return promisify(execFile)(process.execPath, [cc, ...args], { cwd: home, env, timeout: 6000 }); }
  function add(content, pid = 11, extra = {}) { return core.appendBridgeEvent({ from: { pid, name: `sender${pid}`, cwd: "/sender" }, to: { readerKey }, content, ...extra }, { eventsFile: paths.eventsFile }); }
  function policy(value) { core.secureWriteFile(policyFile, typeof value === "string" ? value : JSON.stringify(value)); }
  function hook(consume = true) { const result = run(["inbox", "--format", "hook", ...(consume ? ["--consume"] : [])]); assert.equal(result.status, 0, result.stderr); return result; }
  return { home, paths, env, readerKey, policyFile, stateFile, run, runAsync, add, policy, hook };
}

test("hook mixed ordering, manual visibility, policy repair, duplicate receipts and recipient isolation", t => {
  const s = sandbox(t);
  s.policy({ allowlist: [{ pid: 11 }], rateLimit: { perSenderPer10s: 20 } });
  s.add("allowed-A"); s.add("blocked-B", 22); s.add("allowed-C");
  s.add("duplicate-body", 11, { kind: "message.duplicate" });
  s.add("unknown-body", 11, { kind: "future-event" });
  s.add("other-reader", 11, { to: { readerKey: "other" } });
  const first = s.hook();
  assert.match(first.stdout, /allowed-A/); assert.match(first.stdout, /allowed-C/);
  assert.doesNotMatch(first.stdout, /blocked-B|duplicate-body|unknown-body|other-reader/);
  const manual = s.run(["inbox"]);
  assert.match(manual.stdout, /allowed-A/); assert.match(manual.stdout, /blocked-B/); assert.match(manual.stdout, /allowed-C/); assert.match(manual.stdout, /duplicate/);
  assert.equal(s.hook().stdout, "");
  s.policy({ allowlist: [] });
  assert.equal(s.hook().stdout, "");
  s.add("newly-eligible", 22);
  assert.match(s.hook().stdout, /newly-eligible/);
  assert.match(s.run(["inbox", "--consume"]).stdout, /blocked-B/);
  assert.equal(s.hook().stdout, "");
  s.add("manual-first", 33);
  assert.equal(s.run(["inbox", "--consume"]).status, 0);
  assert.equal(s.hook().stdout, "");
});

for (const policy of ["{", "[]", "null", { mode: "mailbox-only" }, { allowlist: [{ name: " " }] }, { rateLimit: { perSenderPer10s: "5" } }]) test(`hook fail-closed policy ${JSON.stringify(policy)}`, t => {
  const s = sandbox(t); s.add("private-peer-body"); s.policy(policy);
  const first = s.hook(); assert.equal(first.stdout, "");
  if (policy.mode !== "mailbox-only") assert.match(first.stderr, /Invalid bridge policy/);
  assert.match(s.run(["inbox"]).stdout, /private-peer-body/);
  s.policy({ allowlist: [] }); assert.equal(s.hook().stdout, "");
  s.add("after-repair"); assert.match(s.hook().stdout, /after-repair/);
});

test("hook missing policy defaults, symlink/unreadable policy blocks, malformed state fails before output", t => {
  const s = sandbox(t); s.add("default-body"); assert.match(s.hook().stdout, /default-body/);
  fs.unlinkSync(s.policyFile); fs.symlinkSync(path.join(s.home, "absent"), s.policyFile);
  s.add("symlink-held"); assert.match(s.hook().stderr, /Invalid bridge policy/);
  fs.unlinkSync(s.policyFile); fs.mkdirSync(s.policyFile);
  s.add("unreadable-held"); assert.equal(s.hook().stdout, "");
  fs.rmdirSync(s.policyFile); s.policy({ allowlist: [] });
  for (const content of ["{", JSON.stringify({ version: 1, cursor: {}, rateBuckets: [] }), " ".repeat(128 * 1024 + 1), JSON.stringify({ version: 1, cursor: { eventId: "", acceptedAt: 0 }, rateBuckets: [["11", { count: -1, windowStart: 0 }]] })]) {
    fs.writeFileSync(s.stateFile, content);
    const result = s.run(["inbox", "--format", "hook", "--consume"]);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
  }
});

test("hook migration preserves manual cursor; expired anchors warn and recover append-order ties", t => {
  const s = sandbox(t); s.add("legacy-old", 11, { acceptedAt: 100 });
  const anchor = s.add("legacy-anchor", 11, { acceptedAt: 100 });
  s.add("legacy-new", 11, { acceptedAt: 100 });
  const cursors = { [s.readerKey]: { eventId: anchor.eventId, acceptedAt: 100 } };
  core.writeBridgeCursors(cursors, s.paths.cursorsFile);
  const first = s.hook(); assert.match(first.stderr, /Migrating/); assert.match(first.stdout, /legacy-new/); assert.doesNotMatch(first.stdout, /legacy-old|legacy-anchor/);
  assert.deepEqual(core.readBridgeCursors(s.paths.cursorsFile), cursors);
  const state = JSON.parse(fs.readFileSync(s.stateFile)); state.cursor.eventId = "expired"; fs.writeFileSync(s.stateFile, JSON.stringify(state));
  assert.match(s.hook().stderr, /expired/);
  fs.writeFileSync(s.paths.cursorsFile, "{");
  const bad = s.run(["inbox", "--format", "hook", "--consume"]); assert.notEqual(bad.status, 0); assert.equal(bad.stdout, "");
});

test("hook persistent processing-time quotas, nonconsume retries, and limit changes", t => {
  const s = sandbox(t); s.policy({ rateLimit: { perSenderPer10s: 2 } });
  s.add("repeat-body", 11, { acceptedAt: 1 });
  assert.match(s.hook(false).stdout, /repeat-body/); assert.match(s.hook(false).stdout, /repeat-body/);
  assert.equal(s.hook(false).stdout, "");
  assert.equal(JSON.parse(fs.readFileSync(s.stateFile)).cursor.eventId, "");
  s.policy({ rateLimit: { perSenderPer10s: 3 } }); assert.match(s.hook(false).stdout, /repeat-body/);
  s.policy({ rateLimit: { perSenderPer10s: 1 } }); assert.equal(s.hook().stdout, "");
  assert.match(s.run(["inbox"]).stdout, /repeat-body/);
  s.policy({ rateLimit: { perSenderPer10s: 100 } }); assert.equal(s.hook().stdout, "");
});

test("hook batches stop at scan count and byte budget, oversized boundary requires manual unblock", t => {
  const s = sandbox(t); s.policy({ rateLimit: { perSenderPer10s: 1000 } });
  for (let i = 0; i < 65; i++) s.add(`count-${i}-end`);
  const first = s.hook(); assert.equal((first.stdout.match(/count-/g) || []).length, 64); assert.doesNotMatch(first.stdout, /count-64-end/);
  assert.match(s.hook().stdout, /count-64-end/);
  s.add("é中😀\n".repeat(3200)); s.add("z".repeat(32000));
  const bytes = s.hook(); assert.ok(Buffer.byteLength(bytes.stdout) <= 65536);
  assert.ok(s.hook().stdout.length > 0);
  s.add("prefix-before-large"); s.add('"'.repeat(32768)); s.add("after-large");
  const large = s.hook(); assert.match(large.stdout, /prefix-before-large/); assert.match(large.stderr, /exceeds output budget/);
  const pending = s.hook(); assert.equal(pending.stdout, ""); assert.match(pending.stderr, /manual|text/);
  assert.equal(s.run(["inbox", "--consume"]).status, 0); assert.equal(s.hook().stdout, "");
});

for (const mode of ["exhausted-first", "exhausted-later", "nonconsume-first", "nonconsume-later", "prefix-exhausts"]) {
  test(`hook oversized boundary survives quota denial: ${mode}`, t => {
    const s = sandbox(t); s.policy({ rateLimit: { perSenderPer10s: 1 } });
    let prefix;
    if (mode.startsWith("nonconsume")) {
      prefix = s.add("earlier-nonconsuming-output");
      assert.match(s.hook(false).stdout, /earlier-nonconsuming-output/);
      if (mode.endsWith("first")) assert.equal(s.run(["inbox", "--consume"]).status, 0);
    } else if (mode.startsWith("exhausted")) {
      core.secureWriteFile(s.stateFile, JSON.stringify({ version: 1, cursor: { eventId: "", acceptedAt: 0 }, rateBuckets: [["11", { count: 1, windowStart: Date.now() }]] }));
    }
    if (mode === "exhausted-later" || mode === "prefix-exhausts") prefix = s.add("prefix-before-boundary");
    const oversized = s.add("\x1b".repeat(10000)); s.add("after-boundary");
    const first = s.hook();
    assert.match(first.stderr, /exceeds output budget/); assert.ok(first.stderr.includes(oversized.eventId));
    assert.doesNotMatch(first.stdout, /after-boundary/);
    const state = JSON.parse(fs.readFileSync(s.stateFile));
    assert.equal(state.cursor.eventId, mode === "nonconsume-first" ? "" : prefix?.eventId || "");
    assert.equal(state.rateBuckets[0][1].count, 1);
    const next = s.hook(); assert.equal(next.stdout, ""); assert.match(next.stderr, /exceeds output budget/);
    assert.equal(JSON.parse(fs.readFileSync(s.stateFile)).cursor.eventId, state.cursor.eventId);
    assert.equal(s.run(["inbox", "--consume"]).status, 0); assert.equal(s.hook().stdout, "");
  });
}

test("policy-blocked oversized originals retain ordinary held scan semantics", t => {
  const s = sandbox(t); s.policy({ mode: "mailbox-only" });
  const oversized = s.add("\x1b".repeat(10000));
  const output = s.hook(); assert.equal(output.stdout, ""); assert.doesNotMatch(output.stderr, /exceeds output budget/);
  assert.equal(JSON.parse(fs.readFileSync(s.stateFile)).cursor.eventId, oversized.eventId);
});

test("hook blocked-only scan bound and quota accounting exclude duplicate receipts", t => {
  const s = sandbox(t); s.policy({ mode: "mailbox-only", rateLimit: { perSenderPer10s: 100 } });
  for (let n = 0; n < 65; n++) s.add(`held-${n}`);
  s.hook(); let state = JSON.parse(fs.readFileSync(s.stateFile)); assert.equal(state.rateBuckets[0][1].count, 64);
  s.add("duplicate", 11, { kind: "message.duplicate" }); s.hook(); state = JSON.parse(fs.readFileSync(s.stateFile)); assert.equal(state.rateBuckets[0][1].count, 65);
});

test("concurrent actual hooks serialize exactly one ordinary committed output", async t => {
  const s = sandbox(t); s.add("concurrent-body");
  const outputs = await Promise.all(Array.from({ length: 4 }, () => s.runAsync(["inbox", "--format", "hook", "--consume"])));
  assert.equal(outputs.filter(result => /concurrent-body/.test(result.stdout)).length, 1);
  assert.match(s.run(["inbox"]).stdout, /concurrent-body/);
});

test("hook output error/timeout leaves state unadvanced, late callback cannot commit; rotation during handoff", async t => {
  const s = sandbox(t); s.add("recover-output");
  const options = { ...s.paths, readerKey: s.readerKey, policyFile: s.policyFile, format: "hook", consume: true };
  await assert.rejects(core.withInboxTransaction({ ...options, handoff: () => { throw new Error("EPIPE"); } }), /EPIPE/);
  assert.equal(fs.existsSync(s.stateFile), false);
  let finish;
  await assert.rejects(core.withInboxTransaction({ ...options, outputTimeoutMs: 20, handoff: () => new Promise(resolve => { finish = resolve; }) }), /timed out/);
  finish(); await delay(30); assert.equal(fs.existsSync(s.stateFile), false);
  let output;
  await core.withInboxTransaction({ ...options, handoff: text => {
    output = text;
    // Journal lock must be free during output; append rotates the snapshot anchor.
    for (let i = 0; i < 5; i++) core.appendBridgeEvent({ to: { readerKey: s.readerKey }, from: { pid: 22, name: "n", cwd: "/n" }, content: `rotated-${i}` }, { eventsFile: s.paths.eventsFile, maxBytes: 1, backups: 3 });
  } });
  assert.match(output, /recover-output/); assert.match(s.hook().stderr, /expired/);
});

test("sender limiter has fixed windows, retained admitted usage, rollback and 1024 non-evicting keys", () => {
  const limiter = core.createSenderRateLimiter({ limit: 5 });
  for (let n = 0; n < 5; n++) assert.equal(limiter.check("1", 1000).allowed, true);
  assert.equal(limiter.check("1", 1000).allowed, false);
  limiter.setLimit(2); assert.equal(limiter.check("1", 1000).allowed, false);
  limiter.setLimit(6); assert.equal(limiter.check("1", 1000).allowed, true); assert.equal(limiter.check("1", 1000).allowed, false);
  assert.equal(limiter.check("1", 999).allowed, false);
  for (let pid = 2; pid <= 1024; pid++) assert.equal(limiter.check(String(pid), 1000).allowed, true);
  assert.equal(limiter.check("1025", 10999).allowed, false); assert.equal(limiter.export(10999).length, 1024);
  assert.equal(limiter.check("1025", 11000).allowed, true); assert.equal(limiter.export(11000).length, 1);
  assert.throws(() => core.createSenderRateLimiter({ buckets: Array(1025).fill([]) }), /Invalid/);
  assert.throws(() => core.createSenderRateLimiter({ buckets: [["1", { windowStart: 1, count: Infinity }]] }), /Invalid/);
});

test("mailbox exact whole-entry byte admission, bounded marker, failed/late handoff and one recovery", async t => {
  const s = sandbox(t), file = path.join(s.home, "mailbox");
  core.appendMailbox(file, "é".repeat(core.MAILBOX_MAX_BYTES / 2));
  for (let n = 0; n < 20; n++) assert.throws(() => core.appendMailbox(file, "x"), /full/);
  assert.equal(fs.statSync(file).size, core.MAILBOX_MAX_BYTES);
  assert.ok(fs.statSync(`${file}.overflow.json`).size < 1024); assert.match(core.mailboxOverflowStatus(file), /20 rejection/);
  await assert.rejects(core.consumeMailbox(file, () => { throw new Error("handoff failed"); }), /retained recovery/);
  assert.equal(fs.statSync(`${file}.reading`).size, core.MAILBOX_MAX_BYTES);
  core.appendMailbox(file, "new-active");
  let late;
  await assert.rejects(core.consumeMailbox(file, () => new Promise(resolve => { late = resolve; }), { outputTimeoutMs: 20 }), /timed out/);
  late(); await delay(30); assert.ok(fs.existsSync(`${file}.reading`));
  let content; await core.consumeMailbox(file, text => { content = text; });
  assert.equal(Buffer.byteLength(content), core.MAILBOX_MAX_BYTES); assert.equal(fs.readFileSync(file, "utf8"), "new-active");
  assert.match(core.mailboxOverflowStatus(file), /full/);
  await core.consumeMailbox(file, text => assert.equal(text, "new-active"));
  assert.equal(core.mailboxOverflowStatus(file), "");
  assert.equal(fs.readdirSync(s.home).filter(name => name.startsWith("mailbox.reading")).length, 0);
});

test("legacy/oversized recovery blocks growth without deleting data", async t => {
  const s = sandbox(t), file = path.join(s.home, "mailbox");
  fs.writeFileSync(`${file}.reading.legacy`, "legacy");
  assert.throws(() => core.appendMailbox(file, "new"), /Legacy/);
  await assert.rejects(core.consumeMailbox(file, () => assert.fail("must not output")), /Legacy/);
  assert.equal(fs.readFileSync(`${file}.reading.legacy`, "utf8"), "legacy");
  fs.unlinkSync(`${file}.reading.legacy`); fs.writeFileSync(file, "x".repeat(core.MAILBOX_MAX_BYTES + 1));
  assert.throws(() => core.appendMailbox(file, "new"), /Oversized/); assert.equal(fs.statSync(file).size, core.MAILBOX_MAX_BYTES + 1);
});

const invalidRooms = [
  [""], [" "], ["constructor"],
  ["join", "project", "--name", "--kind", "typo"], ["join", "project", "--kind", "typo"], ["join", "project", "--name", ""],
  ["join", "constructor", "--kind", "pi"], ["join", "project", "--kind", "pi", "--kind", "cc"],
  ["post", "project", "hello", "--thread"], ["post", "project", "hello", "--urgent", "--urgent"], ["post", "project", "hello", "--wat"],
  ["post", "--", "project", "hello"], ["post", "project", "@constructor"], ["post", "project", "--", " "], ["follow", "project", "thread", "extra"], ["follow", "project", "thread", "--name"],
  ["dnd", "project", "typo"], ["dnd", "project", "on", "--name", "worker", "--name", "other"], ["list", "extra"], ["list", "--all"],
  ...["1000junk", "NaN", "Infinity", "250", "2147483648", "-1"].map(value => ["manager", "project", "--interval", value]),
  ["manager", "project", "--once", "--once"], ["manager", "project", "--unknown"], ["--help", "extra"],
];
const invalidCc = [[""], [" "], ["constructor"], ["start", "--unknown"], ["start", "extra"], ["status", "--all"], ["stop", "extra"], ["mailbox", "--consume"], ["inbox", "--format"], ["inbox", "--format", "bad"], ["inbox", "--all", "--format", "hook"], ["inbox", "--consume", "--consume"], ["inbox", "extra"], ["state", "--unknown"], ["state", "a", "b"], ["state", "a", "--all"], ["state", "--all", "--all"]];
test("strict CLI invalid arguments never create IPC or mutate existing state", t => {
  const s = sandbox(t);
  for (const [bin, cases] of [[room, invalidRooms], [cc, invalidCc]]) for (const args of cases) {
    const result = s.run(args, bin); assert.notEqual(result.status, 0, args.join(" ")); assert.equal(fs.existsSync(s.paths.ipcDir), false, args.join(" "));
  }
  core.ensureIpcDir(s.paths.ipcDir);
  for (const file of [s.paths.registryFile, s.paths.roomStateFile, s.paths.roomEventsFile, s.paths.cursorsFile, path.join(s.paths.ipcDir, "sentinel.mailbox")]) fs.writeFileSync(file, "sentinel");
  for (const [bin, cases] of [[room, invalidRooms], [cc, invalidCc]]) for (const args of cases) assert.notEqual(s.run(args, bin).status, 0);
  for (const name of fs.readdirSync(s.paths.ipcDir)) assert.equal(fs.readFileSync(path.join(s.paths.ipcDir, name), "utf8"), "sentinel");
});

test("piroom manager ignores unused reserved default member identities", t => {
  const s = sandbox(t);
  s.env.PIROOM_NAME = "constructor";
  const result = s.run(["manager", "demo", "--once"], room);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Room: demo/);
  const cwd = path.join(s.home, "constructor"); fs.mkdirSync(cwd);
  delete s.env.PIROOM_NAME;
  const basename = spawnSync(process.execPath, [room, "manager", "demo", "--once"], { cwd, env: s.env, timeout: 6000, encoding: "utf8" });
  assert.equal(basename.status, 0, basename.stderr); assert.match(basename.stdout, /Room: demo/);
  assert.notEqual(s.run(["manager", "constructor", "--once"], room).status, 0);
});

test("piroom delimiter preserves literal flags and ordinary valid option placement", t => {
  const s = sandbox(t);
  for (const args of [["post", "project", "--name", "worker", "--", "- first point", "--name", "--urgent", "-123"], ["post", "project", "ordinary", "--name", "worker", "text", "--urgent"]]) assert.equal(s.run(args, room).status, 0);
  const events = core.readRoomEvents({ eventsFile: s.paths.roomEventsFile });
  assert.equal(events[0].content, "- first point --name --urgent -123"); assert.equal(events[0].urgent, false);
  assert.equal(events[1].content, "ordinary text"); assert.equal(events[1].urgent, true);
  assert.equal(s.run(["join", "defaults"], room).status, 0);
});

test("mailbox contextual errors preserve output classification without tagging unrelated failures", async t => {
  const s = sandbox(t), file = path.join(s.home, "test.mailbox");
  core.appendMailbox(file, "recover-this-body\n");
  for (const tagged of [true, false]) {
    const original = new Error("handoff rejected");
    if (tagged) original.outputHandoffFailed = true;
    await assert.rejects(core.consumeMailbox(file, () => { throw original; }), error => {
      assert.equal(error.cause, original);
      assert.equal(error.outputHandoffFailed, tagged ? true : undefined);
      assert.match(error.message, /Mailbox handoff failed; retained recovery/);
      return true;
    });
    assert.equal(fs.readFileSync(`${file}.reading`, "utf8"), "recover-this-body\n");
    assert.deepEqual(fs.readdirSync(`${file}.consumer.lock`), []);
  }
});

for (const format of ["text", "hook", "mailbox"]) test(`actual full kernel FIFO times out and releases ${format} ownership before exit`, { timeout: 9000 }, async t => {
  const s = sandbox(t); s.add("kernel-output-body");
  const mailbox = path.join(s.paths.ipcDir, `cc-${crypto.createHash("sha256").update(s.home).digest("hex").slice(0, 8)}.mailbox`);
  if (format === "mailbox") core.appendMailbox(mailbox, "kernel-mailbox-body\n");
  const fifo = path.join(s.home, "stdout.fifo");
  const made = spawnSync("mkfifo", [fifo], { env: s.env, timeout: 1000, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  t.after(() => fs.closeSync(fd));
  // A real named kernel pipe, prefilled to EAGAIN; no output stub or reader.
  let filled = 0, full = false;
  while (filled < 4 * 1024 * 1024) {
    try { filled += fs.writeSync(fd, Buffer.alloc(4096, "x")); }
    catch (error) { if (error.code !== "EAGAIN") throw error; full = true; break; }
  }
  assert.equal(full, true); assert.ok(filled > 0);
  const args = format === "mailbox" ? [cc, "mailbox"] : [cc, "inbox", "--consume", "--format", format];
  const child = spawn(process.execPath, args, { cwd: s.home, env: s.env, stdio: ["ignore", fd, "pipe"] });
  let stderr = ""; child.stderr.on("data", data => stderr += data);
  const done = new Promise(resolve => child.once("exit", code => resolve(code)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 6500);
  t.after(async () => { child.kill("SIGKILL"); await done; clearTimeout(timer); });
  assert.equal(await done, 1); clearTimeout(timer);
  assert.match(stderr, /[Oo]utput.*timed out/);
  assert.equal(fs.existsSync(s.paths.cursorsFile), false);
  assert.equal(fs.existsSync(s.stateFile), false);
  assert.equal(core.readBridgeEvents({ eventsFile: s.paths.eventsFile }).length, 1);
  if (format === "mailbox") {
    assert.equal(fs.readFileSync(`${mailbox}.reading`, "utf8"), "kernel-mailbox-body\n");
    assert.deepEqual(fs.readdirSync(`${mailbox}.consumer.lock`), []);
  } else assert.deepEqual(fs.readdirSync(`${s.stateFile}.reader.lock`), []);
});

async function blockedCli(t, s, args, mode) {
  const barrier = path.join(s.home, `barrier-${Math.random().toString(16).slice(2)}`); fs.mkdirSync(barrier);
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures/inbox-output-preload.cjs"), cc, ...args], { cwd: s.home, env: { ...s.env, YO_OUTPUT_BARRIER: barrier, YO_OUTPUT_MODE: mode }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  const done = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const deadlineTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
  t.after(async () => { child.kill("SIGKILL"); await done; clearTimeout(deadlineTimer); });
  const deadline = performance.now() + 3000;
  while (!fs.existsSync(path.join(barrier, "ready"))) {
    if (performance.now() > deadline || child.exitCode !== null) throw new Error(`barrier failed: ${stderr}`);
    await delay(5);
  }
  return { child, done, release: () => fs.writeFileSync(path.join(barrier, "go"), "go"), stdout: () => stdout, stderr: () => stderr };
}

test("queued hook and manual consume respect reader transaction order", async t => {
  for (const firstFormat of ["text", "hook"]) {
    const s = sandbox(t); s.add("ordered-body");
    const first = await blockedCli(t, s, ["inbox", "--format", firstFormat, "--consume"], "before-output");
    const second = s.runAsync(["inbox", "--format", firstFormat === "text" ? "hook" : "text", "--consume"]);
    await delay(60); first.release(); assert.equal((await first.done).code, 0);
    const next = await second;
    if (firstFormat === "text") assert.equal(next.stdout, "");
    else assert.match(next.stdout, /ordered-body/);
  }
});

for (const mode of ["before-output", "before-commit"]) test(`hook crash ${mode} leaves retryable data and recoverable reader ownership`, async t => {
  const s = sandbox(t); s.add("crash-replay-body");
  const child = await blockedCli(t, s, ["inbox", "--format", "hook", "--consume"], mode);
  if (mode === "before-commit") {
    const deadline = performance.now() + 1000;
    while (!child.stdout().includes("crash-replay-body") && performance.now() < deadline) await delay(5);
    assert.match(child.stdout(), /crash-replay-body/);
  } else assert.equal(child.stdout(), "");
  child.child.kill("SIGKILL"); await child.done;
  assert.match(s.hook().stdout, /crash-replay-body/);
  assert.match(s.run(["inbox"]).stdout, /crash-replay-body/);
});

test("actual hook nonreading output times out without commit, EPIPE stays unread", async t => {
  const s = sandbox(t); s.add("output-pending");
  const child = await blockedCli(t, s, ["inbox", "--format", "hook", "--consume"], "never-read");
  assert.notEqual((await child.done).code, 0); assert.match(child.stderr(), /timed out/);
  assert.equal(fs.existsSync(s.stateFile), false);
  const processChild = spawn(process.execPath, [cc, "inbox", "--format", "hook", "--consume"], { cwd: s.home, env: s.env, stdio: ["ignore", "pipe", "pipe"] });
  processChild.stdout.destroy(); processChild.stderr.resume();
  const killed = setTimeout(() => processChild.kill("SIGKILL"), 5000);
  const code = await new Promise(resolve => processChild.once("exit", resolve)); clearTimeout(killed);
  assert.notEqual(code, 0); assert.equal(fs.existsSync(s.stateFile), false);
  assert.match(s.hook().stdout, /output-pending/);
});

test("mailbox overflow created during handoff survives drain marker race", async t => {
  const s = sandbox(t), file = path.join(s.home, "mailbox"); core.appendMailbox(file, "pending");
  await core.consumeMailbox(file, () => assert.throws(() => core.appendMailbox(file, "x".repeat(core.MAILBOX_MAX_BYTES + 1)), /full/));
  assert.match(core.mailboxOverflowStatus(file), /1 rejection/);
  await core.consumeMailbox(file, () => {}); assert.equal(core.mailboxOverflowStatus(file), "");
});

test("timestamp-only legacy cursor fails closed across inversions but manual all inspection works", t => {
  const s = sandbox(t); s.add("newer-before", 11, { acceptedAt: 200 }); s.add("older-after", 11, { acceptedAt: 100 });
  for (const cursor of [{ acceptedAt: 150 }, { eventId: "", acceptedAt: 150 }]) {
    const bytes = JSON.stringify({ [s.readerKey]: cursor }); fs.writeFileSync(s.paths.cursorsFile, bytes);
    for (const args of [["inbox", "--format", "hook", "--consume"], ["inbox", "--consume"], ["inbox", "--all", "--consume"]]) {
      const result = s.run(args); assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.match(result.stderr, /Unsupported legacy/);
    }
    const all = s.run(["inbox", "--all"]); assert.equal(all.status, 0, all.stderr); assert.match(all.stdout, /newer-before/); assert.match(all.stdout, /older-after/);
    assert.equal(fs.readFileSync(s.paths.cursorsFile, "utf8"), bytes);
  }
  fs.writeFileSync(s.paths.cursorsFile, "{"); assert.equal(s.run(["inbox", "--all"]).status, 0);
  fs.writeFileSync(s.paths.cursorsFile, JSON.stringify({ [s.readerKey]: { acceptedAt: 0, eventId: "" } }));
  s.add("zero-event", 11, { acceptedAt: 0 }); assert.match(s.hook().stdout, /zero-event/);
});

for (const mode of ["before-stage", "mid-stage", "before-commit", "after-commit"]) test(`atomic hook state crash ${mode} preserves old/new state and one fixed stage`, async t => {
  const s = sandbox(t); s.policy({ rateLimit: { perSenderPer10s: 100 } }); s.add("seed-state"); s.hook();
  const before = fs.readFileSync(s.stateFile, "utf8"); s.add("atomic-pending");
  for (let retry = 0; retry < (mode === "after-commit" ? 1 : 3); retry++) {
    const child = await blockedCli(t, s, ["inbox", "--format", "hook", "--consume"], mode);
    child.child.kill("SIGKILL"); await child.done;
    if (mode !== "after-commit") assert.equal(fs.readFileSync(s.stateFile, "utf8"), before);
    const stages = fs.readdirSync(s.paths.ipcDir).filter(name => name.startsWith(path.basename(s.stateFile) + ".") && !name.endsWith(".lock"));
    assert.ok(stages.length <= 1); if (stages.length) { assert.equal(stages[0], path.basename(s.stateFile) + ".next"); assert.ok(fs.statSync(path.join(s.paths.ipcDir, stages[0])).size <= 128 * 1024); }
  }
  const result = s.hook();
  if (mode === "after-commit") assert.equal(result.stdout, ""); else assert.match(result.stdout, /atomic-pending/);
  assert.match(s.run(["inbox"]).stdout, /atomic-pending/);
});

test("hook fixed stage refuses symlink/nonregular/oversized entries without overwriting sentinels", t => {
  const s = sandbox(t); s.add("stage-pending"); core.ensureIpcDir(s.paths.ipcDir);
  const target = path.join(s.home, "sentinel"); fs.writeFileSync(target, "keep");
  const stage = `${s.stateFile}.next`;
  for (const type of ["symlink", "directory", "oversized"]) {
    if (type === "symlink") fs.symlinkSync(target, stage);
    else if (type === "directory") fs.mkdirSync(stage);
    else fs.writeFileSync(stage, "x".repeat(128 * 1024 + 1));
    const result = s.run(["inbox", "--format", "hook", "--consume"]); assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(target, "utf8"), "keep"); assert.equal(fs.existsSync(s.stateFile), false);
    if (type === "directory") fs.rmdirSync(stage); else fs.unlinkSync(stage);
  }
  assert.match(s.hook().stdout, /stage-pending/);
});

test("concurrent/crashed actual mailbox consumers replay one recovery before new active content", async t => {
  const s = sandbox(t), hash = s.readerKey.slice(3), file = path.join(s.paths.ipcDir, `cc-${hash}.mailbox`);
  core.appendMailbox(file, "old-unread");
  for (let n = 0; n < 3; n++) {
    const child = await blockedCli(t, s, ["mailbox"], "before-output");
    child.child.kill("SIGKILL"); await child.done;
    assert.equal(fs.readFileSync(`${file}.reading`, "utf8"), "old-unread");
    assert.equal(fs.readdirSync(s.paths.ipcDir).filter(name => name.startsWith(`cc-${hash}.mailbox.reading`)).length, 1);
  }
  core.appendMailbox(file, "new-active");
  const first = await blockedCli(t, s, ["mailbox"], "before-output");
  const next = s.runAsync(["mailbox"]); await delay(60); first.release(); assert.equal((await first.done).code, 0);
  assert.match(first.stdout(), /old-unread/); assert.match((await next).stdout, /new-active/);
  assert.equal(fs.existsSync(`${file}.reading`), false);
});

test("synced shims include pure parser and reject malformed args without creating IPC", t => {
  const s = sandbox(t), agentRoot = path.join(s.home, "shims");
  assert.equal(core.syncLocalShims({ agentRoot }).ok, true);
  assert.equal(s.run(["post", "project", "hello", "--thread"], path.join(agentRoot, "bin/piroom")).status, 1);
  assert.equal(fs.existsSync(s.paths.ipcDir), false);
});

test("hook exact serialized byte boundary includes escaping metadata and newline", t => {
  const s = sandbox(t); s.policy({ rateLimit: { perSenderPer10s: 100 } });
  const a = s.add('"'.repeat(20000)); const b = s.add("placeholder");
  b.content = "x";
  const overhead = Buffer.byteLength(core.formatInboxHookPayload([a, b]) + "\n") - 1;
  b.content = "x".repeat(65536 - overhead);
  assert.ok(Buffer.byteLength(b.content) < 32768);
  assert.equal(Buffer.byteLength(core.formatInboxHookPayload([a, b]) + "\n"), 65536);
  fs.writeFileSync(s.paths.eventsFile, [a, b].map(event => JSON.stringify(event)).join("\n") + "\n");
  s.add("next-batch");
  const result = s.hook(); assert.equal(Buffer.byteLength(result.stdout), 65536); assert.doesNotMatch(result.stdout, /next-batch/);
  assert.match(s.hook().stdout, /next-batch/);
});

test("persisted hook 1024 bucket capacity and rollback deny without fresh allowance", t => {
  const s = sandbox(t); s.add("capacity-denied", 2000); const now = Date.now();
  const state = { version: 1, cursor: { acceptedAt: 0, eventId: "" }, rateBuckets: Array.from({ length: 1024 }, (_, n) => [String(n + 1), { count: 1, windowStart: now + 20000 }]) };
  fs.writeFileSync(s.stateFile, JSON.stringify(state));
  assert.equal(s.hook(false).stdout, ""); assert.equal(JSON.parse(fs.readFileSync(s.stateFile)).rateBuckets.length, 1024);
  s.add("rollback-denied", 1); assert.equal(s.hook(false).stdout, "");
  state.rateBuckets = state.rateBuckets.map(([key, value]) => [key, { ...value, windowStart: now - 10000 }]);
  fs.writeFileSync(s.stateFile, JSON.stringify(state));
  const allowed = s.hook(); assert.match(allowed.stdout, /capacity-denied/); assert.match(allowed.stdout, /rollback-denied/);
  assert.equal(JSON.parse(fs.readFileSync(s.stateFile)).rateBuckets.length, 2);
});

test("bounded socket dispatcher yields at16, checks absolute deadline before delivery, bounds output", async t => {
  const { EventEmitter } = require("node:events");
  class Socket extends EventEmitter {
    writableNeedDrain = false; writableLength = 0; destroyed = false;
    setTimeout() {} setEncoding() {} pause() {} resume() {}
    destroy() { this.destroyed = true; this.emit("close"); }
    write() { return true; }
  }
  const sockets = new Set(), socket = new Socket(), counts = [];
  let yielded = false;
  core.attachBoundedSocket(socket, sockets, () => {
    counts.push(yielded);
    if (counts.length === 1) setImmediate(() => { yielded = true; });
  });
  t.after(() => socket.destroy()); socket.emit("data", "{}\n".repeat(17));
  await delay(30); assert.equal(counts.length, 17); assert.deepEqual(counts.slice(0, 16), Array(16).fill(false)); assert.equal(counts[16], true);
  socket.writableLength = 65536; core.writeSocketResponseBounded(socket, { type: "ack" }); assert.equal(socket.destroyed, true); assert.equal(sockets.size, 0);
  const deadlineSocket = new Socket(), originalNow = performance.now.bind(performance);
  let clock = 100, delivered = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
  try {
    core.attachBoundedSocket(deadlineSocket, sockets, () => { delivered++; clock += 5001; });
    deadlineSocket.emit("data", "{}\n{}\n"); await delay(10);
    assert.equal(delivered, 1); assert.equal(deadlineSocket.destroyed, true);
  } finally { Object.defineProperty(performance, "now", { configurable: true, value: originalNow }); deadlineSocket.destroy(); }
});


test("malformed originals never inject or persist invalid timestamp cursors", t => {
  const s = sandbox(t); const malformed = s.add("negative-time-body", 11, { acceptedAt: -1 });
  assert.equal(s.hook().stdout, ""); assert.equal(JSON.parse(fs.readFileSync(s.stateFile)).cursor.acceptedAt, 0);
  s.add("valid-after-malformed"); assert.match(s.hook().stdout, /valid-after-malformed/);
  assert.match(s.run(["inbox", "--all"]).stdout, /negative-time-body/);
  assert.equal(malformed.acceptedAt, -1);
});

test("same-time saturated overflow counter cannot erase a newer rejection", async t => {
  const s = sandbox(t), file = path.join(s.home, "mailbox"), markerFile = `${file}.overflow.json`;
  core.appendMailbox(file, "pending");
  fs.writeFileSync(markerFile, JSON.stringify({ version: 1, full: true, time: 1234, rejections: Number.MAX_SAFE_INTEGER, noticeOmitted: false }));
  const now = Date.now; Date.now = () => 1234;
  try {
    await core.consumeMailbox(file, () => assert.throws(() => core.appendMailbox(file, "x".repeat(core.MAILBOX_MAX_BYTES + 1)), /full/));
    const marker = JSON.parse(fs.readFileSync(markerFile)); assert.equal(marker.rejections, Number.MAX_SAFE_INTEGER); assert.match(marker.generation, /^[a-f0-9]{32}$/);
    assert.match(core.mailboxOverflowStatus(file), /overflow/);
  } finally { Date.now = now; }
});
