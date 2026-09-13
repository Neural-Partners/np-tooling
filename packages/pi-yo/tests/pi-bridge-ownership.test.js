"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const core = require("../lib/pi-bridge-core.js");
const fixture = path.join(__dirname, "fixtures/ownership-child.js");

function sandbox(t) {
  const home = fs.mkdtempSync("/tmp/yl-");
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.finished));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const resource = path.join(home, "resource");
  function start(label, barriers = [], extra = {}) {
    const child = spawn(process.execPath, [fixture, JSON.stringify({ home, resource, label, barriers, ...extra })], {
      env: { HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PATH: process.env.PATH, TMPDIR: "/tmp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.output = "";
    child.stderr.on("data", chunk => child.output += chunk);
    const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
    child.finished = new Promise(resolve => child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }));
    child.on("error", error => { child.output += error.message; });
    return child;
  }
  async function wait(label, stage) {
    const marker = path.join(home, `${label}.${stage}`);
    for (let i = 0; i < 500; i++) { if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker)); await delay(10); }
    throw new Error(`Missing barrier ${label}.${stage}: ${children.map(child => child.output).join("\n")}`);
  }
  function resume(label, stage) { fs.writeFileSync(path.join(home, `${label}.${stage}.go`), ""); }
  async function success(child) { assert.deepEqual(await child.finished, { code: 0, signal: null }, child.output); }
  return { home, resource, root: `${resource}.lock`, start, wait, resume, success };
}

for (const stage of ["claim-created", "ticket-published", "callback-entered", "releasing"]) {
  test(`bakery lock recovers SIGKILL at ${stage}`, async t => {
    const s = sandbox(t), owner = s.start("owner", [stage]);
    const observed = await s.wait("owner", stage);
    owner.kill("SIGKILL"); await owner.finished;
    await s.success(s.start("successor"));
    assert.deepEqual(fs.readdirSync(s.root), []);
    assert.equal(fs.statSync(s.root).mode & 0o777, 0o700);
    if (observed.id) assert.equal(fs.existsSync(path.join(s.root, observed.id)), false);
  });
}

for (const stage of ["preflight", "claim-created", "before-contender-scan"]) test(`CC opt-in predecessor observation at ${stage} preserves identity and withdraws on error`, async t => {
  const s = sandbox(t), id = `${process.pid}.${"a".repeat(32)}.999`;
  function publish() { fs.mkdirSync(path.join(s.root, id), { recursive: true }); }
  if (stage === "preflight") publish();
  let observed;
  await assert.rejects(core.acquireOwnership(s.resource, {
    onCheckpoint(checkpoint) { if (checkpoint === stage) publish(); },
    onPredecessor(other) { observed = other.id; throw new Error("duplicate retry"); },
  }), /duplicate retry/);
  assert.equal(observed, id);
  assert.deepEqual(fs.readdirSync(s.root), [id]); // only the test predecessor survives
  fs.rmdirSync(path.join(s.root, id));
  const next = await core.acquireOwnership(s.resource); next.release();
  assert.deepEqual(fs.readdirSync(s.root), []);
});

test("CC opt-in observer excludes its own and later-ticket claims and ESRCH-dead predecessors", async t => {
  const s = sandbox(t), id = `${process.pid}.${"b".repeat(32)}.999`;
  let observed = false;
  const claim = await core.acquireOwnership(s.resource, {
    onCheckpoint(stage, own) {
      if (stage === "ticket-published") fs.mkdirSync(path.join(s.root, id, `ticket-${own.ticket + 1n}`), { recursive: true });
    },
    onPredecessor() { observed = true; },
  });
  assert.equal(observed, false); claim.release();
  const successor = await core.acquireOwnership(s.resource, {
    probePid() { throw Object.assign(new Error("dead"), { code: "ESRCH" }); },
    onPredecessor() { throw new Error("must ignore dead predecessor"); },
  });
  successor.release(); assert.deepEqual(fs.readdirSync(s.root), []);
});

test("equal tickets have bytewise tie ordering and maximum occupancy one", async t => {
  const s = sandbox(t);
  const children = ["a", "b", "c", "d"].map(label => s.start(label, ["ticket-chosen"]));
  const claims = await Promise.all(["a", "b", "c", "d"].map(label => s.wait(label, "ticket-chosen")));
  assert.deepEqual(claims.map(claim => claim.ticket), ["1", "1", "1", "1"]);
  for (const label of ["d", "b", "a", "c"]) s.resume(label, "ticket-chosen");
  await Promise.all(children.map(s.success));
  const order = claims.map((claim, i) => ({ id: claim.id, label: "abcd"[i] })).sort((a, b) => a.id < b.id ? -1 : 1);
  assert.equal(fs.readFileSync(path.join(s.home, "trace"), "utf8"), order.map(({ label }) => `enter ${label}\nexit ${label}\n`).join(""));
});

