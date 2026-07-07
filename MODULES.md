# MODULES — the src/ layout and its dependency contract

The source tree is organized so that **independent agents can work on separate
modules in parallel and merge cleanly**. Each directory below is a module with a
clear owner-surface. The golden rule for parallel work: **one agent stays within
one module directory (plus `scripts/` for its tests)** — cross-module changes go
through `src/core/types.ts` (the shared contract) and should be coordinated.

## Dependency direction

```
core  ←  { llm, mind, econ, causal, gov, transport }  ←  world  ←  persist
```

- Arrows point from *dependent* to *dependency* (right depends on left being stable).
- `render/` and `ui/` are **read-only observers**: they import snapshot/state
  *types* (and pure helpers) from `core/`, `world/`, `mind/`, and `econ/` — they
  never mutate simulation state.
- `src/main.ts` is the only place that wires everything together.
- Known type-only exception: `core/types.ts` re-exports `EconSnapshot` from
  `econ/types.ts` (a `import type` — no runtime edge, no cycle). Treat
  `econ/types.ts` as part of the shared contract.

## src/core/ — the shared contract

- **Owns:** `types.ts` (every cross-module domain type: soma, memory, town,
  snapshots) and `util/` (`num.ts` — pure numeric helpers: clamp, lerp, rng…).
- **Entry points:** `core/types.ts`, `core/util/num.ts`.
- **May import from:** nothing (except the type-only `EconSnapshot` re-export
  noted above).
- Changes here touch everyone — keep them additive and coordinate first.

## src/llm/ — the language-model backend

- **Owns:** `client.ts` (swappable Ollama/remote client), `prompt.ts`
  (interoception rendering, role-play contract, tolerant JSON parsing),
  `embed.ts` (embeddings for memory retrieval).
- **Entry points:** `OllamaClient` (`client.ts`), prompt builders (`prompt.ts`),
  embedding helpers (`embed.ts`).
- **May import from:** `core/`.

## src/mind/ — the per-agent psyche harness

- **Owns:** the full psychological simulator for one agent: `soma.ts`
  (Euler–Maruyama neural/endocrine integrator), `params.ts` (genotype × CB5T),
  `appraisal.ts`, `emotion.ts`, `physiology.ts` (homeostatic reservoirs),
  `needs.ts` (Maslow readout), `sleep.ts`, `workpsych.ts`, `phone.ts`,
  `memgraph.ts` (symbolic memory graph, Memory v3), `mindlite.ts` (abstracted
  interlocutor psyche), `roster.ts` (the cast), and `character.ts` (the unit:
  soma + memory an LLM drives).
- **Entry points:** `Character` (`character.ts`), `MindLite` (`mindlite.ts`),
  `roster.ts`, `params.ts`.
- **May import from:** `core/`, `llm/` (memgraph uses `llm/embed`).
- Knows nothing about the town, the economy, or rendering.

## src/econ/ — the economy

