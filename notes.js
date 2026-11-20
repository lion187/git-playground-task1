#!/usr/bin/env node
const { parseArgs } = require("util");
const readline = require("readline");
const store = require("./lib/store");
const config = require("./lib/config");

class UsageError extends Error {}

// ---------- helpers ----------

function parseId(value, usage) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(value).trim()) {
    throw new UsageError(`Usage: notes ${usage}`);
  }
  return id;
}

function splitTags(value) {
  if (!value) return [];
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

function formatNote(note, idWidth) {
  const id = `#${note.id}`.padStart(idWidth + 1);
  const box = note.done ? "[x]" : "[ ]";
  const date = note.createdAt ? note.createdAt.slice(0, 10) : "          ";
  const tags = note.tags.length ? "  " + note.tags.map((t) => `+${t}`).join(" ") : "";
  return `${id}  ${box}  ${date}  ${note.text}${tags}`;
}

function printNotes(notes, asJson) {
  if (asJson) {
    console.log(JSON.stringify(notes, null, 2));
    return;
  }
  const idWidth = Math.max(...notes.map((n) => String(n.id).length));
  for (const note of notes) console.log(formatNote(note, idWidth));
}

// Only read stdin when something is actually piped or redirected in, so a bare
// `notes add` in a script or cron job doesn't hang waiting for input.
function stdinHasData() {
  try {
    const stat = require("fs").fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function notFound(id) {
  console.error(`No note #${id} found`);
  process.exitCode = 1;
}

// ---------- commands ----------

const commands = {
  add: {
    usage: "add <text> [--tag a,b]   (or pipe text in: echo hi | notes add)",
    options: { tag: { type: "string", short: "t" } },
    async run(args, opts) {
      let text = args.join(" ").trim();
      if (!text && stdinHasData()) text = (await readStdin()).trim();
      if (!text) throw new UsageError(`Usage: notes ${this.usage}`);
      const note = store.add(text, splitTags(opts.tag));
      console.log(`Added note #${note.id}: ${note.text}`);
    },
  },

  list: {
    usage: "list [--done | --open] [--tag name] [--json]",
    options: {
      done: { type: "boolean" },
      open: { type: "boolean" },
      tag: { type: "string", short: "t" },
      json: { type: "boolean" },
    },
    run(args, opts) {
      let notes = store.all();
      if (opts.done) notes = notes.filter((n) => n.done);
      if (opts.open) notes = notes.filter((n) => !n.done);
      if (opts.tag) notes = notes.filter((n) => n.tags.includes(opts.tag));
      if (notes.length === 0) {
        if (opts.json) console.log("[]");
        else if (store.all().length === 0) console.log("No notes yet. Add one with: notes add <text>");
        else console.log("No notes match.");
        return;
      }
      printNotes(notes, opts.json);
    },
  },

  search: {
    usage: "search <term> [--json]",
    options: { json: { type: "boolean" } },
    run(args, opts) {
      const term = args.join(" ").trim();
      if (!term) throw new UsageError(`Usage: notes ${this.usage}`);
      const notes = store.search(term);
      if (notes.length === 0) {
        if (opts.json) console.log("[]");
        else console.log(`No notes match "${term}".`);
        return;
      }
      printNotes(notes, opts.json);
    },
  },

  edit: {
    usage: "edit <id> <new text>",
    run(args) {
      const id = parseId(args[0], this.usage);
      const text = args.slice(1).join(" ").trim();
      if (!text) throw new UsageError(`Usage: notes ${this.usage}`);
      const note = store.update(id, { text });
      if (!note) return notFound(id);
      console.log(`Updated note #${id}: ${note.text}`);
    },
  },

  done: {
    usage: "done <id>",
    run(args) {
      const id = parseId(args[0], this.usage);
      const note = store.update(id, { done: true });
      if (!note) return notFound(id);
      console.log(`Marked note #${id} as done`);
    },
  },

  undone: {
    usage: "undone <id>",
    run(args) {
      const id = parseId(args[0], this.usage);
      const note = store.update(id, { done: false });
      if (!note) return notFound(id);
      console.log(`Marked note #${id} as not done`);
    },
  },

  tag: {
    usage: "tag <id> <tag>[,<tag>...]   (prefix a tag with - to remove it)",
    run(args) {
      const id = parseId(args[0], this.usage);
      const changes = splitTags(args.slice(1).join(","));
      if (changes.length === 0) throw new UsageError(`Usage: notes ${this.usage}`);
      const existing = store.get(id);
      if (!existing) return notFound(id);
      const tags = new Set(existing.tags);
      for (const t of changes) {
        if (t.startsWith("-")) tags.delete(t.slice(1));
        else tags.add(t);
      }
      const note = store.update(id, { tags: [...tags] });
      console.log(`Tags for #${id}: ${note.tags.length ? note.tags.join(", ") : "(none)"}`);
    },
  },

  delete: {
    usage: "delete <id>",
    run(args) {
      const id = parseId(args[0], this.usage);
      if (!store.remove(id)) return notFound(id);
      console.log(`Deleted note #${id}`);
    },
  },

  clear: {
    usage: "clear [--yes]",
    options: { yes: { type: "boolean", short: "y" } },
    async run(args, opts) {
      const count = store.all().length;
      if (count === 0) {
        console.log("No notes to clear.");
        return;
      }
      if (!opts.yes && !(await confirm(`Delete all ${count} notes?`))) {
        console.log("Cancelled. (Use --yes to skip the prompt.)");
        return;
      }
      store.clear();
      console.log(`Deleted ${count} notes.`);
    },
  },

  help: {
    usage: "help",
    run() {
      printHelp();
    },
  },
};

const aliases = { a: "add", ls: "list", s: "search", e: "edit", rm: "delete", del: "delete" };

function printHelp() {
  console.log("Usage: notes <command> [options]\n");
  console.log("Commands:");
  for (const cmd of Object.values(commands)) console.log(`  notes ${cmd.usage}`);
  console.log("\nAliases: " + Object.entries(aliases).map(([a, c]) => `${a}=${c}`).join(", "));
  console.log(`\nNotes file: ${store.FILE}`);
  if (config.SESSION_TIMEOUT_MINUTES !== undefined) {
    console.log(`(Session locks after ${config.SESSION_TIMEOUT_MINUTES} minutes of inactivity.)`);
  }
}

// ---------- entry point ----------

async function main() {
  const [rawCommand, ...rest] = process.argv.slice(2);

  if (!rawCommand || rawCommand === "-h" || rawCommand === "--help") {
    printHelp();
    return;
  }

  const name = aliases[rawCommand] || rawCommand;
  const command = commands[name];
  if (!command) {
    console.error(`Unknown command '${rawCommand}'. Run 'notes help' for the list.`);
    process.exitCode = 1;
    return;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    console.log(`Usage: notes ${command.usage}`);
    return;
  }

  // Commands without options take their arguments as-is, so text like
  // `edit 3 -5 degrees` or `tag 2 -urgent` isn't mistaken for a flag.
  const { values, positionals } = command.options
    ? parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true })
    : { values: {}, positionals: rest };

  if (values.done && values.open) throw new UsageError("Use either --done or --open, not both.");

  await command.run(positionals, values);
}

main().catch((err) => {
  if (err instanceof UsageError || err.code?.startsWith?.("ERR_PARSE_ARGS")) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
});