test("late entrant observes published ticket at fresh contender scan boundary", async t => {
  const s = sandbox(t), a = s.start("a", ["before-contender-scan"]);
  const first = await s.wait("a", "before-contender-scan");
  const b = s.start("b", ["ticket-published"]);
  const second = await s.wait("b", "ticket-published");
  assert.ok(BigInt(second.ticket) > BigInt(first.ticket));
  s.resume("b", "ticket-published"); s.resume("a", "before-contender-scan");
  await Promise.all([a, b].map(s.success));
  assert.match(fs.readFileSync(path.join(s.home, "trace"), "utf8"), /^enter a\nexit a\nenter b\nexit b\n$/);
});

test("two paused reclaimers cannot remove a successor claim", async t => {
  const s = sandbox(t), dead = s.start("dead", ["ticket-published"]);
  const old = await s.wait("dead", "ticket-published"); dead.kill("SIGKILL"); await dead.finished;
  const a = s.start("a", ["reclaim-dead", "callback-entered"]);
  await s.wait("a", "reclaim-dead");
  const b = s.start("b", ["reclaim-dead"]);
  await s.wait("b", "reclaim-dead");
  s.resume("a", "reclaim-dead"); await s.wait("a", "callback-entered");
  s.resume("b", "reclaim-dead"); await delay(50);
  assert.equal(b.exitCode, null);
  assert.equal(fs.existsSync(path.join(s.root, old.id)), false);
  assert.equal(fs.readdirSync(s.root).length, 2);
  s.resume("a", "callback-entered"); await Promise.all([a, b].map(s.success));
});

test("reclaimer crash after ticket deletion leaves recoverable dead choosing claim", async t => {
  const s = sandbox(t), dead = s.start("dead", ["ticket-published"]);
  const old = await s.wait("dead", "ticket-published"); dead.kill("SIGKILL"); await dead.finished;
  const reclaimer = s.start("reclaimer", ["partial-cleanup"], { partialCleanup: old.id });
  await s.wait("reclaimer", "partial-cleanup");
  assert.deepEqual(fs.readdirSync(path.join(s.root, old.id)), []);
  reclaimer.kill("SIGKILL"); await reclaimer.finished;
  await s.success(s.start("successor"));
  assert.deepEqual(fs.readdirSync(s.root), []);
});

test("SIGSTOP owner past contender timeout is never evicted", async t => {
  const s = sandbox(t), owner = s.start("owner", ["callback-entered"]);
  await s.wait("owner", "callback-entered"); owner.kill("SIGSTOP");
  const contender = s.start("contender", [], { timeoutMs: 100 });
  assert.equal((await contender.finished).code, 1);
  assert.match(contender.output, /Ownership timeout.*live/);
  assert.equal(fs.readdirSync(s.root).length, 1);
  owner.kill("SIGCONT"); s.resume("owner", "callback-entered"); await s.success(owner);
  await s.success(s.start("successor"));
});

test("PID reuse, EPERM and unexpected probe failures fail closed; only ESRCH reclaims", t => {
  const s = sandbox(t);
  fs.mkdirSync(s.root);
  const id = `2147483647.${"a".repeat(32)}.1`, claim = path.join(s.root, id);
  fs.mkdirSync(claim); // Missing ticket still owned.
  for (const probePid of [() => {}, () => { throw Object.assign(new Error(), { code: "EPERM" }); }, () => { throw new Error("unexpected"); }]) {
    assert.throws(() => core.withRegistryLock(s.resource, () => assert.fail("must not enter"), { timeoutMs: 30, retryMs: 1, probePid }), /Ownership timeout/);
    assert.equal(fs.existsSync(claim), true);
  }
  core.withRegistryLock(s.resource, () => {}, { probePid: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } });
  assert.deepEqual(fs.readdirSync(s.root), []);
  assert.equal(core.classifyOwnerPid(0), "unknown");
});

test("legacy roots, symlinks, malformed and oversized layouts are actionable refusals", t => {
  const s = sandbox(t);
  fs.writeFileSync(s.root, "");
  assert.throws(() => core.withRegistryLock(s.resource, () => {}), /Stop ALL old.*never delete locks/);
  fs.unlinkSync(s.root);
  const target = path.join(s.home, "target"); fs.mkdirSync(target); fs.symlinkSync(target, s.root);
  assert.throws(() => core.withRegistryLock(s.resource, () => {}), /Unsupported ownership layout/);
  fs.unlinkSync(s.root); fs.mkdirSync(s.root);
  fs.mkdirSync(path.join(s.root, "unknown"));
  assert.throws(() => core.withRegistryLock(s.resource, () => {}), /Unsupported ownership layout/);
  fs.rmdirSync(path.join(s.root, "unknown"));
  for (let i = 1; i <= 1025; i++) fs.mkdirSync(path.join(s.root, `${process.pid}.${"b".repeat(32)}.${i}`));
  assert.throws(() => core.withRegistryLock(s.resource, () => {}), /exceeds 1024/);
  assert.equal(fs.readdirSync(s.root).length, 1025);
});

