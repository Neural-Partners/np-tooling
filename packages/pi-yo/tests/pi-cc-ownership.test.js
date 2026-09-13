"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const core = require("../lib/pi-bridge-core.js");
const bridge = path.resolve(__dirname, "../bin/pi-cc-bridge");
const preload = path.join(__dirname, "fixtures/cc-lifecycle-preload.js");

async function until(check, message, ms = 5000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { const result = check(); if (result) return result; await delay(10); }
  throw new Error(message);
}
function sandbox(t) {
  const home = fs.mkdtempSync("/tmp/yc-");
  const cwd = fs.realpathSync(home);
  const env = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PATH: process.env.PATH, TMPDIR: "/tmp" };
  const children = [];
  const paths = core.buildPaths(home);
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  const root = path.join(paths.ipcDir, `cc-${hash}.owner.lock`);
  function run(args, extra = {}) { return spawnSync(process.execPath, [bridge, ...args], { cwd, env: { ...env, ...extra }, timeout: 6000, encoding: "utf8" }); }
  function start(args = ["start"], fault) {
    const child = spawn(process.execPath, [bridge, ...args], { cwd, env: { ...env, NODE_OPTIONS: `--require=${preload}`, ...(fault && { YO_TEST_FAULT: fault }) }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); child.stdoutText = ""; child.stderrText = "";
    child.stdout.on("data", chunk => child.stdoutText += chunk); child.stderr.on("data", chunk => child.stderrText += chunk);
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.finished = new Promise(resolve => child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }));
    child.on("error", error => child.stderrText += error.message);
    return child;
  }
  const entries = () => core.readRegistry(paths.registryFile).sessions;
  const daemonPids = () => fs.readdirSync(home).filter(file => /^child-\d+$/.test(file)).map(file => Number(file.slice(6)));
  t.after(async () => {
    // PIDs come only from this test's spawned-child fixture; never registry authority.
    for (const pid of daemonPids()) { try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGTERM"); } catch {} }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.finished));
    await delay(300);
    for (const pid of daemonPids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  });
  async function success(child) { assert.equal((await child.finished).code, 0, child.stderrText); }
  async function clean() { await until(() => (!fs.existsSync(root) || fs.readdirSync(root).length === 0) && entries().length === 0, "generation resources not cleaned"); }
  return { home, cwd, env, paths, root, hash, run, start, entries, daemonPids, success, clean };
}
async function message(entry, id = crypto.randomUUID()) {
  return core.sendToSocket(entry.socketPath, { id, type: "message", fromPid: process.pid, fromName: "test", fromCwd: "/test", content: "immediate ready delivery", timestamp: Date.now() }, { requireAck: true, ackTimeoutMs: 1000 });
}
function rawControl(entry, generation, action = "stop") {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(entry.socketPath); let response = "";
    socket.setTimeout(1000, () => { socket.destroy(); resolve(response); });
    socket.on("connect", () => socket.write(JSON.stringify({ ccProtocol: "pi-cc/1", generation, requestId: crypto.randomBytes(16).toString("hex"), action }) + "\n"));
    socket.on("data", chunk => { response += chunk; socket.destroy(); resolve(response); });
    socket.on("close", () => resolve(response)); socket.on("error", reject);
  });
}

test("concurrent launchers yield one adopted receiver, immediate delivery and no later orphan", async t => {
  const s = sandbox(t), launchers = Array.from({ length: 6 }, () => s.start());
  await Promise.all(launchers.map(child => child.finished));
  assert.ok(launchers.some(child => child.exitCode === 0));
  for (const child of launchers) {
    if (child.exitCode === 0) assert.match(child.stdoutText, /started|already running/);
    else assert.doesNotMatch(child.stdoutText, /started/);
  }
  assert.equal(s.entries().length, 1);
  assert.equal(s.entries()[0].lifecycle, "adopted");
  assert.equal((await message(s.entries()[0])).acked, true);
  assert.equal(fs.readdirSync(s.root).length, 1);
  const stopped = s.run(["stop"]); assert.equal(stopped.status, 0, stopped.stderr); assert.match(stopped.stdout, /Stopped/);
  await s.clean(); await delay(300);
  assert.deepEqual(s.entries(), []); assert.deepEqual(fs.readdirSync(s.root), []);
});

