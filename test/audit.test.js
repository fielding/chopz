import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { audit } from "../src/audit.js";
import { pin } from "../src/integrity.js";

// Build a store, lockfile, dev-link record, and pin record. Store entries:
// "dir" -> a real skill folder with a SKILL.md, "link" -> a symlink.
function scene({ lock, links, store }) {
  const root = mkdtempSync(path.join(tmpdir(), "chopz-audit-"));
  const storeDir = path.join(root, "store");
  mkdirSync(storeDir, { recursive: true });
  for (const [name, kind] of Object.entries(store || {})) {
    const p = path.join(storeDir, name);
    if (kind === "dir") {
      mkdirSync(p, { recursive: true });
      writeFileSync(path.join(p, "SKILL.md"), `body of ${name}\n`);
    } else if (kind === "link") {
      symlinkSync(path.join(root, "src", name), p);
    }
  }
  const lockFile = path.join(root, "lock.json");
  if (lock !== undefined) writeFileSync(lockFile, JSON.stringify(lock));
  const linksFile = path.join(root, "links.json");
  if (links !== undefined) writeFileSync(linksFile, JSON.stringify(links));
  const pinsFile = path.join(root, "pins.json");

  const out = [];
  const err = [];
  const ctx = {
    store: storeDir,
    lockFile,
    linksFile,
    pinsFile,
    out: (s = "") => out.push(s),
    err: (s = "") => err.push(s),
  };
  return { root, ctx, out, err, storeDir, pinsFile };
}

const LOCK = {
  version: 3,
  skills: {
    gate: { source: "fielding/skills" },
    "anti-slop": { source: "fielding/skills" },
    voice: { source: "fielding/skills-private" },
  },
};

function pinAll(w, names) {
  for (const n of names) pin(w.pinsFile, n, path.join(w.storeDir, n), "fielding/skills");
}

test("verifies chopz-pinned skills against their content hash", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir", "anti-slop": "dir", voice: "dir" } });
  try {
    pinAll(w, ["gate", "anti-slop", "voice"]);
    const code = audit(w.ctx);
    assert.equal(code, 0);
    const text = w.out.join("\n");
    assert.match(text, /gate\s+fielding\/skills\s+verified [0-9a-f]{12}/);
    assert.match(text, /Summary: 3 verified, 0 drifted/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("flags a pinned skill whose content changed as DRIFTED and exits 1", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir", "anti-slop": "dir", voice: "dir" } });
  try {
    pinAll(w, ["gate", "anti-slop", "voice"]);
    writeFileSync(path.join(w.storeDir, "gate", "SKILL.md"), "MALICIOUS EDIT after pin\n");
    const code = audit(w.ctx);
    assert.equal(code, 1);
    assert.match(w.out.join("\n"), /gate.*DRIFTED \(changed since pin/);
    assert.match(w.out.join("\n"), /Summary: 2 verified, 1 drifted/);
    assert.match(w.err.join("\n"), /1 skill\(s\) changed since they were pinned/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a lock skill with no chopz pin shows as not pinned by chopz", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir" } });
  try {
    const code = audit(w.ctx);
    assert.equal(code, 0);
    assert.match(w.out.join("\n"), /gate\s+fielding\/skills\s+installed, not pinned by chopz/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("marks a chopz dev-linked skill as live/unpinned, never drifted", () => {
  const w = scene({
    lock: LOCK,
    links: { version: 1, links: { gate: { repo: "/src/gate" } } },
    store: { gate: "link" },
  });
  try {
    audit(w.ctx);
    assert.match(w.out.join("\n"), /gate.*dev-linked \(live\/unpinned\)/);
    assert.match(w.out.join("\n"), /1 dev-linked/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("reports a dev-linked skill that is not in the lock", () => {
  const w = scene({
    lock: { version: 3, skills: {} },
    links: { version: 1, links: { mine: { repo: "/src/mine" } } },
    store: { mine: "link" },
  });
  try {
    audit(w.ctx);
    assert.match(w.out.join("\n"), /mine\s+\/src\/mine\s+dev-linked \(live\/unpinned\)/);
    assert.match(w.out.join("\n"), /Summary: 0 verified, 0 drifted, 0 unverifiable, 1 dev-linked/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("flags an untracked live symlink the lock still thinks is installed", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir", "anti-slop": "link", voice: "dir" } });
  try {
    audit(w.ctx);
    assert.match(w.out.join("\n"), /anti-slop.*LINKED, untracked/);
    assert.match(w.out.join("\n"), /1 untracked live link\(s\)/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("reports a lock skill missing from the store", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir", "anti-slop": "dir" } });
  try {
    audit(w.ctx);
    assert.match(w.out.join("\n"), /voice.*MISSING from the store/);
    assert.match(w.out.join("\n"), /1 missing/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("skips an unsafe skill name in the lock instead of joining it into a path", () => {
  const w = scene({
    lock: { version: 3, skills: { "../../.ssh": { source: "evil" }, gate: { source: "fielding/skills" } } },
    links: { version: 1, links: {} },
    store: { gate: "dir" },
  });
  try {
    const code = audit(w.ctx);
    assert.equal(code, 0);
    assert.match(w.out.join("\n"), /unsafe name.*skipped/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("reports a corrupt pin record cleanly instead of throwing", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir" } });
  try {
    writeFileSync(w.pinsFile, "{ not json");
    const code = audit(w.ctx);
    assert.equal(code, 1);
    assert.match(w.err.join("\n"), /not valid JSON/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a malformed pin entry degrades to a clean status instead of crashing", () => {
  const w = scene({ lock: LOCK, links: { version: 1, links: {} }, store: { gate: "dir" } });
  try {
    writeFileSync(w.pinsFile, JSON.stringify({ version: 1, pins: { gate: null } }));
    const code = audit(w.ctx);
    assert.equal(code, 0);
    assert.match(w.out.join("\n"), /gate.*installed, not pinned by chopz/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("handles a missing lockfile gracefully", () => {
  const w = scene({ links: { version: 1, links: {} }, store: {} });
  try {
    const code = audit(w.ctx);
    assert.equal(code, 0);
    assert.match(w.out.join("\n"), /no lock at/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("ignores dotfiles in the store", () => {
  const w = scene({
    lock: { version: 3, skills: { gate: { source: "fielding/skills" } } },
    links: { version: 1, links: {} },
    store: { gate: "dir", ".system": "dir", ".DS_Store": "dir" },
  });
  try {
    audit(w.ctx);
    assert.doesNotMatch(w.out.join("\n"), /\.system|\.DS_Store/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
