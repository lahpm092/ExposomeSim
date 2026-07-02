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
  NpcLite, Relationship, Ledger, DensityField, TownSnapshot, SomaState,
} from '../types';
import { Character } from '../harness/character';
import { MindLite } from '../harness/mindlite';
import { computeCoreAffect } from '../harness/soma';
import { CASHIER_PROFILE, sampleProfile } from '../harness/params';
import { computeNeeds, applyNeedFeedback, emptyNeedIntegrals, updateNeedIntegrals } from '../harness/needs';
import { PLACES, openNow, travelTime } from './places';
import {
  createResources, tickWork, canBuyGroceries, buyGroceries, buyMeal, canEat, consumeMeal,
  dueRent, payRent, FOOD_VOCAB,
} from './economy';
import { chooseIntention } from './arbiter';
import { newRelationship, updateBond, distillSummary, decayBonds } from './relationship';
import { createDensity, stepDensity, expectedAt } from './city';
import { makeNpcLite, stepNpcLite, npcName, type LiteCtx } from './npc';
import { buildMessages, parseResponse, fallbackResponse, LLM_RESPONSE_SCHEMA } from '../llm/prompt';
import { makeCustomer, buildAgenda, IDLE_EVENT } from './events';
import { mulberry32, clamp, lerp, type RNG } from '../util/num';

// locale geometry — interior-room frame (centred on the building; +z toward the
// door / town centre). Figures live in this frame; the renderer maps it to world.
const COUNTER: Vec3 = { x: 0, y: 0, z: 0.2 };            // where the served customer stands
const EXIT: Vec3 = { x: 2.6, y: 0, z: 3.2 };
const CAFE_MARA: Vec3 = { x: -1.0, y: 0, z: 0.5 };       // Mara's café table spot
const waitSlot = (i: number): Vec3 => ({ x: 0, y: 0, z: 1.0 + i * 0.9 });
const WANDER: Record<string, Vec3> = {
  apartment: { x: 0, y: 0, z: 0.0 },
  counter: COUNTER,
  market: { x: 0, y: 0, z: 0.2 },
  cafe: { x: 0, y: 0, z: 0.6 },
};
// a handful of recurring "locals" at the third place, so re-encounters can bond
const SOCIAL_SEEDS = [10117, 20431, 30289, 40763];

let _eid = 0;
const ev = (kind: string, description: string, s: number, v: number, source?: string): WorldEvent =>
  ({ id: `te${(_eid++).toString(36)}`, kind, description, salienceHint: s, valenceHint: v, source });

export interface TownOpts {
  profile?: Profile; llm?: LLMClient | null; consolidator?: LLMClient | null;
  seed?: number; startHour?: number; speed?: number;
}

export class Town {
  readonly mara: Character;
  /** full-resolution protagonists (Mara is [0]; a second can be added at runtime). */
  readonly protagonists: Character[] = [];
  llm: LLMClient | null;
  /** off-hot-path reasoner for memory consolidation/reflection (falls back to llm). */
  consolidator: LLMClient | null;
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
  partnerMind: MindLite | null = null;   // the abstracted, transient interlocutor psyche
  private partnerNpcId: string | null = null;
  private partnerBeatsLeft = 0;
  private socialDone = false; // one real conversation per café visit
  private shopDecided = false; // one emergent grocery decision per market visit
  private carriedGroceries = false; // fresh groceries to stow when she gets home

  private lastSocialAt: number;
  private socialFuel = 0.55; // slow belonging reservoir: drains alone, refills on contact
  private rng: RNG;
  // beatInterval is in sim-hours. With a *thinking* driver (~10s/beat) the pendingLLM
  // guard already prevents pile-up; this sets the deliberate spacing between thoughts.
  private beatAcc = 0; private readonly beatInterval = 0.06;
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
    this.protagonists.push(this.mara);
    this.llm = opts.llm ?? null;
    this.consolidator = opts.consolidator ?? null;
    this.speed = opts.speed ?? 0.05;
    this.rng = mulberry32(((opts.seed ?? 7) * 2654435761) >>> 0);
    this.resources = createResources(this.clock);
    this.density = createDensity();
    this.needs = computeNeeds(this.mara.soma, this.resources, this.mara.phys);
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
    this.needs = computeNeeds(this.mara.soma, this.resources, this.mara.phys);
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

