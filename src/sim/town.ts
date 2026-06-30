// =============================================================================
// town.ts — the level-of-detail orchestrator.
//   Spends the one expensive resource (a full ~33-channel soma + the single LLM
//   flight) only where ATTENTION is: Mara always; an NPC ONLY while she interacts
//   with them (then distilled to a ledger summary and demoted); proximate NPCs as
//   cheap NpcLite minds; the rest of the town as a statistical density field.
//
//   The daily/weekly loop is NOT scripted. Each coarse tick the arbiter reads
//   Maslow deficits off Mara's soma and scores them against place affordances and
//   the binding constraints (money / food / energy / time). The routine is the
//   limit cycle of those drives — and relationships are the persistent side-effect
//   of reciprocated, oxytocin-rewarding encounters at the third place.
// =============================================================================
import type {
  Profile, LLMClient, LLMResponse, WorldEvent, Customer, Vec2, Vec3,
  PlaceId, Intention, CurrentGoal, Resources, NeedsReadout, NeedsIntegrals,
  NpcLite, Relationship, Ledger, DensityField, TownSnapshot,
} from '../types';
import { Character } from '../harness/character';
import { computeCoreAffect } from '../harness/soma';
import { CASHIER_PROFILE, sampleProfile } from '../harness/params';
import { computeNeeds, applyNeedFeedback, emptyNeedIntegrals, updateNeedIntegrals } from '../harness/needs';
import { PLACES, openNow, travelTime } from './places';
import {
  createResources, tickWork, canBuyGroceries, buyGroceries, canEat, consumeMeal,
  dueRent, payRent,
} from './economy';
import { chooseIntention } from './arbiter';
import { newRelationship, updateBond, distillSummary, decayBonds } from './relationship';
import { createDensity, stepDensity, expectedAt } from './city';
import { makeNpcLite, stepNpcLite, npcName, type LiteCtx } from './npc';
import { buildMessages, parseResponse, fallbackResponse } from '../llm/prompt';
import { makeCustomer, buildAgenda, IDLE_EVENT } from './events';
import { mulberry32, clamp, lerp, type RNG } from '../util/num';

// locale geometry (matches Stage's coordinate conventions)
const COUNTER: Vec3 = { x: 0, y: 0, z: 1.7 };
const EXIT: Vec3 = { x: 4.2, y: 0, z: 1.7 };
const waitSlot = (i: number): Vec3 => ({ x: 0, y: 0, z: 3.4 + i * 1.15 });
const WANDER: Record<string, Vec3> = {
  apartment: { x: 0, y: 0, z: 1.0 },
  counter: COUNTER,
  market: { x: 0, y: 0, z: 2.0 },
  cafe: { x: 0, y: 0, z: 1.6 },
};
// a handful of recurring "locals" at the third place, so re-encounters can bond
const SOCIAL_SEEDS = [10117, 20431, 30289, 40763];

let _eid = 0;
const ev = (kind: string, description: string, s: number, v: number, source?: string): WorldEvent =>
  ({ id: `te${(_eid++).toString(36)}`, kind, description, salienceHint: s, valenceHint: v, source });

export interface TownOpts {
  profile?: Profile; llm?: LLMClient | null; seed?: number; startHour?: number; speed?: number;
}

export class Town {
  readonly mara: Character;
  llm: LLMClient | null;
  speed: number;
  paused = false;

  resources: Resources;
  ledger: Ledger = new Map();
  density: DensityField;
  needs: NeedsReadout;
  needsIntegrals: NeedsIntegrals = emptyNeedIntegrals();

  place: PlaceId = 'home';
  macroPos: Vec2;
  travelling = false;
  private travelFrom: Vec2; private travelTo: Vec2; private travelT = 0; private travelDur = 1;
  goal: CurrentGoal;

  figures: NpcLite[] = [];
  partner: Character | null = null;
  private partnerNpcId: string | null = null;
  private partnerBeatsLeft = 0;
  private socialDone = false; // one real conversation per café visit

  private lastSocialAt: number;
  private socialFuel = 0.55; // slow belonging reservoir: drains alone, refills on contact
  private rng: RNG;
  private beatAcc = 0; private readonly beatInterval = 0.05;
  private arbAcc = 0; private readonly arbInterval = 0.22;
  private pendingLLM = false;
  private servedCount = 0;
  private currentEvent?: WorldEvent;

