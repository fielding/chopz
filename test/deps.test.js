import { test } from "node:test";
import assert from "node:assert/strict";

import { add } from "../src/deps.js";

// A fake repo: skills available in `source`, their requires, and an install log.
// isInstalled mirrors the fake install, so a skill "lands" iff installSkill ran.
function fakeCtx(repo, requires = {}) {
  const installed = [];
  const out = [];
  const err = [];
  const ctx = {
    repoSkills: () => repo,
    installSkill: async (_source, name) => {
      installed.push(name);
    },
    isInstalled: (name) => installed.includes(name),
    readRequires: (name) => requires[name] || [],
    out: (s = "") => out.push(s),
    err: (s = "") => err.push(s),
  };
  return { ctx, installed, out, err };
}

test("installs a skill with no requires", async () => {
  const { ctx, installed } = fakeCtx(["solo"]);
  const code = await add(ctx, "fielding/skills", "solo");
  assert.equal(code, 0);
  assert.deepEqual(installed, ["solo"]);
});

test("auto-follows a same-repo require", async () => {
  const { ctx, installed, out } = fakeCtx(["gate", "intent"], { gate: ["intent"] });
  const code = await add(ctx, "fielding/skills", "gate");
  assert.equal(code, 0);
  assert.deepEqual(installed, ["gate", "intent"]);
  assert.match(out.join("\n"), /installed 2 skill\(s\)/);
});

test("follows same-repo requires transitively", async () => {
  const { ctx, installed } = fakeCtx(["a", "b", "c"], { a: ["b"], b: ["c"] });
  const code = await add(ctx, "owner/repo", "a");
  assert.equal(code, 0);
  assert.deepEqual(installed, ["a", "b", "c"]);
});

test("surfaces a cross-repo require, never installs it", async () => {
  // gate requires intent (same repo) and atomic-changes (NOT in this repo)
  const { ctx, installed, out } = fakeCtx(["gate", "intent"], {
    gate: ["intent", "atomic-changes"],
  });
  const code = await add(ctx, "fielding/skills", "gate");
  assert.equal(code, 0);
  assert.deepEqual(installed, ["gate", "intent"]); // atomic-changes NOT installed
  const text = out.join("\n");
  assert.match(text, /Cross-repo requirements were NOT installed/);
  assert.match(text, /atomic-changes\s+\(required by gate\)/);
});

test("does not install or surface the same require twice", async () => {
  const { ctx, installed, out } = fakeCtx(["a", "b", "shared"], {
    a: ["b", "ext"],
    b: ["shared", "ext"],
    shared: [],
  });
  const code = await add(ctx, "owner/repo", "a");
  assert.equal(code, 0);
  assert.deepEqual(installed, ["a", "b", "shared"]);
  // 'ext' (cross-repo) surfaced exactly once despite two requirers
  const surfacedLines = out.join("\n").match(/ext\s+\(required by/g) || [];
  assert.equal(surfacedLines.length, 1);
});

test("handles a requires cycle without looping forever", async () => {
  const { ctx, installed } = fakeCtx(["a", "b"], { a: ["b"], b: ["a"] });
  const code = await add(ctx, "owner/repo", "a");
  assert.equal(code, 0);
  assert.deepEqual(installed.sort(), ["a", "b"]);
});

test("errors when the skill is not in the source repo", async () => {
  const { ctx, installed, err } = fakeCtx(["other"]);
  const code = await add(ctx, "owner/repo", "missing");
  assert.equal(code, 1);
  assert.deepEqual(installed, []);
  assert.match(err.join("\n"), /'missing' is not in owner\/repo/);
});

test("errors and stops when an install fails", async () => {
  const out = [];
  const err = [];
  const ctx = {
    repoSkills: () => ["gate", "intent"],
    installSkill: async (_s, name) => {
      if (name === "gate") throw new Error("network");
    },
    isInstalled: () => true,
    readRequires: () => [],
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  const code = await add(ctx, "fielding/skills", "gate");
  assert.equal(code, 1);
  assert.match(err.join("\n"), /failed to install gate.*network/);
});

test("errors when an install reports success but the skill never lands, and does not pin it", async () => {
  // `skills add` exits 0 even on a failed install; the store is the truth.
  const pinned = [];
  const { ctx, err } = fakeCtx(["gate"]);
  ctx.installSkill = async () => {}; // "succeeds" but lands nothing
  ctx.isInstalled = () => false;
  ctx.pin = (name, source) => pinned.push([name, source]);
  const code = await add(ctx, "fielding/skills", "gate");
  assert.equal(code, 1);
  assert.match(err.join("\n"), /gate did not land in the store/);
  assert.equal(pinned.length, 0, "never pin a skill that did not land");
});

test("a pin failure warns but does not fail the add", async () => {
  const { ctx, installed, err } = fakeCtx(["gate"]);
  ctx.pin = () => {
    throw new Error("EACCES pins file");
  };
  const code = await add(ctx, "fielding/skills", "gate");
  assert.equal(code, 0); // the skill IS installed
  assert.deepEqual(installed, ["gate"]);
  assert.match(err.join("\n"), /warning: could not pin gate.*EACCES/);
});
