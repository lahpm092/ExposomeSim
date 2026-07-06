# ExposomeSim — Economy Design

A layered market economy that closes the material loop for the whole cast and
generates **emergent macro effects** (inflation, unemployment, business cycles,
inequality, homelessness) cheaply enough to run alongside the real-time
neurosymbolic sim. It extends the pre-existing single-wallet ledger
(`sim/economy.ts`, Mara only) to a full multi-agent economy under `sim/econ/`.

## Design principle: match the existing level-of-detail philosophy

The sim already scales resolution by importance (full soma for protagonists,
cheap symbolic `NpcLite` for proximate figures, pure statistics for the city).
The economy mirrors this exactly:

| Tier | Who | Cost | Role in the economy |
|------|-----|------|---------------------|
| **A** | the 18 full-res `Character`s | already paid | own a `Wallet`; income/spend DERIVED from what they actually do; can be hired/fired, save, go into debt, be evicted → homeless, or train |
| **B** | ~5 `Business` firms | tiny (structs) | sell a product on price-elastic demand; pay payroll + rent; hire/fire; can go bankrupt |
| **C** | `ShadowPop` (~240 households) | O(N) floats, econ-clock only | supply the labour pool + the bulk of aggregate demand → the macro substrate. **No soma, no FSM-per-frame, no LLM.** |

Only Tier C is new *population*; per the brief we add **no** new full-resolution
minds. Tier C is what lets micro effects (one firm's layoffs) ripple into macro
effects (a measurable uptick in the unemployment rate and a dip in aggregate
demand) without spending LLM/soma cycles.

## The firms (`config.ts`)

Data-driven instances of one `Business` engine (so "multiple businesses, each
with workers" = seed data, not copy-pasted code):

- **The Counter** (food) — Mara + Gus + Rosa. The fast-food venue.
- **Meridian Software** (software) — Dana + 14 office workers. The office `Company`
  becomes a *revenue-earning firm*: B2B demand, high wages, big payroll — the
  firm most exposed to the business cycle (first to hire in a boom, first to lay
  off in a bust).
- **Corner Market** (groceries), **Civic Water & Power** (utilities),
  **Riverside Café** (retail) — shadow-staffed; they employ the unemployment pool
  and supply the goods Tier A consumes (food/water/groceries).

## Dynamics (the emergent core)

**Goods market — price by excess demand (tâtonnement), per sector:**
```
demand  = Σ price-elastic consumption intents (Tier A needs + Tier C draws)
supply  = Σ firm capacity (headcount × capacityPerWorker)
price  += PRICE_ADJ · price · (demand − supply)/(demand + supply + ε)     // clamped
sold    = min(demand, supply);  shortage = max(0, demand−supply)/demand
```
Shortages raise prices → inflation; gluts cut them. CPI = basket-weighted price
ratio vs t0.

**Labour market — vacancies, wages, matching:**
```
desiredHeadcount = f(recent profit, demand/capacity slack)          // firm wants
if desired > current:  post vacancy; wage ↑ if unfilled             // recruit
if desired < current:  fire lowest (performance, tenure)            // layoff
match: unemployed (Tier A seeking + Tier C) → vacancies, p ∝ skill≥bar · luck
unemployment = unemployed / labourForce   (A + C)
```

**Housing — rent responds to vacancy:**
```
rent ← baseRent · (1 + k·(1 − vacancyRate))         // tight housing ⇒ dearer
miss rent EVICT_MISSED_PERIODS times  ⇒ evicted ⇒ homeless
```

**Wallet loop (Tier A), each econ tick:**
```
income  += wage · hoursWorked        (if employed & at work)
spend   -= food/water/grocery at CURRENT market prices, sized by hunger/thirst
rent charged on schedule; debt below RUIN_MONEY blocks consumption
skill   += SKILL_GROWTH · conscientiousness while working (human capital)
homeless if evicted; unemployed agents may "train" (skill ↑) or job-search
```

**Macro readouts (emergent, not authored):** CPI, inflation, unemployment,
GDP proxy (Σ value produced), mean wage, homeless count, Gini (wealth
inequality across A+C), and a smoothed `boom` output-gap → the business cycle.

## Efficiency

- The whole economy steps on a **coarse econ clock** (`ECON_TICK_HOURS ≈ 1`),
  decoupled from the ~60 fps render frame. Tier C is a single O(N≈240) sweep of
  plain floats — negligible next to one `Character.step`.
- No allocations on the hot path; snapshot built on demand for the HUD.

## File partition (isolation for the parallel build)

Everything lives under **`src/sim/econ/`** + `src/ui/econpanel.ts`, all NEW files,
so the economy agents never touch the memory track's files
(`harness/memgraph.ts`, `llm/embed.ts`, `harness/character.ts`,
`render/memoryviz.ts`) or each other's:

```
econ/types.ts     — the shared contract (DONE)         [orchestrator]
econ/config.ts    — firms + constants (DONE)            [orchestrator]
econ/wallet.ts    — Tier-A wallet + pure money helpers  [agent E1]
econ/business.ts  — the Business firm engine            [agent E2]
econ/market.ts    — GoodsMarket + Housing               [agent E3]
econ/labor.ts     — LaborMarket (recruit/hire/fire)     [agent E4]
econ/shadowpop.ts — Tier-C probabilistic households     [agent E5]
ui/econpanel.ts   — the HUD business/macro dashboard    [agent E6]
econ/econsim.ts   — orchestrator wiring it all          [orchestrator]
```

Integration (`types.ts`, `town.ts`, `society.ts`, `main.ts`, `persist.ts`) is
done by the orchestrator only, after the modules land — the one required
cross-cut is adding `economy?: EconSnapshot` to `TownSnapshot` and populating it
in `Town.snapshot()`.

## Verification

- `npx tsx scripts/town-smoke.ts` — extend with per-agent wallet/employment
  assertions (it already reads `resources.money`/`foodStock`/`wageEarned`).
- A new `scripts/econ-smoke.ts` — run the `EconomySim` headless for N sim-days,
  assert emergence: wages paid, prices moved, someone hired AND fired, a
  homeless spell occurred, unemployment in (0,1), CPI ≠ 1.
- `node scripts/scale-capture.mjs` — Playwright visual capture of the HUD.
