// =============================================================================
// society.ts — the OTHER nine minds. Mara has always had a full soma; now every
// one of the ten does. This module owns the nine non-Mara Characters (the tenth,
// Mara, is stepped by the Town; we only project her role state uniformly here),
// runs each one's ROLE behaviour, and lets conversations EMERGE between them.
//
// Nothing here is a timetable. Where an agent is (home vs. their venue) follows
// a soft circadian window gated by how depleted their body is; WHAT they do at
// the venue emerges from the work-psychology readout of their soma:
//   · the cleaner mops (standing) until a standing-fatigue ODE tips restUrgency
//     over threshold, then withdraws to the supply-room chair and sits until the
//     fatigue drains — then rises and mops again;
//   · office workers trade off desk-work against seeking company: boredom +
//     understimulation raise a talk-propensity, work-anxiety (and the boss on the
//     floor) suppress it; two understimulated workers who drift to the same spot
//     and share an interest fall into an unscripted conversation that rewards both
//     bodies, both memory graphs and a two-sided relationship ledger.
//
// The renderer reads (place, mode, activity, station) per agent and places the
// body; this file never touches THREE or the DOM.
// =============================================================================
import type {
  AgentPublic, AgentPlace, WorkMode, Ledger, WorldEvent, NeedsReadout,
  PhoneState, FeedView, CompanySnapshot,
} from '../types';
import { Character } from '../harness/character';
import {
  ROSTER, type RosterEntry, OFFICE_DESK_BY_ID, OFFICE_TEAM_BY_ID,
  OFFICE_COMMONS_PER_FLOOR,
} from '../harness/roster';
import { seedInterests } from './interests';
import { maybeStartConversation, restoreConversation, type Conversation, type ConversationJSON } from './conversation';
import { distillSummary } from './relationship';
import type { Relationship } from '../types';
import type { CompanyJSON } from './company';
import type { FeedJSON } from './feed';
import {
  createWorkPsych, stepWorkPsych, talkPropensity, restUrgency, workPull, type WorkCtx,
} from '../harness/workpsych';
import { createPhoneState, stepPhone, rolloverPhone, type PhoneCtx } from '../harness/phone';
import { sleepPropensity, sleepDriveOf, melatoninGate, type SleepCtx } from '../harness/sleep';
import { PublicFeed, type FeedMember } from './feed';
import { Company, type CompanyMemberView } from './company';
import { fallbackResponse } from '../llm/prompt';
import { clamp, type RNG } from '../util/num';

// how many gathering spots each office hallway floor offers (must match office.ts)
const N_COMMONS = OFFICE_COMMONS_PER_FLOOR;
// the cleaner's mop route length (must match foodcourt.cleanWaypoints)
const N_CLEAN_WP = 5;

const BEAT = 0.05;        // sim-hours between conversation beats (paces a chat)
const EVENT_INT = 0.12;   // sim-hours between role micro-events (keeps somas + memory alive)

let _eid = 100000;
const ev = (kind: string, description: string, s: number, v: number): WorldEvent =>
  ({ id: `se${(_eid++).toString(36)}`, kind, description, salienceHint: s, valenceHint: v });

/** the macro state the Town hands us for Mara so she projects uniformly. */
export interface MaraMacro {
  place: AgentPlace; mode: WorkMode; activity: string; station: number; commuteT: number;
  needs?: NeedsReadout;
  onPhone?: boolean;              // whether Mara is on her phone (so the feed includes her)
}

interface Runtime {
  idx: number;
  entry: RosterEntry;
  ch: Character;
  ledger: Ledger;                 // this agent's relationships (keyed by other's profile.id)
  wp: ReturnType<typeof createWorkPsych>;
  place: AgentPlace;
  mode: WorkMode;
  activity: string;
  station: number;
  deskIndex: number;              // office: GLOBAL desk index (or -1)
  team: number;                   // office: coordinating team (-1 for boss / non-office)
  cleanWp: number;                // cleaner: current mop waypoint
  atWork: boolean;                // hysteresis latch for the work window
  asleep: boolean;                // emergent sleep latch (home only)
  phone: PhoneState;              // per-agent phone / social-media engagement
  eventAcc: number;
  jitter: number;                 // per-agent phase jitter on the work window
  convoPartner: number;           // idx of current chat partner, or -1
  conversationWith?: string;
  saying?: string;                // the current spoken line (bubble)
}

