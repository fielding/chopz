import { test } from "node:test";
import assert from "node:assert/strict";

import { list, verify, install } from "../src/commands.js";

const MANIFEST = {
  version: 1,
  bundles: {
    gate: {
      description: "The gate pipeline.",
      members: [
        { skill: "gate", source: "fielding/skills" },
        { skill: "atomic-changes", source: "dkubb/skills" },
      ],
    },
    empty: { description: "Nothing.", members: [] },
  },
};

// A context whose sinks collect output and whose store/installer are fakes.
function fakeCtx(overrides = {}) {
  const out = [];
  const err = [];
  return {
    ctx: {
      manifest: MANIFEST,
      store: "/fake/store",
      isInstalled: () => true, // default: skills landed; override to test absence
      out: (s = "") => out.push(s),
      err: (s = "") => err.push(s),
      ...overrides,
    },
    out,
    err,
  };
}

test("list prints every bundle and its members", () => {
  const { ctx, out } = fakeCtx();
  const code = list(ctx);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /gate {2}-- {2}The gate pipeline\./);
  assert.match(text, /gate {2}\[fielding\/skills\]/);
  assert.match(text, /atomic-changes {2}\[dkubb\/skills\]/);
  assert.match(text, /empty {2}-- {2}Nothing\./);
});

test("verify reports ok for installed members and exits 0", () => {
  const { ctx, out } = fakeCtx({ isInstalled: () => true });
  const code = verify(ctx, "gate");
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /ok {6}gate/);
  assert.match(text, /ok {6}atomic-changes/);
  assert.match(text, /bundle 'gate' fully installed/);
});

test("verify prints exact install line for missing members and exits 1", () => {
  // gate installed, atomic-changes missing.
  const isInstalled = (_store, skill) => skill === "gate";
  const { ctx, out, err } = fakeCtx({ isInstalled });
  const code = verify(ctx, "gate");
  assert.equal(code, 1);
  const text = out.join("\n");
  assert.match(text, /ok {6}gate/);
  assert.match(
    text,
    /MISSING atomic-changes {3}-> {3}npx skills add dkubb\/skills -s atomic-changes -g -y/,
  );
  assert.match(err.join("\n"), /1 member\(s\) missing from bundle 'gate'/);
});

test("verify on an unknown bundle exits 1 with the bundle list", () => {
  const { ctx, err } = fakeCtx({ isInstalled: () => true });
  const code = verify(ctx, "nope");
  assert.equal(code, 1);
  assert.match(err.join("\n"), /unknown bundle "nope"/);
});

test("install calls the installer for each member from the bundle", async () => {
  const calls = [];
  const installSkill = async (source, skill) => calls.push([source, skill]);
  const { ctx, out } = fakeCtx({ installSkill });
  const code = await install(ctx, "gate");
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["fielding/skills", "gate"],
    ["dkubb/skills", "atomic-changes"],
  ]);
  assert.match(out.join("\n"), /installed bundle 'gate'/);
});

test("install reports per-member failure and exits 1, continuing the rest", async () => {
  const calls = [];
  const installSkill = async (_source, skill) => {
    calls.push(skill);
    if (skill === "gate") throw new Error("boom");
  };
  const { ctx, err } = fakeCtx({ installSkill });
  const code = await install(ctx, "gate");
  assert.equal(code, 1);
  assert.deepEqual(calls, ["gate", "atomic-changes"]); // did not abort early
  const text = err.join("\n");
  assert.match(text, /gate install errored: boom/);
  assert.match(text, /1 member\(s\) failed to install/);
});

test("install treats a skill that did not land in the store as failed, despite a clean install call", async () => {
  // installSkill resolves for both (skills exits 0), but gate never appears in
  // the store -- chopz must catch that instead of trusting the exit code.
  const installSkill = async () => {};
  const isInstalled = (_store, skill) => skill !== "gate";
  const { ctx, out, err } = fakeCtx({ installSkill, isInstalled });
  const code = await install(ctx, "gate");
  assert.equal(code, 1);
  assert.match(err.join("\n"), /gate did not land in the store/);
  assert.match(out.join("\n"), /ok {6}atomic-changes/); // the other one is fine
  assert.match(err.join("\n"), /1 member\(s\) failed to install/);
});

test("install on an unknown bundle exits 1", async () => {
  const { ctx, err } = fakeCtx({ installSkill: async () => {} });
  const code = await install(ctx, "nope");
  assert.equal(code, 1);
  assert.match(err.join("\n"), /unknown bundle "nope"/);
});

test("a pin failure warns but does not fail the install", async () => {
  const pin = () => {
    throw new Error("EACCES pins file");
  };
  const { ctx, out, err } = fakeCtx({ installSkill: async () => {}, pin });
  const code = await install(ctx, "gate");
  assert.equal(code, 0); // both members ARE in the store
  assert.match(out.join("\n"), /installed bundle 'gate'/);
  assert.match(err.join("\n"), /warning: could not pin gate.*EACCES/);
});
