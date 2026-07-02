#!/usr/bin/env node
// chopz -- a safety-first convenience layer over the `skills` CLI.
//
// Wraps `npx skills`; never reimplements it. The threat model in
// docs/THREAT-MODEL.md is the north star -- every command must respect it.

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveManifest } from "../src/manifest.js";
import {
  storeDir,
  linksFile,
  lockFile,
  pinsFile,
  installSkill,
  isInstalled as storeIsInstalled,
  storeSkills,
  isSafeSkillName,
} from "../src/store.js";
import { knownAgentSkillDirs, repoSkills } from "../src/agents.js";
import { readRequires } from "../src/frontmatter.js";
import * as commands from "../src/commands.js";
import * as devlink from "../src/devlink.js";
import * as deps from "../src/deps.js";
import { audit } from "../src/audit.js";
import { restore } from "../src/restore.js";
import { scanSkill } from "../src/scan.js";
import * as integrity from "../src/integrity.js";

const IMPLEMENTED = {
  list: "List bundles and their members.",
  verify: "Check every member of a bundle is installed (non-zero exit if not).",
  install: "Install every member of a bundle, from each member's source repo.",
  add: "Install a skill from a source repo and its same-repo requires (allowlist-gated).",
  restore: "Reinstall the whole global store from skills' lockfile, then pin each skill.",
  link: "Symlink a local repo's skills in for live editing (author loop).",
  unlink: "Undo a dev link; restore the copy install.",
  sync: "Re-deploy dev-linked skills as pinned copies (drop live links).",
  scan: "Scan a skill's files for cheap-attack red flags (heuristic).",
  audit: "Report installed skills, sources, dev-linked state, and hash drift.",
};

// chopz's own version, display-only: a corrupted install should show
// "(unknown)" in --version, not crash every command at module load.
let VERSION;
try {
  VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "(unknown)";
} catch {
  VERSION = "(unknown)";
}

// Pin an installed skill to a content hash chopz records (THREAT-MODEL #2).
function pinOne(skill, source) {
  integrity.pin(pinsFile(), skill, path.join(storeDir(), skill), source);
}