interface ActiveConvo { conv: Conversation; a: number; b: number; beatAcc: number; commons: number; }

export class Society {
  private readonly rts: Runtime[] = [];
  private readonly convos: ActiveConvo[] = [];
  private mara: MaraMacro = { place: 'home', mode: 'home', activity: 'stand', station: 0, commuteT: 0 };
  private convoCooldown = 0;
  private readonly feedNet = new PublicFeed();     // the public social network (all agents)
  private readonly company: Company;               // the office's emergent organisation
  private maraBelonging = 0;                        // feed→socialFuel bump owed to the Town
  private rolloverDay = -1;                         // last ~04:00 phone-session rollover

  constructor(mara: Character, opts: { seed?: number; startHour?: number } = {}) {
    const startHour = opts.startHour ?? 8;
    ROSTER.forEach((entry, idx) => {
      const ch = idx === 0 ? mara : new Character(entry.profile, { seed: (opts.seed ?? 7) + idx * 101, startHour });
      // seed each character's interests into their OWN memory graph (durable
      // semantic nodes) so shared interests are recallable, not a lookup table.
      seedInterests(ch, entry.interests, startHour);
      const deskIndex = entry.role === 'office_worker' || entry.role === 'office_boss'
        ? (OFFICE_DESK_BY_ID[entry.profile.id] ?? -1) : -1;
      const team = entry.role === 'office_worker' ? (OFFICE_TEAM_BY_ID[entry.profile.id] ?? -1) : -1;
      this.rts.push({
        idx, entry, ch,
        ledger: new Map(),
        wp: createWorkPsych(),
        place: 'home', mode: 'home', activity: 'stand', station: entry.homeIndex,
        deskIndex, team, cleanWp: 0, atWork: false, asleep: false,
        phone: createPhoneState(), eventAcc: 0,
        jitter: (hash01(entry.profile.id) - 0.5) * 1.0,
        convoPartner: -1,
      });
    });

    // the office as an emergent organisation: the boss (office_boss) holds the seed
    // goal in her memory; every worker is on a floor-spanning team.
    const bossRt = this.rts.find((r) => r.entry.role === 'office_boss');
    const officeMembers = this.rts
      .filter((r) => r.entry.role === 'office_worker' || r.entry.role === 'office_boss')
      .map((r) => ({ idx: r.idx, id: r.entry.profile.id, name: r.entry.profile.name, role: r.entry.role, team: r.team }));
    this.company = new Company({
      members: officeMembers,
      bossId: bossRt?.entry.profile.id ?? '',
      bossName: bossRt?.entry.profile.name ?? 'the boss',
      seed: opts.seed ?? 7,
    });
  }

  /** the Characters, for the Town to expose / inspect. Index 0 is Mara. */
  get characters(): Character[] { return this.rts.map((r) => r.ch); }

  setMaraMacro(m: MaraMacro): void { this.mara = m; }

  /** the public feed + the company state, for the Town's snapshot. */
  feedView(): FeedView { return this.feedNet.view(); }
  companySnapshot(): CompanySnapshot { return this.company.snapshot(); }
  /** consume + reset the belonging bump Mara earned from online engagement. */
  takeMaraBelonging(): number { const v = this.maraBelonging; this.maraBelonging = 0; return v; }

