import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRequires } from "../src/frontmatter.js";

test("parses a block list of requires", () => {
  const md = `---
name: gate
description: the gate pipeline
requires:
  - intent
  - state-space-minimization
---
body`;
  assert.deepEqual(parseRequires(md), ["intent", "state-space-minimization"]);
});

test("strips inline comments and quotes from list items", () => {
  const md = `---
requires:
  - intent   # same repo, auto-followed
  - "atomic-changes"
---`;
  assert.deepEqual(parseRequires(md), ["intent", "atomic-changes"]);
});

test("parses an inline flow list", () => {
  const md = `---
requires: [intent, atomic-changes]
---`;
  assert.deepEqual(parseRequires(md), ["intent", "atomic-changes"]);
});

test("parses a single scalar value", () => {
  const md = `---
requires: intent
---`;
  assert.deepEqual(parseRequires(md), ["intent"]);
});

test("returns [] when there is no requires key", () => {
  const md = `---
name: solo
description: no deps
---
body`;
  assert.deepEqual(parseRequires(md), []);
});

test("returns [] when there is no frontmatter at all", () => {
  assert.deepEqual(parseRequires("just a body, no fences"), []);
});

test("the block list ends at the next key, not bleeding into it", () => {
  const md = `---
requires:
  - intent
allowed-tools:
  - Bash
---`;
  assert.deepEqual(parseRequires(md), ["intent"]);
});
