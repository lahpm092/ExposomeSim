# ExposomeSim — World Expansion (phase 5): supply chains, premises, archetypes, and the causal radius

Everything here follows one rule: **events emerge from signals; only physics is authored.**
Templates (costs, capacities, palettes) are physics. Foundings, buildings, leases, purchases,
prices, and who-supplies-whom are emergent.

## 1. The goods economy (supply chains)

New layer under `src/econ/goods.ts` + `wholesale.ts`:

- `GoodId = 'produce' | 'dairy' | 'bakery' | 'meat' | 'grains' | 'drinks' | 'furniture' | 'apparel'`
- **WholesaleMarket** per good — same tâtonnement engine as GoodsMarket (base ≈ 55% of retail
  anchor). Sellers: MAKER firms. Buyers: RETAIL firms restocking shelves.
- `Business` gains `kind: 'service' | 'maker' | 'retail'` and `good?: GoodId`:
  - **service** — exactly today's behavior (Counter, Meridian, Civic W&P, café).
  - **maker** — produces its good (labor → units, Metzler expectations + inventory reused),
    sells into the wholesale market. Small external raw-material COGS remains.
  - **retail** — holds per-good shelf stock; buys at wholesale (cash → wholesale market →
    makers pro-rata by offer) to restock toward expected sales; sells at the retail sector
    price. Retail margin = retail − wholesale, both emergent. What used to leak to External
    as COGS is now INTERNAL income for makers → wages → demand (a real multiplier).
- The existing `Supermarket` singleton becomes a retail Business ('Meridian Fresh Market')
  with a per-category shelf; grocery categories map 1:1 onto goods. Grocery demand splits
  across grocery retailers by offer share → a SECOND supermarket can EMERGE via retail entry
  when grocery margins run fat (not seeded — earned).
- Grains + drinks stay import-supplied (world-price anchor) until a maker enters.
- **Durables demand**: shadow households get `furnWear`/`apparelWear` fields that grow with
  time+use; crossing 1 with money on hand = a discrete purchase (reset with jitter). Tier-A
  agents get a simple equivalent. New retail sectors `homegoods` + `apparel` join the CPI
  basket at small weights.
- Entry (existing margin machinery) extends to: maker entry on wholesale margins/shortage,
  retail entry on retail-vs-wholesale margins. Seeded makers at t0: a bakery and a furniture
  workshop (so wholesale markets are alive); everything else emerges.

## 2. Premises (commercial real estate)

`src/econ/premises.ts` — a CommercialRegistry:
- Construction completes `shopfront` / `workshop` buildings → each adds 1-2 `CommercialUnit`s
  (id, lot, rent, tenantId?).
- Entrants without premises go into a **pending queue** and operate "from home" at 0.4
  capacity until they lease; leasing fits the building to the tenant's archetype (render).
- Lease is a real transfer: tenant firm → building-owner construction firm each rent period.
- The old `extraCap` commercial-capacity pad is REMOVED (it was a hack; premises replace it).
- Construction demand signal = housing vacancy (existing) + pending-entrant queue depth +
  commercial vacancy. **Two competing construction firms** (Ironline + Keystone & Sons),
  both financed through the banking system, both hiring on the labor market, per-firm
  cooldowns; whoever has cash/credit + crew breaks ground first.

## 3. The causal radius + the evolving surrogate (`src/causal/`)

Principle: the radius gates the RESOLUTION of causality, never conservation. The econ tick
still computes exact aggregate flows; the causal layer decides where those flows become
DISCRETE, WATCHED events versus statistical drift.

- `CausalGate` — centers: all Tier-A agent positions (+ the camera). A venue is HOT when
  inside any center's radius (R≈55m; hysteresis so it doesn't flicker). Recomputed on a
  coarse cadence.
- `VenueFlow` — per venue (business premises): converts that venue's share of the sector's
  aggregate demand this tick into **discrete customer arrivals** (Poisson thinning against
  an hour-of-day shape) with basket sizes — but ONLY while HOT. Cold venues accumulate the
  same aggregate flow silently. Totals reconcile with the econ tick either way.
- `VenueStats` — THE EVOLVING PROBABILISTIC FUNCTION. Per venue: 24 hour-buckets of EMA
  (arrival rate, mean basket, revenue) + a visit count. Updated ONLY from HOT (fully
  simulated) episodes. Hierarchical shrinkage: venue-specific stats blend with the pooled
  per-archetype prior by confidence (count-based), so never-visited venues inherit the
  town's average causality, and often-visited venues speak for themselves. Because it is
  refit continuously from live causal episodes, the surrogate always represents the average
  causality of the system AT ITS CURRENT STAGE — a recession observed up close makes the
  whole cold world quieter; a boom loudens it.
- Consumers of the surrogate: cold-venue ambience (render crowd density when the camera
  flies past a cold venue), the observatory (optional), and future coarse ticks.
- Persisted in EconJSON (nVenues × 24 × 3 floats, rounded).

## 4. Distinct low-poly architecture + goods assets (`src/render/archetypes/`)

- Contract: `archetypes/contract.ts` — `registerArchetype(kind, builder)`;
  `builder(ctx: { w, d, floors, seed, variant }) → THREE.Group` (exterior) plus optional
  `interior(ctx)` group (only mounted when camera-near — render what's needed).
- Archetypes (each visually distinct, high taste, kit-built like render/supermarket.ts):
  bakery (masonry oven chimney, arched window, awning), butcher (striped awning, tile
  band), greengrocer (tiered crate stands), dairy co-op (silo + gambrel roof), furniture
  workshop (timber frame, plank stacks, sawhorse), tailor/apparel (mannequin bay window,
  cloth bolts), rival supermarket (contrasting roofline/signage vs Meridian Fresh),
  generic workshop, construction yard (crane, material piles).
- Goods assets (`archetypes/goodsassets.ts`): bread loaves/baguette clusters, produce
  crates, cheese wheels/milk cans, hanging cuts, plank+chair stacks, cloth bolts, shelf
  modules — instanced, palette-consistent, reused across shops' interiors and window
  displays.
- `buildsite.ts`: while under construction → scaffold shell; complete+leased → the tenant
  archetype's exterior; interiors mount only within camera radius (`CausalGate` +
  camera distance), disposed when far.

## 5. Verification

- econ-smoke grows: wholesale market cleared with maker revenue; a retailer restocked from
  wholesale (cash moved retailer→maker); a durable was purchased; the pending-premises queue
  and a lease both occurred; two construction firms both built; conservation still exact.
- causal-smoke (new, headless): hot venue produces discrete arrivals whose sum tracks the
  aggregate; VenueStats converge toward imposed rates; cold+hot totals reconcile.
- Captures: city shots of each archetype; observatory unchanged-green; town-smoke green.
