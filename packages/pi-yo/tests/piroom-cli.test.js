"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const core = require("../lib/pi-bridge-core.js");
const corePath = require.resolve("../lib/pi-bridge-core.js");
const cli = path.resolve(__dirname, "../bin/piroom");

for (const kind of ["pi", "cc"]) test(`piroom ${kind} join binds live receiver, posts preserve binding, restart requires rejoin`, async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yo-room-cli-")));
  const env = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PATH: process.env.PATH };
  const paths = core.buildPaths(home);
  const children = [];
  t.after(async () => {
    for (const receiver of children) await receiver.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  async function receiver(name = "worker", cwd = home) {
    const script = `const c=require(${JSON.stringify(corePath)}),net=require('node:net'),path=require('node:path');c.ensureIpcDir();const socketPath=path.join(c.DEFAULT_PATHS.ipcDir,process.pid+'.sock');const server=net.createServer(socket=>{socket.setEncoding('utf8');let buffer='';socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\\n'))return;const msg=JSON.parse(buffer.trim());process.stdout.write(JSON.stringify(msg)+'\\n');socket.end(JSON.stringify(c.createSocketResponse('ack',msg,{fromPid:process.pid,fromName:${JSON.stringify(name)},fromCwd:process.cwd()}))+'\\n');});});server.listen(socketPath,()=>{c.registerSession({pid:process.pid,name:${JSON.stringify(name)},cwd:process.cwd(),startedAt:Date.now(),socketPath});console.log('ready');});process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
    const child = spawn(process.execPath, ["-e", script], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const exited = new Promise(resolve => child.once("exit", resolve));
    const entry = { child, stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }, messages: () => output.trim().split("\n").filter(line => line !== "ready").map(line => JSON.parse(line)) };
    children.push(entry);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`receiver startup timed out: ${stderr}`)); }, 3000);
      const poll = setInterval(() => { if (output.includes("ready\n")) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 10);
      child.once("error", error => { clearInterval(poll); clearTimeout(timer); reject(error); });
    });
    return entry;
  }
  async function run(...args) {
    return (await promisify(execFile)(process.execPath, [cli, ...args], { cwd: home, env, timeout: 3000 })).stdout;
  }
  const join = () => run("join", "project", "--name", "worker", "--kind", kind);
  const member = () => core.readRoomState(paths.roomStateFile).rooms.project.members.worker;
  const binding = value => [value.kind, value.sessionPid, value.sessionName, value.sessionCwd, value.sessionStartedAt];
  await assert.rejects(join(), /found 0/);
  assert.equal(fs.existsSync(paths.roomStateFile), false);
  // Posting without an agent join must not bind an identically named live receiver.
  const unjoined = await receiver("unjoined");
  await run("post", "unjoined-room", "hello", "--name", "unjoined");
  const human = () => core.readRoomState(paths.roomStateFile).rooms["unjoined-room"].members.unjoined;
  const humanBinding = binding(human());
  assert.equal(human().kind, "human");
  assert.ok(Number.isSafeInteger(human().sessionPid));
  assert.notEqual(human().sessionPid, unjoined.child.pid);
  assert.match(await run("post", "unjoined-room", "@unjoined before restart", "--name", "principal"), /delivered:0 skipped:1/);
  assert.deepEqual(unjoined.messages(), []);
  await unjoined.stop();
  const newUnjoined = await receiver("unjoined");
  await run("post", "unjoined-room", "another human post", "--name", "unjoined");
  assert.deepEqual(binding(human()), humanBinding);
  assert.match(await run("post", "unjoined-room", "@unjoined after restart", "--name", "principal"), /delivered:0 skipped:1/);
  assert.deepEqual(newUnjoined.messages(), []);
  await newUnjoined.stop();

  const first = await receiver();
  await join();
  const original = binding(member());
  const registered = core.readRegistry(paths.registryFile).sessions.find(session => session.pid === first.child.pid);
  assert.deepEqual(original, [kind, first.child.pid, "worker", home, registered.startedAt]);
  assert.match(await run("post", "project", "@worker first", "--name", "principal"), /delivered:1 skipped:0/);
  assert.match(first.messages()[0].content, /@worker first/);
  await run("post", "project", "my own post", "--name", "worker");
  assert.deepEqual(binding(member()), original);

  const ambiguous = await receiver();
  await assert.rejects(join(), /found 2/);
  assert.deepEqual(binding(member()), original);
  await ambiguous.stop();
  await first.stop();
  const replacement = await receiver();
  assert.notEqual(replacement.child.pid, first.child.pid);
  assert.match(await run("post", "project", "@worker before rejoin", "--name", "principal"), /delivered:0 skipped:1/);
  assert.deepEqual(replacement.messages(), []);
  await run("post", "project", "still the old binding", "--name", "worker");
  assert.deepEqual(binding(member()), original);
  await join();
  assert.equal(member().sessionPid, replacement.child.pid);
  assert.equal(member().sessionStartedAt, core.readRegistry(paths.registryFile).sessions.find(session => session.pid === replacement.child.pid).startedAt);
  assert.match(await run("post", "project", "@worker after rejoin", "--name", "principal"), /delivered:1 skipped:0/);
  assert.match(replacement.messages()[0].content, /@worker after rejoin/);
  await replacement.stop();

  await receiver("unrelated");
  const otherCwd = path.join(home, "other"); fs.mkdirSync(otherCwd);
  await receiver("worker", otherCwd);
  await assert.rejects(join(), /found 0/);
  assert.equal(member().sessionPid, replacement.child.pid);
});