    // 4) the interlocutor (if promoted) runs its ABSTRACTED psyche — only now,
    //    at lower causal resolution than Mara's full soma, and dropped after.
    if (this.partnerMind) this.partnerMind.step(dt);

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
    this.shopDecided = false;
    if (place === 'thirdplace') this.spawnSocials();
    else if (place === 'market') this.spawnShoppers();
  }

  private runLocale(dt: number): void {
    // quick consummatory acts (drink / toilet / bathe / grab-a-burger) that can
    // interrupt anything, wherever the affordance exists. If one fires this beat,
    // the place logic is skipped — she's stepped away to do it.
    if (this.runConsummatory()) return;
    switch (this.place) {
      case 'work': this.runWork(); break;
      case 'home': this.runHome(dt); break;
      case 'market': this.runMarket(); break;
      case 'thirdplace': this.runThirdPlace(dt); break;
      default: break;
    }
  }

  /** the fast physiological acts, driven by whichever intention the arbiter chose. */
  private runConsummatory(): boolean {
    const k = this.goal.intention.kind;
    if (k === 'drink' && this.mara.soma.thirst > 0.1) {
      this.mara.drink();
      this.feed(this.mara, ev('drink', 'You fill a glass of water and drink it down; the dry edge fades.', 0.12, 0.2));
      this.shortenDwell(0.05); return true;
    }
    if (k === 'relieve' && this.needs.elimination > 0.05) {
      this.mara.relieve();
      this.feed(this.mara, ev('relieve', 'You slip away to the restroom; the pressure eases.', 0.1, 0.15));
      this.shortenDwell(0.05); return true;
    }
    if (k === 'bathe' && this.place === 'home' && this.needs.cleanliness > 0.1) {
      this.mara.takeBath();
      this.feed(this.mara, ev('bathe', 'You run a warm bath and soak; you feel human again, ready for the day.', 0.18, 0.4));
      this.shortenDwell(0.12); return true;
    }
    if (k === 'buy_meal' && this.place === 'work') {
      if (buyMeal(this.resources, 5)) { this.mara.eat(0.6); this.feed(this.mara, ev('eat', 'On your break you eat a staff burger at the counter; the hunger backs off.', 0.2, 0.35)); }
      this.shortenDwell(0.1); return true;
    }
    return false;
  }

  private shortenDwell(h: number): void {
    this.goal.plannedEnd = Math.min(this.goal.plannedEnd, this.clock + h);
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

  // ---- HOME: stow groceries · cook & eat · bathe/toilet (in runConsummatory) · rest
  private runHome(dt: number): void {
    // just carried groceries back? put them in the fridge (a one-off on arrival).
    if (this.carriedGroceries) {
      this.carriedGroceries = false;
      const items = this.resources.pantry.slice(-4).join(', ');
      this.feed(this.mara, ev('stow', `You unpack the groceries into the fridge${items ? ` — ${items}` : ''}.`, 0.15, 0.25));
    }
    // COOK & EAT when she chose to and there's food to cook (fills the gut reserve).
    if (this.goal.intention.kind === 'eat' && canEat(this.resources) && this.needs.hunger > 0.4) {
      consumeMeal(this.resources);
      this.mara.eat(0.62);
      this.feed(this.mara, ev('eat', `You cook ${this.pickDish()} at the stove and sit down to eat; the hunger settles.`, 0.3, 0.5));
      this.shortenDwell(0.4);
    }
    // REST repays fatigue + sleep debt AND is restorative to the stress axis:
    // sleep lowers cortisol toward baseline, quiets the amygdala, and lets a little
    // allostatic load recover — so a hard day doesn't compound into a spiral.
    if (this.needs.energy > 0.45) {
      const s = this.mara.soma;
      s.fatigue = clamp(s.fatigue - 0.08, 0, 1);
      this.resources.sleepDebt = Math.max(0, this.resources.sleepDebt - 0.1);
      s.cortisol += (0.9 - s.cortisol) * 0.07;
      s.amygdala *= 0.92;
      s.FEAR *= 0.9; s.PANIC_GRIEF *= 0.92;
      s.allostaticLoad = Math.max(0, s.allostaticLoad - 0.018); // partial nightly recovery; a residue persists
      if (this.rng() < 0.2) this.feed(this.mara, ev('rest', 'You lie down in your room; the day finally lets go a little.', 0.2, 0.25));
    }
    // rest is when the hippocampus replays the day: consolidate episodics into
    // semantic gists + reflect (async, LLM-optional, rate-limited inside rest()).
    this.mara.rest(dt, this.consolidator ?? this.llm);
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
    // one EMERGENT grocery decision per visit: she thinks about what to buy (LLM,
    // memory-informed); her thought is interpreted into an abstract basket.
    if (this.goal.intention.kind === 'shop' && canBuyGroceries(this.resources) && !this.shopDecided) {
      this.shopDecided = true;
      const money = Math.round(this.resources.money);
      const e = ev('shop', `You're at the ${PLACES.market.name} with about $${money}, low on food at home. Standing among the fridges and the produce, you think about what to buy for the next few days.`, 0.28, 0.15);
      this.feedShop(e);
    }
  }

  /** interpret her shopping thought into groceries (from the food vocabulary),
   *  stock the fridge, remember the choice, and carry it home to stow. */
  private stockFromThought(text: string): void {
    const t = ` ${text.toLowerCase()} `;
    let items = FOOD_VOCAB.filter((f) => t.includes(f));
    if (!items.length) items = ['rice', 'eggs', 'vegetables', 'fruit', 'chicken']; // sensible staples
    items = items.slice(0, 6);
    buyGroceries(this.resources, items);
    this.carriedGroceries = true;
    this.mara.memory.add(this.clock, `At the ${PLACES.market.name} I bought ${items.join(', ')}.`, this.mara.soma);
    this.shortenDwell(0.12);
  }

  private pickDish(): string {
    const p = this.resources.pantry;
    if (p.length >= 2) { const a = p[p.length - 1], b = p[Math.max(0, p.length - 3)]; return a === b ? a : `${a} and ${b}`; }
    return p[0] ?? 'something simple';
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
    if (!this.partnerMind && !this.socialDone && this.figures.length) {
      const target = this.pickSocialTarget();
      if (target) this.promotePartner(target);
    }
    if (this.partnerMind && this.partnerNpcId) {
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

  // PROMOTE: instantiate an ABSTRACTED interlocutor psyche (MindLite), ONLY for
  // this exchange — lower causal resolution than Mara's soma, carrying just the
  // coarse mood/warmth the ledger remembers of them.
  private promotePartner(fig: NpcLite): void {
    const prof = sampleProfile(fig.profileSeed);
    const rel = this.ledger.get(fig.id);
    this.partnerMind = new MindLite(prof, {
      carryValence: rel?.somaSnapshot?.valence ?? 0,
      carryWarmth: rel ? Math.max(0, rel.affection) : 0,
    });
    this.partnerNpcId = fig.id;
    this.partnerBeatsLeft = 10 + Math.floor(this.rng() * 6);
    if (!this.ledger.has(fig.id)) this.ledger.set(fig.id, newRelationship(fig.id, fig.profileSeed, fig.name));
  }

  // one beat of two-sided interaction: Mara's full soma vs. the partner's coarse mind
  private socialBeat(): void {
    const rel = this.ledger.get(this.partnerNpcId!)!;
    const mind = this.partnerMind!;
    // warmth of this beat: a hopeful baseline + accumulated rapport + the partner's
    // coarse mood + chance. Compatible, familiar pairs trend warm; clashes sour.
    const rapport = rel.affection + 0.35 * mind.valence + 0.2 * (this.rng() - 0.5);
    const warm = clamp(0.55 + rapport, -1, 1);
    const name = rel.name;
    const v0m = this.mara.soma.valence, v0n = mind.valence;
    const maraEv = warm >= 0
      ? ev('social', `${name} leans in, easy and warm, and asks how you've really been.`, 0.15, warm, name)
      : ev('social', `${name} is curt and a little dismissive; the talk goes flat.`, 0.45, warm, name);
    this.feed(this.mara, maraEv);
    mind.perceiveBeat(clamp(warm * 0.9, -1, 1));  // the partner feels it too (coarsely)

    // a genuinely warm exchange soothes and warms MARA's body — reward (da/5HT) and
    // oxytocin/CARE up, threat axis (amygdala/FEAR/PANIC/cortisol) down — so even an
    // anxious person can thaw over a good conversation.
    if (warm > 0) {
      const ss = this.mara.soma;
      ss.da_meso = clamp(ss.da_meso + warm * 0.1, 0, 4);
      ss.serotonin = clamp(ss.serotonin + warm * 0.06, 0, 4);
      ss.oxytocin = clamp(ss.oxytocin + warm * 0.18, 0, 4);
      ss.opioid = clamp(ss.opioid + warm * 0.12, 0, 4);
      ss.CARE = clamp(ss.CARE + warm * 0.12, 0, 1);
      ss.amygdala = clamp(ss.amygdala * (1 - 0.22 * warm), 0, 1);
      ss.FEAR = clamp(ss.FEAR * (1 - 0.28 * warm), 0, 1);
      ss.PANIC_GRIEF = clamp(ss.PANIC_GRIEF * (1 - 0.3 * warm), 0, 1);
      ss.cortisol = ss.cortisol + (1 - ss.cortisol) * 0.15 * warm;
      computeCoreAffect(ss, this.mara.params);
    }
    const dM = this.mara.soma.valence - v0m;
    const dN = mind.valence - v0n;
    updateBond(rel, this.mara.soma, mind.somaView() as unknown as SomaState, dM, dN, 0.4, 0.05);
    rel.lastSeen = this.clock;
    // company eases isolation even if the talk is awkward; warmth eases it more.
    this.socialFuel = clamp(this.socialFuel + (warm >= 0 ? 0.1 : 0.04), 0, 1);
    if (warm >= 0) this.lastSocialAt = this.clock;
  }

  // DEMOTE: distill the encounter to a ledger summary + a Mara memory, drop the mind
  private demotePartner(reason: string): void {
    if (!this.partnerMind || !this.partnerNpcId) return;
    const rel = this.ledger.get(this.partnerNpcId);
    if (rel) {
      rel.summary = distillSummary(rel, this.mara.readout().label, this.mara.lastResponse?.speech ?? '');
      rel.somaSnapshot = { valence: this.partnerMind.valence }; // carry coarse mood for next time
      rel.lastSeen = this.clock;
      this.mara.memory.add(this.clock, `At the ${PLACES.thirdplace.name}, ${rel.name}: ${rel.summary} (${reason})`, this.mara.soma);
      const fig = this.figures.find((f) => f.id === this.partnerNpcId);
      if (fig) fig.bonded = true;
    }
    this.partnerMind = null;
    this.partnerNpcId = null;
    this.partnerBeatsLeft = 0;
  }

  // ===================== figure movement (Tier-1) =======================
  private stepFigures(dt: number): void {
    if (this.place === 'work') return; // work figures are queue-positioned
    const wander = WANDER[PLACES[this.place].localeKind] ?? { x: 0, y: 0, z: 1.5 };
    const maraPos = this.place === 'thirdplace' ? CAFE_MARA : COUNTER;
    const ctx: LiteCtx = { maraPos, exit: EXIT, wander, rng: this.rng };
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
      ch.applyDriverResponse(e, fallbackResponse(ch.soma, ch.readout(), e));
    }
  }

  private async driveLLM(e: WorldEvent): Promise<void> {
    const soma = this.mara.soma, readout = this.mara.readout();
    const mems = this.mara.recall(e.description, 3);
    const messages = buildMessages(this.mara.profile, soma, readout, mems, e);
    let resp: LLMResponse;
    try { resp = parseResponse(await this.llm!.complete(messages, { format: LLM_RESPONSE_SCHEMA, temperature: 0.7 }), soma, readout); }
    catch { resp = fallbackResponse(soma, readout, e); }
    this.mara.applyDriverResponse(e, resp);
  }

  // the grocery decision: like feed(), but her thought is then interpreted into a
  // basket (memory-informed via the recall query — surfaces her food preferences).
  private feedShop(e: WorldEvent): void {
    this.currentEvent = e;
    this.mara.perceive(e);
    if (this.llm && !this.pendingLLM) {
      this.pendingLLM = true;
      void this.driveShop(e).finally(() => { this.pendingLLM = false; });
    } else {
      const resp = fallbackResponse(this.mara.soma, this.mara.readout(), e);
      this.mara.applyDriverResponse(e, resp);
      this.stockFromThought(resp.speech + ' ' + (resp.innerMonologue ?? ''));
    }
  }

  private async driveShop(e: WorldEvent): Promise<void> {
    const soma = this.mara.soma, readout = this.mara.readout();
    const mems = this.mara.recall('food buy market cook eat groceries rice eggs vegetables', 4);
    const messages = buildMessages(this.mara.profile, soma, readout, mems, e);
    let resp: LLMResponse;
    try { resp = parseResponse(await this.llm!.complete(messages, { format: LLM_RESPONSE_SCHEMA, temperature: 0.8 }), soma, readout); }
    catch { resp = fallbackResponse(soma, readout, e); }
    this.mara.applyDriverResponse(e, resp);
    this.stockFromThought(`${resp.speech} ${resp.innerMonologue ?? ''}`);
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
      partner: this.partnerMind?.view(),
      protagonists: this.protagonists.map((p) => p.profile.name),
    };
  }
}

// silence unused-name lints for npcName re-export consumers
void npcName;
