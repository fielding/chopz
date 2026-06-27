# chopz

[![ci](https://github.com/fielding/chopz/actions/workflows/ci.yml/badge.svg)](https://github.com/fielding/chopz/actions/workflows/ci.yml)

A safety-first layer over the [`skills`](https://github.com/vercel-labs/skills) CLI.
It adds the two things I kept wanting, and the ecosystem keeps asking for, named
bundles and dependency resolution, without opening the door that makes those features
dangerous.

> Status: usable. Bundles, dependency resolution, dev linking, content-hash pinning, a
> static scanner, and audit all work and are tested, with zero runtime dependencies.
> The activation gate (review before an agent can load a skill) is the open problem;
> see the threat model. More in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Why this exists

`skills` is great, but two gaps come up constantly: there's no way to install a
related set of skills as a unit, and no way for a skill to declare what it depends on.
Both have been asked for upstream many times. The catch is that the obvious version, a
`depends:` field that auto-installs whatever it points at, is a real supply-chain
hazard.

Here's the part people skim past. A skill isn't inert data. A `SKILL.md` is a set of
instructions an agent runs with full permissions: your shell, your filesystem, your
keys. A malicious one doesn't need an exploit. It just needs you to run a sentence. So
auto-pulling skills you never reviewed, from sources you never approved, is how
supply-chain attacks scale. That's almost certainly why upstream keeps declining those
PRs, and they're right to.

So the thesis is simple: **dependency resolution isn't the danger. Unbounded
transitive trust from arbitrary sources is.** Those are separable, and chopz only
ships the safe half.

## How it stays safe

The full model is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). The short version:

- **The manifest is your allowlist.** chopz only installs what you've listed. Nothing
  else gets in.
- **Same-repo resolution only.** A skill can pull dependencies from its own repo (one
  you already trust by installing from it), never from somewhere new. Cross-repo deps
  get surfaced for you to add by hand, never auto-followed.
- **It pins what it installs.** chopz records a content hash of every skill at install
  and `audit` re-checks it, so a skill that changes on disk after the fact shows up as
  drifted instead of silently slipping past you.
- **It scans for the cheap attacks.** `chopz scan` flags hidden unicode, buried base64,
  pipe-to-shell, credential-path reads, and injection phrasing. Heuristic, not proof, it
  catches low-effort attacks and points your attention at the rest.
- **chopz keeps its own dependencies near zero.** A tool that polices supply chains
  shouldn't be one.

One thing chopz does **not** do: hold a skill inactive for review before an agent can
load it. Once a skill is installed it's in a directory the agent reads, so it's live.
True "review before it can run" needs a quarantine step that fights how `skills`
deploys, so for now review is something you do with `scan` and `audit`, not a gate that
blocks activation. See the threat model for the honest ceiling.

It's not a sandbox and doesn't pretend to be. It raises the bar and removes the blind
spots. It can't save you from a bad skill you reviewed and approved anyway.

## Install

```sh
npx @fielding/chopz <command>
```

The npm package is `@fielding/chopz`; the command it installs is `chopz`. Or run it
from a clone to hack on it:

```sh
git clone https://github.com/fielding/chopz
cd chopz
npm link            # puts chopz on your PATH
chopz <command>     # or: node bin/chopz.js <command>
```

You'll need Node 20+ and the `skills` CLI (chopz shells out to `npx skills`).

## Usage

Working now:

```
chopz list                 List bundles and their members.
chopz verify <bundle>      Check a bundle's skills are all installed.
chopz install <bundle>     Install a bundle's skills from their source repos.
chopz add <source> -s <s>  Install a skill and its same-repo requires (cross-repo surfaced).
chopz link <repo>          Symlink a local repo's skills in for live editing (author loop).
chopz unlink <repo|skill>  Undo a dev link; restore the copy install.
chopz sync                 Re-deploy dev-linked skills as pinned copies (drop live links).
chopz scan [skill]         Flag a skill's files for cheap-attack red flags (heuristic).
chopz audit                Report installed skills, sources, dev-link state, and hash drift.
```

Deferred: an activation gate (`review`, hold a skill inactive until you approve it)
needs a quarantine that fights how `skills` deploys. See the threat model.

Your bundles live in `~/.agents/.skill-bundles.json`, next to the skill store and lock,
where the rest of your skill config already lives. A project can override that with its
own `.chopz/bundles.json` when you are working inside it, or point `$CHOPZ_MANIFEST`
anywhere. The store chopz checks and installs into is `$SKILLS_DIR`, or `~/.agents/skills`
by default.

chopz is a superset of `skills`: any command it does not define (`find`, `use`,
`remove`, `update`, `init`, ...) is forwarded straight to `skills`, so you only need
`chopz` on your PATH. Its own verbs above take precedence, and `chopz audit` is the
richer "what do I have installed" than `skills list`.

`add` installs a skill and auto-follows its `requires:`, but only for requires that
live in that same repo, one you already trust by installing from it. A `requires:`
pointing anywhere else is never fetched. It gets printed for you to review and add to a
bundle by hand. That's the whole thesis in one command: resolution is fine, unbounded
transitive trust is not.

`link` is for skills you're writing. It swaps each deployed copy of a skill for a
symlink to your source, so an edit is live the next time an agent loads it, no
reinstall. Link repos you author, not untrusted downloads. chopz records dev-linked
skills in `~/.agents/.chopz-links.json` and reports them as live/unpinned, so an
integrity check never mistakes a live symlink for a reviewed install.

## Environment

Everything has a safe default, so a fresh clone works with no configuration. Each path
can be overridden:

| Variable | What | Default |
|---|---|---|
| `CHOPZ_MANIFEST` | bundle manifest | `./.chopz/bundles.json`, then `~/.agents/.skill-bundles.json` |
| `SKILLS_DIR` | the skills store chopz reads and installs into | `~/.agents/skills` |
| `CHOPZ_LINKS` | dev-link record | `~/.agents/.chopz-links.json` |
| `CHOPZ_PINS` | content-hash pin record | `~/.agents/.chopz-pins.json` |
| `SKILL_LOCK` | upstream's lockfile, read only | `~/.agents/.skill-lock.json` |

## Example

Define a bundle in `.chopz/bundles.json`. Each member names a skill and the repo it
comes from, so the bundle is an explicit allowlist that can span repos:

```json
{
  "version": 1,
  "bundles": {
    "gate": {
      "description": "The gate pipeline and a couple of skills it composes.",
      "members": [
        { "skill": "gate", "source": "fielding/skills" },
        { "skill": "atomic-changes", "source": "dkubb/skills" }
      ]
    }
  }
}
```

Then install and check it:

```sh
chopz install gate     # install every member from its own source repo
chopz verify gate      # confirm they're all present (non-zero exit + install lines if not)
chopz audit            # what's installed, where from, what's drifted
```

Or pull a single skill and let its same-repo `requires:` come along:

```sh
chopz add fielding/skills -s gate
# installs gate and any requires that live in fielding/skills.
# a requires pointing at another repo is printed for you to approve, never auto-fetched.
```

## Development

```sh
npm install     # dev only: the linter. chopz itself ships zero runtime deps
npm run lint    # biome
npm test        # node --test
```

CI runs the lint and tests on every push. Releases publish to npm on their own:
bump the version in `package.json`, push, and cut a GitHub Release; the publish
workflow re-runs the gate and pushes the package (it needs an `NPM_TOKEN` repo
secret, an npm automation token with publish + bypass-2FA).

## Relationship to `skills`

chopz wraps `skills`, it doesn't replace it. Install, the store, and agent fan-out are
all still `skills`' job. chopz shells out to it and adds bundles, safe dependency
resolution, and review on top. If upstream ever ships native groups, chopz can delegate
to them and keep the safety layer.

## Built on

The `skills` ecosystem by vercel-labs, and a lot of other people's good skills. This
started as a personal bash script (`prototype/skill-bundle`) and grew into something
worth doing properly.
