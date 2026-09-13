"use strict";
const fs = require("node:fs");
const path = require("node:path");
const core = require("../../lib/pi-bridge-core.js");
const config = JSON.parse(process.argv[2]);
const seen = new Set();
function barrier(stage, claim) {
  if (!config.barriers?.includes(stage) || seen.has(stage)) return;
  seen.add(stage);
  const checkpoint = path.join(config.home, `${config.label}.${stage}`);
  fs.writeFileSync(`${checkpoint}.tmp`, JSON.stringify({ pid: process.pid, id: claim?.id, ticket: claim?.ticket?.toString() }));
  fs.renameSync(`${checkpoint}.tmp`, checkpoint);
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(path.join(config.home, `${config.label}.${stage}.go`))) {
    if (performance.now() > deadline) throw new Error(`Barrier timeout: ${stage}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
if (config.partialCleanup) {
  const original = fs.rmdirSync;
  fs.rmdirSync = function(file, ...args) {
    const result = original.call(this, file, ...args);
    if (String(file).includes(config.partialCleanup) && path.basename(file).startsWith("ticket-")) barrier("partial-cleanup");
    return result;
  };
}
core.withRegistryLock(config.resource, () => {
  barrier("callback-entered");
  const occupancy = path.join(config.home, "occupancy");
  const fd = fs.openSync(occupancy, "wx");
  fs.appendFileSync(path.join(config.home, "trace"), `enter ${config.label}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  fs.appendFileSync(path.join(config.home, "trace"), `exit ${config.label}\n`);
  fs.closeSync(fd); fs.unlinkSync(occupancy);
}, { timeoutMs: config.timeoutMs ?? 8000, retryMs: 5, onCheckpoint: barrier });