test("callback throw, reentrancy and nested different-resource locks release correctly", async t => {
  const s = sandbox(t);
  assert.throws(() => core.withRegistryLock(s.resource, () => { throw new Error("callback failure"); }), /callback failure/);
  core.withRegistryLock(s.resource, () => {
    assert.throws(() => core.withRegistryLock(s.resource, () => {}), /Reentrant/);
    core.withRegistryLock(path.join(s.home, "other"), () => {});
    assert.throws(() => fs.openSync(s.root, "wx"), /EEXIST/);
  });
  const claim = await core.acquireOwnership(s.resource);
  assert.equal(fs.existsSync(claim.path), true);
  claim.release(); claim.release();
  assert.deepEqual(fs.readdirSync(s.root), []);
});

test("generation-matched registry updates/removal preserve replacement and socket validation is narrow", t => {
  const s = sandbox(t), paths = core.buildPaths(s.home);
  const entry = { pid: process.pid, name: "CC", generation: "replacement", socketPath: path.join(paths.ipcDir, `cg-${"a".repeat(24)}.sock`) };
  core.registerSession(entry, paths.registryFile);
  assert.equal(core.updateRegisteredSession(process.pid, { name: "old" }, paths.registryFile, "old"), false);
  core.unregisterSession(process.pid, paths.registryFile, "old");
  assert.equal(core.readRegistry(paths.registryFile).sessions[0].name, "CC");
  assert.equal(core.isAllowedBridgeSocketPath(entry.socketPath, paths.ipcDir), true);
  assert.equal(core.isAllowedBridgeSocketPath(path.join(paths.ipcDir, "cg-unknown.sock"), paths.ipcDir), false);
  assert.throws(() => core.assertSocketPathLength("/tmp/" + "é".repeat(50)), /103-byte/);
  core.assertSocketPathLength("/" + "a".repeat(102));
});

test("dead-generation cleanup preserves non-sockets/symlinks and unknown live owners", async t => {
  const s = sandbox(t), resource = path.join(s.home, "cc-12345678.owner"), root = `${resource}.lock`;
  const id = `2147483647.${"c".repeat(32)}.1`;
  const socket = path.join(s.home, `cg-${require("node:crypto").createHash("sha256").update(`cc1:${id}`).digest("hex").slice(0, 24)}.sock`);
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, id));
  fs.writeFileSync(socket, "sentinel");
  assert.throws(() => core.withRegistryLock(resource, () => {}), /Unsupported ownership layout/);
  assert.equal(fs.readFileSync(socket, "utf8"), "sentinel");
  fs.unlinkSync(socket);
  const target = path.join(s.home, "sentinel"); fs.writeFileSync(target, "keep"); fs.symlinkSync(target, socket);
  assert.throws(() => core.withRegistryLock(resource, () => {}), /Unsupported ownership layout/);
  assert.equal(fs.lstatSync(socket).isSymbolicLink(), true); fs.unlinkSync(socket);
  const server = require("node:net").createServer();
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => server.close());
  for (const probePid of [() => {}, () => { throw Object.assign(new Error(), { code: "EPERM" }); }]) {
    assert.throws(() => core.withRegistryLock(resource, () => {}, { timeoutMs: 30, retryMs: 1, probePid }), /Ownership timeout/);
    assert.equal(fs.lstatSync(socket).isSocket(), true);
  }
  core.withRegistryLock(resource, () => {});
  assert.equal(fs.existsSync(socket), false);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

test("doctor preserves directory/file permission distinction and refuses legacy lock migration", t => {
  const s = sandbox(t), paths = core.buildPaths(s.home);
  core.withRegistryLock(paths.registryFile, claimPath => {
    fs.chmodSync(`${paths.registryFile}.lock`, 0o755); fs.chmodSync(claimPath, 0o755);
    const ticket = fs.readdirSync(claimPath)[0]; fs.chmodSync(path.join(claimPath, ticket), 0o755);
    fs.writeFileSync(path.join(claimPath, "generation.json"), "{}", { mode: 0o644 });
    core.doctorIpcPermissions({ ipcDir: paths.ipcDir, fix: true });
    for (const file of [`${paths.registryFile}.lock`, claimPath, path.join(claimPath, ticket)]) assert.equal(fs.statSync(file).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(claimPath, "generation.json")).mode & 0o777, 0o600);
  });
  fs.writeFileSync(`${paths.eventsFile}.lock`, "legacy", { mode: 0o644 });
  const result = core.doctorIpcPermissions({ ipcDir: paths.ipcDir, fix: true });
  assert.ok(result.findings.some(finding => finding.path === `${paths.eventsFile}.lock` && finding.fixed === false && /Stop ALL/.test(finding.issue)));
  assert.equal(fs.statSync(`${paths.eventsFile}.lock`).mode & 0o777, 0o644);
});
