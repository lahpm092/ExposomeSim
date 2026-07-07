# ExposomeSim — POLIS: emergent government from first principles

`src/gov/` — a pure module (no THREE, no DOM, no world imports) in the causal/
mold: `core ← {llm, mind, econ, causal, gov, transport} ← world ← persist`.
The world composes it; smoke tests drive it standalone.

## The thesis

Government is not a feature — it is a phase transition in a social field.
Nothing in this module says "form a government on day N." Instead:

1. **Grievance is real.** Material conditions the sim already computes
   (unemployment, homelessness, rent burden, CPI spikes, gini, and — once
   `src/transport/` lands — commute cost) generate per-capita grievance.
   No synthetic complaints.
2. **The spark is seeded memory, not scripted behavior.** Three main
   characters get durable civic memories via `ch.memory.seed()` (the
   `interests.ts:51` precedent). Memories raise civic *salience*; they do not
   dictate any action. The arbiter, needs, and social physics do the rest.
3. **Opinion travels only on existing channels.** Conversations
   (warmth × trust persuasion), the phone feed (petition posts + a civic
   resonance term), and shadow-population contagion. No new diffusion layer —
   a payload on channels that already exist.
4. **Coordination crosses a threshold, or it doesn't.** When salience mass
   concentrated in a connected social cluster crosses a percolation threshold,
   the highest-influence civic agent calls an assembly. If the mass never
   concentrates, no government ever forms. Runs may differ.
5. **Institutions are economically embodied.** A charter creates a treasury
   (an account id inside `MonetarySystem` — added to the `privateMoney` sum,
   econsim.ts:592, or the Fed misreads taxes as deflation). Taxes exist only
   if voted. Staff are hired through the existing `LaborMarket`. Policies are
   budget lines executed as econ procurement. An insolvent treasury means
   unpaid clerks quit, legitimacy decays, and the institution can dissolve.
6. **Governments can fail, split, and be contested.** Bimodal stance
   distributions can spawn rival movements; recall motions use the same
   ballot machinery. No caps, no floors.

## Resolution ladder (the efficiency contract)

| Tier | What runs | When | Cost |
|------|-----------|------|------|
| P (probabilistic) | shadow opinion field (Float32Array over 240 households), institution state machine, tax/treasury aggregates, turnout distributions | every econ tick (~1 sim-h), keyed off `economy.tickSeq` like causal (town.ts:240) | O(shadow N) per hour |
| M (intermediate) | officials as `MindLite` + standalone `MemoryGraph`, discrete assembly/vote events with figures | only when a causal center (Tier-A or camera-observer) is within the gate radius of the civic venue — own `CausalGate` instance | O(attendees) during events |
| F (full) | roster characters participating via their own soma/memory/LLM beats | whenever a main character attends/joins — they are already simulated | 0 marginal |

Observed↔abstracted flips use `CausalGate` hysteresis (no flicker), and the
**observe-only-when-hot** rule from `stats.ts:79` holds: cold turnout drifts on
the learned surrogate; only hot episodes update it.

## The emergence chain, mechanically

- **Civic salience (Tier-A)**: per-character side table keyed by `profile.id`
  (the types.ts:22 invariant: never touch character.ts). Inputs: material
  conditions from `walletOf(id)`/AgentEconView, memories (world reports
  recall hits on civic cues), trait projections (extraversion, openness,
  `theoryOfMind` persuasion susceptibility, `impulsivity` turnout — all in
  `deriveNeuro`, params.ts:182).
- **Shadow opinion (Tier-C)**: two floats per household (grievance, support),
  updated in gov's own O(N) sweep from econ aggregates + contagion mixing +
  decay mirroring `decayBonds` half-lives. Own serialized mulberry32.
- **Conversations carry opinions**: world calls
  `gov.onConversation(aId, bId, topic, warmth, trustAB, trustBA, clock)` when
  a conversation's topic is civic; gov returns stance deltas + optional memory
  texts for both parties (world writes them via `ch.memory.add`). Civic topics
  enter the candidate pool via `gov.hotTopics(clock)` merged into the
  shared-interest candidates at conversation.ts:80.
