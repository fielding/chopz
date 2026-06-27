import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { walkFiles } from "../src/walk.js";

test("walkFiles returns relative paths, sorted, recursing into subdirs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chopz-walk-"));
  try {
    writeFileSync(path.join(root, "SKILL.md"), "x");
    mkdirSync(path.join(root, "references"));
    writeFileSync(path.join(root, "references", "b.md"), "x");
    writeFileSync(path.join(root, "references", "a.md"), "x");
    assert.deepEqual(walkFiles(root), ["SKILL.md", "references/a.md", "references/b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkFiles skips .git and .DS_Store noise", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chopz-walk-"));
  try {
    writeFileSync(path.join(root, "SKILL.md"), "x");
    writeFileSync(path.join(root, ".DS_Store"), "junk");
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".git", "HEAD"), "ref");
    assert.deepEqual(walkFiles(root), ["SKILL.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkFiles returns empty for a missing directory", () => {
  assert.deepEqual(walkFiles("/no/such/dir"), []);
});

test("walkFiles throws (not silently skips) when a path cannot be read as a directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chopz-walk-"));
  try {
    const file = path.join(root, "afile");
    writeFileSync(file, "x");
    assert.throws(
      () => walkFiles(file),
      (e) => e.code === "ENOTDIR" || e.code === "EACCES",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