// The version of `skills` that `npx skills` resolves on this machine, or null if
// it cannot be determined. This is the skills chopz would actually shell out to.
function skillsVersion() {
  try {
    const r = spawnSync("npx", ["skills", "--version"], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"), "");
    const m = out.match(/\d+\.\d+\.\d+\S*/);
    return r.status === 0 && m ? m[0] : null;
  } catch {
    return null;
  }
}

function versionCommand() {
  console.log(`chopz   ${VERSION}`);
  const sv = skillsVersion();
  console.log(sv ? `skills  ${sv}` : "skills  (not resolved; try: npx skills --version)");
  return 0;
}

// Forward a command chopz does not define straight to `skills`, so chopz is a
// superset and you only need one CLI. Runs in your current directory (skills is
// cwd-sensitive for project scope) with inherited stdio, and returns its exit
// code. chopz's own verbs (list/add/install/...) take precedence.
function passthrough(cmd, rest) {
  const r = spawnSync("npx", ["skills", cmd, ...rest], { stdio: "inherit" });
  if (r.error) {
    console.error(`chopz: could not run skills: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

// `chopz scan [skill|path]`: red-flag a skill's files. With no argument, scan
// every skill in the store. A bare name is resolved inside the store and must be
// a safe skill name (no path traversal); an existing path is scanned as given.
// Heuristic; surfaces findings, exits non-zero if any.
function scanCommand(target) {
  const store = storeDir();
  let targets;
  if (target) {
    let dir;
    if (existsSync(target)) {
      dir = target;
    } else if (isSafeSkillName(target)) {
      dir = path.join(store, target);
    } else {
      console.error(`chopz: '${target}' is not a path that exists or a valid skill name.`);
      return 1;
    }
    if (!existsSync(dir)) {
      console.error(`chopz: no skill or path '${target}' (looked in ${store}).`);
      return 1;
    }
    targets = [{ name: path.basename(dir), dir }];
  } else {
    targets = storeSkills(store);
    if (targets.length === 0) {
      console.log("chopz: no skills in the store to scan.");
      return 0;
    }
  }

  let total = 0;
  for (const { name, dir } of targets) {
    const findings = scanSkill(dir);
    if (findings.length === 0) continue;
    total += findings.length;
    console.log(`\n${name} (${findings.length} flag(s)):`);
    for (const f of findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const m = f.match ? `[${f.match}] ` : "";
      console.log(`  ${f.kind.padEnd(18)} ${loc}  ${m}${f.why}`);
    }
  }

  if (total === 0) {
    console.log(`chopz: scanned ${targets.length} skill(s), no red flags.`);
    return 0;
  }
  console.error(
    `\nchopz: ${total} red flag(s) across ${targets.length} skill(s). Heuristic, not proof; review them before trusting these skills.`,
  );
  return 1;
}

function usage() {
  console.log("chopz -- safe bundles + dependency resolution over the skills CLI\n");
  console.log("Usage: chopz <command> [args]\n");
  console.log("Available:");
  for (const [name, desc] of Object.entries(IMPLEMENTED)) {
    console.log(`  ${name.padEnd(10)} ${desc}`);
  }
  console.log("\nAny other command is forwarded to skills (e.g. chopz find, chopz use, chopz remove),");
  console.log("so you only need one CLI. chopz's own verbs above take precedence.");
  console.log("\nSecurity model: docs/THREAT-MODEL.md (read before extending).");
}

async function main(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return 0;
  }

  if (cmd === "-v" || cmd === "--version") {
    return versionCommand();
  }

  // Anything chopz does not define is a skills command: forward it, so you only
  // need one CLI on your PATH.
  if (!(cmd in IMPLEMENTED)) {
    return passthrough(cmd, rest);
  }

  // --- audit: read-only inventory + hash verification (no manifest needed) ---
  if (cmd === "audit") {
    return audit({
      store: storeDir(),
      lockFile: lockFile(),
      linksFile: linksFile(),
      pinsFile: pinsFile(),
    });
  }

  // --- scan: red-flag a skill's files (no manifest needed) ---
  if (cmd === "scan") {
    const [target] = rest;
    return scanCommand(target);
  }

  // --- restore: rebuild the global store from skills' lockfile (no manifest) ---
  if (cmd === "restore") {
    return restore({ lockFile: lockFile(), store: storeDir(), pin: pinOne });
  }

  // --- add: install a skill + its same-repo requires (no manifest needed) ---
  if (cmd === "add") {
    let positionals, values;
    try {
      ({ positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { skill: { type: "string", short: "s" } },
      }));
    } catch (e) {
      console.error(`chopz: ${e.message}`);
      return 1;
    }
    const [source] = positionals;
    const skill = values.skill;
    if (!source || !skill) {
      console.error("chopz: 'add' needs a source and a skill: chopz add <source> -s <skill>");
      return 1;
    }
    const ctx = {
      repoSkills: (src) => repoSkills(src),
      installSkill,
      isInstalled: (name) => storeIsInstalled(storeDir(), name),
      readRequires: (name) => readRequires(path.join(storeDir(), name, "SKILL.md")),
      pin: pinOne,
    };
    return deps.add(ctx, source, skill);
  }

  // --- dev linking (no manifest needed) ---
  if (cmd === "link" || cmd === "unlink" || cmd === "sync") {
    const home = process.env.HOME || homedir();
    const ctx = {
      linksFile: linksFile(),
      // Every place a skill can be deployed: the store plus the agent dirs from
      // skills' known set that exist on disk. A fixed allowlist of hidden dirs,
      // never a scan, so a source repo can never be a deploy target.
      deployDirs: () => [...new Set([storeDir(), ...knownAgentSkillDirs(home)])],
      installSkill,
    };
    if (cmd === "sync") return devlink.sync(ctx);

    const [target] = rest;
    if (!target) {
      const what = cmd === "link" ? "a local repo path" : "a skill name or repo path";
      console.error(`chopz: '${cmd}' needs ${what}.`);
      return 1;
    }
    if (cmd === "link") return devlink.link(ctx, target);
    return devlink.unlink(ctx, target);
  }

  // --- bundle commands (need the manifest) ---
  // Resolve it once, here, so a missing or malformed manifest is one clear
  // error, not a stack trace.
  let manifest, file;
  try {
    ({ manifest, file } = resolveManifest());
  } catch (e) {
    console.error(`chopz: ${e.message}`);
    return 1;
  }

  const ctx = { manifest, manifestFile: file, store: storeDir(), pin: pinOne };

  if (cmd === "list") return commands.list(ctx);

  // verify/install require a bundle name.
  const [name] = rest;
  if (!name) {
    console.error(`chopz: '${cmd}' needs a bundle name. Try 'chopz list'.`);
    return 1;
  }
  if (cmd === "verify") return commands.verify(ctx, name);
  if (cmd === "install") return commands.install(ctx, name);

  // Every command in IMPLEMENTED is handled above; anything else was forwarded
  // to skills. Reaching here means a verb was added to the table without a
  // handler -- fail loud so the gap surfaces instead of a silent exit 1.
  throw new Error(`internal error: command '${cmd}' is listed in IMPLEMENTED but has no handler`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`chopz: ${err.stack || err.message}`);
    process.exit(1);
  },
);
