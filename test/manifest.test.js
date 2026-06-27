import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadManifest,
  resolveManifest,
  manifestPath,
  getBundle,
  bundleNames,
} from "../src/manifest.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "chopz-test-"));
}

const VALID = {
  version: 1,
  bundles: {
    gate: {
      description: "The gate pipeline.",
      members: [
        { skill: "gate", source: "fielding/skills" },
        { skill: "atomic-changes", source: "dkubb/skills" },
      ],
    },
  },
};

function writeManifest(dir, data) {
  const file = path.join(dir, "bundles.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
}

test("loadManifest reads and validates a good manifest", () => {
  const dir = tmp();
  try {
    const file = writeManifest(dir, VALID);
    const m = loadManifest(file);
    assert.deepEqual(bundleNames(m), ["gate"]);
    assert.equal(m.bundles.gate.members.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest throws a clean ENOENT message", () => {
  assert.throws(() => loadManifest("/no/such/manifest.json"), /no manifest at/);
});

test("loadManifest rejects invalid JSON", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "bundles.json");
    writeFileSync(file, "{ not json");
    assert.throws(() => loadManifest(file), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation rejects a member with a path-traversal skill name", () => {
  const dir = tmp();
  try {
    const bad = { bundles: { x: { members: [{ skill: "../../../.ssh", source: "o/r" }] } } };
    const file = writeManifest(dir, bad);
    assert.throws(() => loadManifest(file), /unsafe skill name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation rejects a member missing source", () => {
  const dir = tmp();
  try {
    const bad = { bundles: { x: { members: [{ skill: "a" }] } } };
    const file = writeManifest(dir, bad);
    assert.throws(() => loadManifest(file), /needs a non-empty "source"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation rejects members that is not an array", () => {
  const dir = tmp();
  try {
    const bad = { bundles: { x: { members: {} } } };
    const file = writeManifest(dir, bad);
    assert.throws(() => loadManifest(file), /must have a "members" array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation rejects a non-object top level", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "bundles.json");
    writeFileSync(file, "[]");
    assert.throws(() => loadManifest(file), /top level must be a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifestPath honors $CHOPZ_MANIFEST override", () => {
  const p = manifestPath({ CHOPZ_MANIFEST: "/custom/path.json" }, "/cwd");
  assert.equal(p, "/custom/path.json");
});

test("manifestPath returns repo-owned path then legacy global", () => {
  const candidates = manifestPath({ HOME: "/home/me" }, "/proj");
  assert.deepEqual(candidates, [
    path.join("/proj", ".chopz", "bundles.json"),
    path.join("/home/me", ".agents", ".skill-bundles.json"),
  ]);
});

test("resolveManifest finds the repo-owned manifest first", () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, ".chopz"));
    writeFileSync(path.join(dir, ".chopz", "bundles.json"), JSON.stringify(VALID));
    const { file, manifest } = resolveManifest({ HOME: "/nonexistent-home" }, dir);
    assert.equal(file, path.join(dir, ".chopz", "bundles.json"));
    assert.deepEqual(bundleNames(manifest), ["gate"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveManifest reports all candidates when none found", () => {
  const dir = tmp();
  try {
    assert.throws(() => resolveManifest({ HOME: dir }, dir), /no manifest found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveManifest surfaces a parse error rather than skipping past", () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, ".chopz"));
    writeFileSync(path.join(dir, ".chopz", "bundles.json"), "{ broken");
    assert.throws(() => resolveManifest({ HOME: dir }, dir), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getBundle throws listing known bundles on a miss", () => {
  assert.throws(() => getBundle(VALID, "nope"), /unknown bundle "nope".*gate/s);
});
