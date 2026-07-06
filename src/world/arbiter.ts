// =============================================================================
// ExposomeSim — sim/arbiter.ts
// -----------------------------------------------------------------------------
// THE GOAL ARBITER. There is NO schedule. The daily/weekly loop is an EMERGENT
// property of a utility competition that runs every decision tick:
//
//   utility(intention) =  Σ_tier  w(tier)·deficit·satisfies        (Maslow pull)
//                       −  money / time / energy / travel costs     (the economy)
//                       +  circadian fit + habit bonus             (rhythm & ritual)
//                       +  urgency boosts (rent, sleep debt)        (binding needs)
//
// Maslow PREPOTENCY is encoded by gating each tier's weight on the satisfaction
// of all lower tiers — a starving Mara cannot be moved by an esteem affordance.
// FEASIBILITY VETOES keep the world honest (no food ⇒ can't eat; no money ⇒
// can't shop) while always leaving `work`/`go_home` open so she never deadlocks.
// HYSTERESIS (a switch margin) plays the role of a minimum dwell time and stops
// the loop from thrashing between near-equal options.
//
// Pure function — no DOM, no rendering, no mutation of inputs.
// =============================================================================

import type {
  NeedsReadout, NeedTier, Resources,
  PlaceId, IntentionKind, Intention, Place, Affordance,
} from '../core/types';
import { PLACES, PLACE_LIST, openNow, travelTime } from './places';
import { clamp } from '../core/util/num';

// ---- the contract the Town orchestrator passes in --------------------------
export interface ArbiterContext {
  needs: NeedsReadout;
  resources: Resources;
  clock: number;                                            // absolute sim-hours
  place: PlaceId;                                           // where Mara is now
  current?: Intention;                                      // incumbent (hysteresis)
  habit: (place: PlaceId, kind: IntentionKind) => number;   // learned ritual strength
  rng: () => number;                                        // deterministic jitter
}

// ---- tuning ---------------------------------------------------------------
const TIERS: NeedTier[] = ['physiological', 'safety', 'belonging', 'esteem', 'actualization'];

const K_MONEY    = 0.55;   // money cost, normalized by affordable budget
const K_TIME     = 0.03;   // opportunity cost per hour committed
const K_ENERGY   = 0.28;   // fatigue cost (rest has negative costEnergy ⇒ a bonus)
const K_TRAVEL   = 0.25;   // distance/time to get there
const K_HABIT    = 0.16;   // ritualization bonus
const K_DOMINANT = 0.05;   // small nudge to agree with needs.dominantTier readout
const CIRC_AMP   = 0.35;   // circadian fit amplitude

const K_WORK_LOWMONEY = 0.32; // chronic-poverty pull toward work
const K_WORK_RENT     = 0.75; // acute rent-deadline pull toward work
const K_REST          = 0.50; // night + sleep-debt pull toward rest
const MONEY_COMFORT   = 170;  // she is saving for tuition — the wage drive persists past rent

const SWITCH_MARGIN   = 0.12; // a challenger must beat the incumbent by this much
const JITTER          = 0.01; // tie-breaking exploration noise

// A synthetic affordance: "withdraw to the safety of home". Always feasible,
// so the argmax is never empty — Mara is never deadlocked.
const GO_HOME: Affordance = {
  kind: 'go_home', tier: 'safety', satisfies: 0.4,
  costMoney: 0, costEnergy: -0.05, durHours: 1,
};

// ---------------------------------------------------------------------------
// Maslow prepotency: a tier's available weight is throttled by the unmet
// deficit of every lower tier. Physiological is always weight 1; esteem only
// matters once hunger/safety/belonging are reasonably met.
// ---------------------------------------------------------------------------
function prepotencyWeights(needs: NeedsReadout): Record<NeedTier, number> {
  const w = {} as Record<NeedTier, number>;
  let gate = 1;
  for (const t of TIERS) {
    w[t] = gate;
    // SOFT prepotency: a lower deficit dims higher tiers but never silences them,
    // so a lonely-but-anxious Mara can still be pulled out to the café.
    gate *= clamp(1 - 0.55 * needs.deficit[t], 0.25, 1);
  }
  return w;
}

