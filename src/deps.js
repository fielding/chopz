// `chopz add <source> -s <skill>`: install a skill and its same-repo requires.
//
// This is the safe half of dependency resolution (THREAT-MODEL #1). A skill's
// `requires:` is auto-followed ONLY when the required skill lives in the same
// source repo -- a repo you already trust wholesale by installing from it. A
// cross-repo require is never fetched; it is surfaced for the operator to add to
// a bundle by hand. That is the whole thesis: resolution is fine, unbounded
// transitive trust from arbitrary sources is not.
//
//   ctx = {
//     repoSkills(source),          -> string[]   skills available in the repo
//     installSkill(source, name),  async; `npx skills add <source> -s <name>`
//     isInstalled(name),           -> boolean    is the skill present in the store?
//     readRequires(name),          -> string[]   requires from the installed SKILL.md
//     out(line), err(line),
//   }

function defaults(ctx) {
  return {
    pin: () => {}, // pin each installed skill to a content hash; no-op unless wired
    out: (s = "") => console.log(s),
    err: (s = "") => console.error(s),
    ...ctx,
  };
}

export async function add(ctx, source, skill) {
  const c = defaults(ctx);
  const { repoSkills, installSkill, isInstalled, readRequires, out, err } = c;

  let inRepo;
  try {
    inRepo = new Set(repoSkills(source));
  } catch (e) {
    err(`chopz: ${e.message}`);
    return 1;
  }
  if (!inRepo.has(skill)) {
    err(`chopz: '${skill}' is not in ${source}. Available: ${[...inRepo].join(", ") || "(none)"}`);
    return 1;
  }

  const installed = [];
  const surfaced = []; // cross-repo requires, never auto-installed
  const seen = new Set([skill]);
  const queue = [skill];

  while (queue.length > 0) {
    const name = queue.shift();
    try {
      await installSkill(source, name);
    } catch (e) {
      err(`chopz: failed to install ${name} from ${source}: ${e.message}`);
      return 1;
    }
    // `skills add` exits 0 even when it fails to install, so confirm the skill
    // actually landed in the store before pinning it or reading its requires
    // (same rule as install and restore).
    if (!isInstalled(name)) {
      err(`chopz: ${name} did not land in the store after install.`);
      return 1;
    }
    installed.push(name);
    // A pin failure must not fail the add: the skill IS installed. Warn so the
    // operator knows audit will report it as unpinned.
    try {
      c.pin(name, source);
    } catch (e) {
      err(`chopz: warning: could not pin ${name}: ${e.message}. 'chopz audit' will show it unpinned.`);
    }
    out(`  installed ${name}  [${source}]`);

    for (const req of readRequires(name)) {
      if (seen.has(req)) continue;
      seen.add(req);
      if (inRepo.has(req)) {
        queue.push(req); // same-repo: auto-follow
      } else {
        surfaced.push({ from: name, requires: req }); // cross-repo: surface only
      }
    }
  }

  out(`chopz: installed ${installed.length} skill(s) from ${source} (${installed.join(", ")}).`);

  if (surfaced.length > 0) {
    out("");
    out("Cross-repo requirements were NOT installed (same-repo auto-follow only).");
    out("Review their source and add them to a bundle to approve:");
    for (const s of surfaced) {
      out(`  ${s.requires}  (required by ${s.from})`);
    }
  }
  return 0;
}
