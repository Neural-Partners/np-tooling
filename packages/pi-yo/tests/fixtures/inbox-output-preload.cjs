"use strict";
// Test-only barriers outside the ownership layout, atomically published.
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.YO_OUTPUT_BARRIER;
const mode = process.env.YO_OUTPUT_MODE;
const originalRename = fs.renameSync;
function mark() {
  fs.writeFileSync(path.join(root, "ready.tmp"), "ready");
  originalRename(path.join(root, "ready.tmp"), path.join(root, "ready"));
}
function pause() {
  mark();
  const deadline = performance.now() + 6000;
  while (!fs.existsSync(path.join(root, "go"))) {
    if (performance.now() >= deadline) throw new Error("test barrier timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
if (["before-commit", "after-commit", "before-stage", "mid-stage"].includes(mode)) {
  const stageFds = new Set();
  const open = fs.openSync, write = fs.writeFileSync;
  fs.openSync = function(file, ...args) {
    const stage = /bridge-hook-[a-f0-9]{64}\.json\.next$/.test(String(file));
    if (stage && mode === "before-stage") pause();
    const fd = open.call(this, file, ...args);
    if (stage) stageFds.add(fd);
    return fd;
  };
  fs.writeFileSync = function(file, content, ...args) {
    if (stageFds.has(file) && mode === "mid-stage") {
      write.call(this, file, String(content).slice(0, 12), ...args);
      pause();
    }
    return write.call(this, file, content, ...args);
  };
  fs.renameSync = function(from, to, ...rest) {
    const state = /bridge-hook-[a-f0-9]{64}\.json$/.test(String(to));
    if (state && mode === "before-commit") pause();
    const result = originalRename.call(this, from, to, ...rest);
    if (state && mode === "after-commit") pause();
    return result;
  };
} else {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(content, ...args) {
    mark();
    if (mode === "never-read") return false;
    const deadline = performance.now() + 6000;
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, "go"))) { clearInterval(timer); write(content, ...args); }
      else if (performance.now() >= deadline) { clearInterval(timer); process.exitCode = 1; }
    }, 5);
    timer.unref();
    return false;
  };
}
