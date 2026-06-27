#!/usr/bin/env node
// chopz -- a safety-first convenience layer over the `skills` CLI.
//
// Wraps `npx skills`; never reimplements it. The threat model in
// docs/THREAT-MODEL.md is the north star -- every command must respect it.

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveManifest } from "../src/manifest.js";
import { storeDir, linksFile, lockFile, pinsFile, installMember, storeSkills, isSafeSkillName } from "../src/store.js";
import { listDeployments, agentDirsFromDeployments, discoverAgentSkillDirs, repoSkills } from "../src/agents.js";
import { readRequires } from "../src/frontmatter.js";
import * as commands from "../src/commands.js";
import * as devlink from "../src/devlink.js";
import * as deps from "../src/deps.js";
import { audit } from "../src/audit.js";
import { scanSkill } from "../src/scan.js";
import * as integrity from "../src/integrity.js";

const IMPLEMENTED = {
  list: "List bundles and their members.",
  verify: "Check every member of a bundle is installed (non-zero exit if not).",
  install: "Install every member of a bundle, from each member's source repo.",
  add: "Install a skill from a source repo and its same-repo requires (allowlist-gated).",
  link: "Symlink a local repo's skills in for live editing (author loop).",
  unlink: "Undo a dev link; restore the copy install.",
  sync: "Re-deploy dev-linked skills as pinned copies (drop live links).",
  scan: "Scan a skill's files for cheap-attack red flags (heuristic).",
  audit: "Report installed skills, sources, dev-linked state, and hash drift.",
};

// Pin an installed skill to a content hash chopz records (THREAT-MODEL #2).
function pinOne(skill, source) {
  integrity.pin(pinsFile(), skill, path.join(storeDir(), skill), source);
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
  console.log("\nSecurity model: docs/THREAT-MODEL.md (read before extending).");
}

async function main(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return 0;
  }

  if (!(cmd in IMPLEMENTED)) {
    console.error(`chopz: unknown command '${cmd}'\n`);
    usage();
    return 1;
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
      installSkill: (src, name) => installMember(src, name),
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
      // Every place a skill can be deployed: the store, the dirs `skills list`
      // reports, and the agent skills dirs discovered on disk. Deduped.
      deployDirs: () => {
        const deployments = listDeployments();
        const known = deployments.map((d) => d.name);
        return [
          ...new Set([
            storeDir(),
            ...agentDirsFromDeployments(deployments),
            ...discoverAgentSkillDirs(home, known),
          ]),
        ];
      },
      installCopy: (source, skill) => installMember(source, skill),
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

  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`chopz: ${err.stack || err.message}`);
    process.exit(1);
  },
);