// The specific need channel an intention chiefly relieves (crisper than the
// aggregated per-tier deficit for physiological eat-vs-rest disambiguation).
function primaryNeed(kind: IntentionKind, n: NeedsReadout): number {
  switch (kind) {
    case 'eat':       return n.hunger;
    case 'buy_meal':  return n.hunger;                         // a prepared meal (work burger)
    case 'drink':     return n.thirst;
    case 'relieve':   return n.elimination;                   // steep near-full ⇒ overrides
    case 'bathe':     return n.cleanliness;
    case 'rest':      return n.energy;
    case 'socialize': return n.belonging;
    case 'linger':    return Math.max(0.4 * n.belonging, n.novelty);
    case 'work':      return Math.max(n.esteem, 0.3);          // always some wage drive
    case 'shop':      return Math.max(n.hunger, 0.2);          // instrumental → eating
    case 'go_home':   return Math.max(n.safety, 0.3 * n.energy);
    default:          return 0.3;
  }
}

// ---- circadian fit: rhythm without a schedule -----------------------------
function hourDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return d > 12 ? 24 - d : d;
}
function bump(h: number, center: number, width: number): number {
  const d = hourDiff(h, center);
  return Math.exp(-0.5 * (d / width) * (d / width));
}
function circadianFit(kind: IntentionKind, clock: number): number {
  const h = ((clock % 24) + 24) % 24;
  let f: number;
  switch (kind) {
    case 'work':      f = bump(h, 13, 4); break;                       // daytime
    case 'rest':      f = bump(h, 2, 4);  break;                       // night (wraps)
    case 'socialize': f = bump(h, 17, 5); break;                       // late afternoon → evening
    case 'linger':    f = bump(h, 16, 5); break;                       // afternoon/eve
    case 'shop':      f = bump(h, 15, 4); break;                       // daytime errand
    case 'go_home':   f = bump(h, 21, 4); break;                       // evening/night
    case 'drink':     f = 0.5; break;                                  // thirst has no clock
    case 'relieve':   f = 0.5; break;                                  // nor does the bladder
    case 'bathe':     f = bump(h, 7, 1.6); break;                      // morning ritual
    case 'buy_meal':  f = bump(h, 12.5, 1.5); break;                   // the lunch break
    case 'eat':       f = Math.max(bump(h, 8, 1.2), bump(h, 12.5, 1.5), bump(h, 19, 1.8)); break;
    default:          f = 0.3;
  }
  return CIRC_AMP * (f - 0.35);
}

// ---- urgency boosts --------------------------------------------------------
function workUrgency(ctx: ArbiterContext): number {
  const { money, rentDue, rentDueAt } = ctx.resources;
  let u = K_WORK_LOWMONEY * clamp(1 - money / MONEY_COMFORT, 0, 1);
  const hoursToRent = rentDueAt - ctx.clock;
  if (rentDue > 0 && hoursToRent < 48) {
    const shortfall = clamp((rentDue - money) / Math.max(rentDue, 1), 0, 1);
    const timePress = clamp(1 - hoursToRent / 48, 0, 1);
    u += K_WORK_RENT * shortfall * timePress;
  }
  // employment is a binding constraint, not a whim: a weekday daytime shift pulls
  // her to the counter regardless of mood (then evenings/weekends are hers).
  const day = Math.floor(ctx.clock / 24);
  const weekend = day % 7 === 5 || day % 7 === 6;
  const h = ((ctx.clock % 24) + 24) % 24;
  if (!weekend && h >= 8 && h < 15) u += 0.5;
  return u;
}
function restPull(ctx: ArbiterContext): number {
  const h = ((ctx.clock % 24) + 24) % 24;
  const night = h >= 22 || h < 6 ? 1 : 0;
  const debt = clamp(ctx.resources.sleepDebt / 8, 0, 1);
  return K_REST * (0.5 * ctx.needs.energy + 0.5 * debt) * (0.4 + 0.6 * night);
}

