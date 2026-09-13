import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function smokeCc(packageRoot = sourceRoot) {
  const home = fs.realpathSync(fs.mkdtempSync("/tmp/ys-"));
  const env = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PATH: process.env.PATH, TMPDIR: "/tmp" };
  const core = createRequire(import.meta.url)(path.join(packageRoot, "lib/pi-bridge-core.js"));
  let ownedPid;
  function run(bin, args) {
    const result = spawnSync(process.execPath, [path.join(packageRoot, "bin", bin), ...args], { cwd: home, env, encoding: "utf8", timeout: 6000 });
    assert.equal(result.status, 0, `${bin}: ${result.error || result.stderr}`);
    return result.stdout;
  }
  try {
    const started = run("pi-cc-bridge", ["start"]);
    ownedPid = Number(started.match(/started\s+pid:(\d+)/)?.[1]);
    assert.ok(ownedPid, started);
    const [entry] = core.readRegistry(core.buildPaths(home).registryFile).sessions;
    assert.equal(entry.pid, ownedPid);
    assert.equal(entry.lifecycle, "adopted");
    assert.match(run("pimsg", [String(ownedPid), "packed immediate message"]), /ACK received/);
    assert.match(run("pi-cc-bridge", ["mailbox"]), /packed immediate message/);
    assert.match(run("pi-cc-bridge", ["status"]), /is running/);
    assert.match(run("pi-cc-bridge", ["stop"]), /Stopped/);
    assert.deepEqual(core.readRegistry(core.buildPaths(home).registryFile).sessions, []);
    assert.equal(fs.existsSync(entry.socketPath), false);
    for (let i = 0; i < 100 && core.classifyOwnerPid(ownedPid) !== "dead"; i++) await delay(10);
    assert.equal(core.classifyOwnerPid(ownedPid), "dead");
    ownedPid = undefined;
    console.log(`CC verified start/immediate delivery/stop/cleanup smoke passed: ${packageRoot}`);
  } finally {
    // Only the PID returned by this smoke's own launch, not arbitrary registry metadata.
    if (ownedPid) { try { process.kill(ownedPid, "SIGKILL"); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await smokeCc(process.argv[2]);
