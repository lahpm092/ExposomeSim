// =============================================================================
// ExposomeSim — GOV FIELD: the facade. Government as a phase transition.
// -----------------------------------------------------------------------------
// Town calls tick() keyed off economy.tickSeq (the causal precedent,
// town.ts:240); Society routes civic conversations and feed engagement through
// onConversation()/onFeedEngagement(); seedPlan() hands the world the three
// civic memory sets at construction. Everything gov "does" comes back as
// COMMANDS in GovTickResult — the world writes the memories, injects the
// posts, applies the levies, executes the procurement. Gov moves nothing.
//
// The institution's life is a state machine
//   dormant → stirring → assembly-called → chartered → elected
//                                        ↘ (insolvent | recalled | dissolved)
// whose every transition is a threshold crossed or a hazard fired by real
// dynamics — grievance from material conditions, salience from seeded memory
// and live engagement, percolation over the social graph, votes, money.
// Nothing is scheduled by the calendar; most runs never leave dormant.
//
// Resolution ladder: the opinion field + treasury + ballots are Tier P (O(N)
// per econ tick); assemblies become OBSERVED events only when a causal center
// stands at the venue — an owned CausalGate instance with hysteresis. The
// turnout surrogate (an owned VenueStats) learns ONLY from real engagement
// and real attendance (stats.ts:79 discipline): shadow turnout is sampled
// FROM it and never fed back.
// =============================================================================

import { clamp, mulberry32, type RNG } from '../core/util/num';
import { CausalGate } from '../causal/gate';
import { VenueStats } from '../causal/stats';
import { OpinionField, categoryScores, grievanceTarget } from './opinion';
import { Movement } from './movement';
import { CharterProcess } from './charter';
import { GovTreasury } from './treasury';
import { Officials } from './officials';
import { GovHistory, STATE_CODE } from './history';
import { civicSeedPlan } from './seeds';
import {
  ALLOWED_TRANSITIONS, CIVIC_CATEGORIES, civicTopic, isCivicTopic,
} from './types';
import type {
  BallotView, CivicCategory, CivicExchange, CivicPostKind,
  GovTickInput, GovTickResult, GovView, InstitutionState,
} from './types';

// ---- cadences & thresholds (rates per sim-hour; EMAs half-life based) ---------
const GATE_PERIOD_H = 0.25;    // gate sweep throttle (causal/index.ts discipline)
const HL_AGITATION = 6;        // engagement-rate EMA half-life
const ENG_NORM_PER_H = 4;      // engagement events/h that saturate agitation
const PETITION_HAZ_PER_H = 0.06;
const ELECTION_RETRY_H = 24;   // failed election reopens after this
const REDERIVE_H = 72;         // budget shares re-derived on this cadence
const INSOLVENT_ENTER_H = 72;  // hours underwater before the state flips
const DISSOLVE_INSOLVENT_H = 168; // insolvent this long ⇒ dissolution
const LEGIT_COLLAPSE_T = 0.12; // legitimacy below this accrues collapse hours
const LEGIT_COLLAPSE_H = 96;
const DORMANT_COOLDOWN_H = 48; // dissolved sits this long before the field may stir again
const SHADOW_TURNOUT_K = 0.12; // shadow assembly attendance propensity
const MEMO_SALIENCE_T = 0.3;   // salient enough to carry a civic memory home
const TOPIC_SCORE_T = 0.12;    // a category this loaded can enter conversations
const SALIENCE_FLOOR = 0.15;   // below this nobody brings civics up at all
const PULSE_ID = 'civic:pulse';       // the engagement surrogate's venue id
const VENUE_ARCH = 'civic-venue';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number) => clamp(x, 0, 1);
const hourOf = (clock: number) => ((Math.floor(clock) % 24) + 24) % 24;

/** how a category reads in prose (posts, memories). */
const TOPIC_LABEL: Record<CivicCategory, string> = {
  jobs: 'the work drying up', rent: 'the rents', prices: 'prices climbing',
  wages: 'what work pays here', transit: 'getting across town',
};

export interface GovFieldOpts { seed?: number; }

export class GovField {
  private readonly seed: number;
  private rng: RNG;