  // ===================== per-tick ==========================================
  step(dt: number, env: { clock: number; weekday: boolean; rng: RNG }): void {
    const hour = ((env.clock % 24) + 24) % 24;
    this.convoCooldown = Math.max(0, this.convoCooldown - dt);

    // ~04:00 rollover: reset everyone's daily phone-session count.
    const day04 = Math.floor((env.clock - 4) / 24);
    if (day04 !== this.rolloverDay) { this.rolloverDay = day04; for (const rt of this.rts) rolloverPhone(rt.phone); }

    // record Mara's projected role state (idx 0) — her Character is stepped by Town.
    const m0 = this.rts[0];
    m0.place = this.mara.place; m0.mode = this.mara.mode;
    m0.activity = this.mara.activity; m0.station = this.mara.station;

    // is the office boss out walking her floor? (raises her floor's felt demand)
    const bossRt = this.rts.find((r) => r.entry.role === 'office_boss');
    const bossOnFloor = !!bossRt && bossRt.place === 'office' && bossRt.mode === 'wandering';
    const bossFloor = bossRt?.entry.officeFloor ?? 1;

    for (let i = 1; i < this.rts.length; i++) {
      const rt = this.rts[i];
      rt.ch.step(dt);                              // the substrate always lives
      this.decidePlace(rt, hour, env.weekday);
      const boss1 = bossOnFloor && rt.entry.officeFloor === bossFloor;
      if (rt.place === 'foodcourt') this.runFood(rt, hour, dt, env.rng);
      else if (rt.place === 'office') this.runOffice(rt, dt, boss1, env.rng);
      else this.runHome(rt, hour, dt, env.weekday, env.rng);
      // the phone is always in reach: an emergent pull to check it, anywhere.
      this.stepAgentPhone(rt, hour, boss1, dt, env.rng);
    }

    this.stepConversations(dt, env.clock);
    this.matchmakeOffice(env.clock, env.rng);

    // the office as an organisation: teams coordinate on the net toward evolving goals.
    this.stepCompany(dt, env.clock);
    // the public social network: everyone (incl. Mara) posts / scrolls / is heard.
    this.stepFeed(dt, env.clock, env.rng);
  }

  // ---- phone / social-media pull (per agent, anywhere) ----------------------
  private stepAgentPhone(rt: Runtime, hour: number, boss1: boolean, dt: number, rng: RNG): void {
    const s = rt.ch.soma, ph = rt.ch.phys, b = rt.entry.profile.bigFive;
    const watched = rt.place === 'office' ? (boss1 ? 1 : 0)
      : rt.place === 'foodcourt' && rt.entry.role !== 'food_boss' ? 0.6 : 0;
    const demand = rt.place === 'office' && rt.entry.role === 'office_worker' ? this.company.demandFor(rt.team) : 0.15;
    const needPull = clamp((1 - ph.satiety) * 0.3 + (1 - ph.hydration) * 0.25 + ph.bladder * 0.6, 0, 1);
    const ctx: PhoneCtx = {
      engaged: rt.convoPartner >= 0 ? 1 : 0,
      watched,
      demand: rt.place === 'home' ? 0.05 : demand,
      needPull,
      night: hour >= 23 || hour < 6.5,
      extraversion: clamp(0.5 + 0.2 * b.E, 0, 1),
      dtHours: dt,
    };
    stepPhone(rt.phone, rt.wp, s, rt.ch.params, ctx, rng);
  }

  // ---- the company: assemble member views, step the organisation ------------
  private stepCompany(dt: number, clock: number): void {
    const views: CompanyMemberView[] = [];
    for (const rt of this.rts) {
      if (rt.entry.role !== 'office_worker' && rt.entry.role !== 'office_boss') continue;
      views.push({
        idx: rt.idx, id: rt.entry.profile.id, role: rt.entry.role, team: rt.team,
        ch: rt.ch, ledger: rt.ledger, wp: rt.wp, interests: rt.entry.interests,
        atDesk: rt.place === 'office' && rt.mode === 'desk_working' && rt.convoPartner < 0,
        inConvo: rt.convoPartner >= 0,
      });
    }
    this.company.step(dt, views, { clock });
  }

