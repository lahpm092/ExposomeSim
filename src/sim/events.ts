// =============================================================================
// events.ts — the burger counter as an event source.
// Customers are sampled with a demeanor; each produces an "agenda" of WorldEvents
// (arrive → order → maybe a twist → served → leave). Salience/valence hints feed
// the low road; the natural-language description feeds the LLM.
// =============================================================================
import type { Customer, Demeanor, WorldEvent, Vec3 } from '../types';
import { weightedPick, type RNG } from '../util/num';

let _seq = 0;
const uid = (p: string) => `${p}${(_seq++).toString(36)}`;

const NAMES = ['a man in a hard hat', 'a teenage girl', 'an older woman', 'a courier', 'two students',
  'a businessman', 'a tired nurse', 'a dad with a toddler', 'a regular', 'a tourist'];
const ORDERS = ['a double cheeseburger and fries', 'a veggie wrap and a shake', 'two kids meals',
  'a black coffee, nothing else', 'the spicy chicken, no mayo', 'a large fries and a cola',
  'three burgers to go', 'whatever is fastest'];

const DEMEANOR_VALENCE: Record<Demeanor, number> = {
  warm: 0.7, polite: 0.3, neutral: 0.0, impatient: -0.4, rude: -0.8,
};

export function makeCustomer(rng: RNG, spawnSlot: Vec3, t: number): Customer {
  const demeanor = weightedPick<Demeanor>(rng, [
    ['polite', 0.38], ['neutral', 0.33], ['warm', 0.15], ['impatient', 0.09], ['rude', 0.05],
  ]);
  return {
    id: uid('c'),
    name: NAMES[Math.floor(rng() * NAMES.length)],
    demeanor,
    patience: demeanor === 'impatient' ? 0.5 : demeanor === 'rude' ? 0.35 : 0.85,
    order: ORDERS[Math.floor(rng() * ORDERS.length)],
    pos: { ...spawnSlot },
    state: 'approaching',
    spawnedAt: t,
  };
}

const ev = (kind: string, description: string, salienceHint: number, valenceHint: number, source?: string): WorldEvent =>
  ({ id: uid('e'), kind, description, salienceHint, valenceHint, source });

/** the sequence of moments one customer brings to the counter */
export function buildAgenda(c: Customer, rng: RNG): WorldEvent[] {
  const v = DEMEANOR_VALENCE[c.demeanor];
  const adv = c.demeanor === 'warm' ? ', smiling' : c.demeanor === 'rude' ? ', scowling'
    : c.demeanor === 'impatient' ? ', glancing at the time' : '';
  const list: WorldEvent[] = [
    ev('customer_arrive', `${c.name} steps up to the counter${adv}.`, 0.3, v * 0.5, c.name),
    ev('order', `${c.name} orders ${c.order}${c.demeanor === 'rude' ? ' — "and make it quick."' : '.'}`, 0.35, v * 0.4, c.name),
  ];

  // a twist, weighted by demeanor
  if (c.demeanor === 'rude') {
    list.push(ev('rude', `${c.name} snaps: "Are you even listening? Hurry up."`, 0.6, -0.6, c.name));
  } else if (c.demeanor === 'impatient') {
    list.push(ev('impatient', `${c.name} sighs loudly and drums their fingers on the counter.`, 0.4, -0.35, c.name));
  } else if (c.demeanor === 'warm') {
    list.push(ev('compliment', `${c.name} says warmly: "You're doing great, take your time."`, 0.45, 0.75, c.name));
  } else if (rng() < 0.18) {
    list.push(ev('complaint', `${c.name} mentions the last order here was wrong and hopes this one isn't.`, 0.55, -0.5, c.name));
  } else if (rng() < 0.15) {
    list.push(ev('smalltalk', `${c.name} makes a small, kind joke about the weather.`, 0.3, 0.4, c.name));
  }

  list.push(ev('served', `You finish ${c.name}'s order and hand it over.`, 0.3, 0.35, c.name));
  list.push(ev('leave', `${c.name} takes the bag and leaves.`, 0.15, v * 0.2, c.name));
  return list;
}

/** ambient events when the counter is quiet or slammed */
export const IDLE_EVENT = (): WorldEvent =>
  ev('idle', 'The line is empty for a moment. The fryer hums. You catch your breath.', 0.1, 0.1);

export const RUSH_EVENT = (n: number): WorldEvent =>
  ev('rush', `The line has grown to ${n} people and the tickets are piling up.`, 0.6, -0.5);