  readonly opinion: OpinionField;
  readonly movement: Movement;
  readonly charterProc: CharterProcess;
  readonly treasury: GovTreasury;
  readonly officials: Officials;
  readonly gate: CausalGate;
  readonly stats: VenueStats;
  readonly history = new GovHistory();

  private state: InstitutionState = 'dormant';
  private lastGateH: number | null = null;

  /** real engagement events since the last tick — the surrogate's ground truth. */
  private engAcc = 0;
  private agitation = 0;

  /** cached category scores + grievance target (hotTopics reads between ticks). */
  private scores: Record<CivicCategory, number> = { jobs: 0, rent: 0, prices: 0, wages: 0, transit: 0 };
  private gStar = 0;

  private clerksDesired = 0;
  private electionRetryAcc = 0;
  private rederiveAcc = 0;
  private insolventSinceH = 0;
  private legitCollapseAcc = 0;
  private dissolvedAtH = 0;
  private lastBallot: BallotView | null = null;
  private firstSpendDone = false;

  constructor(opts: GovFieldOpts = {}) {
    this.seed = (opts.seed ?? 1) >>> 0;
    this.rng = mulberry32((this.seed + 303) >>> 0);
    this.opinion = new OpinionField((this.seed ^ 0x9e3779b9) >>> 0);
    this.movement = new Movement((this.seed + 101) >>> 0);
    this.charterProc = new CharterProcess((this.seed + 202) >>> 0);
    this.treasury = new GovTreasury();
    this.officials = new Officials();
    this.gate = new CausalGate();
    this.stats = new VenueStats();
  }

  // ---------------------------------------------------------------------------
  // seedPlan — the world consumes this at Society construction and writes the
  // texts via ch.memory.seed(). CONSUMING it is what plants the spark gov-side;
  // a world that never calls this gets a field that never wakes (the freedom
  // check's control arm).
  // ---------------------------------------------------------------------------
  seedPlan(): { characterId: string; texts: string[] }[] {
    const plan = civicSeedPlan();
    this.opinion.markSeeded(plan.map((p) => p.characterId));
    return plan;
  }

  // ---------------------------------------------------------------------------
  // hotTopics — civic topics eligible to enter the conversation candidate pool
  // (exact-string, INTEREST_POOL-style). Empty while nobody carries the theme.
  // ---------------------------------------------------------------------------
  hotTopics(_clock: number): string[] {
    if (this.opinion.maxSalience() < SALIENCE_FLOOR) return [];
    const out: string[] = [];
    const b = this.charterProc.activeBallot();
    if (b && !b.resolved) out.push(b.kind === 'ratify' ? civicTopic('charter') : b.kind === 'elect' ? civicTopic('election') : civicTopic('recall'));
    if (this.state === 'assembly-called' && this.movement.assemblyRec()) out.push(civicTopic('assembly'));
    const cats = CIVIC_CATEGORIES.filter((c) => this.scores[c] >= TOPIC_SCORE_T)
      .sort((a, b2) => this.scores[b2] - this.scores[a]);
    for (const c of cats.slice(0, 3)) out.push(civicTopic(c));
    return out;
  }

