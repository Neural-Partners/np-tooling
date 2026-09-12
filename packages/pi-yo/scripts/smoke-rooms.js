#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const piroom = path.join(packageRoot, "bin", "piroom");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "piroom-smoke-"));

function run(args) {
  const result = spawnSync(process.execPath, [piroom, ...args], {
    cwd: packageRoot,
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`piroom ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result.stdout.trim();
}

try {
  assert.match(run(["join", "np-pi-smoke", "--name", "principal"]), /joined np-pi-smoke as principal/);
  // State/rendering smoke only; live agent binding/delivery is covered by CLI socket tests.
  assert.match(run(["join", "np-pi-smoke", "--name", "worker", "--kind", "human"]), /joined np-pi-smoke as worker/);

  const posted = run(["post", "np-pi-smoke", "@worker review this !assign @worker", "--name", "principal", "--urgent"]);
  assert.match(posted, /posted to np-pi-smoke thread thr_/);
  const threadId = posted.match(/thread\s+(thr_[^\s]+)/)?.[1];
  assert.ok(threadId, `expected thread id in output: ${posted}`);

  assert.match(run(["follow", "np-pi-smoke", threadId, "--name", "worker"]), new RegExp(`worker follows ${threadId}`));
  assert.match(run(["dnd", "np-pi-smoke", "on", "--name", "worker"]), /worker dnd:on/);

  const snapshot = run(["manager", "np-pi-smoke", "--once"]);
  assert.match(snapshot, /Room: np-pi-smoke/);
  assert.match(snapshot, /principal/);
  assert.match(snapshot, /worker/);
  assert.match(snapshot, /@worker review this !assign @worker/);
  assert.match(snapshot, /dnd:on/);

  console.log("piroom smoke passed");
  console.log(`temporary HOME: ${home}`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
