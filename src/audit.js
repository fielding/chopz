// `chopz audit`: what is installed, where it came from, and what is not what
// it claims to be.
//
// It reads upstream's lockfile (sources) and overlays what chopz knows that the
// lock does not: which skills are dev-linked (live/unpinned by design), which
// store entries are live symlinks the lock still thinks are pinned, and whether
// each chopz-pinned skill still matches the content hash chopz recorded at
// install. A drifted skill changed on disk since it was pinned (vectors 4/7).
//
//   ctx = { store, lockFile, linksFile, pinsFile, out(line), err(line) }

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadLinks } from "./devlink.js";
import { loadPins, verifyPin } from "./integrity.js";
import { storeSkills, isSafeSkillName } from "./store.js";
import { pathType } from "./walk.js";

function defaults(ctx) {
  return {
    out: (s = "") => console.log(s),
    err: (s = "") => console.error(s),
    ...ctx,
  };
}

// A plain object, or null. Lets audit treat a malformed record (a null or an
// array where an object was expected) as "absent" rather than crashing on it.
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

export function audit(ctx) {
  const c = defaults(ctx);
  const { store, lockFile, linksFile, pinsFile, out, err } = c;

  let lock = { skills: {} };
  if (existsSync(lockFile)) {
    try {
      lock = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch (e) {
      err(`chopz: cannot read lock ${lockFile}: ${e.message}`);
      return 1;
    }
    // Valid JSON that is not an object (e.g. `null`) is a corrupt lock, not an
    // empty one: fail loud like the parse-error branch (restore has the same rule).
    if (!obj(lock)) {
      err(`chopz: lock ${lockFile} is malformed (not an object).`);
      return 1;
    }
  } else {
    out(`chopz: no lock at ${lockFile}; nothing installed through skills yet.`);
  }

  const skills = obj(lock.skills) || {};
  let links, pins;
  try {
    links = loadLinks(linksFile).links;
    pins = pinsFile ? loadPins(pinsFile).pins : {};
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  const storeNames = storeSkills(store).map((s) => s.name);

  // A skill can be known from any of these: the lock, chopz's dev-link record,
  // chopz's pins, or just the store. Report the union so nothing is invisible.
  const names = [
    ...new Set([...Object.keys(skills), ...Object.keys(links), ...Object.keys(pins), ...storeNames]),
  ].sort();

  let verified = 0;
  let drifted = 0;
  let unverifiable = 0;
  let devLinked = 0;
  let untrackedLinks = 0;
  let missing = 0;

  if (names.length === 0) {
    out("No skills installed, dev-linked, or recorded in the lock.");
  } else {
    out(`Skills (${names.length}):`);
    for (const name of names) {
      if (!isSafeSkillName(name)) {
        out(`  ${name.padEnd(28)} ${"(unsafe name)".padEnd(26)} skipped, name will not resolve as a path`);
        continue;
      }
      // Treat any record that is not a plain object as absent, so a malformed
      // lock / link / pin entry degrades to a clean status line, never a crash.
      const entry = obj(skills[name]);
      const linkRec = Object.hasOwn(links, name) ? obj(links[name]) : null;
      const pinRec = obj(pins[name]);
      const skillPath = path.join(store, name);
      const onDisk = pathType(skillPath); // symlink | dir | absent

      let source;
      let status;
      if (linkRec) {
        source = linkRec.repo || linkRec.source || "(local)";
        status = "dev-linked (live/unpinned)";
        devLinked += 1;
      } else if (onDisk === "symlink") {
        source = entry?.source || pinRec?.source || "(unknown source)";
        status = "LINKED, untracked (live symlink chopz did not record)";
        untrackedLinks += 1;
      } else if (onDisk === "absent") {
        source = entry?.source || pinRec?.source || "(unknown source)";
        status = "MISSING from the store (expected to be installed)";
        missing += 1;
      } else if (pinRec?.hash) {
        source = pinRec.source || entry?.source || "(unknown source)";
        try {
          const { ok } = verifyPin(skillPath, pinRec.hash);
          if (ok) {
            status = `verified ${pinRec.hash.slice(0, 12)}`;
            verified += 1;
          } else {
            status = `DRIFTED (changed since pin ${pinRec.hash.slice(0, 12)})`;
            drifted += 1;
          }
        } catch (e) {
          status = `could not verify (${e.code || e.message})`;
          unverifiable += 1;
        }
      } else if (entry) {
        source = entry.source || "(unknown source)";
        status = "installed, not pinned by chopz";
      } else {
        source = "(not in lock)";
        status = "installed, unlocked (no chopz pin, no lock entry)";
      }
      out(`  ${name.padEnd(28)} ${source.padEnd(26)} ${status}`);
    }
  }

  out("");
  out(
    `Summary: ${verified} verified, ${drifted} drifted, ${unverifiable} unverifiable, ` +
      `${devLinked} dev-linked, ${untrackedLinks} untracked live link(s), ${missing} missing.`,
  );
  if (drifted > 0 || unverifiable > 0) {
    if (drifted > 0) err(`chopz: ${drifted} skill(s) changed since they were pinned. Review before trusting them.`);
    if (unverifiable > 0) err(`chopz: ${unverifiable} skill(s) could not be verified (read error). Check them.`);
    return 1;
  }
  return 0;
}