- **Feed**: petition/announcement posts injected via a new
  `PublicFeed.inject(post)`; `PostRec` gains a `kind` field; `resonance()`
  (feed.ts:198) gains a civic term weighted by the reader's salience. The
  `likes[]` array doubles as a petition signature list. Civic efficacy reward
  routes through the existing `cashIn` belonging channel (feed.ts:166) —
  never bespoke soma writes.
- **Assembly**: called when threshold crossed; announced by feed post +
  per-attendee `WorldEvent` (`ch.perceive` + `applyDriverResponse`, the
  tickEvents pattern society.ts:503). Venue: **the park or food court** —
  there is no city hall until the government builds one (see below).
  Tier-A attendance = a `civicPull` urgency term beside `workUrgency`
  (arbiter.ts:198) + a decidePlace pull for the nine (society.ts:262), gated
  by Maslow prepotency for free (the desperate skip civic life — emergent
  class turnout). Shadow attendance = Poisson λ from the opinion field.
- **Charter & ballots**: assembly outcomes derive from attendee stance
  vectors — the top grievance categories become motions (the Company
  `rederiveGoal` bounded-reallocation rule, company.ts:292, is the
  aggregation template). Ballots propagate via feed for a voting window;
  votes are conserved integer counts (Tier-A discrete, shadow Beta-binomial
  from the opinion field). Turnout is prepotency- and impulsivity-gated.
- **Institution**: ratified charter → `GovBody { legitimacy, treasury,
  offices, policies }`. Recruitment = `FirmDemand` rows into
  `firmDemands()` (econsim.ts:689, the Construction precedent, sector
  unused); applyPlan dispatch extended. Taxes = the stepMonetary
  interest-collection pattern (econsim.ts:566): per-payer debits through the
  three channels credited to one treasury balance; hooks at payWage / buy /
  chargeRent sites. Deficit finance via the `Financier` interface
  (construction.ts:26) — bond issuance creates broad money and interacts
  with the Taylor rule for free.
- **Leaders & officials**: influence math adapted from
  `Company.recomputeInfluence` (company.ts:445). A roster winner serves
  full-res; a shadow winner is `sampleProfile(seed)` + MindLite +
  standalone `MemoryGraph` (freely constructible), instantiated only when
  observed.
- **City hall is built, not spawned**: once a treasury exists and a
  facilities motion passes, gov emits a procurement order; a new
  `BuildKind 'civic'` flows through the existing Construction pipeline
  (lots, hurdle rates, real labor). Assemblies relocate when it completes.
- **Policy → world**: policies are budget lines only: transit subsidy
  (founds/funds the transit authority in `src/transport/`), rent assistance
  (counters evictions), public works (construction demand). Execution is
  always econ procurement — gov never conjures goods.

## Module contract (what parallel agents code against)

`src/gov/` files — all pure, importing only `core/` (+ `econ/types` types):

- `types.ts` — every type below; structural interfaces only (no world/econ
  class imports).
- `opinion.ts` — Tier-A side table + shadow Float32Array field; contagion,
  decay, stance readouts.
- `movement.ts` — salience-mass/percolation threshold, assembly calling,
  influence ranking.
- `charter.ts` — motions, ballots, vote tallies (conserved counts),
  legitimacy dynamics, recall.
- `treasury.ts` — pure ledger of levies/spend orders (execution happens in
  econ); insolvency state.
- `officials.ts` — office roster, official seeds, MindLite-on-demand plan.
- `seeds.ts` — the three civic seed-memory text sets + `seedPlan()`.
- `history.ts` — GovHistory recorder (pair-merge decimation, the EconHistory
  pattern) for the observatory.
- `govsim.ts` + `index.ts` — the `GovField` facade.

