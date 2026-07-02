// Content hashing and pin verification (THREAT-MODEL #2).
//
// chopz pins each skill it installs to a content hash of its own, recorded in
// `~/.agents/.chopz-pins.json`. Later it can recompute and compare to catch a
// silent change to an installed skill (a good skill that gets a malicious
// update, vectors 4 and 7). This is chopz's own baseline, not upstream's
// `skillFolderHash`, so it does not depend on matching `skills`' algorithm.
//
// What this does NOT do yet: resolve `@latest`/branch refs to an immutable SHA
// at fetch time, or diff-and-approve before deploy. Those need chopz to own the
// fetch (see the deferred review gate). Pinning the installed bytes catches the
// "it changed after I installed it" case, which is the core of the threat.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { walkFiles, writeJson } from "./walk.js";

const PINS_VERSION = 1;

// A deterministic sha256 over a skill folder: every file's relative path, byte
// length, and bytes, in sorted path order (from the shared walk, which skips
// .git / .DS_Store noise). Length-prefixing keeps it unambiguous (file "a"+"b"
// cannot collide with file "ab").
export function hashSkillFolder(dir) {
  const h = createHash("sha256");
  for (const rel of walkFiles(dir)) {
    const buf = readFileSync(path.join(dir, rel));
    h.update(`${rel}\n`);
    h.update(`${String(buf.length)}\n`);
    h.update(buf);
  }
  return h.digest("hex");
}

// --- pin record ------------------------------------------------------------

export function loadPins(file) {
  if (!existsSync(file)) return { version: PINS_VERSION, pins: {} };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`pin record ${file} is not valid JSON: ${err.message}`);
  }
  if (typeof data !== "object" || data === null || typeof data.pins !== "object" || data.pins === null) {
    throw new Error(`pin record ${file} is malformed`);
  }
  return data;
}

// Pin a skill to the current hash of its installed folder.
export function pin(file, skill, dir, source, now = () => new Date().toISOString()) {
  const state = loadPins(file);
  state.pins[skill] = { hash: hashSkillFolder(dir), source, pinnedAt: now() };
  writeJson(file, state);
  return state.pins[skill].hash;
}

// Recompute and compare against a recorded hash.
export function verifyPin(dir, recordedHash) {
  const current = hashSkillFolder(dir);
  return { ok: current === recordedHash, current };
}