  // ---- the public feed: everyone, incl. Mara (via her projected onPhone) -----
  private stepFeed(dt: number, clock: number, rng: RNG): void {
    const members: FeedMember[] = this.rts.map((rt) => ({
      idx: rt.idx, id: rt.entry.profile.id, name: rt.entry.profile.name, hatColor: rt.entry.hatColor,
      ch: rt.ch, ledger: rt.ledger, interests: rt.entry.interests,
      onPhone: rt.idx === 0 ? !!this.mara.onPhone : rt.phone.onPhone,
      tom: rt.ch.params.neuro.theoryOfMind,
    }));
    this.feedNet.step(dt, { clock, rng }, members);
    this.maraBelonging += this.feedNet.takeBelonging(this.rts[0].entry.profile.id);
  }

  // ---- macro placement: a soft circadian window, gated by depletion ---------
  private decidePlace(rt: Runtime, hour: number, weekday: boolean): void {
    const [open, close] = this.workWindow(rt);
    const inWindow = weekday && hour >= open + rt.jitter && hour < close + rt.jitter;
    const spent = rt.ch.soma.fatigue > 0.9;        // too wrecked to be at work
    if (!rt.atWork && inWindow && !spent) rt.atWork = true;
    else if (rt.atWork && (!inWindow || rt.ch.soma.fatigue > 0.95)) {
      rt.atWork = false;
      this.leaveConvo(rt.idx);
    }
    const target: AgentPlace = rt.atWork
      ? (rt.entry.workplace === 'foodcourt' ? 'foodcourt' : 'office')
      : 'home';
    if (target !== 'home') rt.asleep = false;   // leaving for work wakes you
    rt.place = target;
  }

  /** each role's rough daily window (hours). Not a schedule — a soft attractor. */
  private workWindow(rt: Runtime): [number, number] {
    switch (rt.entry.role) {
      case 'cleaner':    return [17, 23];   // the evening clean
      case 'food_boss':  return [10, 19];   // covers the counter shift
      case 'office_boss':return [9, 18];
      default:           return [9, 17];    // office workers
    }
  }

  // ---- FOOD venue: boss supervises · cleaner mops & rests -------------------
  private runFood(rt: Runtime, hour: number, dt: number, rng: RNG): void {
    if (rt.entry.role === 'food_boss') {
      rt.mode = 'supervising'; rt.activity = 'stand'; rt.station = 0;
      this.stepWp(rt, { onTask: true, socializing: false, standing: false, resting: false, novelty: 0.1, demand: 0.25, dtHours: dt });
      this.tickEvents(rt, dt, rng, () => ev('supervise', 'You watch the line and call the next order.', 0.12, 0.05));
      return;
    }
    // cleaner: mop until standing-fatigue tips restUrgency high; then sit in the
    // supply room until it drains; then rise and mop again. Pure ODE-driven.
    const resting = rt.mode === 'resting';
    if (!resting && restUrgency(rt.wp) > 0.6) {
      rt.mode = 'resting';                         // legs gave out — go sit in the supply room
    } else if (resting && restUrgency(rt.wp) < 0.2) {
      rt.mode = 'cleaning';                        // legs recovered — back to it
    } else if (rt.mode !== 'resting') {
      rt.mode = 'cleaning';
    }
    if (rt.mode === 'resting') {
      rt.activity = 'sit_rest'; rt.station = -1;   // -1 → the supply-room chair
      this.stepWp(rt, { onTask: false, socializing: false, standing: false, resting: true, novelty: 0.05, demand: 0, dtHours: dt });
      this.tickEvents(rt, dt, rng, () => ev('rest', 'You sink into the supply-room chair; your legs finally stop aching.', 0.16, 0.28));
    } else {
      rt.activity = 'mop';
      rt.station = rt.cleanWp;   // tickEvents advances cleanWp along the mop route
      rt.mode = 'cleaning';
      this.stepWp(rt, { onTask: true, socializing: false, standing: true, resting: false, novelty: 0.05, demand: 0.15, dtHours: dt });
      this.tickEvents(rt, dt, rng, () => ev('clean', 'You run the mop across the tiles; the floor comes up clean.', 0.1, 0.12));
    }
  }

