// Shared, deterministic directory walk: relative file paths in sorted order,
// skipping VCS and OS noise (.git, .DS_Store). The scanner and the content
// hasher both use it so they can never disagree about which files belong to a
// skill (a divergence that once made the scanner flag .DS_Store as binary).
//
// An absent top-level directory yields []. Any other read error (a permission
// problem on a subdirectory) is THROWN, never swallowed: a tool that walks a
// skill must not quietly skip files it could not read and then report "clean".

import { readdirSync, lstatSync } from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", ".DS_Store"]);

// Classify a path without following symlinks: "symlink", "dir", "file", or
// "absent". Shared by dev linking and audit.
export function pathType(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return "absent";
    throw err;
  }
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  return "file";
}

export function walkFiles(dir) {
  const out = [];
  walk(dir, "", out, true);
  return out.sort();
}

function walk(dir, prefix, out, top) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (top && err.code === "ENOENT") return; // an absent skill dir is fine
    throw err; // an unreadable directory is surfaced, never silently dropped
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out, false);
    else if (e.isFile()) out.push(rel);
  }
}
