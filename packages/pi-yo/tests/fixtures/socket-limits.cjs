"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
// Runs against both actual receivers. Every owned socket is closed in finally.
module.exports = async function checkSocketLimits(socketPath, checkAccepted) {
  const owned = [];
  async function connect() {
    const socket = net.createConnection(socketPath); owned.push(socket);
    socket.on("error", () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect timeout")), 1000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
    return socket;
  }
  async function waitClosed(socket, timeout) {
    if (socket.destroyed) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket close deadline")), timeout);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  try {
    // More than two yielded batches must survive EOF, including an incomplete tail.
    for (const type of ["ping", "message"]) {
      const socket = await connect();
      const frames = Array.from({ length: 33 }, (_, n) => ({ type, id: `half-${type}-${n}`, fromPid: 456, fromName: "peer", fromCwd: "/peer", content: `half-message-body-${n}`, timestamp: Date.now() }));
      let output = "";
      socket.on("data", chunk => output += chunk);
      const closed = waitClosed(socket, 2000);
      socket.end(frames.map(frame => JSON.stringify(frame)).join("\n") + '\n{"incomplete":');
      await closed;
      const responses = output.trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(responses.map(response => response.ackFor), frames.map(frame => frame.id));
      assert.ok(responses.every(response => response.ok === true && response.type === (type === "ping" ? "pong" : "ack")));
      if (type === "message") checkAccepted(frames);
    }
    // Allow the previous sender's half-close to reach receiver cleanup.
    await delay(40);
    const sockets = [];
    for (let n = 0; n < 32; n++) sockets.push(await connect());
    const excess = await connect(); await waitClosed(excess, 700);
    assert.equal(sockets.filter(socket => !socket.destroyed).length, 32);
    sockets[0].destroy(); await delay(40);
    const reused = await connect(); await delay(30); assert.equal(reused.destroyed, false);
    for (const socket of sockets.slice(1)) socket.destroy();
    await waitClosed(reused, 2300); // idle timeout
    const trickle = await connect(); trickle.resume();
    const started = performance.now();
    const timer = setInterval(() => { if (!trickle.destroyed) trickle.write(" "); }, 100);
    try { await waitClosed(trickle, 5600); } finally { clearInterval(timer); }
    assert.ok(performance.now() - started >= 4500, "trickle should avoid idle timeout");
    const exact = await connect();
    const base = { id: "exact-frame", type: "ping", fromPid: 456, fromName: "peer", fromCwd: "/peer", padding: "" };
    base.padding = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(base)));
    const frame = JSON.stringify(base);
    assert.equal(Buffer.byteLength(frame), 65536);
    const ack = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("exact frame pong timeout")), 1200);
      exact.once("data", data => { clearTimeout(timer); resolve(data.toString()); });
    });
    exact.write(frame.slice(0, 100)); await delay(10); exact.write(frame.slice(100) + "\n");
    assert.match(await ack, /pong/); exact.destroy();
    const oversized = await connect(); oversized.write("x".repeat(65537)); await waitClosed(oversized, 1000);
    const nonreader = await connect();
    const ping = JSON.stringify({ id: "ping", type: "ping", fromPid: 456, fromName: "peer", fromCwd: "/peer" }) + "\n";
    // Flood is bounded locally; pause prevents draining the response peer.
    nonreader.pause(); nonreader.write(ping.repeat(600));
    await delay(5200); nonreader.resume(); await waitClosed(nonreader, 1000);
  } finally { for (const socket of owned) socket.destroy(); }
};