  // ---- OFFICE: desk-work vs. drifting off to talk ---------------------------
  private runOffice(rt: Runtime, dt: number, bossOnFloor: boolean, rng: RNG): void {
    // already talking? hold the conversation; the convo stepper drives the reward.
    if (rt.convoPartner >= 0) {
      rt.mode = 'talking'; rt.activity = 'talk';
      this.stepWp(rt, { onTask: false, socializing: true, standing: false, resting: false, novelty: 0.4, demand: 0, dtHours: dt });
      return;
    }
    const boss = rt.entry.role === 'office_boss';
    // felt task pressure: the base + the re-derived priority of this team's subgoal
    // (the goal→body feedback edge) + the boss walking your floor. So a team the boss
    // has quietly elevated feels heavier even with no one saying a word.
    const demand = boss ? 0.15 : 0.15 + this.company.demandFor(rt.team) + (bossOnFloor ? 0.45 : 0);
    // wandering the halls is itself a little stimulating (drains boredom slowly), so a
    // lone wanderer who never finds company eventually drifts back to the desk.
    const novelty = rt.mode === 'wandering' ? 0.3 : 0.05;
    this.stepWp(rt, { onTask: rt.mode === 'desk_working', socializing: false, standing: false, resting: false, novelty, demand, dtHours: dt });

    const talkP = talkPropensity(rt.wp, rt.ch.soma);
    const workP = workPull(rt.wp, rt.ch.soma);
    // the office BOSS mostly works, but now and then walks the floor (which pressures
    // the room). Everyone else trades desk-work against the pull to seek company.
    if (boss) {
      if (rt.mode !== 'wandering' && rt.mode !== 'desk_working') rt.mode = 'desk_working'; // enter → sit
      if (rt.mode !== 'wandering' && rng() < 0.02 && rt.wp.boredom > 0.4) {
        rt.mode = 'wandering'; rt.station = Math.floor(rng() * N_COMMONS);   // walk the floor
      } else if (rt.mode === 'wandering' && rng() < 0.15) {
        rt.mode = 'desk_working';
      }
    } else {
      const wantTalk = talkP > 0.5 && talkP > workP && !bossOnFloor;
      if (rt.mode !== 'wandering' && wantTalk) {
        rt.mode = 'wandering';
        rt.station = this.pickCommons(rt.idx, rng);   // drift to a gathering spot to find company
      } else if (rt.mode === 'wandering' && !wantTalk) {
        rt.mode = 'desk_working';                       // no longer restless — back to the desk
      } else if (rt.mode !== 'wandering') {
        rt.mode = 'desk_working';
      }
    }

    if (rt.mode === 'desk_working') { rt.activity = 'sit_desk'; rt.station = rt.deskIndex; }
    else { rt.activity = 'walk'; }                       // wandering to a commons spot

    this.tickEvents(rt, dt, rng, () =>
      rt.mode === 'desk_working'
        ? (rt.wp.boredom > 0.6
            ? ev('grind', 'Another dull ticket drags on; your attention slides off it.', 0.14, -0.08)
            : ev('work', 'You clear a task off the board.', 0.1, 0.06))
        : ev('drift', 'You wander out toward the hallway, hoping to catch someone.', 0.1, 0.05));
  }

