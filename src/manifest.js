// Manifest loading and validation.
//
// chopz's manifest (`.chopz/bundles.json`) is a hand-authored allowlist: it
// names exactly which skills a bundle installs and where each one comes from.
// Nothing is discovered transitively (see docs/THREAT-MODEL.md #1), so parsing
// is deliberately strict -- a malformed manifest is an error, never a guess.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isSafeSkillName } from "./store.js";

// Resolution order, first hit wins:
//   1. $CHOPZ_MANIFEST                explicit override
//   2. ./.chopz/bundles.json          a project's own bundles, when you're in one
//   3. ~/.agents/.skill-bundles.json  your global bundles, next to the skill store
//                                     and lock (the home for the common case)
export function manifestPath(env = process.env, cwd = process.cwd()) {
  if (env.CHOPZ_MANIFEST) return env.CHOPZ_MANIFEST;
  const home = env.HOME || homedir();
  return [
    path.join(cwd, ".chopz", "bundles.json"),
    path.join(home, ".agents", ".skill-bundles.json"),
  ];
}

// Read and validate the manifest at `file`. Throws an Error whose message is
// suitable for printing straight to the user.
export function loadManifest(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`no manifest at ${file}`);
    throw new Error(`cannot read manifest ${file}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest ${file} is not valid JSON: ${err.message}`);
  }

  return validateManifest(data, file);
}

// Try each candidate path in order; return { file, manifest } for the first
// that exists. Throws listing the candidates if none is found.
export function resolveManifest(env = process.env, cwd = process.cwd()) {
  const candidates = [].concat(manifestPath(env, cwd));
  for (const file of candidates) {
    try {
      return { file, manifest: loadManifest(file) };
    } catch (err) {
      if (/^no manifest at /.test(err.message)) continue;
      throw err; // a real parse/validation error: surface it, do not skip past.
    }
  }
  throw new Error(
    `no manifest found. Looked in:\n` +
      candidates.map((c) => `  ${c}`).join("\n") +
      `\nCreate one or set $CHOPZ_MANIFEST.`,
  );
}

function validateManifest(data, file) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`manifest ${file}: top level must be a JSON object`);
  }
  if (data.bundles === undefined) {
    throw new Error(`manifest ${file}: missing "bundles" object`);
  }
  if (typeof data.bundles !== "object" || data.bundles === null || Array.isArray(data.bundles)) {
    throw new Error(`manifest ${file}: "bundles" must be an object`);
  }

  for (const [name, bundle] of Object.entries(data.bundles)) {
    if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
      throw new Error(`manifest ${file}: bundle "${name}" must be an object`);
    }
    if (bundle.description !== undefined && typeof bundle.description !== "string") {
      throw new Error(`manifest ${file}: bundle "${name}" description must be a string`);
    }
    if (!Array.isArray(bundle.members)) {
      throw new Error(`manifest ${file}: bundle "${name}" must have a "members" array`);
    }
    bundle.members.forEach((m, i) => {
      const where = `bundle "${name}" member ${i}`;
      if (typeof m !== "object" || m === null || Array.isArray(m)) {
        throw new Error(`manifest ${file}: ${where} must be an object`);
      }
      if (typeof m.skill !== "string" || m.skill === "") {
        throw new Error(`manifest ${file}: ${where} needs a non-empty "skill"`);
      }
      if (!isSafeSkillName(m.skill)) {
        throw new Error(
          `manifest ${file}: ${where} has an unsafe skill name "${m.skill}" ` +
            `(skill names join into filesystem paths; use letters, digits, dot, dash, underscore).`,
        );
      }
      if (typeof m.source !== "string" || m.source === "") {
        throw new Error(`manifest ${file}: ${where} ("${m.skill}") needs a non-empty "source"`);
      }
    });
  }

  return data;
}

export function bundleNames(manifest) {
  return Object.keys(manifest.bundles);
}

// Return a bundle by name, or throw with the list of known bundles.
export function getBundle(manifest, name) {
  if (!Object.hasOwn(manifest.bundles, name)) {
    const known = bundleNames(manifest);
    const list = known.length ? known.map((b) => `  ${b}`).join("\n") : "  (none defined)";
    throw new Error(`unknown bundle "${name}". Available:\n${list}`);
  }
  return manifest.bundles[name];
}
