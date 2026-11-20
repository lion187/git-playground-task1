const fs = require("fs");
const os = require("os");
const path = require("path");

// Notes live in the user's data folder, not next to the code, so a global
// install or upgrade never loses them. NOTES_DIR overrides (handy for tests).
const DATA_DIR =
  process.env.NOTES_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "notes");
const FILE = path.join(DATA_DIR, "notes.json");

const SCHEMA_VERSION = 2;

function emptyStore() {
  return { version: SCHEMA_VERSION, nextId: 1, notes: [] };
}

// Fill in fields that notes saved by older versions don't have.
function migrate(data) {
  if (data.version === SCHEMA_VERSION) return data;
  data.notes = (data.notes || []).map((n) => ({
    id: n.id,
    text: n.text,
    done: n.done ?? false,
    tags: n.tags ?? [],
    createdAt: n.createdAt ?? null,
    ...(n.updatedAt ? { updatedAt: n.updatedAt } : {}),
  }));
  data.nextId = data.nextId ?? Math.max(0, ...data.notes.map((n) => n.id)) + 1;
  data.version = SCHEMA_VERSION;
  return data;
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyStore();
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Never fall back to an empty store here: the next save would wipe the file.
    throw new Error(`Notes file is corrupt: ${FILE} (left untouched — fix or move it)`);
  }
  return migrate(data);
}

// Write to a temp file, then rename: a crash mid-write can't leave a half-written file.
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, FILE);
}

function all() {
  return load().notes;
}

function get(id) {
  return all().find((n) => n.id === id) || null;
}

function add(text, tags = []) {
  const data = load();
  const note = {
    id: data.nextId,
    text,
    done: false,
    tags,
    createdAt: new Date().toISOString(),
  };
  data.notes.push(note);
  data.nextId += 1;
  save(data);
  return note;
}

function update(id, changes) {
  const data = load();
  const note = data.notes.find((n) => n.id === id);
  if (!note) return null;
  Object.assign(note, changes, { updatedAt: new Date().toISOString() });
  save(data);
  return note;
}

function remove(id) {
  const data = load();
  const index = data.notes.findIndex((n) => n.id === id);
  if (index === -1) return false;
  data.notes.splice(index, 1);
  save(data);
  return true;
}

function clear() {
  const data = load();
  const count = data.notes.length;
  data.notes = [];
  save(data); // keeps nextId, so ids are never reused
  return count;
}

function search(term) {
  const t = term.toLowerCase();
  return all().filter(
    (n) => n.text.toLowerCase().includes(t) || n.tags.some((tag) => tag.toLowerCase() === t)
  );
}

module.exports = { FILE, all, get, add, update, remove, clear, search };