async function barrier(s, stage) {
  return until(() => fs.existsSync(path.join(s.home, stage)) && Number(fs.readFileSync(path.join(s.home, stage))), `${stage} not reached`);
}
for (const [fault, stage] of [["prepared-stop", "prepared-stopped"], ["claim-created-stop", "claim-stopped"]]) {
  test(`parent remembers ${fault} generation across spawn pause, adoption and completed stop`, async t => {
    const s = sandbox(t), first = s.start(["start"], fault);
    const owner = await barrier(s, stage);
    const duplicate = s.start(["start"], "parent-spawn-stop");
    const parent = await barrier(s, "spawn-stopped");
    process.kill(owner, "SIGCONT"); await s.success(first);
    assert.equal(s.run(["stop"]).status, 0); await s.clean();
    process.kill(parent, "SIGCONT");
    assert.equal((await duplicate.finished).code, 1);
    assert.match(duplicate.stderrText, /Preceding CC generation.*retry/);
    assert.doesNotMatch(duplicate.stdoutText, /started|already running/);
    await s.clean(); await delay(100); assert.deepEqual(s.entries(), []);
    await s.success(s.start([])); // No-argument start remains compatible.
    assert.equal(s.run(["stop"]).status, 0);
  });
}

test("child predecessor observation survives pause, adoption and completed stop", async t => {
  const s = sandbox(t), duplicate = s.start(["start"], "child-predecessor-stop");
  const child = await barrier(s, "before-acquire");
  const first = s.start(["start"], "prepared-stop"), owner = await barrier(s, "prepared-stopped");
  process.kill(child, "SIGCONT"); await barrier(s, "predecessor-stopped");
  process.kill(owner, "SIGCONT"); await s.success(first);
  assert.equal(s.run(["stop"]).status, 0); await s.clean();
  process.kill(child, "SIGCONT");
  assert.equal((await duplicate.finished).code, 1);
  assert.match(duplicate.stderrText, /Preceding CC generation.*retry/);
  assert.doesNotMatch(duplicate.stdoutText, /started|already running/);
  await s.clean(); await delay(100); assert.deepEqual(s.entries(), []);
});

for (const fault of ["bind", "registration", "state", "readiness", "disconnect"]) {
  test(`failed ${fault} startup is nonzero and cleans unique ownership`, async t => {
    const s = sandbox(t), launcher = s.start(["start"], fault);
    assert.notEqual((await launcher.finished).code, 0);
    assert.doesNotMatch(launcher.stdoutText, /started/);
    await s.clean();
    assert.equal(fs.readdirSync(s.paths.ipcDir).filter(file => /^cg-.*\.sock$/.test(file)).length, 0);
    await s.success(s.start());
    assert.equal((await message(s.entries()[0])).acked, true);
    assert.equal(s.run(["stop"]).status, 0); await s.clean();
  });
}

test("parent death before adoption cancels resumed child without serving", async t => {
  const s = sandbox(t), launcher = s.start(["start"], "claim-stop");
  const pid = await until(() => fs.existsSync(path.join(s.home, "claim-stopped")) && Number(fs.readFileSync(path.join(s.home, "claim-stopped"))), "child never stopped");
  launcher.kill("SIGKILL"); await launcher.finished;
  assert.equal(fs.readdirSync(s.root).length, 1);
  process.kill(pid, "SIGCONT"); await s.clean();
  await s.success(s.start()); assert.equal((await message(s.entries()[0])).acked, true);
  assert.equal(s.run(["stop"]).status, 0);
});

