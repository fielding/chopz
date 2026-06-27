// Deployment discovery and repo skill enumeration.
//
// chopz never hardcodes the ~50-entry agent->dir table that `skills` carries
// internally; that would drift every time upstream adds an agent. Instead it
// reads `skills list --json` (upstream's own, structured report of where every
// skill is deployed) and derives the live agent dirs from those paths. This is
// the wrap-don't-reimplement rule applied to dev linking.

import { readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Run `npx skills list --json` from a neutral cwd and parse it. Returns the
// array of { name, path, scope, agents } upstream reports, or throws with a
// message fit to print. Injectable runner keeps this testable.
export function listDeployments({ env = process.env, run = defaultRun } = {}) {
  const home = env.HOME || homedir();
  const { status, stdout, stderr } = run("npx", ["skills", "list", "--json"], {
    cwd: home,
    env,
  });
  if (status !== 0) {
    throw new Error(`npx skills list --json exited ${status}: ${(stderr || "").trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`could not parse 'skills list --json' output: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`'skills list --json' did not return an array`);
  }
  return parsed;
}

// A two-minute ceiling so a stalled `npx`/`git` subprocess cannot hang the CLI
// forever (upstream tree-fetches are known to wedge on flaky networks).
const RUN_TIMEOUT_MS = 120000;

function defaultRun(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS, ...opts });
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") {
      throw new Error(`${cmd} ${args.join(" ")} timed out after ${RUN_TIMEOUT_MS / 1000}s`);
    }
    throw r.error;
  }
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// The skill names a source repo provides, via `npx skills add <source> -l`
// (list without installing). Upstream offers no --json for this, so parse its
// output. Used to classify a `requires:` entry as same-repo (auto-followable)
// or cross-repo (surface only). Injectable runner for tests.
export function repoSkills(source, { env = process.env, run = defaultRun } = {}) {
  const home = env.HOME || homedir();
  const { status, stdout } = run("npx", ["skills", "add", source, "-l"], { cwd: home, env });
  const names = parseRepoSkills(stdout || "");
  if (names.length === 0 && status !== 0) {
    throw new Error(`could not list skills in ${source} (npx skills add -l exited ${status})`);
  }
  return names;
}

// Parse `skills add <source> -l` output. Skill names are single kebab-case
// tokens listed under an "Available Skills" header; descriptions are sentences
// (they contain spaces) and are skipped. Box-drawing borders and ANSI colors
// are stripped first. Tolerant by design: if the header is absent, scan the
// whole output for name-shaped lines.
export function parseRepoSkills(raw) {
  const clean = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[─-╿\s]+/, "").replace(/\s+$/, ""));

  const header = clean.findIndex((l) => /^Available Skills$/.test(l));
  const lo = header >= 0 ? header + 1 : 0;
  let hi = clean.findIndex((l, i) => i >= lo && /^Use --skill\b/.test(l));
  if (hi < 0) hi = clean.length;

  const NAME = /^[a-z0-9][a-z0-9._-]*$/;
  return [...new Set(clean.slice(lo, hi).filter((l) => NAME.test(l)))];
}

function stripAnsi(s) {
  const ESC = String.fromCharCode(27);
  return s.replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "");
}

// The distinct agent skills directories currently in use, derived from where
// skills are already deployed: each deployment path is <agentdir>/<name>, so
// the agent dir is its parent. Deduplicated, sorted for stable output.
export function agentDirsFromDeployments(deployments) {
  const dirs = new Set();
  for (const d of deployments) {
    if (d && typeof d.path === "string" && d.path) dirs.add(path.dirname(d.path));
  }
  return [...dirs].sort();
}

// Discover the agent skills directories on this machine without the ~50-entry
// agent->dir table upstream carries. `skills list --json` reports only the
// canonical (store) path per skill, never the per-agent mirror dirs, and those
// mirrors may be independent copies that each need their own symlink. So scan
// for directories named "skills" under $HOME (a dot-dir deep, plus one nested
// level for the likes of .config/<agent>/skills) and keep the ones that
// actually hold an installed skill -- that membership test is what tells a real
// agent mirror apart from some unrelated "skills" folder. `knownSkills` is the
// set of currently-installed skill names. Returns absolute dirs, sorted.
export function discoverAgentSkillDirs(homeDir, knownSkills, { readdir = readDirNames } = {}) {
  const known = new Set(knownSkills);
  const found = new Set();

  const qualifies = (skillsDir) => readdir(skillsDir).some((e) => known.has(e));
  const consider = (skillsDir) => {
    if (qualifies(skillsDir)) found.add(skillsDir);
  };

  for (const top of readDirEntries(homeDir)) {
    if (!top.isDirectory()) continue;
    // Agent config lives in hidden dirs (~/.claude, ~/.codex, ~/.config/<x>,
    // ~/.agents). Restricting to dotdirs keeps a source repo like
    // ~/src/hack/skills, which is also a "skills" dir full of known skills, from
    // being mistaken for a deploy target (which once made `link` self-destruct it).
    if (!top.name.startsWith(".")) continue;
    const base = path.join(homeDir, top.name);
    consider(path.join(base, "skills"));
    for (const sub of readDirEntries(base)) {
      if (sub.isDirectory()) consider(path.join(base, sub.name, "skills"));
    }
  }
  return [...found].sort();
}

function readDirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Enumerate the skills a repo provides. A skill is a directory holding a
// SKILL.md. Matches how `skills` treats a repo: immediate subdirectories with a
// SKILL.md are each a skill; if there are none but the repo root has a SKILL.md,
// the repo itself is a single skill named after its folder. Returns
// [{ name, dir }] sorted by name.
export function skillsInRepo(repoPath) {
  const root = path.resolve(repoPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${repoPath}`);
  }

  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (existsSync(path.join(dir, "SKILL.md"))) {
      found.push({ name: entry.name, dir });
    }
  }

  if (found.length === 0 && existsSync(path.join(root, "SKILL.md"))) {
    found.push({ name: path.basename(root), dir: root });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}