// ---- feasibility veto ------------------------------------------------------
function feasible(aff: Affordance, ctx: ArbiterContext): boolean {
  if (aff.needsFoodStock && ctx.resources.foodStock <= 0) return false; // can't eat empty
  if (aff.costMoney > 0 && ctx.resources.money < aff.costMoney) return false; // can't afford
  if (aff.kind === 'shop' && ctx.resources.foodStock > 8) return false;  // pantry already full
  if (aff.kind === 'bathe' && ctx.needs.cleanliness < 0.12) return false; // already clean
  if (aff.kind === 'relieve' && ctx.needs.elimination < 0.05) return false; // nothing to void
  if (aff.kind === 'buy_meal' && ctx.needs.hunger < 0.35) return false; // not hungry enough
  return true;
}

// grocery pull: a low fridge recruits a proactive shopping run (people restock
// before they are fully out), so the supermarket is a real, regular food source.
function groceryPull(ctx: ArbiterContext): number {
  const low = clamp(1 - ctx.resources.foodStock / 5, 0, 1);
  return 0.55 * low;
}

// deep-night sleep gate: while she should be asleep at home, non-urgent errands are
// suppressed and rest is pulled — so nights are for sleeping, mornings for the ritual.
function nightGate(kind: IntentionKind, clock: number): number {
  const h = ((clock % 24) + 24) % 24;
  if (!(h >= 23 || h < 6)) return 0;
  if (kind === 'rest') return 0.7;
  if (kind === 'relieve') return 0;          // the bladder can still wake her
  if (kind === 'drink') return -0.15;        // a sip is ok but not a priority
  return -0.5;                               // everything else waits for morning
}

// ---- the score of one (affordance @ place) candidate ----------------------
function score(aff: Affordance, place: Place, ctx: ArbiterContext, w: Record<NeedTier, number>): number {
  const tierVal    = w[aff.tier] * primaryNeed(aff.kind, ctx.needs) * aff.satisfies;
  const moneyCost  = K_MONEY  * aff.costMoney / Math.max(ctx.resources.money, 4);
  const timeCost   = K_TIME   * aff.durHours;
  const energyCost = K_ENERGY * aff.costEnergy;                 // rest < 0 ⇒ bonus
  const travel     = K_TRAVEL * travelTime(ctx.place, place.id);
  const circ       = circadianFit(aff.kind, ctx.clock);
  const habitBonus = K_HABIT  * ctx.habit(place.id, aff.kind);

  let u = tierVal - moneyCost - timeCost - energyCost - travel + circ + habitBonus;

  if (aff.tier === ctx.needs.dominantTier) u += K_DOMINANT;     // agree with readout
  if (aff.kind === 'work') u += workUrgency(ctx);               // rent / poverty
  if (aff.kind === 'rest') u += restPull(ctx);                  // night + sleep debt
  if (aff.kind === 'shop') u += groceryPull(ctx);              // empty fridge → restock
  u += nightGate(aff.kind, ctx.clock);                         // sleep through the night
  u += (ctx.rng() - 0.5) * 2 * JITTER;                          // break exact ties
  return u;
}

