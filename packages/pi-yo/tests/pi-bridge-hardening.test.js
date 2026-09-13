"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const core = require("../lib/pi-bridge-core.js");
const corePath = require.resolve("../lib/pi-bridge-core.js");
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-hard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("pruning rejects malformed entries and never deletes unrelated or regular files", (t) => {
  const home = sandbox(t), paths = core.buildPaths(home);
  core.ensureIpcDir(paths.ipcDir);
  const outside = path.join(home, "sentinel"), regular = path.join(paths.ipcDir, "123.sock");
  for (const file of [outside, regular]) fs.writeFileSync(file, "keep");
  const entries = [null, {}, { pid: 0 }, { pid: "123" }, ...[outside, regular].map(socketPath => ({ pid: 2147483647, socketPath }))];
  for (const operation of [() => core.activeSessions({ registryFile: paths.registryFile }), () => core.registerSession({ pid: process.pid }, paths.registryFile), () => core.setSessionVisibility(process.pid, "visible", paths.registryFile)]) {
    fs.writeFileSync(paths.registryFile, JSON.stringify({ sessions: entries }));
    operation();
    for (const file of [outside, regular]) assert.equal(fs.readFileSync(file, "utf8"), "keep");
  }
});

test("pruning removes a legitimate dead socket only within the configured root", async (t) => {
  const dir = sandbox(t), socketPath = path.join(dir, "123.sock");
  const server = net.createServer();
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => server.close());
  assert.deepEqual(core.pruneDeadSessions([{ pid: 2147483647, socketPath }], { ipcDir: dir }), []);
  assert.equal(fs.existsSync(socketPath), false);
});

test("existing invalid policies fail closed and recover after repair; missing stays compatible", (t) => {
  const dir = sandbox(t), file = path.join(dir, "policy.json");
  assert.equal(core.readBridgePolicy(file).mode, "auto-inject");
  for (const raw of ["{", "null", "[]", '{"mode":"typo"}', '{"allowlist":{}}', '{"allowlist":[null]}', '{"allowlist":[{}]}', '{"allowlist":[{"pid":"123"}]}', '{"allowlist":[{"name":"ok","pid":0}]}', '{"rateLimit":null}']) {
    fs.writeFileSync(file, raw);
    const warnings = [];
    const policy = core.readBridgePolicy(file, { onDiagnostic: text => warnings.push(text) });
    assert.equal(policy.mode, "mailbox-only", raw);
    assert.equal(core.decideMessageDelivery({}, policy).action, "mailbox");
    assert.equal(warnings.length, 1);
  }
  fs.writeFileSync(file, '{"mode":"auto-inject","allowlist":[{"pid":123}]}');
  assert.equal(core.readBridgePolicy(file).mode, "auto-inject");
  fs.chmodSync(file, 0);
  if (process.getuid?.() !== 0) assert.equal(core.readBridgePolicy(file).mode, "mailbox-only");
  fs.chmodSync(file, 0o600);
});

