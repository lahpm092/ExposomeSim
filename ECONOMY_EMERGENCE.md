# ExposomeSim — Economy Emergence Expansion + the Economy Observatory

Phase 4 of the economy. A systematic audit of the phase-1..3 economy found the
feedback loops that were still one-way (computed but nothing reacts) — exactly
the places where closing the loop buys the most **emergence per unit compute**.
This phase closes five of them and adds the missing observational instrument:
a full-history **Economy Observatory** visualizer alongside the brain/memory/
psyche family.

## The audit: where emergence was blocked

| # | Block | Consequence |
|---|-------|-------------|
| 1 | Policy rate was a **cost, never a signal** — firms drew credit on cash thresholds, construction ignored rates | the rates→credit→demand loop was open; monetary policy did nothing real |
| 2 | The Fed never saw actual goods prices (Phillips-only π) | real price spikes could not trigger policy |
| 3 | No firm **entry**; bankruptcy latched but firms zombied on | no demography, no competition, capacity only ever lost |
| 4 | Supply = capacity, always — no expectations, no inventories | no endogenous (Metzler) cycles, only noise-driven ones |
| 5 | Households had **no balance sheets** — no consumer credit, deposit interest deducted from bank equity but paid to no one, loan losses an exogenous constant | no financial accelerator, no Minsky dynamics, silent money leaks |
| 6 | No on-the-job search — the employed never quit | no vacancy chains, no wage ladder, churn pinned by exogenous hazards |
| 7 | Homelessness / gini / skill computed but nothing downstream | dead-end readouts |

## The five expansions (all conserved, all dt-invariant)

**E1 — Money matters (rates → real activity).**
`Business.decide` takes the lending rate: a high real rate raises the hiring
bar and thins the working-capital target; construction gets a hurdle rate
(no groundbreaking when financing is dear). The Fed's Taylor input blends the
**measured goods CPI** with the Phillips path, and `realGrowth` is derived from
the GDP EMA instead of a constant. Policy now moves investment, hiring and
prices — and reacts to them.

**E2 — Credit risk is real (the financial accelerator).**
A bankrupt borrower's loan book is **written off against its bank's capital**
(deposits untouched — the money stays; the asset dies). Lower capital ⇒ smaller
`lendingCapacity` ⇒ credit rationing ⇒ other firms can't smooth payroll ⇒
contagion. Banks price a risk spread off their own capital ratio. Bankrupt
firms now truly **exit**: workers laid off, loans written off, firm removed.

**E3 — Household balance sheets (the Minsky channel).**
Shadow households hold a consumer-credit line at their bank: draw when short
(employed only, debt-service capped), repay when comfortable, **default** when
broke + jobless (write-off → bank capital). Deposit interest is actually paid
(bank equity → household deposits, counted in the broad-money identity).
Precautionary saving: consumption throttles as unemployment risk rises —
the classic demand amplifier. Re-employment wages index partially to CPI
(wage-price spiral is now possible). Homelessness penalizes job-finding
(hysteresis / poverty trap) instead of being cosmetic.

**E4 — Firm demography (Schumpeter).**
When a sector shows a persistent shortage/markup, a **rich shadow household
founds a firm** (equity from its savings + a bank loan; it becomes the owner
and draws dividends when the firm is flush — capital income → emergent wealth
concentration). Entrants draw heterogeneous productivity/cost; selection kills
the weak. B2B **software demand is endogenized** to the number of firms alive.
Sector caps + entry cooldowns keep the goods markets in the stable regime.

**E5 — Expectations + inventories (Metzler cycles).**
Firms form **adaptive demand expectations** (heterogeneous learning rates) and
plan production = expected demand + inventory-gap correction, capped by
capacity. COGS is paid on **production, not sales** — overproduction hurts.
Unsold storables (food/retail) go to inventory (with carrying decay);
non-storables (software/utilities) are wasted. Supply = production + shelf.
Expectation error → inventory overshoot → production cut → the endogenous
inventory cycle.

