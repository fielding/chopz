# AGENTS.md: instructions for building chopz

This file tells you what chopz is, how to work on it, and where to start. Read it
fully, then read `docs/` before writing code.

## What chopz is

A safety-first convenience layer **over** the `skills` CLI (`vercel-labs/skills`).
It adds **named bundles** and **allowlist-based dependency resolution**, two things
upstream has repeatedly declined to ship, because the naive versions open a
supply-chain attack vector. chopz's whole reason to exist is to ship those features
*safely*.

**The thesis, in one line:** dependency resolution is not the danger. Unbounded
transitive trust from arbitrary sources is. chopz ships only the safe half.

## Read these first, in order

1. `docs/THREAT-MODEL.md`, the north star. Non-negotiable. Every feature is measured
   against it. If a convenience widens the attack surface, it does not ship without a
   mitigation here.
2. `docs/DESIGN.md`, architecture, command surface, manifest formats, how it wraps
   `skills`.
3. `docs/ROADMAP.md`, the phased build plan. Build in order.
4. `prototype/skill-bundle`, a **working bash prototype** of the v1 bundle commands.
   Port its behavior to JS; it is the spec for v1.

## How to work

- **Start at v1** (port the bundle prototype). Do not jump to convenience features
  ahead of the safety layer they depend on.
- **Wrap, never reimplement.** Shell out to `npx skills ...` and `git ...` for
  install/store/fetch. chopz adds bundles + safe deps + review on top; it does not
  duplicate upstream's installer.
- **Keep chopz's own supply chain near-zero.** Node 20+, ESM, built-ins
  (`node:util` parseArgs, `child_process`, `fs`, `crypto`). A security tool must not
  be a supply-chain risk itself. Every *runtime* dependency is a deliberate, reviewed
  decision, so default to none. Dev-only tools are fine: the one devDependency is the
  `biome` linter, which never ships to consumers.
- **Lint and test as you go.** `npm run lint` (biome) and `npm test` (`node --test`)
  must both pass; CI enforces them on every push. Each roadmap stage has an acceptance
  line.

## Conventions

- **Commits:** dkubb's `atomic-changes` form. Capitalized verb-first subject, no
  conventional `type():` prefix, no "and"/"or" (a compound subject is two commits),
  imperative, body explains what + why. Source of truth:
  `~/src/github/dkubb/skills/skills/atomic-changes`. End commit messages with the
  `Co-Authored-By` trailer.
- **Prose** (README, docs) is in Fielding's voice: direct, honest, a little dry, no
  em dashes, no AI-tell filler. Use the `voice` skill when writing user-facing prose.
- **No em dashes** in anything presented as Fielding's own (README, published docs,
  commit messages). They are fine in internal scratch only.

## Gotchas (learned upstream; do not rediscover)

- Run install ops from a **neutral cwd** (`$HOME`). Running from inside `~/.agents`
  nests a bogus `~/.agents/.agents/skills/`.
- `npx skills add ... -s X` takes **one** skill per call; comma-lists fail. Loop.
- `npx skills update` can fail on the GitHub tree-fetch for private repos; a clean
  `remove` + `add` forces a fresh clone. Account for flaky upstream calls.
- The lockfile is `.skill-lock.json`; never hand-edit it, write through `npx skills`.

## Naming / publish

Published to npm as `@fielding/chopz`. Bare `chopz` is unpublishable: npm's
similarity filter rejects it (too close to `coz`/`copy`), so the package is scoped
under `@fielding`. The command and the repo stay `chopz`; only the install path
carries the scope (`npx @fielding/chopz`). `package.json` is no longer `private`.

## Definition of done for v1

`chopz list`, `chopz verify <bundle>`, `chopz install <bundle>` reproduce the bash
prototype's behavior, read `.chopz/bundles.json`, have tests, and the README's
"Usage" reflects what actually works.