  // work-locale state
  private workQueue: Customer[] = [];
  private workCurrent: Customer | null = null;
  private workAgenda: WorldEvent[] = [];
  private nextSpawnAt = 0;
  private lastFinish = 0;
  private localeReady = false;

  constructor(opts: TownOpts = {}) {
    this.mara = new Character(opts.profile ?? CASHIER_PROFILE, {
      seed: opts.seed ?? 7, startHour: opts.startHour ?? 7.5,
    });
    this.llm = opts.llm ?? null;
    this.speed = opts.speed ?? 0.05;
    this.rng = mulberry32(((opts.seed ?? 7) * 2654435761) >>> 0);
    this.resources = createResources(this.clock);
    this.density = createDensity();
    this.needs = computeNeeds(this.mara.soma, this.resources);
    this.lastSocialAt = this.clock - 8; // start the day a little starved for company
    this.macroPos = { ...PLACES.home.pos2D };
    this.travelFrom = { ...this.macroPos }; this.travelTo = { ...this.macroPos };
    this.goal = {
      intention: { kind: 'rest', place: 'home', utility: 0, reason: 'waking up at home' },
      phase: 'execute', startedAt: this.clock, plannedEnd: this.clock + 0.6,
    };
    this.enterLocale('home');
  }

  get clock(): number { return this.mara.soma.t; }
  get day(): number { return Math.floor(this.clock / 24); }
  get weekend(): boolean { const d = this.day % 7; return d === 5 || d === 6; }

  // ===================== main tick ======================================
  update(dtReal: number): void {
    if (this.paused) return;
    const dt = dtReal * this.speed;
    if (dt <= 0) return;

    // 1) the protagonist substrate always lives
    this.mara.step(dt);

    // 2) Maslow needs read off the soma, fed back as forces (the closed loop).
    //    Solitude is invisible to the fast neuromodulators (PANIC/GRIEF decays in
    //    minutes), so belonging is carried by a SLOW reservoir: socialFuel drains
    //    while alone and refills on real contact. A comfortable shut-in therefore
    //    aches for company after a day or two — and a good evening out quiets it.
    this.socialFuel = clamp(this.socialFuel - 0.035 * dt, 0, 1);
    this.needs = computeNeeds(this.mara.soma, this.resources);
    const lonely = 1 - this.socialFuel;
    this.needs.belonging = Math.max(this.needs.belonging, lonely);
    this.needs.deficit.belonging = Math.max(this.needs.deficit.belonging, lonely);
    // let the body feel it too (a gentle somatic ache that biases appraisal)
    this.mara.soma.PANIC_GRIEF = clamp(this.mara.soma.PANIC_GRIEF + lonely * 0.04 * dt * (1 - this.mara.soma.PANIC_GRIEF), 0, 1);
    applyNeedFeedback(this.mara.soma, this.needs, dt);
    updateNeedIntegrals(this.needsIntegrals, this.needs, dt);

    // 3) economy + city (cheap, statistical)
    if (this.place === 'work' && !this.travelling) tickWork(this.resources, dt);
    if (dueRent(this.resources, this.clock)) payRent(this.resources, this.clock);
    stepDensity(this.density, this.clock, dtReal);
    decayBonds(this.ledger, dt);

    // 4) the partner (if promoted) runs the full soma too, but only now
    if (this.partner) this.partner.step(dt);

    // 5) macro agency: travel, or arbitrate + run the current locale
    if (this.travelling) {
      this.advanceTravel(dt);
    } else {
      this.arbAcc += dt;
      if (this.arbAcc >= this.arbInterval) { this.arbAcc = 0; this.reArbitrate(); }
      this.beatAcc += dt;
      if (this.beatAcc >= this.beatInterval && !this.pendingLLM) {
        this.beatAcc = 0;
        this.runLocale(dt);
      }
      this.stepFigures(dt);
    }
  }

