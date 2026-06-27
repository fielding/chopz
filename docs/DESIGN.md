# Design

## What chopz is

A thin convenience layer **over** the `skills` CLI (`vercel-labs/skills`), not a
replacement. chopz does not reimplement install, the store, or agent fan-out. It
shells out to `npx skills` for all of that. It adds two things upstream does not
ship, and adds them *safely* (see `THREAT-MODEL.md`):

1. **Bundles**: named groups of skills installed/verified as a unit.
2. **Allowlist-based dependency resolution**: `requires:` auto-follow, same-repo
   only, never transitive across trust boundaries.

## Why a wrapper, not a fork or a PR

- Upstream has repeatedly declined the naive `depends:` / groups PRs (e.g. the
  closed PR #512). Building on top avoids a fork's permanent merge burden and lets
  chopz move at its own pace.
- A wrapper composes: if upstream ever ships native groups, chopz's bundle half can
  delegate to it, and the dependency-safety half still stands on its own.
- It installs and runs the same way as the thing it wraps (`npx`), so adoption is
  frictionless.

## Relationship to the skills ecosystem

- **`.skill-lock.json`** (upstream's lockfile), the record of what is installed,
  each skill's source, and a pinned `skillFolderHash`. chopz reads it as the
  integrity baseline and writes through `npx skills`, never by hand.
- **The store** (`~/.agents/skills` or each agent's skills dir), managed by
  upstream; chopz checks presence here for `verify`.
- **chopz's own manifest**, `.chopz/bundles.json` (or `.skill-bundles.json`),
  a separate file chopz owns, so upstream's lockfile rewrites never clobber it.

## Command surface (target)

| Command | Phase | Notes |
|---|---|---|
| `chopz list` | v1 | Bundles and members. |
| `chopz verify <bundle>` | v1 | Presence check; non-zero exit + install lines for missing. |
| `chopz install <bundle>` | v1 | `npx skills add <source> -s <m> -g -y` per member, from a neutral cwd, idempotent. |
| `chopz add <source> -s <skill>` | v2 | Install a skill and its **same-repo** `requires:`; cross-repo deps are surfaced, never auto-followed. |
| `chopz link <repo>` | v1.5 | Symlink a local repo's own skills into the agent dirs for live editing; records them dev-linked (unpinned). |
| `chopz unlink <repo or skill>` | v1.5 | Restore a dev-linked skill to a copy install, or remove it. |
| `chopz sync` | v1.5 | Re-deploy locally-sourced skills the safe (copy) way, for a pinned snapshot instead of a live link. |
| `chopz scan [skill]` | v4 | Heuristic red-flag scan of a skill's files: invisible unicode, blobs, pipe-to-shell, sensitive paths, injection phrasing. |
| `chopz audit` | v3 | Installed skills, sources, dev-link state, and chopz-pin hash drift. Lists dev-linked skills as live/unpinned. |
| `chopz review [skill]` | deferred | An activation gate (review before an agent can load a skill) needs a quarantine that fights how `skills` deploys. Open problem (THREAT-MODEL #3). |

## Manifest formats

Bundle manifest (hand-authored allowlist), ported from the bash prototype in
`prototype/.skill-bundles.json`:

```json
{
  "version": 1,
  "bundles": {
    "gate": {
      "description": "The gate pipeline and every skill it composes.",
      "members": [
        { "skill": "gate", "source": "fielding/skills" },
        { "skill": "atomic-changes", "source": "dkubb/skills" }
      ]
    }
  }
}
```

`requires:` (v2) lives in each skill's own `SKILL.md` frontmatter and is only ever
read for **same-repo** resolution:

```yaml
requires:
  - state-space-minimization   # only auto-followed if it lives in THIS skill's repo
```

## Dev linking (the author loop)

When you author skills, `skills` deploys them by *copying*: source into the store, then
again into each agent dir. A local install is a snapshot. Editing the source after
install changes nothing until you reinstall, so you are always running a stale copy of
your own skill. (Confirmed empirically: `skills add <local-path>` copies at every hop;
there is no live mode.) This is the deploy gap.

`chopz link <repo>` closes it for skills you own. For each skill in the repo it
replaces the agent-dir copy with a symlink straight to the source, so an edit is live
the next time an agent loads the skill. No reinstall, no commit, no push. That is the
edit-and-use loop an author actually wants.

This steps outside the integrity model on purpose. What keeps it honest is that chopz
never lets a live link pass for a reviewed install, plus one rule you follow by hand:

- A dev-linked skill is **live and unpinned**. Its content changes whenever you save.
  Hash-pinning (THREAT-MODEL #2) and install-is-not-activate (#3) do not apply, because
  you are the author watching your own keystrokes, not a consumer vetting someone
  else's drop.
- chopz **records** which skills are dev-linked, so no integrity op mistakes a live
  symlink for a reviewed, pinned install. `chopz audit` lists them explicitly as
  live/unpinned with their source repo. This is the guarantee that matters, and it is
  the one chopz enforces.
- It is **local-dev only, by convention**. The rule is: link repos you are actively
  authoring, never an untrusted download. chopz does **not** try to prove a local repo
  is yours. A brand-new skill you have not pushed has no remote to check, so enforcing
  ownership would refuse the common case to stop a self-inflicted one: anyone who
  deliberately links code they distrust has opted out of the safety model on purpose,
  and no remote-parsing saves them. So chopz documents the rule and does not police it.

`chopz unlink <repo or skill>` restores the copy install or removes it. `chopz sync`
is the safe, declarative sibling: it re-runs the copy install for locally-sourced
skills, slower per edit but keeping the store and lock authoritative, for when you want
a pinned snapshot rather than a live link.

## Implementation notes

- Node 20+, ESM. Zero / near-zero runtime deps (see THREAT-MODEL #7). Use built-in
  `node:util` `parseArgs`, `node:child_process`, `node:fs`, `node:crypto`.
- Shell out to `npx skills ...` and `git ...`; never reimplement them.
- All install operations run from a neutral cwd (`$HOME`): running from inside
  `~/.agents` nests a bogus `~/.agents/.agents/skills/` (a known upstream gotcha).
- `-s` takes one skill per call; comma-lists fail upstream. Loop.
- Word-splitting: this is Node, so the bash zsh-vs-bash split trap does not apply,
  but the bash prototype documents it; do not regress if any shell glue is added.
