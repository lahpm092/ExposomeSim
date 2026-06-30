// =============================================================================
// world.ts — the simulation orchestrator.
// Couples a continuously-integrated soma with asynchronous, LLM-driven "beats".
// Key design: update(dtReal) is synchronous and always advances the substrate &
// movement; events fire on a beat timer and dispatch an async LLM call guarded by
// `pendingLLM`. The body keeps living while the mind "thinks" — which is realistic.
// =============================================================================
import type {
  Profile, WorldEvent, WorldSnapshot, Customer, Vec3, LLMClient, LLMResponse,
} from '../types';
import { Character } from '../harness/character';
import { CASHIER_PROFILE } from '../harness/params';
import { buildMessages, parseResponse, fallbackResponse } from '../llm/prompt';
import { makeCustomer, buildAgenda, IDLE_EVENT, RUSH_EVENT } from './events';
import { mulberry32, type RNG } from '../util/num';

const COUNTER: Vec3 = { x: 0, y: 0, z: 1.7 };
const waitingSlot = (i: number): Vec3 => ({ x: 0, y: 0, z: 3.4 + i * 1.15 });
const EXIT: Vec3 = { x: 4.2, y: 0, z: 1.7 };

export interface WorldOpts {
  profile?: Profile;
  llm?: LLMClient | null;
  seed?: number;
  startHour?: number;
  speed?: number; // sim-hours per real second
}

export class World {
  readonly cashier: Character;
  llm: LLMClient | null;
  speed: number;
  paused = false;

  private rng: RNG;
  private queue: Customer[] = [];
  private current: Customer | null = null;
  private leaving: { c: Customer; until: number }[] = [];
  private agenda: WorldEvent[] = [];
  private beatAcc = 0;
  private readonly beatInterval = 0.07; // sim-hours between beats (~1.4s at default speed)
  private nextSpawnAt: number;
  private lastFinish = 0;
  private pendingLLM = false;
  private servedCount = 0;
  private currentEvent?: WorldEvent;

  constructor(opts: WorldOpts = {}) {
    this.cashier = new Character(opts.profile ?? CASHIER_PROFILE, {
      seed: opts.seed ?? 7, startHour: opts.startHour ?? 11,
    });
    this.llm = opts.llm ?? null;
    this.speed = opts.speed ?? 0.05;
    this.rng = mulberry32((opts.seed ?? 7) * 2654435761 >>> 0);
    this.nextSpawnAt = this.clock + 0.02;
  }

  private get clock() { return this.cashier.soma.t; }

  /** one animation-frame tick */
  update(dtReal: number): void {
    if (this.paused) return;
    const dt = dtReal * this.speed; // sim-hours elapsed
    if (dt <= 0) return;

    // 1) the substrate always lives
    this.cashier.step(dt);

    // 2) world bookkeeping: spawns, queue patience, exits
    this.spawnIfDue();
    this.updatePatience(dt);
    this.updateExits();
    this.updatePositions();

    // 3) beats: promote a customer, then walk their agenda via the LLM
    this.beatAcc += dt;
    if (!this.pendingLLM && this.beatAcc >= this.beatInterval) {
      this.beatAcc = 0;
      this.advance();
    }
  }

  // -- scenario state machine ------------------------------------------------
  private spawnIfDue(): void {
    if (this.clock >= this.nextSpawnAt && this.queue.length < 6) {
      const c = makeCustomer(this.rng, waitingSlot(this.queue.length), this.clock);
      this.queue.push(c);
      const rush = this.queue.length >= 4;
      this.nextSpawnAt = this.clock + (rush ? 0.08 : 0.14 + this.rng() * 0.3);
    }
  }

  private advance(): void {
    // finish current interaction
    if (this.current && this.agenda.length === 0) {
      const done = this.current;
      done.state = 'leaving';
      this.leaving.push({ c: done, until: this.clock + 0.06 });
      this.current = null;
      this.servedCount++;
      this.lastFinish = this.clock;
    }
    // promote next customer
    if (!this.current && this.queue.length > 0 && this.clock - this.lastFinish >= 0.01) {
      this.current = this.queue.shift()!;
      this.current.state = 'ordering';
      this.agenda = buildAgenda(this.current, this.rng);
      if (this.queue.length >= 4) this.dispatch(RUSH_EVENT(this.queue.length + 1));
    }
    // next beat of the current agenda, or an idle breath
    if (this.current && this.agenda.length > 0) {
      this.dispatch(this.agenda.shift()!);
    } else if (!this.current && this.queue.length === 0) {
      if (this.rng() < 0.5) this.dispatch(IDLE_EVENT());
    }
  }

  /** perceive an event, then drive the response (async LLM, guarded) */
  private dispatch(ev: WorldEvent): void {
    this.currentEvent = ev;
    this.cashier.perceive(ev);
    if (this.current && ev.kind === 'order') this.current.state = 'waiting';

    if (!this.llm) {
      this.cashier.applyDriverResponse(ev, fallbackResponse(this.cashier.soma, this.cashier.readout()));
      return;
    }

    this.pendingLLM = true;
    void this.drive(ev).finally(() => { this.pendingLLM = false; });
  }

  private async drive(ev: WorldEvent): Promise<void> {
    const soma = this.cashier.soma;
    const readout = this.cashier.readout();
    const mems = this.cashier.recall(ev.description, 3);
    const messages = buildMessages(this.cashier.profile, soma, readout, mems, ev);
    let resp: LLMResponse;
    try {
      const raw = await this.llm!.complete(messages, { format: 'json', temperature: 0.7 });
      resp = parseResponse(raw, soma, readout);
    } catch {
      resp = fallbackResponse(soma, readout);
    }
    this.cashier.applyDriverResponse(ev, resp);
  }

  // -- spatial / housekeeping ------------------------------------------------
  private updatePatience(dt: number): void {
    for (const c of this.queue) c.patience = Math.max(0, c.patience - dt * 0.25);
    if (this.current) this.current.patience = Math.max(0, this.current.patience - dt * 0.1);
  }

  private updateExits(): void {
    this.leaving = this.leaving.filter(({ c, until }) => {
      if (this.clock >= until) { c.state = 'gone'; return false; }
      return true;
    });
  }

  private updatePositions(): void {
    if (this.current) this.current.pos = { ...COUNTER };
    this.queue.forEach((c, i) => { c.pos = waitingSlot(i); if (c.state === 'approaching' && i === 0) c.state = 'waiting'; });
    for (const { c } of this.leaving) c.pos = { ...EXIT };
  }

  // -- public API ------------------------------------------------------------
  setSpeed(s: number): void { this.speed = s; }
  togglePause(): void { this.paused = !this.paused; }

  snapshot(): WorldSnapshot {
    const queue: Customer[] = [];
    if (this.current) queue.push(this.current);
    queue.push(...this.queue, ...this.leaving.map((l) => l.c));
    return {
      time: this.clock,
      speed: this.speed,
      queue,
      servedCount: this.servedCount,
      cashier: this.cashier.snapshot(),
      currentEvent: this.currentEvent,
    };
  }
}