  // ---- HOME: the off-shift life — sleep is EMERGENT, not clock-driven --------
  private runHome(rt: Runtime, hour: number, dt: number, weekday: boolean, rng: RNG): void {
    rt.mode = 'home';
    rt.station = rt.entry.homeIndex;
    const s = rt.ch.soma;
    const onPhone = rt.phone.onPhone;                 // from the prior beat (stepped after runHome)
    const [open, close] = this.workWindow(rt);
    const workWindowOpen = weekday && hour >= open + rt.jitter && hour < close + rt.jitter;
    const ctx: SleepCtx = { phone: onPhone ? 1 : 0, talking: rt.convoPartner >= 0, workWindowOpen };
    const P = sleepPropensity(s, ctx);
    // onset/wake HYSTERESIS (mirrors the cleaner's rest latch). Scrolling keeps you up.
    if (onPhone) rt.asleep = false;
    else rt.asleep = (!rt.asleep && P > 0.60) ? true : (rt.asleep && P < 0.30) ? false : rt.asleep;

    // soma-derived home-activity ladder (deterministic; replaces the hardcoded hour rule).
    const melN = melatoninGate(s);
    if (rt.asleep) rt.activity = 'sleep';
    else if (onPhone) rt.activity = 'couch_phone';                        // scrolling (in bed at night)
    else if (rt.ch.phys.hygiene < 0.55 && melN < 0.40 && s.fatigue < 0.60) { rt.activity = 'shower'; rt.ch.takeBath(); }
    else if (clamp(s.SEEKING, 0, 1) > 0.50 && melN < 0.80) rt.activity = 'couch_phone';
    else rt.activity = 'couch_tv';

    this.stepWp(rt, { onTask: false, socializing: false, standing: false, resting: rt.asleep, novelty: 0.1, demand: 0, dtHours: dt });

    // restoration only while actually ASLEEP (and not scrolling in bed): the stress
    // axis relaxes, fatigue drains, the exposome partly recovers, the day is replayed.
    if (rt.asleep) {
      s.fatigue = clamp(s.fatigue - 0.05 * dt * 6, 0, 1);
      s.cortisol += (0.9 - s.cortisol) * 0.04 * dt * 6;
      s.amygdala *= (1 - 0.02 * dt * 6);
      s.allostaticLoad = Math.max(0, s.allostaticLoad - 0.01 * dt * 6);
      rt.ch.rest(dt, null);
    }
    this.tickEvents(rt, dt, rng, () =>
      rt.asleep
        ? ev('rest', 'You lie down at home; the day finally lets go.', 0.12, 0.2)
        : onPhone
          ? ev('scroll', 'You thumb through the feed, half here and half not.', 0.08, 0.05)
          : ev('home', 'You potter around your flat, the shift behind you.', 0.08, 0.12));
  }

  // ===================== conversations =====================================
  private matchmakeOffice(clock: number, rng: RNG): void {
    if (this.convoCooldown > 0) return;
    // group office wanderers by their FLOOR + chosen commons spot; any two free,
    // compatible, interest-sharing wanderers at the same spot (hence the same floor)
    // can strike up a conversation. Keying by floor keeps a floor-2 worker from
    // "meeting" a floor-1 worker who happens to share a commons index.
    const byCommons = new Map<string, number[]>();
    for (const rt of this.rts) {
      if (rt.place !== 'office' || rt.mode !== 'wandering' || rt.convoPartner >= 0) continue;
      const key = `${rt.entry.officeFloor ?? 1}:${rt.station}`;
      const arr = byCommons.get(key) ?? [];
      arr.push(rt.idx); byCommons.set(key, arr);
    }
    for (const [key, idxs] of byCommons) {
      const commons = Number(key.split(':')[1]);
      if (idxs.length < 2) continue;
      const a = this.rts[idxs[0]], b = this.rts[idxs[1]];
      const conv = maybeStartConversation(
        a.ch, b.ch, a.entry.interests, b.entry.interests,
        a.ledger, b.ledger, clock, rng,
      );
      if (conv) {
        a.convoPartner = b.idx; b.convoPartner = a.idx;
        a.conversationWith = b.ch.profile.name; b.conversationWith = a.ch.profile.name;
        a.mode = b.mode = 'talking'; a.activity = b.activity = 'talk';
        a.station = b.station = commons;
        this.convos.push({ conv, a: a.idx, b: b.idx, beatAcc: 0, commons });
        this.convoCooldown = 0.4;                 // don't spawn a crowd at once
        return;
      }
    }
  }

  private stepConversations(dt: number, clock: number): void {
    for (let k = this.convos.length - 1; k >= 0; k--) {
      const c = this.convos[k];
      c.beatAcc += dt;
      while (c.beatAcc >= BEAT && !c.conv.done) { c.conv.step(BEAT); c.beatAcc -= BEAT; }
      // keep both partners parked together while the talk runs; surface the line.
      const a = this.rts[c.a], b = this.rts[c.b];
      if (a.convoPartner === c.b) { a.conversationWith = b.ch.profile.name; a.station = c.commons; a.saying = c.conv.lastUtterance; }
      if (b.convoPartner === c.a) { b.conversationWith = a.ch.profile.name; b.station = c.commons; b.saying = c.conv.lastUtterance; }
      if (c.conv.done) {
        this.closeConvo(c, clock);
        this.convos.splice(k, 1);
      }
    }
  }