// ---- human-readable "why" for the dashboard -------------------------------
const pct = (x: number) => `${Math.round(x * 100)}%`;
function reasonFor(kind: IntentionKind, place: PlaceId, ctx: ArbiterContext): string {
  const n = ctx.needs;
  const at = `@ ${place}`;
  switch (kind) {
    case 'eat':       return `hungry (${pct(n.hunger)}) -> cook & eat ${at}`;
    case 'buy_meal':  return `hungry (${pct(n.hunger)}) -> grab a burger ${at}`;
    case 'drink':     return `thirsty (${pct(n.thirst)}) -> drink ${at}`;
    case 'relieve':   return `need the toilet (${pct(n.elimination)}) -> ${at}`;
    case 'bathe':     return `feeling grimy (${pct(n.cleanliness)}) -> bathe ${at}`;
    case 'shop':
      return n.hunger > 0.4 && ctx.resources.foodStock <= 0
        ? `hungry, foodStock empty -> shop ${at}`
        : `restock groceries -> shop ${at}`;
    case 'rest':      return `depleted (energy ${pct(n.energy)}) -> rest ${at}`;
    case 'work': {
      const rentSoon = ctx.resources.rentDue > 0
        && (ctx.resources.rentDueAt - ctx.clock) < 48
        && ctx.resources.money < ctx.resources.rentDue;
      if (rentSoon) return `rent due soon, short on money -> work ${at}`;
      if (ctx.resources.money < MONEY_COMFORT * 0.5) return `low on money -> work ${at}`;
      return `earn wage / esteem -> work ${at}`;
    }
    case 'socialize': return `lonely (belonging ${pct(n.belonging)}) -> socialize ${at}`;
    case 'linger':    return `seeking novelty (${pct(n.novelty)}) -> linger ${at}`;
    case 'go_home':   return `withdraw home (safety ${pct(n.safety)})`;
    default:          return `${kind} ${at}`;
  }
}

interface Scored { kind: IntentionKind; place: PlaceId; utility: number; }

// ===========================================================================
//  chooseIntention — the argmax over feasible, open, reachable affordances.
// ===========================================================================
export function chooseIntention(ctx: ArbiterContext): Intention {
  const w = prepotencyWeights(ctx.needs);

  // Dedup by (kind@place), keeping the strongest utility — a place may surface
  // an option more than once and we want a single best score per option.
  const best = new Map<string, Scored>();
  const offer = (kind: IntentionKind, place: PlaceId, utility: number) => {
    const key = `${kind}@${place}`;
    const prev = best.get(key);
    if (!prev || utility > prev.utility) best.set(key, { kind, place, utility });
  };

  // 1. Every authored affordance at every OPEN, reachable place.
  for (const place of PLACE_LIST) {
    if (!openNow(place, ctx.clock)) continue;
    for (const aff of place.affordances) {
      if (!feasible(aff, ctx)) continue;
      offer(aff.kind, place.id, score(aff, place, ctx, w));
    }
  }

  // 2. The guaranteed fallback: withdraw home. Costs nothing, needs nothing —
  //    so a broke, hungry, exhausted Mara at midnight is never deadlocked.
  offer(GO_HOME.kind, 'home', score(GO_HOME, PLACES.home, ctx, w));

  // 3. argmax.
  let winner: Scored | undefined;
  for (const c of best.values()) if (!winner || c.utility > winner.utility) winner = c;
  // best always holds the go_home fallback, so winner is defined; satisfy tsc.
  if (!winner) winner = { kind: 'go_home', place: 'home', utility: 0 };

  // 4. Hysteresis / min-dwell: the incumbent intention defends its position.
  //    A challenger only displaces it by beating it by SWITCH_MARGIN; this
  //    prevents the loop from thrashing between near-equal goals.
  let holding = false;
  if (ctx.current) {
    const inc = best.get(`${ctx.current.kind}@${ctx.current.place}`);
    if (inc && (inc.kind !== winner.kind || inc.place !== winner.place)) {
      if (winner.utility < inc.utility + SWITCH_MARGIN) {
        winner = inc;
        holding = true;
      }
    }
  }

  const reason = reasonFor(winner.kind, winner.place, ctx) + (holding ? ' [holding]' : '');
  return { kind: winner.kind, place: winner.place, utility: winner.utility, reason };
}