Cross-cutting: `macro.gini` now spans Tier-A + shadow wealth; quits emit
`quit` events; the labour matcher can poach employed workers who see a ≥15%
raise.

## The Economy Observatory (render/econviz.ts)

A **full-bleed canvas stage overlay** (the memory-viz pattern: titlebar
`ECON` toggle + the `e` key, hidden by default, ink-on-sepia). The four stage
corners are taken; full-bleed is the only honest canvas for a macro dashboard.

Data source: a new **`EconHistory`** recorder inside the econ core — one
compact sample per econ tick (~40 scalars: macro, rates, money, credit flows,
write-offs, per-sector prices/shortages, housing, firm demography, wealth
percentiles, consumer debt) plus a bounded **notable-event stream** (foundings,
bankruptcies, defaults, policy shifts, evictions). Bounded by **pair-merge
decimation**: when the buffer hits its cap the oldest half is merged pairwise
and the stride doubles — the series always spans **t0 → now**, at fine
resolution recently and coarser further back (exactly how memory should work).
Persisted (rounded) in `EconJSON`, so history survives reload and branching;
capped so branch nodes stay inside the localStorage quota.

Layout — three answers to "how has the economy evolved?":

1. **Strips (left ~62%)** — synced macro time-series from t0→now on one time
   axis, FRED-style: GDP + recession shading; CPI + price level; policy vs
   lending rate; broad/base money with credit-flow bars; unemployment +
   vacancies; firms alive with birth/death ticks; inequality (gini, p90/p10,
   consumer debt); housing (rent, vacancy, dwellings). An **event lane** above
   the axis shows the discrete drama.
2. **Phase portrait (right-mid)** — the Phillips trail (unemployment × annual
   inflation), ink fading with age: loops and spirals make the *dynamics*
   visible, not just the series.
3. **Distribution + now-board (right)** — wealth histogram (now vs t0
   outline), and a current-state board: per-sector price vs base, shortage,
   inventory fill; bank capital ratios; Fed dial; construction/supermarket
   pulse.

## Verification

`npx tsx scripts/econ-smoke.ts` (70 sim-days, 33 checks): all the phase-1..3
checks plus — a firm was FOUNDED; an exit or write-off dented bank capital;
consumer credit was used; deposit interest was paid; a QUIT happened (job
ladder); firms carried inventory; gini spans A+C; conservation stays exact
under the extended identity (Δbroad ≡ created − repaid + deposit interest);
history spans t0→now, time-monotonic, within its cap, with events logged.
`node scripts/econviz-capture.mjs` screenshots the Observatory at day 20 and
day 45 against a live dev server. `town-smoke.ts` + `harness-smoke.ts` stay
green.

## Balance lessons (phase 4)

- **Supply must respect marginal cost** (materials + wage/productivity): gating
  production only on COGS lets sectors freeze at sell-below-cost prices.
- **Inventory corrections must be bounded** (±0.6× expected demand/tick) or an
  empty shelf demands 3× capacity and nullifies every other production signal.
- **Credit lines need caps** (1.2× equity): unlimited working capital lets an
  unprofitable firm zombie forever on freshly-created money.
- **Deposit interest must be paid on the banks' actual deposit book** and kept
  OUT of the QTM money-growth impulse — on Σhousehold cash it compounds into a
  hike→interest→"money growth"→hike doom loop that pegs the Taylor rule at 25%.
- **The cycle indicator needs a band-pass** (~24h vs ~7d GDP EMAs): raw hourly
  GDP now carries Metzler chop that aliases into the weekly Phillips sample and
  ratchets expectations.
- **Entry belongs on margins, not the t0 price index**: after the price level
  settles below its t0 stickers nothing would ever enter on a `price ≥ base`
  rule; `price/templateCost` is scale-free and honest.
