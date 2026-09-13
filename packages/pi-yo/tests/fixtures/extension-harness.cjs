"use strict";
// Executes the actual extension factory and handlers without a model or host state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createRequire } = require("node:module");
const ts = require("typescript");
const source = path.resolve(__dirname, "../../extensions/pi-bridge.ts");
const compiled = ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exportsObject = {};
new Function("require", "exports", compiled)(createRequire(source), exportsObject);
const core = require("../../lib/pi-bridge-core.js");
const paths = core.DEFAULT_PATHS;
const handlers = new Map(), commands = new Map(), tools = new Map(), notices = [], injected = [];
let throwDelivery = false;
const pi = {
  on: (name, fn) => handlers.set(name, fn),
  registerCommand: (name, definition) => commands.set(name, definition),
  registerTool: definition => tools.set(definition.name, definition),
  getSessionName: () => "backend",
  sendUserMessage: (content, options) => { if (throwDelivery) throw new Error("injected queue failure"); injected.push({ content, options }); },
};
const ctx = { cwd: process.env.HOME, isIdle: () => true, hasUI: true, mode: "rpc", ui: { notify: (text, level) => notices.push({ text, level }) }, sessionManager: { getSessionFile: () => undefined } };
exportsObject.default(pi);
const socketPath = path.join(paths.ipcDir, `${process.pid}.sock`);
const msg = { id: "retry", type: "message", fromPid: 123, fromName: "sender", fromCwd: process.env.HOME, content: "é中😀\nnormal\ttab\x1b]52;c;bad\x07\x9b2J", timestamp: Date.now() };
async function send(message = msg) { return core.sendToSocket(socketPath, message, { requireAck: true, ackTimeoutMs: 100 }); }
async function run() {
  core.ensureIpcDir(paths.ipcDir);
  fs.mkdirSync(socketPath);
  await assert.rejects(handlers.get("session_start")({}, ctx));
  fs.rmdirSync(socketPath);
  await handlers.get("session_start")({}, ctx);
  const rosterTarget = path.join(process.env.HOME, "roster-target.json");
  fs.writeFileSync(rosterTarget, "{}", { mode: 0o644 });
  fs.symlinkSync(rosterTarget, path.join(process.env.HOME, ".pi/agent/bridge-roster.json"));
  await commands.get("yo").handler("list", ctx);
  assert.equal(fs.statSync(rosterTarget).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(rosterTarget, "utf8"), "{}");
  throwDelivery = true;
  await assert.rejects(send(), /ACK/);
  assert.equal(core.readBridgeEvents().length, 0);
  throwDelivery = false;
  assert.equal((await send()).response.duplicate, false);
  assert.equal((await send()).response.duplicate, true);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content, /not an instruction from the user/);
  assert.doesNotMatch(injected[0].content, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  // Every split of representative multibyte content traverses the actual Pi receiver.
  const marker = Buffer.from("é中😀");
  const splitIds = [];
  for (let split = 1; split < marker.length; split++) {
    const id = `split-${split}`;
    splitIds.push(id);
    const frame = Buffer.from(JSON.stringify({ ...msg, id }) + "\n");
    const start = frame.indexOf(marker);
    assert.ok(start >= 0, "Unicode marker must occur literally in the JSON frame");
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("timeout")); });
      socket.on("error", reject);
      socket.once("data", () => { socket.destroy(); resolve(); });
      socket.on("connect", () => { socket.write(frame.subarray(0, start + split)); setTimeout(() => socket.write(frame.subarray(start + split)), 5); });
    });
  }
  const accepted = core.readBridgeEvents().filter(event => event.kind === "message.accepted");
  assert.deepEqual(accepted.map(event => event.messageId), [msg.id, ...splitIds]);
  assert.equal(accepted.length, marker.length);
  for (const event of accepted) assert.equal(event.content, msg.content, event.messageId);
  const policyFile = path.join(process.env.HOME, ".pi/agent/bridge-policy.json");
  fs.writeFileSync(policyFile, "{");
  const before = injected.length;
  assert.equal((await send({ ...msg, id: "held" })).acked, true);
  assert.equal(injected.length, before);
  assert.ok(notices.some(notice => /Invalid bridge policy/.test(notice.text)));
  const mailbox = path.join(paths.ipcDir, `${process.pid}.mailbox`);
  await commands.get("bridge-mailbox").handler("", ctx);
  core.appendMailbox(mailbox, "x".repeat(core.MAILBOX_MAX_BYTES));
  for (const requireAck of [false, true]) await assert.rejects(core.sendToSocket(socketPath, { ...msg, id: "overflow" }, { requireAck }), /Negative ACK.*full/);
  assert.equal(core.readBridgeEvents().some(event => event.messageId === "overflow"), false);
  await commands.get("bridge-mailbox").handler("", { ...ctx, hasUI: false });
  assert.equal(fs.statSync(mailbox).size, core.MAILBOX_MAX_BYTES);
  await commands.get("bridge-mailbox").handler("", ctx);
  assert.ok(notices.some(notice => /Sender must retry/.test(notice.text)));
  assert.equal((await send({ ...msg, id: "overflow" })).response.duplicate, false);
  assert.equal((await send({ ...msg, id: "overflow" })).response.duplicate, true);
  // Policy edits must not reset active usage; use an independent PID.
  const savePolicy = limit => fs.writeFileSync(policyFile, JSON.stringify({ rateLimit: { perSenderPer10s: limit } }));
  savePolicy(2);
  await send({ ...msg, id: "limit-1", fromPid: 789 }); await send({ ...msg, id: "limit-2", fromPid: 789 });
  const admitted = injected.length;
  savePolicy(1); await send({ ...msg, id: "limit-lowered", fromPid: 789 }); assert.equal(injected.length, admitted);
  savePolicy(3); await send({ ...msg, id: "limit-raised", fromPid: 789 }); assert.equal(injected.length, admitted + 1);
  await send({ ...msg, id: "limit-denied", fromPid: 789 }); assert.equal(injected.length, admitted + 1);
  fs.writeFileSync(policyFile, "{");
  await require("./socket-limits.cjs")(socketPath, frames => {
    const accepted = core.readBridgeEvents().filter(event => event.kind === "message.accepted" && event.messageId.startsWith("half-message-"));
    assert.deepEqual(accepted.map(event => event.messageId), frames.map(frame => frame.id));
    const content = fs.readFileSync(mailbox, "utf8");
    for (const frame of frames) assert.ok(content.includes(frame.content + "\n"), frame.id);
  });
  await commands.get("room").handler("join project as principal", ctx);
  await commands.get("room").handler("post project hello", ctx);
  await commands.get("room").handler("follow project thread-one", ctx);
  await commands.get("room").handler("dnd project on", ctx);
  const state = core.readRoomState();
  assert.deepEqual(Object.keys(state.rooms.project.members), ["principal"]);
  const member = state.rooms.project.members.principal;
  assert.equal(member.sessionName, "backend");
  assert.equal(member.dnd, true);
  assert.deepEqual(member.followedThreads, ["thread-one"]);
  assert.equal(core.readRoomEvents().find(event => event.kind === "room.message").from.memberId, "principal");
  // Name, cwd, and generation contradictions cannot route to unrelated sessions.
  member.dnd = false;
  const event = { roomId: "project", mentions: ["principal"], from: { memberId: "other" } };
  const session = core.readRegistry().sessions[0];
  const delivered = [];
  for (const candidate of [{ ...session, name: "unrelated" }, { ...session, startedAt: session.startedAt - 1 }, { ...session, pid: session.pid + 1 }]) {
    const result = await core.deliverRoomAlerts(event, { state, sessions: [candidate], sendToSocket: async () => delivered.push(true) });
    assert.equal(result.deliveries.length, 0);
  }
  const result = await core.deliverRoomAlerts(event, { state, sessions: [session], sendToSocket: async () => ({ acked: true }) });
  assert.equal(result.deliveries.length, 1);
  // Run registered tools through the installed current Pi agent loop with a synthetic
  // in-memory assistant stream. No provider, credentials, or network are involved.
  const hostRoot = require.resolve.paths("@earendil-works/pi-coding-agent").map(base => path.join(base, "@earendil-works/pi-coding-agent")).find(base => fs.existsSync(path.join(base, "package.json")));
  const agentRoot = createRequire(path.join(hostRoot, "package.json")).resolve.paths("@earendil-works/pi-agent-core").map(base => path.join(base, "@earendil-works/pi-agent-core")).find(base => fs.existsSync(path.join(base, "package.json")));
  const { Agent } = await import(require("node:url").pathToFileURL(path.join(agentRoot, "dist/index.js")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(agentRoot, "package.json"))).version, "0.85.1");
  assert.deepEqual([...tools.keys()].sort(), ["update_session_status", "set_session_visibility", "join_chat_room", "post_room_message", "follow_room_thread", "set_room_notifications", "list_chat_rooms", "list_sessions", "send_to_session", "reply_to_session"].sort());
  const warningSocket = path.join(paths.ipcDir, "999999.sock");
  const warningServer = net.createServer(socket => socket.once("data", raw => {
    const message = JSON.parse(raw.toString());
    socket.end(JSON.stringify(core.createSocketResponse("ack", message, { fromPid: process.ppid, fromName: "warning-peer", fromCwd: ctx.cwd }, { journalRecorded: false, warning: "retained journal failed \x1b]52;c;bad\x07" })) + "\n");
  }));
  await new Promise(resolve => warningServer.listen(warningSocket, resolve));
  core.registerSession({ pid: process.ppid, name: "warning-peer", cwd: ctx.cwd, socketPath: warningSocket });
  try {
    for (const tool of ["send_to_session", "reply_to_session"]) {
      const receipt = await tools.get(tool).execute("warning", { target: String(process.ppid), message: "test" }, undefined, undefined, ctx);
      assert.match(receipt.content[0].text, /ACK received.*Warning: retained journal failed/);
      assert.doesNotMatch(receipt.content[0].text, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    }
    const { stdout } = await require("node:util").promisify(require("node:child_process").execFile)(process.execPath, [path.resolve(__dirname, "../../bin/pimsg"), String(process.ppid), "test"], { cwd: ctx.cwd, env: { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, timeout: 2000 });
    assert.match(stdout, /ACK received.*Warning: retained journal failed/);
    assert.doesNotMatch(stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  } finally { await new Promise(resolve => warningServer.close(resolve)); core.unregisterSession(process.ppid); }
  const calls = [
    ["update_session_status", { status: "typo" }, true],
    ["set_session_visibility", { visibility: "typo" }, true],
    ["send_to_session", { target: "missing", message: "hello" }, true],
    ["reply_to_session", { target: "missing", message: "hello" }, true],
    ["update_session_status", { status: "working" }, false],
  ];
  const agent = new Agent({
    initialState: { model: { id: "synthetic", provider: "synthetic", api: "synthetic" }, tools: [...tools.values()].map(tool => ({ ...tool, execute: (id, args, signal, update) => tool.execute(id, args, signal, update, ctx) })) },
    shouldStopAfterTurn: () => true,
    streamFn: () => {
      const message = { role: "assistant", content: calls.map(([name, args], i) => ({ type: "toolCall", id: String(i), name, arguments: args })), stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, result: async () => message };
    },
  });
  await agent.prompt("synthetic test input");
  const results = agent.state.messages.filter(message => message.role === "toolResult");
  assert.equal(results.length, calls.length);
  for (const [i, result] of results.entries()) assert.equal(result.isError, calls[i][2], result.toolName);
  assert.ok(notices.every(notice => ["info", "warning", "error"].includes(notice.level)));
  const open = net.createConnection(socketPath);
  await new Promise(resolve => open.once("connect", resolve));
  const closed = new Promise(resolve => open.once("close", resolve));
  open.on("error", () => {});
  await handlers.get("session_shutdown")({});
  await closed;
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(injected.length, admitted + 1);
  await handlers.get("session_shutdown")({});
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_shutdown")({});
  console.log("extension behavior passed");
}
run().catch(async error => { console.error(error); await handlers.get("session_shutdown")({}); process.exitCode = 1; });