- **Owns:** the full probabilistic economy (formerly `src/sim/econ/`):
  `types.ts` (the economy's own shared contract — everything in this module
  imports only from it plus `core/util`), `econsim.ts` (the orchestrator),
  `wallet.ts`, `business.ts`, `market.ts`, `goods.ts` (wholesale markets),
  `premises.ts` (commercial real estate), `labor.ts`, `construction.ts`,
  `banking.ts`, `fed.ts`, `monetary.ts`, `shadowpop.ts`, `physio.ts`,
  `history.ts`, `config.ts` — plus `economy.ts` (Mara's legacy per-agent
  ledger). (The old `supermarket.ts` singleton became the 'Meridian Fresh
  Market' retail firm inside `business.ts`/`config.ts`.)
- **Entry points:** `EconSim` (`econsim.ts`), `econ/types.ts`, `economy.ts`.
- **May import from:** `core/`.
- Knows nothing about minds or the town; the town drives it via `econsim.ts`.

## src/causal/ — the causal radius + evolving surrogate

- **Owns:** the resolution gate for the expanding world (see
  `WORLD_EXPANSION.md` §3): `gate.ts` (radius + hysteresis around the main
  characters), `stats.ts` (`VenueStats` — the EVOLVING probabilistic function:
  hour-bucketed EMAs learned only from fully-simulated "hot" episodes, with
  hierarchical venue↔archetype↔flat shrinkage), `flow.ts` (Poisson
  discretization of the econ tick's exact aggregates for hot venues; silent
  drift for cold ones — resolution changes, conservation never does),
  `index.ts` (`CausalField` facade), `types.ts`.
- **Entry points:** `CausalField` (`index.ts`), `causal/types.ts`.
- **May import from:** `core/` only. Pure: no THREE, no DOM, no town imports.
- Verified standalone by `scripts/causal-smoke.ts`.

## src/gov/ — emergent government (POLIS)

- **Owns:** the civic phase-transition machinery (see `POLIS_DESIGN.md`):
  `opinion.ts` (Tier-A salience side-table + shadow opinion field),
  `movement.ts` (percolation threshold, assembly calling, influence),
  `charter.ts` (motions, ballots, conserved vote tallies, legitimacy,
  recall), `treasury.ts` (pure levy/spend ledger — execution stays in econ),
  `officials.ts` (MindLite-on-demand officials), `seeds.ts` (the three civic
  seed-memory sets), `history.ts`, `govsim.ts`/`index.ts` (`GovField`
  facade), `types.ts`.
- **Entry points:** `GovField` (`index.ts`), `gov/types.ts`.
- **May import from:** `core/`, `causal/` (gate/stats reuse), and *types
  only* from `econ/types.ts`. Pure: no THREE, no DOM, no town imports;
  moves no money — it emits commands the world/econ execute.
- Verified standalone by `scripts/gov-smoke.ts`.

## src/transport/ — streets, modes, crowds

- **Owns:** the mobility layer (see `TRANSPORT_DESIGN.md`): `netgraph.ts`
  (THE canonical street graph — render draws from it), `routing.ts` (A* +
  generalized cost + logit mode choice), `odfield.ts` (learned demand),
  `congestion.ts`, `fleet.ts` (taxi/transit operations), `transitplan.ts`
  (routes synthesized from demand), `signals.ts`, `pedsim.ts` (social-force
  pedestrians, hot-only), `history.ts`, `transportsim.ts`/`index.ts`
  (`TransportField` facade), `types.ts`.
- **Entry points:** `TransportField` (`index.ts`), `netgraph.ts` (read-only
  for render), `transport/types.ts`.
- **May import from:** `core/`, `causal/`, and *types only* from
  `econ/types.ts`. Pure; moves no money (fares/purchases execute in econ).
- Verified standalone by `scripts/transport-smoke.ts`.

## src/world/ — the town / society layer

- **Owns:** the level-of-detail town that composes minds + economy into a
  society: `town.ts` (the orchestrating sim: LOD tiers, ticks), `world.ts`,
  `city.ts` (Tier-3 density field), `places.ts` (affordances), `npc.ts`,
  `arbiter.ts` (needs → action), `society.ts`, `events.ts`, `conversation.ts`,
  `relationship.ts`, `socialaffect.ts`, `interests.ts`, `feed.ts`, `company.ts`.
- **Entry points:** `Town` (`town.ts`), `society.ts`, `places.ts`.
- **May import from:** `core/`, `llm/`, `mind/`, `econ/`, `causal/`,
  `gov/`, `transport/`.

## src/persist/ — save / load / branching

- **Owns:** `persist.ts` (serialize/deserialize the whole sim), `session.ts`
  (session lifecycle used by `main.ts`), `branchtree.ts` (timeline branching).
- **Entry points:** `session.ts` (for `main.ts`/UI), `persist.ts`,
  `branchtree.ts`.
- **May import from:** `core/`, `mind/`, `world/` (it sits on top of everything
  it snapshots).

## src/render/ — the three.js instruments

- **Owns:** all 3D: the city stage, world geometry, humanoids, interiors
  (apartment, office, supermarket, food court, bank…), and the visualizers
  (`brain.ts`, `psycheviz.ts`, `memoryviz.ts`, `econviz.ts`, `skyclock.ts`),
  plus the shared geometry kits (`kit.ts`, `doorkit.ts`, `palette.ts`,
  `poses.ts`).
- **Entry points:** `citystage.ts`, `cityview.ts`, and the per-instrument
  modules imported by `main.ts`.
- **May import from:** `core/`, and *types/read-only state* from `mind/`
  (roster, params), `world/` (places), `econ/` (types, config). Never mutates
  sim state.

## src/ui/ — DOM panels

- **Owns:** `dashboard.ts`, `townpanel.ts`, `socialfeed.ts`, `companypanel.ts`,
  `econpanel.ts`, `branchbar.ts`, `style.css`.
- **Entry points:** the panel constructors imported by `main.ts`;
  `style.css` is linked from `index.html`.
- **May import from:** `core/`, snapshot types from `econ/`/`world/`, and
  `persist/session` (branch bar drives save/branch actions). Never mutates sim
  state directly.

## src/main.ts — composition root

Wires everything: creates the session (`persist/session`), the LLM client,
the render instruments, and the UI panels. The only file allowed to import
from every module.

## scripts/ — smoke tests & capture harnesses

- `harness-smoke.ts` (fast, mind-only), `town-smoke.ts` (~minutes, whole town),
  `econ-smoke.ts` (~3 min, economy checks, prints `ALL PASS`),
  `causal-smoke.ts`, `gov-smoke.ts`, `transport-smoke.ts` (standalone module
  scenarios), plus headless capture scripts (`*.mjs`). All have offline
  fallbacks if Ollama isn't running.
- Verify any refactor with: `npx tsc --noEmit` + the smoke scripts.

## Working in parallel

- Pick **one** module directory and stay inside it (plus `scripts/` for its
  tests). Merges stay conflict-free because module boundaries only meet in
  `core/types.ts`, `econ/types.ts`, and `main.ts`.
- If you must extend the shared contract, make **additive** changes to
  `core/types.ts` (new optional fields / new types), and mention it in your PR
  so concurrent agents can rebase early.
- Respect the dependency arrows above: never import "downward" (e.g. `mind/`
  must not import `world/`; `econ/` must not import `mind/`).
