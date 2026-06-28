import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { restore } from "../src/restore.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "chopz-restore-"));
}

// A fake world over an injected lockfile. installCopy records calls and (by
// default) "lands" the skill so the presence check passes; pin records pins.
function world(lock) {
  const root = tmp();
  const lockFile = path.join(root, ".skill-lock.json");
  writeFileSync(lockFile, JSON.stringify(lock));
  const installed = [];
  const pinned = [];
  const landed = new Set();
  const out = [];
  const err = [];
  const ctx = {
    lockFile,
    store: path.join(root, "store"),
    installMember: async (source, skill) => {
      installed.push([source, skill]);
      landed.add(skill);
    },
    isInstalled: (_store, skill) => landed.has(skill),
    pin: (skill, source) => pinned.push([skill, source]),
    out: (s = "") => out.push(s),
    err: (s = "") => err.push(s),
  };
  return { root, ctx, installed, pinned, landed, out, err };
}

function cleanup(w) {
  rmSync(w.root, { recursive: true, force: true });
}

test("restore reinstalls every github skill from its source and pins each", async () => {
  const w = world({
    version: 3,
    skills: {
      gate: { source: "fielding/skills", sourceType: "github" },
      "state-space-minimization": { source: "dkubb/skills", sourceType: "github" },
    },
  });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 0);
    assert.deepEqual(w.installed.sort(), [
      ["dkubb/skills", "state-space-minimization"],
      ["fielding/skills", "gate"],
    ]);
    assert.deepEqual(w.pinned.sort(), [
      ["gate", "fielding/skills"],
      ["state-space-minimization", "dkubb/skills"],
    ]);
  } finally {
    cleanup(w);
  }
});

test("restore appends a pinned ref to the source when the lock records one", async () => {
  const w = world({
    version: 3,
    skills: { gate: { source: "fielding/skills", sourceType: "github", ref: "abc123" } },
  });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 0);
    assert.deepEqual(w.installed, [["fielding/skills#abc123", "gate"]]);
  } finally {
    cleanup(w);
  }
});

test("restore surfaces and skips non-github sources, but still restores the rest", async () => {
  const w = world({
    version: 3,
    skills: {
      gate: { source: "fielding/skills", sourceType: "github" },
      local: { source: "some-pkg", sourceType: "node_modules" },
      nosrc: { sourceType: "github" },
    },
  });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 0); // skips are not failures
    assert.deepEqual(w.installed, [["fielding/skills", "gate"]]);
    const errText = w.err.join("\n");
    assert.match(errText, /skipping local: sourceType 'node_modules'/);
    assert.match(errText, /skipping nosrc: no source recorded/);
  } finally {
    cleanup(w);
  }
});

test("restore skips an unsafe skill name rather than join it into a path", async () => {
  const w = world({
    version: 3,
    skills: {
      gate: { source: "fielding/skills", sourceType: "github" },
      "../evil": { source: "x/y", sourceType: "github" },
    },
  });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 0);
    assert.deepEqual(w.installed, [["fielding/skills", "gate"]]);
    assert.match(w.err.join("\n"), /skipping \.\.\/evil: unsafe skill name/);
  } finally {
    cleanup(w);
  }
});

test("restore reports a skill that installs but never lands in the store, and exits 1", async () => {
  const w = world({
    version: 3,
    skills: { ghost: { source: "x/y", sourceType: "github" } },
  });
  // installMember "succeeds" but the skill never lands
  w.ctx.installMember = async () => {};
  w.ctx.isInstalled = () => false;
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /did not land in the store/);
    assert.equal(w.pinned.length, 0); // never pin something that did not land
  } finally {
    cleanup(w);
  }
});

test("restore exits 1 and pins nothing when an install errors", async () => {
  const w = world({
    version: 3,
    skills: { gate: { source: "fielding/skills", sourceType: "github" } },
  });
  w.ctx.installMember = async () => {
    throw new Error("npx skills add exited 1");
  };
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /gate install errored/);
    assert.equal(w.pinned.length, 0);
  } finally {
    cleanup(w);
  }
});

test("restore refuses a lockfile newer than it understands", async () => {
  const w = world({ version: 99, skills: { gate: { source: "x/y", sourceType: "github" } } });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /version 99; chopz restore understands up to 3/);
    assert.equal(w.installed.length, 0);
  } finally {
    cleanup(w);
  }
});

test("restore on an empty lock is a clean no-op", async () => {
  const w = world({ version: 3, skills: {} });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 0);
    assert.match(w.out.join("\n"), /records no skills/);
  } finally {
    cleanup(w);
  }
});

test("restore errors when the lockfile is absent", async () => {
  const w = world({ version: 3, skills: {} });
  rmSync(w.ctx.lockFile);
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /no lockfile at/);
  } finally {
    cleanup(w);
  }
});

test("restore exits 1 when nothing in the lock is restorable", async () => {
  const w = world({
    version: 3,
    skills: { local: { source: "p", sourceType: "node_modules" } },
  });
  try {
    const code = await restore(w.ctx);
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /nothing in .* can be restored/);
    assert.equal(w.installed.length, 0);
  } finally {
    cleanup(w);
  }
});