```ts
class GovField {
  constructor(opts?: { seed?: number });
  /** aggregate tick — Town calls this keyed off economy.tickSeq. */
  tick(input: GovTickInput, clock: number, dtH: number): GovTickResult;
  /** discrete civic exchange during a conversation with a civic topic. */
  onConversation(aId: string, bId: string, topic: string, warmth: number,
                 trustAB: number, trustBA: number, clock: number): CivicExchange | null;
  /** feed engagement on a civic post (like/sign/reply). */
  onFeedEngagement(readerId: string, postKind: CivicPostKind, authorId: string, clock: number): void;
  /** civic topics currently eligible to enter conversations. */
  hotTopics(clock: number): string[];
  /** seed memories world injects at Society construction. */
  seedPlan(): { characterId: string; texts: string[] }[];
  view(): GovView;           // for snapshot()
  toJSON(): unknown; loadJSON(j: unknown): void;
}
```

`GovTickInput`: macro slice (unemployment, gini, cpi, homeless, meanWage,
rentBurden), `commuteCostIndex` (from transport view; 0 until transport
lands), per-Tier-A material rows `{ id, wage, employed, homeless, money }`,
shadow household count, hot centers `{id,x,z}[]`, civic venue points.

`GovTickResult` (commands the WORLD executes — gov moves no money itself):
`memoriesToWrite {characterId, text}[]`, `feedPosts {kind, authorId, topic,
text}[]`, `worldEvents {targetId, description, salienceHint, valenceHint}[]`,
`assemblyCall { place, startH, endH } | null`, `levies { payroll?, sales? }`
(rates; econ applies + credits treasury), `hires FirmDemandRow[]`,
`spendOrders { kind: 'transit-subsidy'|'civic-build'|'relief', amount }[]`,
`treasuryDelta` reconciliation, `historyEvents`.

## Conservation & determinism invariants (smoke-checked)

- Σ(taxes collected) === treasury inflow; treasury outflow === Σ(spend
  executed) + payroll; conservation to 1e-6 with a carry, audited in econ's
  `conservationError`.
- Votes: Σ(cast) === Σ(tallied); turnout ≤ population, exactly.
- Byte-identical `toJSON()` across same-seed runs (causal-smoke.ts:126
  discipline); all draws through an owned serialized mulberry32.
- dt-invariance: every rate per-sim-hour, EMAs via λ_eff = 1−(1−λ)^dt.
- Gate flip count bounded (hysteresis, no flicker).
- **Freedom checks**: with seeds removed, a 30-day run yields NO government
  (the spark matters); with seeds present, formation is possible but not
  guaranteed at low grievance; high imposed grievance + seeds ⇒ movement
  mass grows. Assert the *mechanism*, never a scripted outcome.

## scripts/gov-smoke.ts

Standalone (imports only `src/gov/`): synthetic macro curves (imposed
recession), synthetic conversation/feed traffic, moving centers. Assert the
invariants above + determinism + hysteresis + surrogate learning
(turnout shape Pearson r > 0.6 vs imposed curve) + the freedom checks.

## Wiring appendix (exact anchors, for the integration agent)

- town.ts:80 field `readonly gov = new GovField(...)`; tick keyed off
  `economy.tickSeq` beside causal (town.ts:240); cursor reset in loadJSON
  (town.ts:813 pattern); `gov: this.gov.view()` in snapshot (town.ts:757);
  `gov?: unknown` in TownJSON (town.ts:838).
- society.ts:108 seed injection at construction; society.ts:206 `stepGov`
  view assembly; decidePlace pull (society.ts:262).
- conversation.ts:80 topic injection; conversation.ts:165 opinion-transfer
  beside the memory writes.
- feed.ts: `PostRec.kind`, `inject()`, civic resonance term (feed.ts:198),
  cashIn efficacy (feed.ts:166).
- econ: treasury account in privateMoney (econsim.ts:592); levy debits
  (econsim.ts:276/283, shadowpop.ts:260/300); FirmDemand row
  (econsim.ts:689) + applyPlan dispatch (econsim.ts:727); EconEventKind /
  LaborEvent union extensions; `BuildKind 'civic'`.
- arbiter.ts:198 `civicPull`; IntentionKind + `attend_assembly` affordance
  at park/thirdplace (PLACES untouched otherwise — assemblies borrow venues
  until city hall exists).
- Mara caveat: her wallet is a mirrored legacy ledger (econsim.ts:203) —
  levy her via the town rent pattern (town.ts:201), not the Tier-A loop.
