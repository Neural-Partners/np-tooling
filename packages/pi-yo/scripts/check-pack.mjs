import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { smokePi } from "./smoke-pi.mjs";
import { smokeCc } from "./smoke-cc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync("/tmp/yp-");
const env = { HOME: path.join(temp, "home"), PI_CODING_AGENT_DIR: path.join(temp, "home/.pi/agent"), PATH: process.env.PATH, TMPDIR: "/tmp", npm_config_cache: path.join(temp, "cache"), npm_config_ignore_scripts: "true" };
fs.mkdirSync(env.HOME);
function run(command, args, cwd = temp) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.error || result.stderr}`);
  return result.stdout;
}
try {
  const [pack] = JSON.parse(run("npm", ["pack", root, "--json", "--pack-destination", temp]));
  for (const file of pack.files) {
    assert.match(file.path, /^(?:bin\/|lib\/|extensions\/|skills\/|assets\/|scripts\/|tests\/|README\.md$|LICENSE$|package\.json$)/);
    assert.doesNotMatch(file.path, /(?:^|\/)(?:node_modules|\.env|\.pi|registry\.json|.*\.tgz)(?:\/|$)/);
  }
  for (const bin of ["pimsg", "pi-cc-bridge", "piroom"]) assert.equal(pack.files.find(file => file.path === `bin/${bin}`)?.mode & 0o111, 0o111);
  for (const resource of ["extensions/pi-bridge.ts", "lib/pi-bridge-core.js", "skills/pi-yo/SKILL.md", "LICENSE"]) assert.ok(pack.files.some(file => file.path === resource));
  console.log(JSON.stringify({ filename: pack.filename, integrity: pack.integrity, files: pack.files.map(file => file.path) }));
  const prefix = path.join(temp, "install"); fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(prefix, "package.json"), '{"name":"pi-yo-pack-check","private":true,"version":"1.0.0"}');
  run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-fund", "--no-audit", path.join(temp, pack.filename)], prefix);
  const installed = path.join(prefix, "node_modules", "@neuralpartners", "pi-yo");
  assert.equal(fs.existsSync(path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent")), false, "optional host peer must not auto-install Pi");
  for (const [bin, args] of [["pimsg", ["list"]], ["piroom", ["--help"]], ["pi-cc-bridge", ["inbox"]]]) run(path.join(prefix, "node_modules", ".bin", bin), args, prefix);
  run(process.execPath, [path.join(installed, "scripts", "smoke-rooms.js")], prefix);
  await smokeCc(installed);
  const audit = JSON.parse(run("npm", ["audit", "--omit=dev", "--json"], prefix));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  console.log("Clean tarball install audit: 0 vulnerabilities; standalone bins and room smoke passed");
  await smokePi(installed);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