  // ---------------------------------------------------------------------------
  // onConversation — a civic topic came up between two agents. Warmth × trust
  // is the persuasion gain (the conversation.ts:135 formula's civic payload);
  // gov applies stance deltas to its side table and hands back memory texts
  // for the world to write. A real, watched engagement — it teaches the pulse.
  // ---------------------------------------------------------------------------
  onConversation(aId: string, bId: string, topic: string, warmth: number,
                 trustAB: number, trustBA: number, _clock: number): CivicExchange | null {
    if (!isCivicTopic(topic)) return null;
    this.engAcc += 1;
    const x = this.opinion.applyConversation(aId, bId, warmth, trustAB, trustBA);
    // persuasion is influence: whoever moved the other more, earned it.
    this.movement.addEngagementReceived(aId, Math.min(0.5, Math.abs(x.dB) * 3));
    this.movement.addEngagementReceived(bId, Math.min(0.5, Math.abs(x.dA) * 3));
    return {
      topic,
      dSupportA: x.dA,
      dSupportB: x.dB,
      memoryA: Math.abs(x.sA) > 0.25 ? this.convMemory(topic, x.sA) : null,
      memoryB: Math.abs(x.sB) > 0.25 ? this.convMemory(topic, x.sB) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // onFeedEngagement — a like/sign/reply on a civic post. Raises the reader's
  // salience, nudges their stance toward the author's, and builds the author's
  // influence (petition signatures weigh most — the likes[] array IS the
  // signature list, feed-side).
  // ---------------------------------------------------------------------------
  onFeedEngagement(readerId: string, postKind: CivicPostKind, authorId: string, _clock: number): void {
    this.engAcc += 1;
    const strong = postKind === 'petition' || postKind === 'ballot';
    this.opinion.applyFeedEngagement(readerId, authorId, strong);
    this.movement.addEngagementReceived(authorId, strong ? 0.15 : 0.08);
  }

  // ---------------------------------------------------------------------------
  // tick — one aggregate step (~1 sim-h, econ cadence). O(tierA + shadowN).
  // ---------------------------------------------------------------------------
  tick(input: GovTickInput, clock: number, dtH: number): GovTickResult {
    const res: GovTickResult = {
      memoriesToWrite: [], feedPosts: [], worldEvents: [], assemblyCall: null,
      levies: {}, hires: [], spendOrders: [], treasuryDelta: 0, historyEvents: [],
    };
    if (!(dtH > 0)) return res;
    const ev = (kind: Parameters<GovHistory['event']>[1], label: string, mag?: number) => {
      this.history.event(clock, kind, label, mag);
      res.historyEvents.push({ t: clock, kind, label, ...(mag === undefined ? {} : { mag }) });
    };

    // ---- 1 · material conditions → grievance field ---------------------------
    this.scores = categoryScores(input.macro, input.commuteCostIndex);
    this.gStar = grievanceTarget(this.scores);
    const credited = input.treasuryCredited ?? 0;
    const debited = input.treasuryDebited ?? 0;
    this.treasury.report(credited, debited, dtH);
    res.treasuryDelta = credited - debited;
    const charter = this.charterProc.charterRec();
    const leviesOn = charter !== null && (this.state === 'chartered' || this.state === 'elected'
      || this.state === 'insolvent' || this.state === 'recalled');
    const payrollRate = leviesOn ? charter!.levyPayroll : 0;

    // ---- 2 · the pulse: real engagement teaches the surrogate (hot only) -----
    const lamA = 1 - Math.pow(0.5, dtH / HL_AGITATION);
    this.agitation += lamA * (clamp01(this.engAcc / dtH / ENG_NORM_PER_H) - this.agitation);
    this.stats.observe(PULSE_ID, 'civic', hourOf(clock), this.engAcc, 1, dtH);
    this.engAcc = 0;

    // ---- 3 · opinion sweep ----------------------------------------------------
    this.opinion.tick(input, this.gStar, this.agitation, payrollRate, dtH);

    // ---- 4 · gate sweep over civic venues (throttled, hysteretic) -------------
    if (this.lastGateH === null || clock - this.lastGateH >= GATE_PERIOD_H - 1e-9) {
      this.gate.update(input.hotCenters, input.civicVenues.map((v) => ({ ...v, archetype: VENUE_ARCH })), clock);
      this.lastGateH = clock;
    }

    // ---- 5 · movement: percolation mass + threshold signals -------------------
    const sig = this.movement.tick(this.opinion.tierMass(), input.adjacency.density01,
                                   this.opinion.meanShadowSupport(), dtH);
    if (sig.stir && this.state === 'dormant') { this.setState('stirring'); ev('stir', 'something is stirring', this.movement.mass()); }
    if (sig.wane && this.state === 'stirring') { this.setState('dormant'); ev('wane', 'the moment passes', this.movement.mass()); }

    if (sig.callAssembly && this.state === 'stirring' && input.civicVenues.length) {
      const venue = input.civicVenues[(this.rng() * input.civicVenues.length) | 0];
      const a = this.movement.openAssembly(venue, clock);
      this.setState('assembly-called');
      res.assemblyCall = { place: a.place, startH: a.startH, endH: a.endH };
      const caller = this.leaderId() ?? this.opinion.salientIds()[0] ?? '';
      res.feedPosts.push({
        kind: 'announcement', authorId: caller, topic: civicTopic('assembly'),
        text: `Open assembly at the ${a.place}, ${hourOf(a.startH)}:00. Come say what this town is failing at — out loud, together.`,
      });
      for (const row of this.opinion.rows()) {
        if (row.salience < MEMO_SALIENCE_T) continue;
        res.worldEvents.push({
          targetId: row.id,
          description: `Word is going around: an open assembly at the ${a.place} — people are finally naming what this town is failing at.`,
          salienceHint: clamp01(0.5 + 0.4 * row.salience),
          valenceHint: 0.15,
        });
      }
      ev('assembly', `assembly called at ${a.place}`, this.movement.mass());
    }
    // a dissolved institution's movement may outlive it: if the mass is still
    // latched when the cooldown ends, the field re-stirs (no fresh crossing).
    // Ordered AFTER the call block so a tick never walks two edges at once.
    if (!sig.stir && this.state === 'dormant' && this.movement.isStirring()) {
      this.setState('stirring'); ev('stir', 'the embers catch again', this.movement.mass());
    }
    this.movement.noteAttendance(input.hotCenters, clock);

    // ---- 6 · assembly resolution: quorum or fizzle ----------------------------
    const due = this.movement.dueAssembly(clock);
    if (due) {
      const tierAttend = due.attendees.length;
      // shadow attendance sampled FROM the surrogate — never fed back into it.
      const lamShadow = input.shadowHouseholds * Math.max(0, this.opinion.meanShadowSupport())
        * SHADOW_TURNOUT_K * this.stats.shape(due.place, VENUE_ARCH, hourOf(due.startH));
      const shadowAttend = Math.min(input.shadowHouseholds, poisson(this.rng, lamShadow));
      if (this.gate.isHot(due.place)) {
        // a watched assembly is ground truth for THIS venue's turnout shape —
        // real attendees only (the shadow crowd is the model's own output).
        this.stats.observe(due.place, VENUE_ARCH, hourOf(due.startH), tierAttend, 1, due.endH - due.startH);
      }
      this.movement.clearAssembly();
      const quorum = tierAttend >= 2 && tierAttend + 0.05 * shadowAttend >= 3;
      if (quorum) {
        this.charterProc.draft(this.scores, clock);
        const eligible = input.tierA.length + input.shadowHouseholds;
        this.charterProc.openBallot('ratify', civicTopic('charter'), clock, eligible);
        const author = this.leaderId() ?? due.attendees[0] ?? '';
        res.feedPosts.push({
          kind: 'ballot', authorId: author, topic: civicTopic('charter'),
          text: `The assembly drafted a charter — a sliver of wages, pooled, pointed at what hurts. The vote is open for two days.`,
        });
        for (const id of due.attendees) {
          res.memoriesToWrite.push({
            characterId: id,
            text: `The assembly at the ${due.place} actually happened — a crowd, motions read out, a vote to come. The town felt different walking home.`,
          });
        }
        ev('assembly', `assembly met: ${tierAttend} + ~${shadowAttend} attended`, tierAttend + shadowAttend);
      } else {
        this.setState('stirring');
        this.movement.damp(0.6);
        ev('quorum-fail', `assembly fizzled (${tierAttend} came)`, tierAttend);
      }
    }

    // ---- 7 · ballots close ----------------------------------------------------
    const closed = this.charterProc.tallyIfDue(clock, {
      tier: this.opinion.rows(),
      shadowN: input.shadowHouseholds,
      shadowSupportMean: this.opinion.meanShadowSupport(),
    });
    if (closed) {
      this.lastBallot = { ...closed };
      this.charterProc.clearBallot();
      const cast = closed.yes + closed.no;
      const yesShare = cast > 0 ? closed.yes / cast : 0;
      if (closed.kind === 'ratify') {
        if (closed.passed) {
          this.setState('chartered');
          this.charterProc.setLegitimacy(yesShare);
          ev('charter', `charter ratified ${closed.yes}–${closed.no}`, yesShare);
          ev('levy', `payroll levy ${(this.charterProc.charterRec()!.levyPayroll * 100).toFixed(0)}% in force`);
          this.openElection(input, clock, res);
          const top = this.topCategory();
          res.feedPosts.push({
            kind: 'result', authorId: this.leaderId() ?? '', topic: civicTopic('charter'),
            text: `The charter passed, ${closed.yes} to ${closed.no}. The pool is real now, and it is pointed at ${TOPIC_LABEL[top]}.`,
          });
          for (const row of this.opinion.rows()) {
            if (row.salience < MEMO_SALIENCE_T) continue;
            res.memoriesToWrite.push({
              characterId: row.id,
              text: `The charter passed. We taxed ourselves a sliver of wages and pointed it at ${TOPIC_LABEL[top]}. It has our names on it.`,
            });
          }
        } else {
          this.setState('stirring');
          this.charterProc.dropCharter();
          this.movement.damp(0.6);
          ev('charter-fail', `charter voted down ${closed.yes}–${closed.no}`, yesShare);
        }
      } else if (closed.kind === 'elect') {
        if (closed.passed && closed.candidateId) {
          const holder = closed.candidateId.startsWith('shadow:')
            ? { kind: 'shadow' as const, profileSeed: Number(closed.candidateId.slice(7)) >>> 0 }
            : { kind: 'roster' as const, id: closed.candidateId };
          this.officials.seat('steward', holder, clock);
          this.setState('elected');
          this.clerksDesired = this.officials.clerkTarget();
          this.electionRetryAcc = 0;
          ev('election', `steward elected ${closed.yes}–${closed.no}`, yesShare);
          res.feedPosts.push({
            kind: 'result', authorId: closed.candidateId.startsWith('shadow:') ? '' : closed.candidateId,
            topic: civicTopic('election'),
            text: `The count is in: ${closed.yes} to ${closed.no}. We have a steward. Whatever comes next, we chose it.`,
          });
          for (const row of this.opinion.rows()) {
            if (row.salience < MEMO_SALIENCE_T) continue;
            res.memoriesToWrite.push({ characterId: row.id, text: 'We chose a steward by ballot. Whatever comes next, we chose it ourselves.' });
          }
        } else {
          this.electionRetryAcc = 0;
          ev('election-fail', `election failed ${closed.yes}–${closed.no}`, yesShare);
        }
      } else { // recall
        if (closed.passed) {
          this.officials.unseat('steward');
          this.setState('recalled');
          ev('recall', `steward recalled ${closed.yes}–${closed.no}`, yesShare);
          res.feedPosts.push({
            kind: 'result', authorId: '', topic: civicTopic('recall'),
            text: `The recall carried, ${closed.yes} to ${closed.no}. The office is vacant; the charter stands.`,
          });
        } else {
          ev('recall-fail', `recall failed ${closed.yes}–${closed.no}`, yesShare);
        }
      }
    }

    // ---- 8 · institution upkeep -----------------------------------------------
    if (charter && this.state !== 'dissolved') {
      this.charterProc.stepLegitimacy(this.opinion.meanSupportAll(), this.gStar, this.state === 'insolvent', dtH);
    }
    if (this.charterProc.stepRival(this.opinion.wingShares(), dtH)) {
      ev('rival', 'a rival wing coheres against the movement', this.charterProc.rival().mass);
    }

    if (this.state === 'recalled') {
      // the charter survives its steward: straight back to election season.
      this.setState('chartered');
      this.openElection(input, clock, res);
    } else if (this.state === 'chartered' && !this.officials.hasSteward() && !this.charterProc.activeBallot()) {
      this.electionRetryAcc += dtH;
      if (this.electionRetryAcc >= ELECTION_RETRY_H) { this.electionRetryAcc = 0; this.openElection(input, clock, res); }
    }

    if (this.state === 'elected' && !this.charterProc.activeBallot() && this.charterProc.recallHazard(dtH)) {
      const steward = this.officials.steward();
      const cand = steward && steward.holder.kind === 'roster' ? steward.holder.id
        : steward && steward.holder.kind === 'shadow' ? `shadow:${steward.holder.profileSeed}` : null;
      this.charterProc.openBallot('recall', civicTopic('recall'), clock, input.tierA.length + input.shadowHouseholds, cand);
      res.feedPosts.push({
        kind: 'ballot', authorId: '', topic: civicTopic('recall'),
        text: 'A recall motion is on the table. Two days to say whether the steward keeps the seat.',
      });
    }

    // ---- 9 · money: payroll, insolvency, budget lines --------------------------
    const meanWage = Math.max(1, input.macro.meanWage);
    const clerkWage = this.officials.clerkDemand(meanWage, this.clerksDesired).wage;
    const payrollPerH = this.clerksDesired * clerkWage;
    this.treasury.stepInsolvency(payrollPerH, dtH);

    if (this.state === 'elected' && this.treasury.insolvencyHours() >= INSOLVENT_ENTER_H) {
      this.setState('insolvent');
      this.insolventSinceH = clock;
      this.clerksDesired = 0;              // unpaid clerks quit
      ev('insolvent', 'the treasury cannot make payroll — the clerks walk');
    } else if (this.state === 'insolvent') {
      const rehireCost = this.officials.clerkTarget() * clerkWage * 48;
      if (this.treasury.balance() > rehireCost) {
        this.setState('elected');
        this.clerksDesired = this.officials.clerkTarget();
        this.treasury.resetInsolvency();
        ev('recover', 'the treasury recovers; the office reopens');
      } else if (clock - this.insolventSinceH >= DISSOLVE_INSOLVENT_H) {
        this.dissolve(clock, 'starved', ev);
      }
    }

    if (this.state === 'elected') {
      this.legitCollapseAcc = this.charterProc.legitimacy() < LEGIT_COLLAPSE_T
        ? this.legitCollapseAcc + dtH : Math.max(0, this.legitCollapseAcc - dtH);
      if (this.legitCollapseAcc >= LEGIT_COLLAPSE_H) this.dissolve(clock, 'abandoned', ev);
    }

    if (this.state === 'dissolved' && clock - this.dissolvedAtH >= DORMANT_COOLDOWN_H) {
      this.setState('dormant');
    }

    // budget lines execute only under a functioning government.
    let spendOrdered = 0;
    if (this.state === 'elected' && charter) {
      this.rederiveAcc += dtH;
      if (this.rederiveAcc >= REDERIVE_H) { this.rederiveAcc = 0; this.charterProc.rederive(this.scores); }
      const orders = this.treasury.accrue(charter.lines, payrollPerH, dtH);
      for (const o of orders) { res.spendOrders.push(o); spendOrdered += o.amount; }
      if (orders.length && !this.firstSpendDone) {
        this.firstSpendDone = true;
        ev('spend', `first budget execution: ${orders[0].kind}`, orders[0].amount);
      }
    }
    if (leviesOn) res.levies = { payroll: payrollRate };
    if (this.state === 'elected' || this.state === 'insolvent') {
      res.hires = [this.officials.clerkDemand(meanWage, this.clerksDesired)];
    }

    // ---- 10 · petitions: movement voice while it lives -------------------------
    if ((this.state === 'stirring' || this.state === 'assembly-called') && this.opinion.salientIds().length) {
      const p = 1 - Math.exp(-PETITION_HAZ_PER_H * this.movement.mass() * dtH);
      if (this.rng() < p) {
        const author = this.pickAuthor();
        const top = this.topCategory();
        const texts = [
          `Enough. ${cap(TOPIC_LABEL[top])} is breaking people quietly — sign if you feel it too.`,
          `Ask around: everyone is carrying ${TOPIC_LABEL[top]} alone. Put your name here and stop carrying it alone.`,
        ];
        res.feedPosts.push({ kind: 'petition', authorId: author, topic: civicTopic(top), text: texts[(this.rng() * texts.length) | 0] });
        ev('petition', `petition on ${civicTopic(top)}`);
      }
    }

    // ---- 11 · the record --------------------------------------------------------
    this.history.record({
      t: clock,
      state: STATE_CODE[this.state],
      mass: this.movement.mass(),
      salience: this.opinion.maxSalience(),
      tierSupport: meanTierSupport(this.opinion),
      shadowSupport: this.opinion.meanShadowSupport(),
      shadowGrievance: this.opinion.meanShadowGrievance(),
      agitation: this.agitation,
      legitimacy: this.charterProc.legitimacy(),
      treasury: this.treasury.balance(),
      payrollTax: payrollRate,
      spendOrdered,
      turnout: this.lastBallot ? this.lastBallot.tierACast + this.lastBallot.shadowCast : 0,
      yesShare: this.lastBallot && this.lastBallot.yes + this.lastBallot.no > 0
        ? this.lastBallot.yes / (this.lastBallot.yes + this.lastBallot.no) : 0,
      rivalMass: this.charterProc.rival().mass,
    });
    return res;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private setState(to: InstitutionState): void {
    // defensive: the machine only walks its published edges.
    if (!ALLOWED_TRANSITIONS.some(([a, b]) => a === this.state && b === to)) return;
    this.state = to;
  }

  private dissolve(clock: number, why: string, ev: (k: 'dissolve', label: string, mag?: number) => void): void {
    this.setState('dissolved');
    this.dissolvedAtH = clock;
    this.officials.unseatAll();
    this.charterProc.dropCharter();
    this.movement.damp(0.25);
    this.clerksDesired = 0;
    this.legitCollapseAcc = 0;
    this.treasury.resetInsolvency();
    ev('dissolve', `the institution dissolves (${why})`);
  }

  private openElection(input: GovTickInput, clock: number, res: GovTickResult): void {
    const lead = this.leaderId();
    // no credible roster figure ⇒ a shadow citizen stands (sampleProfile seed;
    // the world promotes them to MindLite + MemoryGraph only when observed).
    const cand = lead ?? `shadow:${(this.seed ^ Math.floor(clock)) >>> 0}`;
    this.charterProc.openBallot('elect', civicTopic('election'), clock,
      input.tierA.length + input.shadowHouseholds, cand);
    res.feedPosts.push({
      kind: 'ballot', authorId: lead ?? '', topic: civicTopic('election'),
      text: 'The charter needs hands. A steward stands for the seat — the ballot is open for two days.',
    });
  }

  private leaderId(): string | null {
    return this.movement.leader(this.opinion.rows().map((r) => ({ id: r.id, salience: r.salience })));
  }

  private pickAuthor(): string {
    const lead = this.leaderId();
    if (lead) return lead;
    const ids = this.opinion.salientIds();
    return ids[(this.rng() * ids.length) | 0] ?? '';
  }

  private topCategory(): CivicCategory {
    let best: CivicCategory = 'rent', bestV = -1;
    for (const c of CIVIC_CATEGORIES) if (this.scores[c] > bestV) { best = c; bestV = this.scores[c]; }
    return best;
  }

  private convMemory(topic: string, support: number): string {
    const cat = topic.slice(6) as CivicCategory;
    const label = TOPIC_LABEL[cat] ?? 'what this town is failing at';
    const pro = [
      `We talked about ${label} — hearing someone else say it made it feel less like private bad luck.`,
      `That talk about ${label} stayed with me; it is not just me carrying this.`,
    ];
    const con = [
      `All that talk about ${label} — I would rather keep my head down and manage my own.`,
      `Someone pressed me about ${label}; I do not want trouble organised in my name.`,
    ];
    const pool = support > 0 ? pro : con;
    return pool[(this.rng() * pool.length) | 0];
  }

  // ---------------------------------------------------------------------------
  // view — compact snapshot for Town's world snapshot / the observatory.
  // ---------------------------------------------------------------------------
  view(): GovView {
    const charter = this.charterProc.charterRec();
    const a = this.movement.assemblyRec();
    const rows = this.opinion.rows();
    return {
      state: this.state,
      mass: r6(this.movement.mass()),
      agitation: r6(this.agitation),
      leaderId: this.leaderId(),
      legitimacy: r6(this.charterProc.legitimacy()),
      levies: { payroll: charter && this.state !== 'dormant' && this.state !== 'stirring' && this.state !== 'assembly-called' ? charter.levyPayroll : 0, sales: 0 },
      treasury: {
        balance: r6(this.treasury.balance()),
        credited: r6(this.treasury.totalCredited()),
        debited: r6(this.treasury.totalDebited()),
        insolvent: this.state === 'insolvent',
      },
      tierA: rows.map((r) => ({ ...r, influence: r6(this.movement.influenceOf(r.id, r.salience)) })),
      shadow: {
        n: this.opinion.shadowN(),
        meanSupport: r6(this.opinion.meanShadowSupport()),
        meanGrievance: r6(this.opinion.meanShadowGrievance()),
        posShare: r6(this.opinion.wingShares().pos),
        negShare: r6(this.opinion.wingShares().neg),
      },
      rival: this.charterProc.rival(),
      officials: this.officials.view(),
      ballot: this.charterProc.activeBallot(),
      lastBallot: this.lastBallot,
      assembly: a ? { place: a.place, startH: a.startH, endH: a.endH } : null,
      policy: charter ? charter.lines.map((l) => ({ kind: l.kind, share: r6(l.share) })) : [],
      topics: this.hotTopics(0),
      hotCivic: [...this.gate.hotList()],
      history: this.history.view(),
    };
  }

  // ---------------------------------------------------------------------------
  // persistence — every path-dependent cursor rides along (causal discipline).
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      seed: this.seed,
      rng: this.rng.save ? this.rng.save() : 0,
      state: this.state,
      lastGateH: this.lastGateH === null ? null : r6(this.lastGateH),
      engAcc: this.engAcc,
      agitation: r6(this.agitation),
      scores: CIVIC_CATEGORIES.map((c) => r6(this.scores[c])),
      gStar: r6(this.gStar),
      clerksDesired: this.clerksDesired,
      electionRetryAcc: r6(this.electionRetryAcc),
      rederiveAcc: r6(this.rederiveAcc),
      insolventSinceH: r6(this.insolventSinceH),
      legitCollapseAcc: r6(this.legitCollapseAcc),
      dissolvedAtH: r6(this.dissolvedAtH),
      firstSpendDone: this.firstSpendDone ? 1 : 0,
      lastBallot: this.lastBallot,
      opinion: this.opinion.toJSON(),
      movement: this.movement.toJSON(),
      charter: this.charterProc.toJSON(),
      treasury: this.treasury.toJSON(),
      officials: this.officials.toJSON(),
      gate: this.gate.toJSON(),
      stats: this.stats.toJSON(),
      history: this.history.toJSON(),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as Record<string, unknown> | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    if (typeof o.state === 'string') this.state = o.state as InstitutionState;
    this.lastGateH = typeof o.lastGateH === 'number' ? o.lastGateH : null;
    this.engAcc = typeof o.engAcc === 'number' ? o.engAcc : 0;
    this.agitation = typeof o.agitation === 'number' ? o.agitation : 0;
    if (Array.isArray(o.scores)) CIVIC_CATEGORIES.forEach((c, i) => { const x = (o.scores as unknown[])[i]; this.scores[c] = typeof x === 'number' ? x : 0; });
    this.gStar = typeof o.gStar === 'number' ? o.gStar : 0;
    this.clerksDesired = typeof o.clerksDesired === 'number' ? o.clerksDesired : 0;
    this.electionRetryAcc = typeof o.electionRetryAcc === 'number' ? o.electionRetryAcc : 0;
    this.rederiveAcc = typeof o.rederiveAcc === 'number' ? o.rederiveAcc : 0;
    this.insolventSinceH = typeof o.insolventSinceH === 'number' ? o.insolventSinceH : 0;
    this.legitCollapseAcc = typeof o.legitCollapseAcc === 'number' ? o.legitCollapseAcc : 0;
    this.dissolvedAtH = typeof o.dissolvedAtH === 'number' ? o.dissolvedAtH : 0;
    this.firstSpendDone = o.firstSpendDone === 1;
    this.lastBallot = (o.lastBallot as BallotView | null) ?? null;
    this.opinion.loadJSON(o.opinion);
    this.movement.loadJSON(o.movement);
    this.charterProc.loadJSON(o.charter);
    this.treasury.loadJSON(o.treasury);
    this.officials.loadJSON(o.officials);
    this.gate.loadJSON(o.gate);
    this.stats.loadJSON(o.stats);
    this.history.loadJSON(o.history);
  }
}

// ---- local numerics ------------------------------------------------------------

function meanTierSupport(op: OpinionField): number {
  const rows = op.rows();
  if (!rows.length) return 0;
  let s = 0;
  for (const r of rows) s += r.support;
  return s / rows.length;
}

/** Knuth Poisson (flow.ts idiom) — shadow attendance lives at small λ. */
function poisson(rng: RNG, lam: number): number {
  if (!(lam > 0)) return 0;
  if (lam > 30) {
    const u1 = Math.max(rng(), 1e-12), u2 = Math.max(rng(), 1e-12);
    const n = Math.round(lam + Math.sqrt(lam) * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
    return n > 0 ? n : 0;
  }
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