  private closeConvo(c: ActiveConvo, clock: number): void {
    const a = this.rts[c.a], b = this.rts[c.b];
    // distill the encounter into each side's ledger summary (the memory of the
    // actual beats was already laid down in both graphs by conversation.step).
    const relA = a.ledger.get(b.ch.profile.id);
    if (relA) relA.summary = distillSummary(relA, a.ch.readout().label, c.conv.lastUtterance);
    const relB = b.ledger.get(a.ch.profile.id);
    if (relB) relB.summary = distillSummary(relB, b.ch.readout().label, c.conv.lastUtterance);
    this.freeRuntime(a); this.freeRuntime(b);
    void clock;
  }

  private leaveConvo(idx: number): void {
    for (let k = this.convos.length - 1; k >= 0; k--) {
      const c = this.convos[k];
      if (c.a === idx || c.b === idx) { this.freeRuntime(this.rts[c.a]); this.freeRuntime(this.rts[c.b]); this.convos.splice(k, 1); }
    }
  }

  private freeRuntime(rt: Runtime): void {
    rt.convoPartner = -1; rt.conversationWith = undefined; rt.saying = undefined;
    if (rt.mode === 'talking') rt.mode = 'desk_working';
  }

  private pickCommons(idx: number, rng: RNG): number {
    // prefer a spot where a free wanderer ON THE SAME FLOOR already waits (so pairs
    // actually meet), else a fresh random spot on this floor.
    const floor = this.rts[idx]?.entry.officeFloor ?? 1;
    for (const rt of this.rts) {
      if (rt.idx !== idx && rt.place === 'office' && rt.mode === 'wandering'
        && rt.convoPartner < 0 && (rt.entry.officeFloor ?? 1) === floor) return rt.station;
    }
    return Math.floor(rng() * N_COMMONS);
  }

  // ===================== helpers ===========================================
  private stepWp(rt: Runtime, ctx: WorkCtx): void { stepWorkPsych(rt.wp, rt.ch.soma, ctx); }

  /** feed a role micro-event on a throttle so the soma + memory graph stay alive. */
  private tickEvents(rt: Runtime, dt: number, rng: RNG, make: () => WorldEvent): void {
    rt.eventAcc += dt;
    if (rt.eventAcc < EVENT_INT) return;
    rt.eventAcc = 0;
    // cleaner mop-route advances on each event tick while cleaning
    if (rt.entry.role === 'cleaner' && rt.mode === 'cleaning') rt.cleanWp = (rt.cleanWp + 1) % N_CLEAN_WP;
    const e = make();
    rt.ch.perceive(e);
    rt.ch.applyDriverResponse(e, fallbackResponse(rt.ch.soma, rt.ch.readout(), e));
    void rng;
  }

  // ===================== projection ========================================
  publicViews(maraPublic: AgentPublic): AgentPublic[] {
    const out: AgentPublic[] = [];
    for (const rt of this.rts) {
      if (rt.idx === 0) { out.push({ ...maraPublic }); continue; }  // Town stamps Mara's phone/sleep
      const base = rt.ch.snapshot();
      const id = rt.entry.profile.id;
      const drive = sleepDriveOf(rt.ch.soma,
        { phone: rt.phone.onPhone ? 1 : 0, talking: rt.convoPartner >= 0, workWindowOpen: rt.place !== 'home' }, rt.asleep);
      out.push({
        ...base,
        id,
        role: rt.entry.role,
        hatColor: rt.entry.hatColor,
        interests: rt.entry.interests,
        place: rt.place,
        mode: rt.mode,
        activity: rt.activity,
        homeIndex: rt.entry.homeIndex,
        station: rt.station,
        commuteT: 0,
        workpsych: { ...rt.wp },
        conversationWith: rt.conversationWith,
        saying: rt.saying,
        onPhone: rt.phone.onPhone,
        phoneHabit: rt.phone.habit,
        phoneCraving: rt.phone.craving,
        phoneSessions: rt.phone.sessionsToday,
        asleep: rt.asleep,
        sleepDrive: drive,
        team: rt.team,
        netInfluence: this.company.influenceOf(id),
        isLeader: this.company.isLeader(id),
      });
    }
    return out;
  }

