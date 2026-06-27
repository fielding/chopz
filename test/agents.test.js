import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listDeployments,
  agentDirsFromDeployments,
  discoverAgentSkillDirs,
  parseRepoSkills,
  repoSkills,
  skillsInRepo,
} from "../src/agents.js";

const ESC = String.fromCharCode(27);
const BAR = "│";
const CORNER = "└";

// A faithful reproduction of `skills add <source> -l` output: box-drawing
// borders, ANSI cursor codes, names indented under "Available Skills", and
// sentence descriptions one level deeper.
const REPO_LIST_OUTPUT = [
  `${BAR}`,
  `${BAR}  Found 3 skills`,
  `${ESC}[?25h`,
  `${BAR}  Available Skills`,
  `${BAR}    gate`,
  `${BAR}      the gate pipeline`,
  `${BAR}    intent`,
  `${BAR}      capture change intent`,
  `${BAR}    state-space-minimization`,
  `${BAR}      shrink the state space`,
  ``,
  `${CORNER}  Use --skill <name> to install specific skills`,
].join("\n");

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "chopz-agents-"));
}

test("listDeployments parses `skills list --json` via the injected runner", () => {
  const run = (cmd, args) => {
    assert.deepEqual([cmd, ...args], ["npx", "skills", "list", "--json"]);
    return {
      status: 0,
      stdout: JSON.stringify([
        { name: "alpha", path: "/h/.claude/skills/alpha", agents: ["Claude Code"] },
        { name: "alpha", path: "/h/.codex/skills/alpha", agents: ["Codex"] },
      ]),
      stderr: "",
    };
  };
  const out = listDeployments({ env: { HOME: "/h" }, run });
  assert.equal(out.length, 2);
});

test("listDeployments throws a clean error on non-zero exit", () => {
  const run = () => ({ status: 1, stdout: "", stderr: "boom" });
  assert.throws(() => listDeployments({ run }), /skills list --json exited 1: boom/);
});

test("listDeployments throws on non-JSON output", () => {
  const run = () => ({ status: 0, stdout: "not json", stderr: "" });
  assert.throws(() => listDeployments({ run }), /could not parse/);
});

test("agentDirsFromDeployments returns unique parent dirs, sorted", () => {
  const deployments = [
    { name: "alpha", path: "/h/.claude/skills/alpha" },
    { name: "beta", path: "/h/.claude/skills/beta" },
    { name: "alpha", path: "/h/.codex/skills/alpha" },
  ];
  assert.deepEqual(agentDirsFromDeployments(deployments), [
    "/h/.claude/skills",
    "/h/.codex/skills",
  ]);
});

test("discoverAgentSkillDirs finds agent dirs holding a known skill, one and two levels deep, ignoring unrelated ones", () => {
  const home = tmp();
  try {
    // real agent mirrors (contain the known skill 'alpha')
    for (const rel of [".claude/skills", ".codex/skills", ".config/crush/skills"]) {
      const d = path.join(home, rel);
      mkdirSync(path.join(d, "alpha"), { recursive: true });
    }
    // a 'skills' dir that does NOT hold a known skill -> should be ignored
    mkdirSync(path.join(home, "project/skills/unrelated"), { recursive: true });
    // a deeper-than-scanned mirror -> not found (documents the bound)
    mkdirSync(path.join(home, "a/b/c/skills/alpha"), { recursive: true });

    const dirs = discoverAgentSkillDirs(home, ["alpha", "beta"]);
    assert.deepEqual(dirs, [
      path.join(home, ".claude/skills"),
      path.join(home, ".codex/skills"),
      path.join(home, ".config/crush/skills"),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skillsInRepo finds subdirectories that contain a SKILL.md", () => {
  const root = tmp();
  try {
    for (const name of ["gate", "intent"]) {
      const d = path.join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "SKILL.md"), "x");
    }
    mkdirSync(path.join(root, "not-a-skill"), { recursive: true }); // no SKILL.md
    const skills = skillsInRepo(root);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["gate", "intent"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillsInRepo treats a root SKILL.md as a single skill named for the folder", () => {
  const root = tmp();
  try {
    const repo = path.join(root, "my-skill");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "SKILL.md"), "x");
    const skills = skillsInRepo(repo);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "my-skill");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillsInRepo throws on a missing path", () => {
  assert.throws(() => skillsInRepo("/no/such/repo"), /not a directory/);
});

test("parseRepoSkills extracts skill names, skipping borders and descriptions", () => {
  assert.deepEqual(parseRepoSkills(REPO_LIST_OUTPUT), [
    "gate",
    "intent",
    "state-space-minimization",
  ]);
});

test("parseRepoSkills returns [] on empty output", () => {
  assert.deepEqual(parseRepoSkills(""), []);
});

test("repoSkills runs `skills add <source> -l` and parses it", () => {
  const run = (cmd, args) => {
    assert.deepEqual([cmd, ...args], ["npx", "skills", "add", "fielding/skills", "-l"]);
    return { status: 0, stdout: REPO_LIST_OUTPUT, stderr: "" };
  };
  assert.deepEqual(repoSkills("fielding/skills", { env: { HOME: "/h" }, run }), [
    "gate",
    "intent",
    "state-space-minimization",
  ]);
});

test("repoSkills throws when listing fails and yields nothing", () => {
  const run = () => ({ status: 1, stdout: "", stderr: "boom" });
  assert.throws(() => repoSkills("bad/repo", { run }), /could not list skills in bad\/repo/);
});