  // ===================== macro agency ===================================
  private reArbitrate(): void {
    const intent = chooseIntention({
      needs: this.needs,
      resources: this.resources,
      clock: this.clock,
      place: this.place,
      current: this.goal?.intention,
      habit: (p, k) => this.habit(p, k),
      rng: this.rng,
    });
    if (intent.place !== this.place && openNow(PLACES[intent.place], this.clock)) {
      this.startTravel(intent);
    } else if (!this.goal || this.goal.intention.kind !== intent.kind) {
      this.goal = {
        intention: intent, phase: 'execute', startedAt: this.clock,
        plannedEnd: this.clock + this.durOf(intent),
      };
    }
  }

  /** habit strength: how rewarding this (place,kind) has been, from memory recall */
  private habit(place: PlaceId, kind: string): number {
    const mems = this.mara.recall(`${place} ${kind}`, 3);
    if (!mems.length) return 0;
    return mems.reduce((s, m) => s + m.salience, 0) / mems.length;
  }

  private durOf(intent: Intention): number {
    const a = PLACES[intent.place].affordances.find((x) => x.kind === intent.kind);
    return a?.durHours ?? 1;
  }

  private startTravel(intent: Intention): void {
    this.demotePartner('left for ' + intent.place);
    this.figures = [];
    this.localeReady = false;
    this.travelling = true;
    this.travelFrom = { ...this.macroPos };
    this.travelTo = { ...PLACES[intent.place].pos2D };
    this.travelT = 0;
    this.travelDur = Math.max(0.02, travelTime(this.place, intent.place));
    this.goal = { intention: intent, phase: 'travel', startedAt: this.clock, plannedEnd: this.clock + this.travelDur };
    this.currentEvent = ev('travel', `Heading to the ${PLACES[intent.place].name.toLowerCase()} — ${intent.reason}.`, 0.2, 0.05);
  }

  private advanceTravel(dt: number): void {
    this.travelT = clamp(this.travelT + dt / this.travelDur, 0, 1);
    this.macroPos = {
      x: lerp(this.travelFrom.x, this.travelTo.x, this.travelT),
      y: lerp(this.travelFrom.y, this.travelTo.y, this.travelT),
    };
    // travelling costs a little energy
    this.mara.soma.fatigue = clamp(this.mara.soma.fatigue + dt * 0.02, 0, 1);
    if (this.travelT >= 1) {
      this.travelling = false;
      this.place = this.goal.intention.place;
      this.macroPos = { ...PLACES[this.place].pos2D };
      this.goal = { ...this.goal, phase: 'execute', startedAt: this.clock, plannedEnd: this.clock + this.durOf(this.goal.intention) };
      this.enterLocale(this.place);
    }
  }

  // ===================== locales ========================================
  private enterLocale(place: PlaceId): void {
    this.figures = [];
    this.workQueue = []; this.workCurrent = null; this.workAgenda = [];
    this.nextSpawnAt = this.clock + 0.02; this.lastFinish = this.clock;
    this.localeReady = true;
    this.socialDone = false;
    if (place === 'thirdplace') this.spawnSocials();
    else if (place === 'market') this.spawnShoppers();
  }

  private runLocale(dt: number): void {
    switch (this.place) {
      case 'work': this.runWork(); break;
      case 'home': this.runHome(); break;
      case 'market': this.runMarket(); break;
      case 'thirdplace': this.runThirdPlace(dt); break;
      default: break;
    }
  }

  // ---- WORK: the existing counter, now an affordance that pays wage --------
  private runWork(): void {
    // spawn customers
    if (this.clock >= this.nextSpawnAt && this.workQueue.length < 5 && openNow(PLACES.work, this.clock)) {
      const c = makeCustomer(this.rng, waitSlot(this.workQueue.length), this.clock);
      this.workQueue.push(c);
      this.nextSpawnAt = this.clock + 0.1 + this.rng() * 0.25;
    }
    // finish / promote / beat
    if (this.workCurrent && this.workAgenda.length === 0) {
      this.workCurrent.state = 'leaving';
      this.workCurrent = null; this.servedCount++; this.lastFinish = this.clock;
    }
    if (!this.workCurrent && this.workQueue.length && this.clock - this.lastFinish >= 0.01) {
      this.workCurrent = this.workQueue.shift()!;
      this.workCurrent.state = 'ordering';
      this.workAgenda = buildAgenda(this.workCurrent, this.rng);
    }
    if (this.workCurrent && this.workAgenda.length) {
      this.feed(this.mara, this.workAgenda.shift()!);
    } else if (!this.workCurrent && this.rng() < 0.4) {
      this.feed(this.mara, IDLE_EVENT());
    }
    this.syncWorkFigures();
  }