test("paused child across deadline retains claim, then cancels before serving", async t => {
  const s = sandbox(t), launcher = s.start(["start"], "claim-created-stop");
  const pid = await until(() => fs.existsSync(path.join(s.home, "claim-stopped")) && Number(fs.readFileSync(path.join(s.home, "claim-stopped"))), "child never stopped");
  assert.equal((await launcher.finished).code, 1);
  assert.match(launcher.stderrText, /timed out; cancellation pending/);
  assert.equal(fs.readdirSync(s.root).length, 1);
  assert.equal(s.entries().length, 0);
  const contender = s.start();
  assert.equal((await contender.finished).code, 1);
  await until(() => fs.readdirSync(s.root).length === 1, "cancelled contender did not withdraw");
  process.kill(pid, "SIGCONT"); await s.clean();
  assert.equal(fs.readdirSync(s.paths.ipcDir).filter(file => /^cg-/.test(file)).length, 0);
});

test("stop/start overlap holds ownership through cleanup and rejects old-generation control", async t => {
  const s = sandbox(t); await s.success(s.start(["start"], "stop-cleanup"));
  const old = s.entries()[0];
  const stopping = s.start(["stop"]);
  const pid = await until(() => fs.existsSync(path.join(s.home, "cleanup-stopped")) && Number(fs.readFileSync(path.join(s.home, "cleanup-stopped"))), "cleanup never stopped");
  assert.equal(s.entries()[0].generation, old.generation);
  assert.equal(s.entries()[0].lifecycle, "stopping");
  assert.equal(fs.existsSync(old.socketPath), false);
  const starting = s.start(); await delay(100);
  assert.equal(starting.exitCode, null);
  assert.equal(fs.existsSync(path.join(s.root, old.generation.slice(4))), true);
  process.kill(pid, "SIGCONT");
  await s.success(stopping); await s.success(starting);
  const replacement = s.entries()[0];
  assert.notEqual(replacement.generation, old.generation);
  assert.notEqual(replacement.socketPath, old.socketPath);
  assert.equal(await rawControl(replacement, old.generation), "");
  assert.equal((await message(replacement)).acked, true);
  await assert.rejects(rawControl(old, old.generation), /ENOENT|ECONNREFUSED/);
  assert.equal((await message(replacement)).acked, true);
  const stopA = s.start(["stop"]), stopB = s.start(["stop"]);
  await Promise.all([stopA.finished, stopB.finished]);
  assert.ok([stopA, stopB].some(child => child.exitCode === 0));
  await s.clean();
  assert.equal(s.run(["stop"]).status, 0);
});

test("failed STOPPING publication cleans up but requires explicit retry", async t => {
  const s = sandbox(t); await s.success(s.start(["start"], "stop-publication-failure"));
  const stopping = s.start(["stop"]), pid = await barrier(s, "cleanup-stopped");
  assert.equal(s.entries()[0].lifecycle, "adopted");
  const refused = s.start(); assert.equal((await refused.finished).code, 1);
  assert.match(refused.stderrText, /Preceding CC generation.*retry/);
  assert.equal(fs.readdirSync(s.root).length, 1);
  process.kill(pid, "SIGCONT"); await s.success(stopping); await s.clean();
  await s.success(s.start()); assert.equal(s.run(["stop"]).status, 0);
});

test("mismatched STOPPING endpoint metadata cannot authorize a queued replacement", async t => {
  const s = sandbox(t); await s.success(s.start(["start"], "stop-cleanup"));
  const old = s.entries()[0], stopping = s.start(["stop"]);
  const pid = await barrier(s, "cleanup-stopped");
  assert.equal(s.entries()[0].lifecycle, "stopping");
  core.updateRegisteredSession(old.pid, { socketPath: path.join(s.paths.ipcDir, `cg-${"a".repeat(24)}.sock`) }, s.paths.registryFile, old.generation);
  const refused = s.start(); assert.equal((await refused.finished).code, 1);
  assert.match(refused.stderrText, /Preceding CC generation.*retry/);
  assert.equal(fs.readdirSync(s.root).length, 1);
  core.updateRegisteredSession(old.pid, { socketPath: old.socketPath }, s.paths.registryFile, old.generation);
  process.kill(pid, "SIGCONT"); await s.success(stopping); await s.clean();
  assert.deepEqual(s.entries(), []);
});

