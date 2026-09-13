"use strict";
// Test-only fault injection, loaded explicitly via NODE_OPTIONS in disposable children.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const core = require("../../lib/pi-bridge-core.js");
const home = process.env.HOME;
function stopped(stage) {
  const file = path.join(home, stage);
  fs.writeFileSync(`${file}.next`, String(process.pid));
  fs.renameSync(`${file}.next`, file);
  process.kill(process.pid, "SIGSTOP");
}
if (process.env.__PI_CC_BRIDGE_DAEMON !== "1" && process.env.YO_TEST_FAULT === "parent-spawn-stop") {
  const cp = require("node:child_process"), spawn = cp.spawn;
  cp.spawn = (...args) => { stopped("spawn-stopped"); return spawn(...args); };
}
if (process.env.__PI_CC_BRIDGE_DAEMON === "1") {
  fs.writeFileSync(path.join(home, `child-${process.pid}`), "");
  const fault = process.env.YO_TEST_FAULT;
  if (fault === "prepared-stop") {
    const send = process.send.bind(process);
    process.send = (message, ...args) => {
      if (message.action === "prepared") stopped("prepared-stopped");
      return send(message, ...args);
    };
  }
  if (fault === "child-predecessor-stop") {
    const acquire = core.acquireOwnership;
    core.acquireOwnership = (resource, options) => {
      stopped("before-acquire");
      return acquire(resource, { ...options, onPredecessor(other) {
        stopped("predecessor-stopped");
        options.onPredecessor(other);
      } });
    };
  }
  if (fault === "claim-stop" || fault === "claim-created-stop") {
    const acquire = core.acquireOwnership;
    core.acquireOwnership = (resource, options) => acquire(resource, { ...options, onCheckpoint(stage) {
      if (stage === (fault === "claim-stop" ? "ticket-published" : "claim-created")) stopped("claim-stopped");
    } });
  }
  if (fault === "bind-pause") {
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function(socketPath, ...args) {
      fs.writeFileSync(path.join(home, "bind-path"), socketPath);
      stopped("bind-stopped");
      return listen.call(this, socketPath, ...args);
    };
  }
  if (fault === "bind") net.Server.prototype.listen = function() { throw new Error("injected bind failure"); };
  if (fault === "bound-stop") core.registerSession = () => stopped("bound-stopped");
  if (fault === "registration") core.registerSession = () => { throw new Error("injected registration failure"); };
  if (fault === "state") core.updateSessionStatus = () => { throw new Error("injected state failure"); };
  if (fault === "readiness") {
    const write = net.Socket.prototype.write;
    net.Socket.prototype.write = function(chunk, ...args) {
      if (typeof chunk === "string" && chunk.includes('"ccProtocol":"pi-cc/1"')) return true; // lose response
      return write.call(this, chunk, ...args);
    };
  }
  if (fault === "disconnect") {
    const send = process.send.bind(process);
    process.send = (message, ...args) => {
      if (message.action === "prepared") { process.disconnect(); return; }
      return send(message, ...args);
    };
  }
  if (fault === "stop-publication-failure") {
    const update = core.updateRegisteredSession;
    core.updateRegisteredSession = (pid, patch, ...args) => {
      if (patch.lifecycle === "stopping") throw new Error("injected stopping publication failure");
      return update(pid, patch, ...args);
    };
  }
  if (fault === "stop-cleanup" || fault === "stop-publication-failure") {
    const unregister = core.unregisterSession;
    core.unregisterSession = (...args) => { stopped("cleanup-stopped"); return unregister(...args); };
  }
}
