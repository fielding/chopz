import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BIN = fileURLToPath(new URL("../bin/chopz.js", import.meta.url));

// Run the real CLI as a subprocess (bin/chopz.js calls process.exit, so it has
// to be exercised out of process). Returns { code, stdout, stderr }.
function run(args, { home, manifest, pathPrepend } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  if (manifest) env.CHOPZ_MANIFEST = manifest;
  if (pathPrepend) env.PATH = `${pathPrepend}${path.delimiter}${env.PATH}`;
  const r = spawnSync("node", [BIN, ...args], { encoding: "utf8", env });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function tmpHome() {
  return mkdtempSync(path.join(tmpdir(), "chopz-bin-"));
}

test("--help exits 0 and lists the commands", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: chopz/);
  assert.match(r.stdout, /scan/);
  assert.match(r.stdout, /audit/);
});

test("no arguments prints usage and exits 0", () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Available:/);
});

test("--version reports both the chopz and the resolved skills version", () => {
  const home = tmpHome();
  try {
    const binDir = path.join(home, "fakebin");
    mkdirSync(binDir);
    const fakeNpx = path.join(binDir, "npx");
    // respond to `skills --version` with a version; echo otherwise
    writeFileSync(fakeNpx, '#!/bin/sh\nif [ "$2" = "--version" ]; then echo "1.5.13"; exit 0; fi\necho "FAKE $*"\n');
    chmodSync(fakeNpx, 0o755);

    const r = run(["--version"], { home, pathPrepend: binDir });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /chopz\s+\d+\.\d+\.\d+/);
    assert.match(r.stdout, /skills\s+1\.5\.13/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a command chopz does not define is forwarded to skills", () => {
  const home = tmpHome();
  try {
    // a fake `npx` on PATH that echoes its args, so we can see the forwarded command
    const binDir = path.join(home, "fakebin");
    mkdirSync(binDir);
    const fakeNpx = path.join(binDir, "npx");
    writeFileSync(fakeNpx, '#!/bin/sh\necho "FAKE-NPX $*"\nexit 0\n');
    chmodSync(fakeNpx, 0o755);

    const r = run(["find", "rust"], { home, pathPrepend: binDir });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /FAKE-NPX skills find rust/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("add without -s exits 1 with usage", () => {
  const r = run(["add", "fielding/skills"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs a source and a skill/);
});

test("scan rejects a traversal target name", () => {
  const home = tmpHome();
  try {
    const r = run(["scan", "../../etc/passwd"], { home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a path that exists or a valid skill name/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("list reads the manifest and prints a bundle", () => {
  const home = tmpHome();
  try {
    const manifest = path.join(home, "bundles.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        bundles: { gate: { description: "the gate bundle", members: [{ skill: "gate", source: "fielding/skills" }] } },
      }),
    );
    const r = run(["list"], { home, manifest });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /gate/);
    assert.match(r.stdout, /fielding\/skills/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify with a manifest but no bundle name exits 1", () => {
  const home = tmpHome();
  try {
    const manifest = path.join(home, "bundles.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, bundles: {} }));
    const r = run(["verify"], { home, manifest });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs a bundle name/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed manifest produces a clean error, not a stack trace", () => {
  const home = tmpHome();
  try {
    const manifest = path.join(home, "bundles.json");
    writeFileSync(manifest, "{ not json");
    const r = run(["list"], { home, manifest });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.doesNotMatch(r.stderr, /at Object\.|at Module\./); // no raw stack
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