test("IPC root and configuration symlinks are not traversed or chmodded", (t) => {
  const dir = sandbox(t), target = path.join(dir, "target"), link = path.join(dir, "link");
  fs.mkdirSync(target, 0o755); fs.symlinkSync(target, link);
  assert.equal(core.doctorIpcPermissions({ ipcDir: link, fix: true }).findings[0].fixed, false);
  assert.throws(() => core.ensureIpcDir(link), /symbolic link/);
  assert.throws(() => core.secureWriteFile(path.join(link, "new"), "bad"), /symbolic link/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  const policyTarget = path.join(dir, "target.json"), policy = path.join(dir, "policy.json");
  fs.writeFileSync(policyTarget, '{}', { mode: 0o644 }); fs.symlinkSync(policyTarget, policy);
  assert.equal(core.readBridgePolicy(policy).mode, "mailbox-only");
  assert.throws(() => core.readSecureFile(policy), /non-regular/);
  assert.equal(fs.statSync(policyTarget).mode & 0o777, 0o644);
});

test("special files reject promptly in isolated write/append/clear/read subprocesses", (t) => {
  const dir = sandbox(t), file = path.join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  for (const method of ["secureWriteFile", "appendFileSecure", "readAndClearFileAtomic", "readSecureFile"]) {
    const run = spawnSync(process.execPath, ["-e", `const c=require(${JSON.stringify(corePath)});try{c.${method}(${JSON.stringify(file)},'xx',{maxBytes:1});process.exit(1)}catch(e){if(!/non-regular/.test(e.message))throw e}`], { timeout: 2000, env: { HOME: dir, PATH: process.env.PATH } });
    assert.equal(run.status, 0, `${method}: ${run.stderr}`);
    assert.equal(fs.lstatSync(file).isFIFO(), true);
  }
});

test("reserved room and member identifiers reject without prototype mutation", (t) => {
  const dir = sandbox(t);
  const run = spawnSync(process.execPath, ["-e", `const c=require(${JSON.stringify(corePath)}),a=require('node:assert/strict'); const before=Object.getOwnPropertyDescriptors(Object.prototype);const options={stateFile:${JSON.stringify(path.join(dir, "state"))},eventsFile:${JSON.stringify(path.join(dir, "events"))}};for(const value of ['__proto__','constructor','toString'])for(const key of ['room','name'])for(const op of ['joinRoom','postRoomMessage','followRoomThread','setRoomNotifications'])a.throws(()=>c[op]({room:'ordinary',name:'worker',content:'hello',threadId:'t',[key]:value},options),/Reserved/);a.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),before);c.joinRoom({room:'ordinary',name:'worker'},options);a.ok(c.readRoomState(options.stateFile).rooms.ordinary.members.worker);`], { timeout: 3000, env: { HOME: dir, PATH: process.env.PATH } });
  assert.equal(run.status, 0, String(run.stderr));
});

test("shell quoting preserves one exact argument without executing substitutions", (t) => {
  const dir = sandbox(t), sentinel = path.join(dir, "sentinel");
  for (const name of ["a'b", 'a"b', "two words", "line\nbreak", `$(touch ${sentinel})`, `\`touch ${sentinel}\``]) {
    const run = spawnSync("/bin/sh", ["-c", `printf '%s' ${core.shellQuote(name)}`], { env: { HOME: dir, PATH: process.env.PATH }, encoding: "utf8", timeout: 2000 });
    assert.equal(run.stdout, name); assert.equal(run.status, 0);
  }
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(core.terminalSafeText("a\nb\tc"), "a\nb\tc");
  assert.doesNotMatch(core.terminalSafeText("\x1b]52;c;bad\x07\x9b2J"), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
});

test("outbound serialization and wire size fail before connection", async () => {
  for (const content of ["a".repeat(70000), "\x01".repeat(12000)]) await assert.rejects(core.sendToSocket("/missing", { content }), /Outbound bridge frame/);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(core.sendToSocket("/missing", cycle), /Cannot serialize/);
  await assert.rejects(core.sendToSocket("/missing", { content: 1n }), /Cannot serialize/);
});

test("receipt streaming decoder preserves all UTF-8 byte splits", async (t) => {
  const dir = sandbox(t), file = path.join(dir, "123.sock");
  const sockets = new Set();
  let split = 1;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.once("data", raw => {
      const msg = JSON.parse(raw.toString());
      const frame = Buffer.from(JSON.stringify(core.createSocketResponse("ack", msg, { fromPid: 1, fromName: "é中😀", fromCwd: dir })) + "\n");
      const start = frame.indexOf(Buffer.from("é中😀"));
      socket.write(frame.subarray(0, start + split));
      setTimeout(() => socket.end(frame.subarray(start + split)), 10);
    });
  });
  await new Promise(resolve => server.listen(file, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  for (split = 1; split < Buffer.byteLength("é中😀"); split++) {
    const receipt = await core.sendToSocket(file, { id: "test", type: "message", content: "hi" }, { requireAck: true });
    assert.equal(receipt.response.fromName, "é中😀");
  }
});

test("rotated journals retain history/dedupe and expired cursors replay visibly", (t) => {
  const dir = sandbox(t), eventsFile = path.join(dir, "events"), cursorsFile = path.join(dir, "cursors");
  const append = id => core.appendBridgeEvent({ eventId: id, messageId: id, acceptedAt: 1000, to: { readerKey: "reader" }, content: id }, { eventsFile, maxBytes: 300 });
  append("first");
  const first = core.readInboxEvents({ readerKey: "reader", eventsFile, cursorsFile });
  core.consumeInboxEvents(first);
  append("second"); append("third");
  assert.deepEqual(core.readBridgeEvents({ eventsFile }).map(e => e.eventId), ["first", "second", "third"]);
  assert.deepEqual(core.readInboxEvents({ readerKey: "reader", eventsFile, cursorsFile }).events.map(e => e.eventId), ["second", "third"]);
  assert.ok(core.findExistingMessageEvent({ id: "first" }, core.readBridgeEvents({ eventsFile }), { readerKey: "reader" }));
  for (const id of ["fourth", "fifth", "sixth"]) append(id);
  const expired = core.readInboxEvents({ readerKey: "reader", eventsFile, cursorsFile });
  assert.equal(expired.cursorExpired, true);
  assert.ok(expired.events.length > 0);
  const roomEvents = path.join(dir, "rooms");
  for (const id of ["a", "b", "c"]) core.appendRoomEvent({ eventId: id, room: "test", content: "hello" }, { eventsFile: roomEvents, maxBytes: 200 });
  assert.deepEqual(core.readRoomEvents({ eventsFile: roomEvents }).map(e => e.eventId), ["a", "b", "c"]);
});

test("room replacement is atomic on rename failure and malformed state is preserved", (t) => {
  const dir = sandbox(t), file = path.join(dir, "state");
  const state = { schemaVersion: 1, rooms: {} };
  core.writeRoomState(state, file);
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error("injected rename failure"); };
  try { assert.throws(() => core.writeRoomState({ rooms: { other: {} } }, file), /injected/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(core.readRoomState(file), state);
  fs.writeFileSync(file, "{");
  assert.throws(() => core.joinRoom({ room: "ordinary", name: "worker" }, { stateFile: file }), /repair/);
  assert.equal(fs.readFileSync(file, "utf8"), "{");
});

function childCode(dir, code) {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'),c=require(${JSON.stringify(corePath)});${code}`], { env: { HOME: dir, PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => stderr += data);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`child ${code}: ${stderr}`)); }); });
  return { child, done };
}

test("multiprocess registry/status/cursor mutations and journal rotation lose no updates", async (t) => {
  const dir = sandbox(t), paths = core.buildPaths(dir), ready = path.join(dir, "go");
  core.ensureIpcDir(paths.ipcDir);
  // All writers begin together; PIDs remain alive through registry verification.
  const children = Array.from({ length: 6 }, (_, i) => childCode(dir, `while(!fs.existsSync(${JSON.stringify(ready)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);for(let j=0;j<8;j++){c.registerSession({pid:process.pid,name:'worker-${i}',socketPath:c.DEFAULT_PATHS.ipcDir+'/'+process.pid+'.sock'});c.updateRegisteredSession(process.pid,{lastHeartbeatAt:j});c.updateSessionStatus({pid:${i + 1},status:'working'});c.appendBridgeEvent({eventId:'${i}-'+j,to:{readerKey:'reader-${i}'},content:'hello'}, {maxBytes:5000});c.consumeInboxEvents(c.readInboxEvents({readerKey:'reader-${i}'}));}process.stdout.write('ready');setTimeout(()=>{},1500);`));
  t.after(() => children.forEach(({ child }) => child.kill()));
  const doneWriting = children.map(({ child }) => new Promise(resolve => child.stdout.once("data", resolve)));
  fs.writeFileSync(ready, "go");
  await Promise.all(doneWriting);
  assert.equal(core.readRegistry(paths.registryFile).sessions.length, 6);
  assert.equal(Object.keys(core.readBridgeState(paths.stateFile).sessions).length, 6);
  assert.equal(Object.keys(core.readBridgeCursors(paths.cursorsFile)).length, 6);
  const events = core.readBridgeEvents({ eventsFile: paths.eventsFile });
  assert.equal(events.length, 48);
  assert.equal(new Set(events.map(event => event.eventId)).size, 48);
  await Promise.all(children.map(({ done }) => done));
});

test("stale inbox consumer cannot move same-reader cursor backwards", (t) => {
  const dir = sandbox(t), eventsFile = path.join(dir, "events"), cursorsFile = path.join(dir, "cursors");
  core.appendBridgeEvent({ eventId: "a", acceptedAt: 1, to: { readerKey: "r" } }, { eventsFile });
  const old = core.readInboxEvents({ readerKey: "r", eventsFile, cursorsFile });
  core.appendBridgeEvent({ eventId: "b", acceptedAt: 1, to: { readerKey: "r" } }, { eventsFile });
  const newer = core.readInboxEvents({ readerKey: "r", eventsFile, cursorsFile });
  assert.equal(core.consumeInboxEvents(newer), true);
  assert.equal(core.consumeInboxEvents(old), false);
  assert.equal(core.readBridgeCursors(cursorsFile).r.eventId, "b");
});

test("mailbox clear waits for an append with an already-open descriptor", async (t) => {
  const dir = sandbox(t), file = path.join(dir, "mailbox"), opened = path.join(dir, "opened"), go = path.join(dir, "go");
  const writer = childCode(dir, `const original=fs.writeFileSync;fs.writeFileSync=function(fd,...args){if(typeof fd==='number'){original(${JSON.stringify(opened)},'ready');while(!fs.existsSync(${JSON.stringify(go)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return original(fd,...args)};c.appendFileSecure(${JSON.stringify(file)},'delivered');`);
  t.after(() => writer.child.kill());
  for (let i=0; !fs.existsSync(opened) && i<100; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(fs.existsSync(opened));
  const reader = childCode(dir, `process.stdout.write(c.readAndClearFileAtomic(${JSON.stringify(file)}));`);
  t.after(() => reader.child.kill());
  let result = ""; reader.child.stdout.on("data", data => result += data);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(result, "");
  fs.writeFileSync(go, "go");
  await Promise.all([writer.done, reader.done]);
  assert.equal(result, "delivered");
});

test("failed mailbox read preserves the renamed copy", (t) => {
  const dir = sandbox(t), file = path.join(dir, "mailbox");
  core.appendFileSecure(file, "keep");
  let preserved;
  assert.throws(() => core.readAndClearFileAtomic(file, { afterRename: renamed => { preserved = renamed; throw new Error("injected read error"); } }), /preserved/);
  assert.equal(fs.readFileSync(preserved, "utf8"), "keep");
});

test("actual extension handlers cover queue failure/retry, UTF-8, policy, alias, routing and shutdown", (t) => {
  const dir = sandbox(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/extension-harness.cjs")], { env: { HOME: dir, PI_CODING_AGENT_DIR: path.join(dir, "agent"), PATH: process.env.PATH }, timeout: 30000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /extension behavior passed/);
});

test("blank allowlist restrictions never normalize into allow-all", (t) => {
  const dir = sandbox(t), policyFile = path.join(dir, "policy.json");
  for (const key of ["name", "cwd"]) for (const value of ["", "   ", "\t\n", "\x1b\x07", "\x9b"]) {
    const input = { mode: "auto-inject", allowlist: [{ [key]: value }] };
    assert.equal(core.normalizeBridgePolicy(input).mode, "mailbox-only", JSON.stringify(input));
    fs.writeFileSync(policyFile, JSON.stringify(input));
    assert.equal(core.readBridgePolicy(policyFile).mode, "mailbox-only");
  }
  assert.equal(core.normalizeBridgePolicy({ allowlist: [{ pid: undefined }] }).mode, "mailbox-only");
});

test("outbound frame byte boundary includes JSON escaping and permits the exact limit", async (t) => {
  const dir = sandbox(t), file = path.join(dir, "123.sock");
  const message = { id: "boundary", protocol: 1, content: "\x01é中😀" };
  const bytes = Buffer.byteLength(JSON.stringify(message));
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.once("data", () => socket.end()); });
  await new Promise(resolve => server.listen(file, resolve));
  t.after(() => server.close());
  await assert.rejects(core.sendToSocket(file, message, { maxFrameBytes: bytes - 1 }), /Outbound bridge frame/);
  assert.equal(connections, 0);
  assert.equal((await core.sendToSocket(file, message, { maxFrameBytes: bytes })).delivered, true);
  assert.equal(connections, 1);
});

test("room posts without session preserve identity and explicit joins replace it", (t) => {
  const dir = sandbox(t), options = { stateFile: path.join(dir, "state"), eventsFile: path.join(dir, "events") };
  const first = { pid: 123, name: "receiver", cwd: dir, startedAt: 1 };
  const joined = core.joinRoom({ room: "project", name: "alias", kind: "pi", session: first }, options);
  const posted = core.postRoomMessage({ room: "project", from: { name: "alias" }, content: "hello" }, options);
  for (const key of ["kind", "sessionPid", "sessionName", "sessionCwd", "sessionStartedAt"]) assert.equal(posted.member[key], joined.member[key], key);
  const rejoined = core.joinRoom({ room: "project", name: "alias", kind: "cc", session: { ...first, pid: 456, startedAt: 2 } }, options);
  assert.equal(rejoined.member.kind, "cc");
  assert.equal(rejoined.member.sessionPid, 456);
  assert.equal(rejoined.member.sessionStartedAt, 2);
});