test("killed adopted daemon is reclaimed and PID metadata never signals or deletes another process", async t => {
  const s = sandbox(t); await s.success(s.start());
  const old = s.entries()[0];
  process.kill(old.pid, "SIGKILL");
  await until(() => core.classifyOwnerPid(old.pid) === "dead", "daemon did not die");
  await s.success(s.start());
  const replacement = s.entries()[0];
  assert.notEqual(replacement.generation, old.generation);
  assert.equal((await message(replacement)).acked, true);
  const pidFile = path.join(s.paths.ipcDir, `cc-${s.hash}.pid`), metaFile = path.join(s.paths.ipcDir, `cc-${s.hash}.json`);
  fs.writeFileSync(pidFile, String(process.pid));
  fs.writeFileSync(metaFile, JSON.stringify({ pid: process.pid, cwd: s.cwd, scriptPath: bridge }));
  const refused = s.run(["stop"]);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /Legacy\/unknown.*Stop all old/);
  assert.equal(fs.readFileSync(pidFile, "utf8"), String(process.pid));
  assert.equal((await message(replacement)).acked, true);
  // Test-created legacy files are removed only after stopping this test generation directly.
  await rawControl(replacement, replacement.generation); await s.clean();
});

test("long encoded socket paths fail startup clearly without orphan resources", async t => {
  const s = sandbox(t), home = path.join(s.home, "é".repeat(45)); fs.mkdirSync(home);
  const result = s.run(["start"], { HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent") });
  assert.equal(result.status, 1); assert.match(result.stderr, /103-byte/); assert.doesNotMatch(result.stdout, /started/);
  const ipc = core.buildPaths(home).ipcDir;
  await until(() => fs.readdirSync(ipc).filter(file => file.endsWith(".lock")).every(file => fs.readdirSync(path.join(ipc, file)).length === 0), "long-path claim not released");
});

test("SIGKILL after bind before registration reclaims its orphan endpoint", async t => {
  const s = sandbox(t), launcher = s.start(["start"], "bound-stop");
  const pid = await until(() => fs.existsSync(path.join(s.home, "bound-stopped")) && Number(fs.readFileSync(path.join(s.home, "bound-stopped"))), "bind barrier not reached");
  const [oldSocket] = fs.readdirSync(s.paths.ipcDir).filter(file => /^cg-.*\.sock$/.test(file));
  assert.ok(oldSocket); assert.equal(s.entries().length, 0);
  // Corrupt diagnostic metadata to prove a crash mid-write cannot strand ownership.
  const [claim] = fs.readdirSync(s.root);
  fs.writeFileSync(path.join(s.root, claim, "generation.json"), "{");
  process.kill(pid, "SIGKILL"); await launcher.finished;
  await until(() => core.classifyOwnerPid(pid) === "dead", "child did not die");
  await s.success(s.start());
  assert.equal(fs.existsSync(path.join(s.paths.ipcDir, oldSocket)), false);
  assert.notEqual(path.basename(s.entries()[0].socketPath), oldSocket);
  assert.equal((await message(s.entries()[0])).acked, true);
  assert.equal(s.run(["stop"]).status, 0); await s.clean();
});

test("bind conflict never unlinks an endpoint this generation did not bind", async t => {
  const s = sandbox(t), launcher = s.start(["start"], "bind-pause");
  const pid = await until(() => fs.existsSync(path.join(s.home, "bind-stopped")) && Number(fs.readFileSync(path.join(s.home, "bind-stopped"))), "bind pause not reached");
  const socketPath = fs.readFileSync(path.join(s.home, "bind-path"), "utf8");
  const sentinel = net.createServer(socket => socket.end("sentinel"));
  await new Promise(resolve => sentinel.listen(socketPath, resolve));
  t.after(() => sentinel.close());
  const inode = fs.lstatSync(socketPath).ino;
  process.kill(pid, "SIGCONT");
  assert.equal((await launcher.finished).code, 1);
  await s.clean();
  assert.equal(fs.lstatSync(socketPath).ino, inode);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  await new Promise(resolve => sentinel.close(resolve));
});
