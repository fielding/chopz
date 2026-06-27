# Roadmap

Phased so each stage ships something usable and the security model is in from the
start, not bolted on. Build in order; do not skip ahead to convenience features that
the safety layer (v3) has not caught up to.

## v0: scaffold (done)
This repo: package skeleton, `bin/chopz.js` dispatch stub, the docs, the bash
prototype to port. Nothing functional yet.

## v1: bundles (shipped)
Port `prototype/skill-bundle` (working bash) to JS.
- `chopz list` / `verify <bundle>` / `install <bundle>`.
- Read `.chopz/bundles.json`; install members via `npx skills add <source> -s <m> -g -y`.
- `verify` checks the store, prints exact install lines for missing, non-zero exit.
- Acceptance: reproduce the bash prototype's behavior, with tests.

## v1.5: dev linking, the author loop (shipped)
For skills you author, close the edit-and-use gap. `skills` deploys by copying at every
hop, so editing a local source does nothing until you reinstall. See DESIGN "Dev
linking".
- `chopz link <repo>`: symlink each of the repo's own skills into the agent dirs,
  replacing the copy install, so edits are live with no reinstall.
- Record dev-linked state so the v3/v4 integrity ops never treat a live symlink as a
  pinned, reviewed install; `audit` lists them as live/unpinned. This is the one
  guarantee `link` enforces.
- Local-dev only by convention, not enforcement: `link` works on any local path and the
  rule (link what you author, not untrusted downloads) is documented, not policed. An
  ownership gate would refuse the common case (a fresh local skill with no remote) to
  stop a self-inflicted one. See THREAT-MODEL "Dev linking".
- `chopz unlink <repo or skill>` restores the copy install; `chopz sync` re-deploys
  locally-sourced skills the safe (copy) way.
- Acceptance: link a local repo, edit a SKILL.md, an agent loads the change with no
  reinstall; `audit` shows it as dev-linked.

## v2: allowlist dependency resolution (shipped)
- Read `requires:` from a skill's `SKILL.md` frontmatter.
- Auto-follow **same-repo only**; a cross-repo `requires:` is reported and skipped,
  never installed, until added to a bundle by hand (THREAT-MODEL #1).
- `chopz add <source> -s <skill>` installs the skill + its same-repo requires.
- Acceptance: a skill requiring a same-repo dep installs both; a skill requiring a
  cross-repo dep installs only itself and prints the cross-repo dep for the operator.

## v3: integrity + review (hashing shipped; the activation gate deferred)
- Hash-pin: chopz pins its own content hash at install and `audit` verifies it for
  drift. Shipped. Still open: resolve `@latest`/branch to an immutable SHA at fetch,
  and diff before applying an update (THREAT-MODEL #2).
- Install-is-not-activate: deferred. `skills add` deploys live, so a quarantine gate
  fights upstream; revisiting the approach is an open problem (THREAT-MODEL #3).
- `chopz audit`: installed skills, sources, dev-link state, hash drift. Shipped.

## v4: scanning + trust (scan shipped)
- `chopz scan`: zero-width/bidi unicode, base64/hex blobs, `curl|sh`, sensitive-path
  access, prompt-injection phrasing. Shipped (THREAT-MODEL #4).
- Trust tiers: auto-trust own repos + a vetted-author allowlist; else require review
  (THREAT-MODEL #5).
- Surface `allowed-tools`; flag overbroad asks (THREAT-MODEL #6).
