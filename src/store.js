// The skills store and the `skills` CLI shell-out.
//
// chopz never reimplements install or the store -- it shells out to
// `npx skills` (docs/DESIGN.md, AGENTS.md "Wrap, never reimplement"). This
// module is the seam: store-presence checks for `verify`, and the spawn for
// `install`. Both are injectable so commands stay testable without a real CLI.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// The store upstream installs global skills into. Matches the bash prototype:
// $SKILLS_DIR overrides, else ~/.agents/skills.
export function storeDir(env = process.env) {
  if (env.SKILLS_DIR) return env.SKILLS_DIR;
  const home = env.HOME || homedir();
  return path.join(home, ".agents", "skills");
}

// A skill name safe to join into a filesystem path: starts alphanumeric, then
// alphanumerics / dot / dash / underscore only. No separators and no leading
// dot, so it can never traverse out of the store (e.g. `../../.ssh`). Both the
// manifest boundary and the path-join sites enforce this.
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeSkillName(name) {
  return typeof name === "string" && SKILL_NAME.test(name);
}

// Skills present in the store as { name, dir }: directories or symlinks, never
// dotfiles like .DS_Store or upstream's .system folder. The one place anything
// lists the store, so the bin and audit cannot drift.
export function storeSkills(store) {
  let entries;
  try {
    entries = readdirSync(store, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => ({ name: e.name, dir: path.join(store, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Is `skill` present in the store?
export function isInstalled(store, skill) {
  return existsSync(path.join(store, skill));
}

// Where chopz records dev-linked skills. Global, alongside the store's parent,
// because dev links affect the global agent dirs. $CHOPZ_LINKS overrides.
export function linksFile(env = process.env) {
  if (env.CHOPZ_LINKS) return env.CHOPZ_LINKS;
  const home = env.HOME || homedir();
  return path.join(home, ".agents", ".chopz-links.json");
}

// Upstream's lockfile: the record of what is installed, each skill's source, and
// its pinned skillFolderHash. chopz reads it (never writes it). $SKILL_LOCK
// overrides; default sits beside the store's parent.
export function lockFile(env = process.env) {
  if (env.SKILL_LOCK) return env.SKILL_LOCK;
  const home = env.HOME || homedir();
  return path.join(home, ".agents", ".skill-lock.json");
}

// chopz's own content-hash pins, written at install. $CHOPZ_PINS overrides.
export function pinsFile(env = process.env) {
  if (env.CHOPZ_PINS) return env.CHOPZ_PINS;
  const home = env.HOME || homedir();
  return path.join(home, ".agents", ".chopz-pins.json");
}

// The exact argv `install` runs per member. Kept as a pure function so the
// command line chopz prints (in `verify`) and the one it executes (in
// `install`) cannot drift apart, and so it is trivially testable.
//   npx skills add <source> -s <skill> -g -y
export function addArgs(source, skill) {
  return ["skills", "add", source, "-s", skill, "-g", "-y"];
}

export function addCommandLine(source, skill) {
  return ["npx", ...addArgs(source, skill)].join(" ");
}

// A five-minute ceiling on a single skill install: a git clone over a flaky
// network can be slow but should not hang the CLI forever.
const INSTALL_TIMEOUT_MS = 300000;

// Install one member by shelling out to `npx skills add`. Runs from a neutral
// cwd ($HOME): running inside ~/.agents nests a bogus ~/.agents/.agents/skills/
// (a known upstream gotcha, AGENTS.md). Resolves on exit 0, rejects otherwise.
export function installSkill(source, skill, { env = process.env, cwd, timeout = INSTALL_TIMEOUT_MS } = {}) {
  const home = env.HOME || homedir();
  return new Promise((resolve, reject) => {
    const child = spawn("npx", addArgs(source, skill), {
      cwd: cwd || home,
      stdio: "inherit",
      env,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`npx ${addArgs(source, skill).join(" ")} timed out after ${timeout / 1000}s`));
    }, timeout);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npx ${addArgs(source, skill).join(" ")} exited ${code}`));
    });
  });
}
