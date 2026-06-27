// Deployment discovery and repo skill enumeration.
//
// Deploy targets come from a fixed allowlist (agent-dirs.js, mirrored from
// skills' own agent table), not a scan of $HOME. Every entry is a hidden,
// $HOME-relative dir, so a source repo (e.g. ~/src/hack/skills) can never be
// mistaken for a deploy target. That is the data-loss bug made impossible.

import { readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { KNOWN_AGENT_SKILL_DIRS } from "./agent-dirs.js";

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

// The agent skills directories that exist on this machine, taken from skills'
// own known set (agent-dirs.js) resolved against $HOME. Only these hidden,
// $HOME-relative dirs are ever deploy targets, so a source repo can never be
// one. Returns absolute dirs that exist, sorted. Injectable existence check for
// tests.
export function knownAgentSkillDirs(homeDir, { exists = existsSync } = {}) {
  return KNOWN_AGENT_SKILL_DIRS.map((rel) => path.join(homeDir, rel))
    .filter((dir) => exists(dir))
    .sort();
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
