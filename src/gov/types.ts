// =============================================================================
// ExposomeSim — POLIS shared contract.
// -----------------------------------------------------------------------------
// Government is a phase transition in a social field, never a scripted feature
// (POLIS_DESIGN.md). Everything under src/gov/ imports ONLY from this file,
// core/util, and the reusable causal primitives (CausalGate / VenueStats) — no
// THREE, no DOM, no econ classes, no world. The world composes the module: gov
// emits COMMANDS (memory texts, feed posts, levies, hires, spend orders) and
// the world/econ execute them — gov itself never moves money, people or votes.
// =============================================================================

// ---- civic topics -------------------------------------------------------------
// Namespaced 'civic:<slug>' so conversation/feed matching stays exact-string,
// exactly like INTEREST_POOL hobby topics (interests.ts).

/** the grievance categories material conditions can load. */
export const CIVIC_CATEGORIES = ['jobs', 'rent', 'prices', 'wages', 'transit'] as const;
export type CivicCategory = (typeof CIVIC_CATEGORIES)[number];

/** category → exact-match conversation/feed topic string. */
export const civicTopic = (c: CivicCategory | 'assembly' | 'charter' | 'election' | 'recall'): string =>
  `civic:${c}`;

export const isCivicTopic = (topic: string): boolean => topic.startsWith('civic:');

// ---- tick input (assembled by Town/Society each econ tick) --------------------

/** the macro slice gov reads grievance from — all real, sim-computed numbers. */
export interface GovMacroSlice {
  unemployment: number;   // 0..1
  gini: number;           // 0..1
  cpi: number;            // price index, 1 = base year
  homeless: number;       // homeless share of households, 0..1
  meanWage: number;       // $/sim-h
  rentBurden: number;     // rent / income share, 0..1+
}

/** one Tier-A character's material conditions (from walletOf/AgentEconView). */
export interface TierAMaterialRow {
  id: string;             // profile.id — the side-table key (never touch character.ts)
  wage: number;
  employed: boolean;
  homeless: boolean;
  money: number;
}

/** a point of causal attention or a civic venue, world metres. */
export interface CivicPoint { id: string; x: number; z: number; }

export interface GovTickInput {
  macro: GovMacroSlice;
  /** generalized commute cost from transport's view; 0 until transport lands. */
  commuteCostIndex: number;
  tierA: TierAMaterialRow[];
  /** shadow household count (the opinion field's N). */
  shadowHouseholds: number;
  /** coarse adjacency summary: pairwise-link density (0..1) among the currently
   *  SALIENT Tier-A agents — the world computes it from relationship ledgers.
   *  Formation requires a connected cluster, not a raw global mean. */
  adjacency: { density01: number };
  /** current causal centers (Tier-A positions; the hot radius follows them). */
  hotCenters: readonly CivicPoint[];
  /** venues an assembly may borrow (park, food court — no city hall exists). */
  civicVenues: readonly CivicPoint[];
  /** econ's report of actual treasury flows since last tick (gov reconciles;
   *  it never credits/debits itself). Absent ⇒ 0. */
  treasuryCredited?: number;
  treasuryDebited?: number;
}

// ---- tick result (commands the WORLD executes) ---------------------------------

export type CivicPostKind = 'petition' | 'announcement' | 'ballot' | 'result';

export type SpendKind = 'transit-subsidy' | 'civic-build' | 'relief';

/** a labor demand row econ folds into firmDemands() (Construction precedent —
 *  structural on purpose: gov never imports econ classes). */
export interface FirmDemandRow {
  id: string;             // e.g. 'gov:office'
  name: string;
  wage: number;
  desired: number;        // desired headcount (0 ⇒ clerks quit / are let go)
  minSkill: number;
}

export interface GovTickResult {
  /** world writes these via ch.memory.add (the company.ts:322 pattern). */
  memoriesToWrite: { characterId: string; text: string }[];
  /** world injects these via PublicFeed.inject(). */
  feedPosts: { kind: CivicPostKind; authorId: string; topic: string; text: string }[];
  /** per-attendee perceptual packets (ch.perceive + applyDriverResponse). */
  worldEvents: { targetId: string; description: string; salienceHint: number; valenceHint: number }[];
  /** non-null exactly on the tick an assembly is called. */
  assemblyCall: { place: string; startH: number; endH: number } | null;
  /** tax RATES in force — econ applies them and credits the treasury. */
  levies: { payroll?: number; sales?: number };
  /** recruitment rows for econ's labor market. */
  hires: FirmDemandRow[];
  /** budget lines to execute as econ procurement — gov conjures no goods. */
  spendOrders: { kind: SpendKind; amount: number }[];
  /** gov-ledger balance change this tick (credited − debited), for econ's
   *  conservationError audit. */
  treasuryDelta: number;
  historyEvents: GovEvent[];
}