  // ===================== persistence =======================================
  toJSON(): SocietyJSON {
    return {
      runtimes: this.rts.map((rt) => ({
        place: rt.place, mode: rt.mode, activity: rt.activity, station: rt.station,
        deskIndex: rt.deskIndex, team: rt.team, cleanWp: rt.cleanWp, atWork: rt.atWork,
        asleep: rt.asleep, phone: { ...rt.phone }, eventAcc: rt.eventAcc, jitter: rt.jitter,
        convoPartner: rt.convoPartner, conversationWith: rt.conversationWith, saying: rt.saying,
        wp: { ...rt.wp }, ledger: [...rt.ledger.entries()],
      })),
      convos: this.convos.map((c) => ({ a: c.a, b: c.b, beatAcc: c.beatAcc, commons: c.commons, conv: c.conv.toJSON() })),
      convoCooldown: this.convoCooldown, maraBelonging: this.maraBelonging, rolloverDay: this.rolloverDay,
      company: this.company.toJSON(), feed: this.feedNet.toJSON(),
    };
  }

  /** overwrite runtime state IN PLACE (Characters are already loaded by the caller).
   *  `townRng` is the shared Town RNG that conversation closures capture. */
  loadJSON(j: SocietyJSON, townRng: RNG): void {
    j.runtimes.forEach((r, i) => {
      const rt = this.rts[i];
      rt.place = r.place; rt.mode = r.mode; rt.activity = r.activity; rt.station = r.station;
      rt.deskIndex = r.deskIndex; rt.team = r.team; rt.cleanWp = r.cleanWp; rt.atWork = r.atWork;
      rt.asleep = r.asleep; Object.assign(rt.phone, r.phone); rt.eventAcc = r.eventAcc; rt.jitter = r.jitter;
      rt.convoPartner = r.convoPartner; rt.conversationWith = r.conversationWith; rt.saying = r.saying;
      Object.assign(rt.wp, r.wp);
      rt.ledger = new Map<string, Relationship>(r.ledger);
    });
    this.company.loadJSON(j.company);
    this.feedNet.loadJSON(j.feed);
    // rebuild active conversations bound to the already-restored Characters + ledgers.
    this.convos.length = 0;
    for (const c of j.convos) {
      const a = this.rts[c.a], b = this.rts[c.b];
      const conv = restoreConversation(a.ch, b.ch, a.ledger, b.ledger, townRng, c.conv);
      this.convos.push({ conv, a: c.a, b: c.b, beatAcc: c.beatAcc, commons: c.commons });
    }
    this.convoCooldown = j.convoCooldown; this.maraBelonging = j.maraBelonging; this.rolloverDay = j.rolloverDay;
  }
}

interface RuntimeJSON {
  place: AgentPlace; mode: WorkMode; activity: string; station: number;
  deskIndex: number; team: number; cleanWp: number; atWork: boolean;
  asleep: boolean; phone: PhoneState; eventAcc: number; jitter: number;
  convoPartner: number; conversationWith?: string; saying?: string;
  wp: ReturnType<typeof createWorkPsych>; ledger: [string, Relationship][];
}
export interface SocietyJSON {
  runtimes: RuntimeJSON[];
  convos: { a: number; b: number; beatAcc: number; commons: number; conv: ConversationJSON }[];
  convoCooldown: number; maraBelonging: number; rolloverDay: number;
  company: CompanyJSON; feed: FeedJSON;
}

/** module id-counter accessors (for save/load reconciliation). */
export function getSocietyEid(): number { return _eid; }
export function setSocietyEid(n: number): void { _eid = n; }

// ---- free functions ---------------------------------------------------------
function hash01(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