  private syncWorkFigures(): void {
    const figs: NpcLite[] = [];
    if (this.workCurrent) {
      const n = makeNpcLite(this.workCurrent.id, this.workCurrent.profileSeed ?? 1, COUNTER);
      n.name = this.workCurrent.name; n.goalToken = 'queue'; figs.push(n);
    }
    this.workQueue.forEach((c, i) => {
      const n = makeNpcLite(c.id, c.profileSeed ?? 1, waitSlot(i));
      n.name = c.name; n.goalToken = 'queue'; figs.push(n);
    });
    this.figures = figs;
  }

  // ---- HOME: eat (consummatory hunger reset) + rest (sleep) ----------------
  private runHome(): void {
    // EAT only when genuinely hungry (a meal sates for hours) — not every beat.
    if (canEat(this.resources) && this.needs.hunger > 0.5) {
      consumeMeal(this.resources);
      this.mara.soma.ghrelin = 0.35;         // consummatory reset → lasting satiety
      this.mara.soma.leptin = 1.7;
      this.feed(this.mara, ev('eat', 'You heat up something to eat at home and finally sit down.', 0.3, 0.5));
    }
    // REST repays fatigue + sleep debt while she's home and depleted.
    if (this.needs.energy > 0.45) {
      this.mara.soma.fatigue = clamp(this.mara.soma.fatigue - 0.08, 0, 1);
      this.resources.sleepDebt = Math.max(0, this.resources.sleepDebt - 0.1);
      if (this.rng() < 0.2) this.feed(this.mara, ev('rest', 'You lie down in your room; the day finally lets go a little.', 0.2, 0.25));
    }
  }

  // ---- MARKET: convert money → food stock ---------------------------------
  private spawnShoppers(): void {
    const n = Math.min(PLACES.market.capacity, Math.round(expectedAt(this.density, 'market', this.clock)));
    for (let i = 0; i < n; i++) {
      const seed = 5000 + ((this.day * 7 + i) % 97);
      const f = makeNpcLite(`shop-${this.day}-${i}`, seed, { x: (this.rng() - 0.5) * 4, y: 0, z: 1 + this.rng() * 3 });
      f.goalToken = 'browse';
      this.figures.push(f);
    }
  }
  private runMarket(): void {
    if (this.goal.intention.kind === 'shop' && canBuyGroceries(this.resources)) {
      const spent = buyGroceries(this.resources);
      if (spent > 0) this.feed(this.mara, ev('shop', 'You fill a basket at the market — enough food for a few days.', 0.25, 0.2));
      // a short dwell, then the arbiter will move her on
      this.goal.plannedEnd = Math.min(this.goal.plannedEnd, this.clock + 0.1);
    }
  }

  // ---- THIRD PLACE: the social site — promotion, bonding, demotion ---------
  private spawnSocials(): void {
    const want = Math.min(PLACES.thirdplace.capacity, Math.max(2, Math.round(expectedAt(this.density, 'thirdplace', this.clock))));
    // bias toward recurring locals (so bonds can deepen across visits)
    const pool = [...SOCIAL_SEEDS].sort(() => this.rng() - 0.5).slice(0, want);
    pool.forEach((seed, i) => {
      const f = makeNpcLite(`local-${seed}`, seed, { x: (i - want / 2) * 1.4, y: 0, z: 1.2 + (i % 2) });
      f.goalToken = 'linger';
      f.bonded = this.ledger.has(`local-${seed}`);
      this.figures.push(f);
    });
  }

  private runThirdPlace(dt: number): void {
    if (this.goal.intention.kind !== 'socialize') return;
    // one real conversation per visit: promote the most-familiar present local
    if (!this.partner && !this.socialDone && this.figures.length) {
      const target = this.pickSocialTarget();
      if (target) this.promotePartner(target);
    }
    if (this.partner && this.partnerNpcId) {
      this.socialBeat();
      this.partnerBeatsLeft -= 1;
      if (this.partnerBeatsLeft <= 0) { this.demotePartner('the conversation wound down'); this.socialDone = true; }
    }
  }

