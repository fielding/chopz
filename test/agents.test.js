import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { knownAgentSkillDirs, parseRepoSkills, repoSkills, skillsInRepo } from "../src/agents.js";

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

test("knownAgentSkillDirs returns only known agent dirs that exist, never a source repo", () => {
  const home = "/h";
  // a few known agent dirs exist, plus a source repo that is NOT in the allowlist
  const present = new Set([
    path.join(home, ".claude/skills"),
    path.join(home, ".codex/skills"),
    path.join(home, ".config/crush/skills"),
    path.join(home, "src/hack/skills"), // a source repo: not a known agent dir
  ]);
  const dirs = knownAgentSkillDirs(home, { exists: (d) => present.has(d) });
  assert.deepEqual(dirs, [
    path.join(home, ".claude/skills"),
    path.join(home, ".codex/skills"),
    path.join(home, ".config/crush/skills"),
  ]);
  assert.ok(!dirs.includes(path.join(home, "src/hack/skills")), "a source repo is never a deploy target");
});

test("knownAgentSkillDirs returns [] when none of the known dirs exist", () => {
  assert.deepEqual(knownAgentSkillDirs("/h", { exists: () => false }), []);
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
