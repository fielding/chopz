import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { hashSkillFolder, pin, loadPins, verifyPin } from "../src/integrity.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "chopz-integrity-"));
}

function makeSkill(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

test("hashSkillFolder is deterministic and content-sensitive", () => {
  const root = tmp();
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    makeSkill(a, { "SKILL.md": "hello", "references/x.md": "world" });
    makeSkill(b, { "SKILL.md": "hello", "references/x.md": "world" });
    assert.equal(hashSkillFolder(a), hashSkillFolder(b), "same content -> same hash");

    writeFileSync(path.join(b, "SKILL.md"), "hello!");
    assert.notEqual(hashSkillFolder(a), hashSkillFolder(b), "changed content -> changed hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash ignores .git and .DS_Store noise", () => {
  const root = tmp();
  try {
    const a = path.join(root, "a");
    makeSkill(a, { "SKILL.md": "x" });
    const h1 = hashSkillFolder(a);
    writeFileSync(path.join(a, ".DS_Store"), "junk");
    makeSkill(path.join(a, ".git"), { HEAD: "ref" });
    assert.equal(hashSkillFolder(a), h1, "noise files do not affect the hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path-vs-content boundary cannot be forged (length prefixing)", () => {
  const root = tmp();
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    makeSkill(a, { ab: "x", c: "y" });
    makeSkill(b, { a: "bx", c: "y" }); // same concatenated bytes, different file split
    assert.notEqual(hashSkillFolder(a), hashSkillFolder(b));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin records a hash and verifyPin confirms or detects drift", () => {
  const root = tmp();
  try {
    const skill = path.join(root, "gate");
    makeSkill(skill, { "SKILL.md": "original" });
    const file = path.join(root, "pins.json");

    const h = pin(file, "gate", skill, "fielding/skills", () => "2026-06-27T00:00:00.000Z");
    const state = loadPins(file);
    assert.equal(state.pins.gate.hash, h);
    assert.equal(state.pins.gate.source, "fielding/skills");

    assert.equal(verifyPin(skill, h).ok, true);

    writeFileSync(path.join(skill, "SKILL.md"), "tampered");
    const v = verifyPin(skill, h);
    assert.equal(v.ok, false);
    assert.notEqual(v.current, h);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPins on a missing file returns an empty record", () => {
  assert.deepEqual(loadPins("/no/such/pins.json"), { version: 1, pins: {} });
});

test("loadPins rejects a malformed record", () => {
  const root = tmp();
  try {
    const f = path.join(root, "pins.json");
    writeFileSync(f, "[]");
    assert.throws(() => loadPins(f), /malformed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