  private pickSocialTarget(): NpcLite | null {
    let best: NpcLite | null = null; let bestScore = -1;
    for (const f of this.figures) {
      const rel = this.ledger.get(f.id);
      const score = (rel ? rel.familiarity + Math.max(0, rel.affection) : 0.2) + this.rng() * 0.2;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    if (best) best.goalToken = 'approach_mara';
    return best;
  }

  // PROMOTE: lift a Tier-1 NPC to a full-sim Character, ONLY for this exchange
  private promotePartner(fig: NpcLite): void {
    const prof = sampleProfile(fig.profileSeed);
    const partner = new Character(prof, { seed: fig.profileSeed, startHour: this.clock });
    const rel = this.ledger.get(fig.id);
    if (rel) {
      partner.memory.seed([`I know Mara: ${rel.summary}`], this.clock);
      if (rel.somaSnapshot) Object.assign(partner.soma, rel.somaSnapshot); // resume chronic load
    }
    // a café-goer arrives relatively at ease (not carrying Mara's shift stress) —
    // so a warm exchange is possible, not foreclosed by two maxed-out nervous systems.
    partner.soma.amygdala *= 0.5;
    partner.soma.cortisol = Math.min(partner.soma.cortisol, 1.05);
    partner.soma.oxytocin = Math.max(partner.soma.oxytocin, 1.1);
    this.partner = partner;
    this.partnerNpcId = fig.id;
    this.partnerBeatsLeft = 10 + Math.floor(this.rng() * 6);
    if (!this.ledger.has(fig.id)) this.ledger.set(fig.id, newRelationship(fig.id, fig.profileSeed, fig.name));
  }

  // one beat of two-sided interaction, measured from both real substrates
  private socialBeat(): void {
    const rel = this.ledger.get(this.partnerNpcId!)!;
    const partner = this.partner!;
    // warmth of this beat: a hopeful baseline + accumulated rapport + the partner's
    // mood + chance. Compatible, familiar pairs trend warm; clashes sour.
    const rapport = rel.affection + 0.35 * partner.soma.valence + 0.2 * (this.rng() - 0.5);
    const warm = clamp(0.55 + rapport, -1, 1);
    const name = rel.name;
    const v0m = this.mara.soma.valence, v0n = partner.soma.valence;
    // POV-mirrored event pair
    const maraEv = warm >= 0
      ? ev('social', `${name} leans in, easy and warm, and asks how you've really been.`, 0.15, warm, name)
      : ev('social', `${name} is curt and a little dismissive; the talk goes flat.`, 0.45, warm, name);
    const npcEv = warm >= 0
      ? ev('social', `Mara meets your eyes and softens; the talk is warm.`, 0.15, clamp(warm * 0.9, -1, 1), 'Mara')
      : ev('social', `Mara goes quiet and guarded; the talk is stiff.`, 0.45, clamp(warm * 0.9, -1, 1), 'Mara');
    this.feed(this.mara, maraEv);
    this.feed(partner, npcEv);
    // a genuinely warm exchange soothes and warms the body — reward (da/5HT) and
    // oxytocin/CARE up, fear down — so even an anxious person can thaw over a good
    // conversation. Recompute core affect so this beat's valence delta reflects it.
    if (warm > 0) {
      for (const ch of [this.mara, partner]) {
        const ss = ch.soma;
        // social buffering / co-regulation: oxytocin & opioid rise, reward lifts,
        // and the threat axis (amygdala/FEAR/PANIC/cortisol) is pulled DOWN — this
        // is how a warm conversation thaws even a wound-tight nervous system.
        ss.da_meso = clamp(ss.da_meso + warm * 0.1, 0, 4);
        ss.serotonin = clamp(ss.serotonin + warm * 0.06, 0, 4);
        ss.oxytocin = clamp(ss.oxytocin + warm * 0.18, 0, 4);
        ss.opioid = clamp(ss.opioid + warm * 0.12, 0, 4);
        ss.CARE = clamp(ss.CARE + warm * 0.12, 0, 1);
        ss.amygdala = clamp(ss.amygdala * (1 - 0.22 * warm), 0, 1);
        ss.FEAR = clamp(ss.FEAR * (1 - 0.28 * warm), 0, 1);
        ss.PANIC_GRIEF = clamp(ss.PANIC_GRIEF * (1 - 0.3 * warm), 0, 1);
        ss.cortisol = ss.cortisol + (1 - ss.cortisol) * 0.15 * warm; // ease toward baseline
        computeCoreAffect(ss, ch.params);
      }
    }
    const dM = this.mara.soma.valence - v0m;
    const dN = partner.soma.valence - v0n;
    updateBond(rel, this.mara.soma, partner.soma, dM, dN, 0.4, 0.05);
    rel.lastSeen = this.clock;
    // company eases isolation even if the talk is awkward; warmth eases it more.
    this.socialFuel = clamp(this.socialFuel + (warm >= 0 ? 0.1 : 0.04), 0, 1);
    if (warm >= 0) this.lastSocialAt = this.clock;
  }

  // DEMOTE: distill the encounter to a ledger summary + a Mara memory, drop the soma
  private demotePartner(reason: string): void {
    if (!this.partner || !this.partnerNpcId) return;
    const rel = this.ledger.get(this.partnerNpcId);
    if (rel) {
      rel.summary = distillSummary(rel, this.mara.readout().label, this.mara.lastResponse?.speech ?? '');
      rel.somaSnapshot = { allostaticLoad: this.partner.soma.allostaticLoad, cortisol: this.partner.soma.cortisol };
      rel.lastSeen = this.clock;
      this.mara.memory.add(this.clock, `At the ${PLACES.thirdplace.name}, ${rel.name}: ${rel.summary} (${reason})`, this.mara.soma);
      const fig = this.figures.find((f) => f.id === this.partnerNpcId);
      if (fig) fig.bonded = true;
    }
    this.partner = null;
    this.partnerNpcId = null;
    this.partnerBeatsLeft = 0;
  }

  // ===================== figure movement (Tier-1) =======================
  private stepFigures(dt: number): void {
    if (this.place === 'work') return; // work figures are queue-positioned
    const wander = WANDER[PLACES[this.place].localeKind] ?? { x: 0, y: 0, z: 1.5 };
    const ctx: LiteCtx = { maraPos: COUNTER, exit: EXIT, wander, rng: this.rng };
    this.figures = this.figures.filter((f) => !stepNpcLite(f, dt, ctx));
  }

  // ===================== Mara/partner drive =============================
  private feed(ch: Character, e: WorldEvent): void {
    this.currentEvent = e;
    ch.perceive(e);
    if (ch === this.mara && this.llm && !this.pendingLLM) {
      this.pendingLLM = true;
      void this.driveLLM(e).finally(() => { this.pendingLLM = false; });
    } else {
      ch.applyDriverResponse(e, fallbackResponse(ch.soma, ch.readout()));
    }
  }

  private async driveLLM(e: WorldEvent): Promise<void> {
    const soma = this.mara.soma, readout = this.mara.readout();
    const mems = this.mara.recall(e.description, 3);
    const messages = buildMessages(this.mara.profile, soma, readout, mems, e);
    let resp: LLMResponse;
    try { resp = parseResponse(await this.llm!.complete(messages, { format: 'json', temperature: 0.7 }), soma, readout); }
    catch { resp = fallbackResponse(soma, readout); }
    this.mara.applyDriverResponse(e, resp);
  }

  // ===================== public API =====================================
  setSpeed(s: number): void { this.speed = s; }
  togglePause(): void { this.paused = !this.paused; }

  snapshot(): TownSnapshot {
    const cashier = this.mara.snapshot();
    cashier.needs = this.needs;
    cashier.needsIntegrals = this.needsIntegrals;
    const queue: Customer[] = [];
    if (this.workCurrent) queue.push(this.workCurrent);
    queue.push(...this.workQueue);
    return {
      time: this.clock, speed: this.speed, queue, servedCount: this.servedCount,
      cashier, currentEvent: this.currentEvent,
      place: this.place, macroPos: this.macroPos, travelling: this.travelling,
      needs: this.needs, needsIntegrals: this.needsIntegrals, resources: this.resources,
      intention: this.goal.intention, day: this.day, weekend: this.weekend,
      density: this.density, locale: { figures: this.figures },
      relationships: [...this.ledger.values()].sort((a, b) => b.familiarity - a.familiarity),
      partner: this.partner?.snapshot(),
    };
  }
}

// silence unused-name lints for npcName re-export consumers
void npcName;
