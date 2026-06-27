// Dev linking: link / unlink / sync (the author loop).
//
// `skills add <local-path>` copies, so editing your source after install runs a
// stale copy. `link` replaces each deployed copy of a skill with a symlink to
// the live source, so an edit is live the next time an agent loads it. It is a
// local-dev tool: link repos you author, not untrusted downloads. chopz does
// not police that (a fresh local skill has no remote to check); the one thing
// it does guarantee is that a dev-linked skill is recorded as live/unpinned so
// no integrity op mistakes a live symlink for a reviewed install.
//
// Commands take a context so they are testable without the real `skills` CLI:
//   ctx = {
//     linksFile,                where the dev-link record lives
//     deployDirs(),             -> [dir]  the store + every agent skills dir
//     installCopy(repo, name),  async; lay/restore a copy via `npx skills add`
//     now(),                    -> ISO timestamp (injectable for tests)
//     out(line), err(line),
//   }

import { readlinkSync, rmSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { skillsInRepo } from "./agents.js";
import { pathType } from "./walk.js";

const LINKS_VERSION = 1;

function defaults(ctx) {
  return {
    now: () => new Date().toISOString(),
    out: (s = "") => console.log(s),
    err: (s = "") => console.error(s),
    ...ctx,
  };
}

// --- dev-link record -------------------------------------------------------

export function loadLinks(file) {
  if (!existsSync(file)) return { version: LINKS_VERSION, links: {} };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`dev-link record ${file} is not valid JSON: ${err.message}`);
  }
  if (typeof data !== "object" || data === null || typeof data.links !== "object" || data.links === null) {
    throw new Error(`dev-link record ${file} is malformed`);
  }
  return data;
}

function saveLinks(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

// --- filesystem primitives -------------------------------------------------

// Make `p` a symlink to `target`, replacing whatever is there. Returns
// "unchanged" if it already points at target, else "linked".
export function ensureSymlink(target, p) {
  const t = pathType(p);
  if (t === "symlink" && safeReadlink(p) === target) return "unchanged";
  if (t === "dir") rmSync(p, { recursive: true, force: true });
  else if (t !== "absent") rmSync(p, { force: true });
  mkdirSync(path.dirname(p), { recursive: true });
  symlinkSync(target, p);
  return "linked";
}

function safeReadlink(p) {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

// --- commands --------------------------------------------------------------

export async function link(ctx, repoPath) {
  const c = defaults(ctx);
  const { deployDirs, installCopy, linksFile, now, out, err } = c;

  let skills;
  try {
    skills = skillsInRepo(repoPath);
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  if (skills.length === 0) {
    err(`chopz: no skills found in ${repoPath} (a skill is a directory with a SKILL.md).`);
    return 1;
  }

  let state;
  let dirs;
  try {
    state = loadLinks(linksFile);
    dirs = deployDirs();
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  const repo = path.resolve(repoPath);

  for (const { name, dir } of skills) {
    // Link the skill in every place it is already deployed (store + each agent
    // dir), converting copy or stale symlink to a live symlink at the source.
    let locations = dirs.filter((d) => pathType(path.join(d, name)) !== "absent");

    // Not deployed anywhere yet: lay a copy once so the dirs exist, re-discover.
    if (locations.length === 0) {
      out(`chopz: ${name} not installed yet; installing once so it can be linked.`);
      try {
        await installCopy(repo, name);
        dirs = deployDirs();
      } catch (e) {
        err(`chopz: could not install ${name} to link it: ${e.message}`);
        return 1;
      }
      locations = dirs.filter((d) => pathType(path.join(d, name)) !== "absent");
    }
    if (locations.length === 0) {
      err(`chopz: could not place ${name} (no agent dirs found).`);
      return 1;
    }

    const paths = [];
    for (const d of locations) {
      const p = path.join(d, name);
      ensureSymlink(dir, p);
      paths.push(p);
    }
    state.links[name] = { source: dir, repo, paths, linkedAt: now() };
    out(`  linked ${name}  ->  ${dir}  (${paths.length} location(s))`);
  }

  saveLinks(linksFile, state);
  out(`chopz: dev-linked ${skills.length} skill(s) from ${repo}. Edits are now live; 'chopz audit' lists them as live/unpinned.`);
  return 0;
}

export async function unlink(ctx, target) {
  const c = defaults(ctx);
  const { linksFile, out, err } = c;

  let state;
  try {
    state = loadLinks(linksFile);
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  let names;
  try {
    names = resolveTargets(state, target);
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  if (names.length === 0) {
    err(`chopz: nothing dev-linked matches '${target}'.`);
    return 1;
  }

  const failed = await restoreEach(c, state, names);
  saveLinks(linksFile, state);
  if (failed > 0) {
    err(`chopz: ${failed} skill(s) could not be unlinked (left linked). ${names.length - failed} restored.`);
    return 1;
  }
  out(`chopz: unlinked ${names.length} skill(s); restored copy installs.`);
  return 0;
}

export async function sync(ctx) {
  const c = defaults(ctx);
  const { linksFile, out, err } = c;

  let state;
  try {
    state = loadLinks(linksFile);
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  const names = Object.keys(state.links);
  if (names.length === 0) {
    out("chopz: nothing dev-linked; nothing to sync.");
    return 0;
  }

  const failed = await restoreEach(c, state, names);
  saveLinks(linksFile, state);
  if (failed > 0) {
    err(`chopz: ${failed} skill(s) could not be synced (left linked). ${names.length - failed} synced.`);
    return 1;
  }
  out(`chopz: synced ${names.length} skill(s) to pinned copies; live links dropped.`);
  return 0;
}

// Restore each named skill to a copy. Per-skill failures are reported and
// skipped (the record is kept and the skill re-linked) so one bad skill never
// leaves the set in a half-removed state. Returns the failure count.
async function restoreEach(c, state, names) {
  let failed = 0;
  for (const name of names) {
    try {
      await restoreCopy(c, state, name);
    } catch (e) {
      failed += 1;
      c.err(`chopz: ${e.message}`);
    }
  }
  return failed;
}

// Replace a skill's live symlinks with a fresh copy from its source and drop
// the dev-link record. If the copy install fails, the symlinks are restored so
// the skill is never left missing, and the record is kept. Shared by unlink and
// sync.
async function restoreCopy(c, state, name) {
  const { installCopy, out } = c;
  const record = state.links[name];
  const linked = (record.paths || []).filter((p) => pathType(p) === "symlink");

  for (const p of linked) rmSync(p, { force: true });
  try {
    await installCopy(record.repo, name);
  } catch (e) {
    for (const p of linked) ensureSymlink(record.source, p); // roll back
    throw new Error(`could not restore copy for ${name}: ${e.message} (left linked)`);
  }

  delete state.links[name];
  out(`  restored ${name}  (copy from ${record.repo})`);
}

// A target is a dev-linked skill name, or a repo path whose skills are linked.
function resolveTargets(state, target) {
  if (!target) throw new Error("unlink needs a skill name or repo path.");
  if (Object.hasOwn(state.links, target)) return [target];

  // Treat as a repo path: link any of its skills that are recorded.
  if (existsSync(target)) {
    const names = skillsInRepo(target)
      .map((s) => s.name)
      .filter((n) => Object.hasOwn(state.links, n));
    return names;
  }
  return [];
}
