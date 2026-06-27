import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, readlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { link, unlink, sync, loadLinks, ensureSymlink } from "../src/devlink.js";
import { pathType } from "../src/walk.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "chopz-devlink-"));
}

// Build a fake world: a source repo with skills, a store dir, and N agent dirs
// each holding a plain-copy of every skill. Returns the pieces plus a ctx whose
// listDeployments/installCopy are fakes over this world.
function world(skillNames = ["alpha", "beta"], agentDirs = ["claude", "codex"]) {
  const root = tmp();
  const repo = path.join(root, "repo");
  const store = path.join(root, "store");
  mkdirSync(store, { recursive: true });

  const agents = agentDirs.map((a) => path.join(root, a, "skills"));
  for (const d of agents) mkdirSync(d, { recursive: true });

  // source skills
  for (const name of skillNames) {
    const dir = path.join(repo, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\nsource body\n`);
    // a plain copy in the store and in each agent dir (the "installed" state)
    for (const d of [store, ...agents]) {
      const cp = path.join(d, name);
      mkdirSync(cp, { recursive: true });
      writeFileSync(path.join(cp, "SKILL.md"), "stale copy body\n");
    }
  }

  const linksFile = path.join(root, "links.json");
  const out = [];
  const err = [];
  const installed = [];

  // deployDirs: the store plus every agent dir (what the bin assembles from
  // `skills list` + the on-disk scan).
  const allDirs = [store, ...agents];

  const ctx = {
    linksFile,
    now: () => "2026-06-26T00:00:00.000Z",
    deployDirs: () => allDirs,
    installCopy: async (repoArg, name) => {
      installed.push([repoArg, name]);
      // simulate skills laying a fresh copy back into each agent dir
      for (const d of agents) {
        const cp = path.join(d, name);
        mkdirSync(cp, { recursive: true });
        writeFileSync(path.join(cp, "SKILL.md"), "fresh copy body\n");
      }
    },
    out: (s = "") => out.push(s),
    err: (s = "") => err.push(s),
  };

  return { root, repo, store, agents, linksFile, ctx, out, err, installed, skillNames };
}

test("ensureSymlink replaces a copy dir with a symlink, and is idempotent", () => {
  const root = tmp();
  try {
    const target = path.join(root, "src");
    mkdirSync(target);
    const p = path.join(root, "dest");
    mkdirSync(p); // a real dir (copy)
    writeFileSync(path.join(p, "x"), "1");

    assert.equal(ensureSymlink(target, p), "linked");
    assert.equal(pathType(p), "symlink");
    assert.equal(readlinkSync(p), target);

    // second call is a no-op
    assert.equal(ensureSymlink(target, p), "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("link symlinks every deployment (+ store) to the live source and records it", async () => {
  const w = world(["alpha", "beta"], ["claude", "codex"]);
  try {
    const code = await link(w.ctx, w.repo);
    assert.equal(code, 0);

    for (const name of ["alpha", "beta"]) {
      const src = path.join(w.repo, name);
      // each agent dir is now a symlink to the source
      for (const d of w.agents) {
        const p = path.join(d, name);
        assert.equal(lstatSync(p).isSymbolicLink(), true, `${p} should be a symlink`);
        assert.equal(readlinkSync(p), src);
      }
      // the store is linked too
      const sp = path.join(w.store, name);
      assert.equal(readlinkSync(sp), src);
    }

    // recorded as dev-linked
    const state = loadLinks(w.linksFile);
    assert.deepEqual(Object.keys(state.links).sort(), ["alpha", "beta"]);
    assert.equal(state.links.alpha.source, path.join(w.repo, "alpha"));
    assert.equal(state.links.alpha.linkedAt, "2026-06-26T00:00:00.000Z");
    // store + 2 agent dirs = 3 locations
    assert.equal(state.links.alpha.paths.length, 3);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("an edit to the source is visible through the link (live)", async () => {
  const w = world(["alpha"], ["claude"]);
  try {
    await link(w.ctx, w.repo);
    // edit the source
    writeFileSync(path.join(w.repo, "alpha", "SKILL.md"), "EDITED body\n");
    // read through the agent-dir symlink
    const viaLink = path.join(w.agents[0], "alpha", "SKILL.md");
    assert.match(readFileSync(viaLink, "utf8"), /EDITED body/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("unlink by skill name removes the symlinks, restores a copy, clears the record", async () => {
  const w = world(["alpha", "beta"], ["claude", "codex"]);
  try {
    await link(w.ctx, w.repo);
    const code = await unlink(w.ctx, "alpha");
    assert.equal(code, 0);

    // alpha restored to copies (installCopy called with the repo + name)
    assert.deepEqual(w.installed, [[path.resolve(w.repo), "alpha"]]);
    for (const d of w.agents) {
      const p = path.join(d, "alpha");
      assert.equal(lstatSync(p).isSymbolicLink(), false, `${p} should be a copy again`);
    }
    // beta is still linked
    const state = loadLinks(w.linksFile);
    assert.deepEqual(Object.keys(state.links), ["beta"]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("unlink by repo path unlinks all of that repo's recorded skills", async () => {
  const w = world(["alpha", "beta"], ["claude"]);
  try {
    await link(w.ctx, w.repo);
    const code = await unlink(w.ctx, w.repo);
    assert.equal(code, 0);
    assert.equal(Object.keys(loadLinks(w.linksFile).links).length, 0);
    assert.equal(w.installed.length, 2);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("unlink on something not linked exits 1", async () => {
  const w = world(["alpha"], ["claude"]);
  try {
    const code = await unlink(w.ctx, "nonexistent-skill");
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /nothing dev-linked matches/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("sync restores every dev-linked skill to a pinned copy and empties the record", async () => {
  const w = world(["alpha", "beta"], ["claude", "codex"]);
  try {
    await link(w.ctx, w.repo);
    const code = await sync(w.ctx);
    assert.equal(code, 0);
    assert.equal(Object.keys(loadLinks(w.linksFile).links).length, 0);
    assert.equal(w.installed.length, 2); // both restored
    for (const name of ["alpha", "beta"]) {
      for (const d of w.agents) {
        assert.equal(lstatSync(path.join(d, name)).isSymbolicLink(), false);
      }
    }
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("unlink rolls back to the symlink and keeps the record when restore fails", async () => {
  const w = world(["alpha"], ["claude", "codex"]);
  try {
    await link(w.ctx, w.repo);
    // make the copy-restore fail
    w.ctx.installCopy = async () => {
      throw new Error("npx skills add exited 1");
    };
    const code = await unlink(w.ctx, "alpha");
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /could not restore copy for alpha/);

    // skill is still a working symlink (rolled back), record retained
    const src = path.join(w.repo, "alpha");
    for (const d of w.agents) {
      assert.equal(lstatSync(path.join(d, "alpha")).isSymbolicLink(), true);
      assert.equal(readlinkSync(path.join(d, "alpha")), src);
    }
    assert.deepEqual(Object.keys(loadLinks(w.linksFile).links), ["alpha"]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("sync with nothing linked is a clean no-op", async () => {
  const w = world(["alpha"], ["claude"]);
  try {
    const code = await sync(w.ctx);
    assert.equal(code, 0);
    assert.match(w.out.join("\n"), /nothing dev-linked/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("link on a repo with no skills exits 1", async () => {
  const root = tmp();
  try {
    const empty = path.join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const out = [];
    const err = [];
    const ctx = {
      linksFile: path.join(root, "links.json"),
      deployDirs: () => [],
      installCopy: async () => {},
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    };
    const code = await link(ctx, empty);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /no skills found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