// ---- institution state machine --------------------------------------------------

export type InstitutionState =
  | 'dormant'          // no movement — the default fate of most runs
  | 'stirring'         // salience mass in a connected cluster, below call threshold
  | 'assembly-called'  // an assembly is scheduled / ratification ballot running
  | 'chartered'        // charter ratified; treasury exists; election pending
  | 'elected'          // officials seated; levies + budget lines in force
  | 'insolvent'        // treasury can't cover obligations; clerks quit
  | 'recalled'         // steward removed by ballot; re-election pending
  | 'dissolved';       // the institution failed; the field may stir again

/** the edges the machine may traverse — smoke tests assert nothing else ever
 *  happens. Every transition is rate/threshold-driven, none clock-scripted. */
export const ALLOWED_TRANSITIONS: readonly [InstitutionState, InstitutionState][] = [
  ['dormant', 'stirring'], ['stirring', 'dormant'],
  ['stirring', 'assembly-called'],
  ['assembly-called', 'stirring'],       // quorum fail / ratification fail
  ['assembly-called', 'chartered'],
  ['chartered', 'elected'],
  ['elected', 'insolvent'], ['insolvent', 'elected'],
  ['insolvent', 'dissolved'],
  ['elected', 'recalled'], ['recalled', 'chartered'],
  ['elected', 'dissolved'],
  ['dissolved', 'dormant'],
];

// ---- ballots (conserved integer counts) ----------------------------------------

export type BallotKind = 'ratify' | 'elect' | 'recall';

export interface BallotView {
  kind: BallotKind;
  topic: string;
  opensH: number;
  closesH: number;
  candidateId: string | null;
  resolved: boolean;
  passed: boolean;
  tierACast: number;
  shadowCast: number;
  yes: number;
  no: number;
  eligible: number;
}

// ---- officials -------------------------------------------------------------------

export type OfficeKind = 'steward' | 'clerk';

/** who holds an office: a roster character (full-res for free) or a shadow
 *  citizen — sampleProfile(profileSeed) + MindLite, instantiated only when
 *  observed (the town.ts:587 on-demand pattern). */
export type OfficeHolder =
  | { kind: 'roster'; id: string }
  | { kind: 'shadow'; profileSeed: number };

export interface OfficialView {
  office: OfficeKind;
  holder: OfficeHolder;
  seatedAtH: number;
}

// ---- conversations ----------------------------------------------------------------

/** what a civic conversation exchanged. Stance deltas are ALREADY applied to
 *  gov's side table; the memory texts are for the world to write via
 *  ch.memory.add (gov never touches a memory graph itself). */
export interface CivicExchange {
  topic: string;
  dSupportA: number;
  dSupportB: number;
  memoryA: string | null;
  memoryB: string | null;
}

// ---- history ------------------------------------------------------------------------

export type GovEventKind =
  | 'stir' | 'wane' | 'petition' | 'assembly' | 'quorum-fail'
  | 'charter' | 'charter-fail' | 'election' | 'election-fail'
  | 'levy' | 'spend' | 'hire' | 'recall' | 'recall-fail'
  | 'insolvent' | 'recover' | 'rival' | 'dissolve';

export interface GovEvent {
  t: number;
  kind: GovEventKind;
  label: string;
  mag?: number;
}

export interface GovHistoryView {
  version: number;
  n: number;
  stride: number;
  fields: readonly string[];
  data: number[][];
  events: GovEvent[];
}

// ---- view -----------------------------------------------------------------------------

export interface GovTierAView {
  id: string;
  salience: number;
  grievance: number;
  support: number;
  influence: number;
}

export interface GovView {
  state: InstitutionState;
  mass: number;
  agitation: number;
  leaderId: string | null;
  legitimacy: number;
  levies: { payroll: number; sales: number };
  treasury: { balance: number; credited: number; debited: number; insolvent: boolean };
  tierA: GovTierAView[];
  shadow: { n: number; meanSupport: number; meanGrievance: number; posShare: number; negShare: number };
  rival: { active: boolean; mass: number };
  officials: OfficialView[];
  ballot: BallotView | null;       // the OPEN ballot, if any
  lastBallot: BallotView | null;   // the most recently RESOLVED ballot
  assembly: { place: string; startH: number; endH: number } | null;
  policy: { kind: SpendKind; share: number }[];
  topics: string[];
  hotCivic: string[];
  history: GovHistoryView;
}
