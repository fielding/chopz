import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { storeDir, isInstalled, addArgs, addCommandLine, isSafeSkillName, storeSkills } from "../src/store.js";

test("isSafeSkillName accepts real skill names and rejects path-traversal", () => {
  for (const ok of ["gate", "atomic-changes", "state-space-minimization", "a.b_c-1"]) {
    assert.equal(isSafeSkillName(ok), true, ok);
  }
  for (const bad of ["../../.ssh", "a/b", "a\\b", ".hidden", "", "/abs", null, 42]) {
    assert.equal(isSafeSkillName(bad), false, JSON.stringify(bad));
  }
});

test("storeSkills lists dirs and symlinks as {name,dir}, skipping dotfiles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chopz-store-"));
  try {
    mkdirSync(path.join(root, "gate"));
    symlinkSync(path.join(root, "src"), path.join(root, "anti-slop"));
    mkdirSync(path.join(root, ".system"));
    writeFileSync(path.join(root, ".DS_Store"), "junk");
    const skills = storeSkills(root);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["anti-slop", "gate"],
    );
    assert.equal(skills[1].dir, path.join(root, "gate"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storeDir honors $SKILLS_DIR then falls back to ~/.agents/skills", () => {
  assert.equal(storeDir({ SKILLS_DIR: "/custom/skills" }), "/custom/skills");
  assert.equal(storeDir({ HOME: "/home/me" }), path.join("/home/me", ".agents", "skills"));
});

test("isInstalled checks for the skill directory in the store", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "chopz-store-"));
  try {
    mkdirSync(path.join(dir, "gate"));
    assert.equal(isInstalled(dir, "gate"), true);
    assert.equal(isInstalled(dir, "missing"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addArgs matches the documented npx skills invocation", () => {
  assert.deepEqual(addArgs("fielding/skills", "gate"), [
    "skills",
    "add",
    "fielding/skills",
    "-s",
    "gate",
    "-g",
    "-y",
  ]);
});

test("addCommandLine renders the printable install line", () => {
  assert.equal(
    addCommandLine("dkubb/skills", "atomic-changes"),
    "npx skills add dkubb/skills -s atomic-changes -g -y",
  );
});
