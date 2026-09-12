import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function smokePi(packageRoot = sourceRoot) {
  const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const host = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8"));
  assert.equal(host.version, "0.85.1");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yo-rpc-"));
  const agentDir = path.join(temp, ".pi", "agent"), ipc = path.join(agentDir, "ipc");
  fs.mkdirSync(ipc, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "bridge-policy.json"), JSON.stringify({ mode: "mailbox-only", focus: { mode: "never" } }));
  const env = { HOME: temp, PATH: process.env.PATH, TMPDIR: os.tmpdir(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = spawn(process.execPath, [path.join(hostRoot, host.bin.pi), "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", packageRoot], { cwd: temp, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let buffer = "", stderr = "", exit;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch { stderr += `Invalid RPC JSON: ${line}\n`; } }
    }
  });
  child.stderr.on("data", chunk => stderr += chunk);
  const exited = new Promise(resolve => { child.on("error", error => { stderr += error.message; resolve(); }); child.on("exit", (code, signal) => { exit = { code, signal }; resolve(); }); });
  const deadline = Date.now() + 20000;
  async function wait(check) {
    while (Date.now() < deadline) {
      const result = check(); if (result) return result;
      if (exit) throw new Error(`Pi exited early: ${JSON.stringify(exit)} ${stderr}`);
      await delay(20);
    }
    throw new Error(`RPC smoke timed out: ${stderr}`);
  }
  let sequence = 0;
  async function rpc(type, extra = {}) {
    const id = String(++sequence);
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    const response = await wait(() => events.find(event => event.type === "response" && event.id === id));
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }
  try {
    const commands = (await rpc("get_commands")).data.commands;
    assert.ok(commands.some(command => command.name === "room"));
    // Loading the package root must also resolve its declared skill resource.
    assert.ok(commands.some(command => command.name === "skill:pi-yo"));
    await rpc("prompt", { message: "/room join qa as observer" });
    await rpc("prompt", { message: "/room dnd qa on" });
    await rpc("prompt", { message: "/bridge-list" });
    await wait(() => fs.existsSync(path.join(ipc, `${child.pid}.sock`)));
    const send = spawnSync(process.execPath, [path.join(packageRoot, "bin/pimsg"), String(child.pid), "synthetic mailbox smoke"], { cwd: temp, env, encoding: "utf8", timeout: 5000 });
    assert.equal(send.status, 0, send.stderr);
    assert.match(send.stdout, /ACK received/);
    await wait(() => events.some(event => /held in bridge mailbox/.test(event.message || "")));
    assert.ok(events.filter(event => event.method === "notify").every(event => ["info", "warning", "error"].includes(event.notifyType)));
    assert.ok(events.every(event => !/Esc closes|Ctrl\+C exits/.test(event.message || "")));
    assert.equal(events.some(event => event.type === "agent_start"), false, "smoke must never trigger a model turn");
    assert.equal(events.some(event => event.type === "extension_error"), false);
    const state = JSON.parse(fs.readFileSync(path.join(ipc, "room-state.json"), "utf8"));
    assert.equal(state.rooms.qa.members.observer.dnd, true);
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(killTimer);
    try {
      assert.equal(fs.existsSync(path.join(ipc, `${child.pid}.sock`)), false, "Pi left its socket behind");
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  console.log(`Node ${process.version}; Pi ${host.version} offline package/RPC/mailbox/shutdown smoke passed: ${packageRoot}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await smokePi(process.argv[2]);
