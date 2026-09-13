"use strict";

// Pure parsing: callers may only mutate state after this returns successfully.
function parseCommand(argv, schemas, defaultCommand) {
  const args = [...argv];
  const command = args.length ? args.shift() : defaultCommand;
  if (!command.trim()) throw new Error("Blank command");
  const schema = Object.hasOwn(schemas, command) ? schemas[command] : undefined;
  if (!schema) throw new Error(`Unknown command: ${command}`);
  const options = {}, positionals = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--" && schema.literal) {
      if (!positionals.length) throw new Error("Room must precede the literal-message delimiter");
      positionals.push(...args.slice(i + 1)); break;
    }
    if (token.startsWith("-")) {
      if (!Object.hasOwn(schema.flags || {}, token)) throw new Error(`Unknown option: ${token}`);
      if (Object.hasOwn(options, token)) throw new Error(`Duplicate option: ${token}`);
      const type = schema.flags[token];
      if (type === "boolean") options[token] = true;
      else {
        const value = args[++i];
        if (value === undefined || !value.trim() || value.startsWith("-")) throw new Error(`Missing/blank value for ${token}`);
        options[token] = value;
      }
    } else {
      if (!token.trim()) throw new Error("Blank positional argument");
      positionals.push(token);
    }
  }
  if (positionals.length < (schema.min || 0) || positionals.length > (schema.max ?? schema.min ?? 0)) throw new Error(`Unexpected arguments for ${command}`);
  return { command, options, positionals };
}

const roomSchemas = {
  join: { min: 1, flags: { "--name": "value", "--kind": "value" } },
  post: { min: 2, max: Infinity, literal: true, flags: { "--name": "value", "--thread": "value", "--urgent": "boolean" } },
  follow: { min: 2, flags: { "--name": "value" } },
  dnd: { min: 1, max: 2, flags: { "--name": "value" } },
  list: {},
  manager: { min: 1, flags: { "--once": "boolean", "--interval": "value" } },
  "--help": {}, "-h": {},
};
const ccSchemas = {
  start: {}, stop: {}, status: {}, mailbox: {},
  inbox: { flags: { "--consume": "boolean", "--all": "boolean", "--format": "value" } },
  state: { max: 1, flags: { "--all": "boolean" } },
};
function parseRoomCommand(argv, core, defaultName) {
  const parsed = parseCommand(argv, roomSchemas, "--help");
  const { command, options, positionals } = parsed;
  if (!["--help", "-h", "list"].includes(command)) {
    core.normalizeRoomId(positionals[0]);
    if (command !== "manager") {
      parsed.name = options["--name"] ?? defaultName;
      core.normalizeRoomMemberId(parsed.name);
    }
  }
  if (options["--kind"] !== undefined && !["pi", "cc", "human"].includes(options["--kind"])) throw new Error("kind must be pi|cc|human");
  if (command === "dnd" && !["on", "off", "status"].includes(positionals[1] ?? "status")) throw new Error("DND action must be on|off|status");
  if (command === "post") core.parseRoomMessageDirectives(positionals.slice(1).join(" "));
  const thread = command === "follow" ? positionals[1] : options["--thread"];
  if (thread !== undefined && (Buffer.byteLength(thread) > 256 || /[\x00-\x20\x7f-\x9f]/.test(thread))) throw new Error("Invalid thread identifier");
  if (options["--interval"] !== undefined && (!/^[0-9]+$/.test(options["--interval"]) || !Number.isSafeInteger(Number(options["--interval"])) || Number(options["--interval"]) < 251 || Number(options["--interval"]) > 2147483647)) throw new Error("interval must be an integer from 251 to 2147483647");
  return parsed;
}
function parseCcCommand(argv) {
  const parsed = parseCommand(argv, ccSchemas, "start");
  const { command, options, positionals } = parsed;
  if (command === "inbox") {
    if (options["--format"] !== undefined && !["text", "hook"].includes(options["--format"])) throw new Error("format must be text|hook");
    if (options["--all"] && options["--format"] === "hook") throw new Error("inbox --all is manual text inspection only");
  }
  if (command === "state" && options["--all"] && positionals.length) throw new Error("state accepts a target OR --all");
  return parsed;
}
module.exports = { parseRoomCommand, parseCcCommand };
