// `chopz restore`: rebuild the whole global store from skills' lockfile.
//
// skills can restore a *project* lockfile (`skills-lock.json` in cwd, via
// `experimental_install`) but has no command that restores the *global* store
// from `~/.agents/.skill-lock.json`. restore fills that gap: it reads the global
// lockfile, reinstalls every github-sourced skill from its recorded source
// (`-g`), and pins each with chopz's own content hash so `chopz audit` tracks
// drift afterward. Entries chopz cannot safely reinstall (a non-github
// sourceType like node_modules, a missing source, an unsafe name) are surfaced
// and skipped, never guessed at.
//
//   ctx = {
//     lockFile,                       path to ~/.agents/.skill-lock.json
//     store,                          store dir (post-install presence check)
//     installMember(source, skill),   async install one    (default: store.js)
//     isInstalled(store, skill),      presence check        (default: store.js)
//     pin(skill, source),             record a content pin  (default: no-op)
//     out(line), err(line),           output sinks          (default: console)
//   }

import { existsSync, readFileSync } from "node:fs";
import {
  isInstalled as storeIsInstalled,
  installMember as storeInstallMember,
  isSafeSkillName,
} from "./store.js";

// The lockfile schema chopz understands. A newer schema may move fields chopz
// relies on, so refuse it loudly rather than restore from a shape it misreads.
const SUPPORTED_LOCK_VERSION = 3;

function defaults(ctx) {
  return {
    installMember: (source, skill) => storeInstallMember(source, skill),
    isInstalled: storeIsInstalled,
    pin: () => {},
    out: (s = "") => console.log(s),
    err: (s = "") => console.error(s),
    ...ctx,
  };
}

export async function restore(ctx) {
  const c = defaults(ctx);
  const { lockFile, store, installMember, isInstalled, out, err } = c;

  if (!existsSync(lockFile)) {
    err(`chopz: no lockfile at ${lockFile}; nothing to restore.`);
    return 1;
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch (e) {
    err(`chopz: cannot read lockfile ${lockFile}: ${e.message}`);
    return 1;
  }
  if (typeof lock?.version !== "number" || lock.version > SUPPORTED_LOCK_VERSION) {
    err(
      `chopz: lockfile ${lockFile} is version ${lock?.version}; chopz restore understands up to ${SUPPORTED_LOCK_VERSION}. Update chopz.`,
    );
    return 1;
  }

  const skills = lock.skills && typeof lock.skills === "object" ? lock.skills : {};
  const names = Object.keys(skills).sort();
  if (names.length === 0) {
    out(`chopz: lockfile ${lockFile} records no skills; nothing to restore.`);
    return 0;
  }

  // Classify each entry. Only a safely-named, github-sourced skill is reinstalled;
  // everything else is surfaced and skipped so restore never guesses at a source.
  const toInstall = [];
  const skipped = [];
  for (const name of names) {
    const entry = skills[name];
    if (!entry || typeof entry !== "object") {
      skipped.push([name, "malformed lock entry"]);
    } else if (!isSafeSkillName(name)) {
      skipped.push([name, "unsafe skill name (will not resolve as a path)"]);
    } else if (entry.sourceType && entry.sourceType !== "github") {
      skipped.push([name, `sourceType '${entry.sourceType}' (only github sources are restored)`]);
    } else if (!entry.source) {
      skipped.push([name, "no source recorded"]);
    } else {
      toInstall.push({ name, source: entry.ref ? `${entry.source}#${entry.ref}` : entry.source });
    }
  }

  for (const [name, why] of skipped) {
    err(`chopz: skipping ${name}: ${why}.`);
  }
  if (toInstall.length === 0) {
    err(`chopz: nothing in ${lockFile} can be restored (${skipped.length} skipped).`);
    return 1;
  }

  out(`chopz: restoring ${toInstall.length} skill(s) from ${lockFile}.`);
  let failed = 0;
  for (const { name, source } of toInstall) {
    out(`==> ${name} (${source})`);
    try {
      await installMember(source, name);
    } catch (e) {
      err(`chopz: ${name} install errored: ${e.message}`);
      failed += 1;
      continue;
    }
    // `skills add` exits 0 even when a per-agent install fails, so confirm the
    // skill actually landed in the store before pinning it (same rule as install).
    if (isInstalled(store, name)) {
      c.pin(name, source);
      out(`  ok      ${name}`);
    } else {
      err(`chopz: ${name} did not land in the store (${store}) after install.`);
      failed += 1;
    }
  }

  const restored = toInstall.length - failed;
  out("");
  out(
    `chopz: restored ${restored}/${toInstall.length} skill(s)${skipped.length ? `, skipped ${skipped.length}` : ""}.`,
  );
  if (failed > 0) {
    err(`chopz: ${failed} skill(s) failed to restore. Re-run to retry, or 'chopz audit' to see what is present.`);
    return 1;
  }
  return 0;
}
