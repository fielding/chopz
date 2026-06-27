// The v1 bundle commands: list, verify, install.
//
// Ported from prototype/skill-bundle (the spec for v1). Each command takes a
// context so it is testable without touching the real store or `skills` CLI,
// and returns an exit code instead of calling process.exit -- the bin wrapper
// owns the process.
//
//   ctx = {
//     manifest,                       parsed, validated manifest
//     manifestFile,                   where it came from (for messages)
//     store,                          store dir
//     isInstalled(store, skill),      presence check         (default: store.js)
//     installMember(source, skill),   async install one      (default: store.js)
//     out(line), err(line),           output sinks           (default: console)
//   }

import { getBundle, bundleNames } from "./manifest.js";
import { isInstalled as storeIsInstalled, installMember as storeInstallMember, addCommandLine } from "./store.js";

function defaults(ctx) {
  return {
    isInstalled: storeIsInstalled,
    installMember: (source, skill) => storeInstallMember(source, skill),
    pin: () => {}, // pin the installed skill to a content hash; no-op unless wired
    out: (s = "") => console.log(s),
    err: (s = "") => console.error(s),
    ...ctx,
  };
}

export function list(ctx) {
  const { manifest, out } = defaults(ctx);
  const names = bundleNames(manifest);
  if (names.length === 0) {
    out("No bundles defined.");
    return 0;
  }
  for (const name of names) {
    const bundle = manifest.bundles[name];
    const desc = bundle.description ? `  --  ${bundle.description}` : "";
    out(`${name}${desc}`);
    for (const m of bundle.members) {
      out(`    ${m.skill}  [${m.source}]`);
    }
    out("");
  }
  return 0;
}

export function verify(ctx, name) {
  const c = defaults(ctx);
  const { manifest, store: storeDir, isInstalled, out, err } = c;

  let bundle;
  try {
    bundle = getBundle(manifest, name);
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }

  let missing = 0;
  for (const m of bundle.members) {
    if (isInstalled(storeDir, m.skill)) {
      out(`  ok      ${m.skill}`);
    } else {
      out(`  MISSING ${m.skill}   ->   ${addCommandLine(m.source, m.skill)}`);
      missing += 1;
    }
  }

  if (missing > 0) {
    err(`chopz: ${missing} member(s) missing from bundle '${name}'.`);
    return 1;
  }
  out(`chopz: bundle '${name}' fully installed.`);
  return 0;
}

export async function install(ctx, name) {
  const c = defaults(ctx);
  const { manifest, store, installMember, isInstalled, out, err } = c;

  let bundle;
  try {
    bundle = getBundle(manifest, name);
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }

  let failed = 0;
  for (const m of bundle.members) {
    out(`==> ${m.skill} (${m.source})`);
    try {
      await installMember(m.source, m.skill);
    } catch (e) {
      err(`chopz: ${m.skill} install errored: ${e.message}`);
      failed += 1;
      continue;
    }
    // `skills add` exits 0 even when it fails to install (e.g. a per-agent
    // "Failed to install 1"), so do not trust the exit code. Confirm the skill
    // actually landed in the store before calling it installed.
    if (isInstalled(store, m.skill)) {
      c.pin(m.skill, m.source);
      out(`  ok      ${m.skill}`);
    } else {
      err(`chopz: ${m.skill} did not land in the store (${store}) after install.`);
      failed += 1;
    }
  }

  if (failed > 0) {
    err(`chopz: ${failed} member(s) failed to install in bundle '${name}'.`);
    return 1;
  }
  out(`chopz: installed bundle '${name}'. Run 'chopz verify ${name}' to confirm.`);
  return 0;
}
