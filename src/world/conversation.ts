// =============================================================================
// ExposomeSim — the emergent two-body conversation.
// -----------------------------------------------------------------------------
// A conversation is NOT an action either character chooses, and NOTHING here is
// scripted. It EMERGES when two co-located people who are free to talk turn out
// to share an interest (or roll into small talk), and it then feeds back into
// BOTH of them symmetrically: each beat rewards (or mildly threatens) TWO full
// somas exactly the way town.ts's socialBeat rewards Mara's, updates a two-sided
// relationship ledger from the reciprocated affect deltas, and lays down an
// episodic memory in BOTH memory graphs naming the partner and the topic.
//
// Warmth is the beat's currency: a hopeful base, warmed by Big-Five compatibility
// (agreeable + extraverted pairs), by a real shared interest, by standing rapport
// (ledger affection) and by each body's current warmth (oxytocin/CARE up, amygdala
// down), plus a little noise. A warm beat thaws both bodies; a cold one stings.
//
// Pure & deterministic: no DOM/THREE/render, no Math.random. Every stochastic
// choice is drawn from the rng the caller threads in, so a run is reproducible.
// =============================================================================

import type { Character } from '../mind/character';
import type { Ledger } from '../core/types';
import { newRelationship, updateBond } from './relationship';
import { computeCoreAffect } from '../mind/soma';
import { sharedInterests } from './interests';
import { socialReward, socialThreat, somaWarmth, bigFiveCompat } from './socialaffect';
import { clamp } from '../core/util/num';

export interface Conversation {
  a: Character; b: Character;
  topic: string;          // a shared interest, or 'small talk'
  beatsLeft: number;
  done: boolean;
  lastWarm: number;       // [-1,1] warmth of the most recent beat
  lastUtterance: string;  // a short first-person line for a speech bubble
  step(dtHours: number): void;  // fold ONE beat into both characters
  toJSON(): ConversationJSON;
}

export interface ConversationJSON {
  topic: string; beatsLeft: number; done: boolean; lastWarm: number; lastUtterance: string;
  compat: number; aId: string; bId: string; clock: number;
}

/** rebuild a conversation bound to already-restored Characters + ledgers + the Town rng. */
export function restoreConversation(
  a: Character, b: Character, ledgerAB: Ledger, ledgerBA: Ledger, rng: () => number, j: ConversationJSON,
): Conversation {
  const c = new TwoBodyConversation(a, b, j.topic, j.beatsLeft, j.compat, ledgerAB, ledgerBA, j.aId, j.bId, j.clock, rng);
  c.done = j.done; c.lastWarm = j.lastWarm; c.lastUtterance = j.lastUtterance;
  return c;
}

/**
 * Decide whether a conversation is worth starting between two characters the
 * caller has already found co-located and free to talk, and if so build it. The
 * basis is a shared interest OR a roll for small talk; the odds rise with
 * Big-Five compatibility and with any standing rapport already in the ledgers.
 * `extraTopics` are the currently-hot civic topics (gov.hotTopics) merged into
 * the shared-candidate pool — they widen WHAT gets talked about, never WHETHER
 * a conversation sparks. Returns the live Conversation, or null.
 */
export function maybeStartConversation(
  a: Character, b: Character,
  aInterests: string[], bInterests: string[],
  ledgerAB: Ledger, ledgerBA: Ledger,   // a's ledger-of-b, and b's ledger-of-a
  clock: number, rng: () => number,
  extraTopics: string[] = [],
): Conversation | null {
  const shared = sharedInterests(aInterests, bInterests);
  const compat = compatibility(a, b);           // [0,1]
  const bId = b.profile.id, aId = a.profile.id;
  const rapport = 0.5 * ((ledgerAB.get(bId)?.affection ?? 0) + (ledgerBA.get(aId)?.affection ?? 0));

  // disposition to talk: compatible, already-warm pairs strike up easily; a shared
  // interest is a strong pull; strangers with nothing in common seldom bother.
  let p = 0.12 + 0.4 * compat + 0.25 * Math.max(0, rapport);
  if (shared.length > 0) p += 0.3;
  p = clamp(p, 0.02, 0.97);
  if (rng() >= p) return null;

  // topic: a random draw from real shared interests ∪ hot civic topics, else
  // lower-warmth small talk. Civic topics ride the same channel — no new layer.
  const pool = [...shared, ...extraTopics];
  const topic = pool.length ? pool[Math.floor(rng() * pool.length)] : 'small talk';
  const beatsLeft = 4 + Math.floor(rng() * 6);  // 4..9 beats

  // ensure each side has a ledger entry for the other, keyed by profile.id.
  if (!ledgerAB.has(bId)) ledgerAB.set(bId, newRelationship(bId, seedFromId(bId), b.profile.name));
  if (!ledgerBA.has(aId)) ledgerBA.set(aId, newRelationship(aId, seedFromId(aId), a.profile.name));

  return new TwoBodyConversation(a, b, topic, beatsLeft, compat, ledgerAB, ledgerBA, aId, bId, clock, rng);
}

// ---- the conversation object ------------------------------------------------

class TwoBodyConversation implements Conversation {
  readonly a: Character;
  readonly b: Character;
  topic: string;
  beatsLeft: number;
  done = false;
  lastWarm = 0;
  lastUtterance: string;

  private readonly compat: number;
  private readonly ledgerAB: Ledger;
  private readonly ledgerBA: Ledger;
  private readonly aId: string;
  private readonly bId: string;
  private readonly rng: () => number;
  private clock: number;         // advanced by dtHours each beat (memory timestamps)
  private readonly isShared: boolean;

  constructor(
    a: Character, b: Character, topic: string, beatsLeft: number, compat: number,
    ledgerAB: Ledger, ledgerBA: Ledger, aId: string, bId: string,
    clock: number, rng: () => number,
  ) {
    this.a = a; this.b = b;
    this.topic = topic;
    this.beatsLeft = beatsLeft;
    this.compat = compat;
    this.ledgerAB = ledgerAB;
    this.ledgerBA = ledgerBA;
    this.aId = aId; this.bId = bId;
    this.clock = clock;
    this.rng = rng;
    // civic topics aren't hobbies: they enter the pool but carry no shared-joy warmth.
    this.isShared = topic !== 'small talk' && !topic.startsWith('civic:');
    const label = topicLabel(topic);
    this.lastUtterance = this.isShared ? `Wait — you're into ${label}?`
      : topic.startsWith('civic:') ? `Have you been thinking about ${label} too?` : 'Oh, hey there.';
  }

  step(dtHours: number): void {
    if (this.done) return;
    const a = this.a, b = this.b, rng = this.rng;
    const relAB = this.ledgerAB.get(this.bId)!;
    const relBA = this.ledgerBA.get(this.aId)!;

    // --- per-beat warmth in [-1,1] --------------------------------------------
    let warm = 0.4;                              // a hopeful baseline
    warm += 0.5 * (this.compat - 0.5);           // Big-Five compatibility (A,E warm; N cools)
    if (this.isShared) warm += 0.3;              // a genuinely shared interest
    warm += 0.3 * relAB.affection;               // standing rapport (a's affection for b)
    warm += 0.15 * somaWarmth(a.soma);           // a's body: oxytocin/CARE up & amygdala down warms
    warm += 0.15 * somaWarmth(b.soma);           // b's body likewise
    warm += 0.2 * (rng() - 0.5);                 // a little noise
    warm = clamp(warm, -1, 1);

    // --- fold the beat into BOTH full somas -----------------------------------
    const v0a = a.soma.valence, v0b = b.soma.valence;
    if (warm > 0) {
      socialReward(a.soma, warm);                // a warm exchange thaws both bodies
      socialReward(b.soma, warm);
    } else {
      socialThreat(a.soma, warm);                // an awkward beat nudges threat up mildly
      socialThreat(b.soma, warm);
    }
    computeCoreAffect(a.soma, a.params);
    computeCoreAffect(b.soma, b.params);
    const dA = a.soma.valence - v0a;
    const dB = b.soma.valence - v0b;

    // --- move the two-sided ledger from the reciprocated deltas ---------------
    updateBond(relAB, a.soma, b.soma, dA, dB, 0.4, dtHours);
    updateBond(relBA, b.soma, a.soma, dB, dA, 0.4, dtHours);

    // --- encode the moment in BOTH memory graphs ------------------------------
    this.clock += dtHours;
    const feel = warm > 0.2 ? 'good' : warm < -0.1 ? 'awkward' : 'ok';
    const label = topicLabel(this.topic);
    a.memory.add(this.clock, `Talked with ${b.profile.name} about ${label}; it felt ${feel}.`, a.soma);
    b.memory.add(this.clock, `Talked with ${a.profile.name} about ${label}; it felt ${feel}.`, b.soma);

    // --- surface state for the caller / speech bubble -------------------------
    this.lastWarm = warm;
    this.lastUtterance = this.topic.startsWith('civic:')
      ? civicUtterance(warm, label, rng)
      : utteranceFor(warm, label, this.isShared, rng);
    this.beatsLeft -= 1;
    this.done = this.beatsLeft <= 0;
  }

  toJSON(): ConversationJSON {
    return { topic: this.topic, beatsLeft: this.beatsLeft, done: this.done, lastWarm: this.lastWarm,
      lastUtterance: this.lastUtterance, compat: this.compat, aId: this.aId, bId: this.bId, clock: this.clock };
  }
}

// ---- helpers ----------------------------------------------------------------

/** Big-Five pair compatibility in [0,1] — delegates to the shared metric. */
function compatibility(a: Character, b: Character): number {
  return bigFiveCompat(a.profile.bigFive, b.profile.bigFive);
}

/** how a civic topic slug reads in prose (memories, utterances). Raw interests
 *  pass through untouched; the raw 'civic:<slug>' string stays gov's key. */
const CIVIC_LABEL: Record<string, string> = {
  'civic:jobs': 'the work drying up', 'civic:rent': 'the rents',
  'civic:prices': 'prices climbing', 'civic:wages': 'what work pays here',
  'civic:transit': 'getting across town', 'civic:assembly': 'the assembly',
  'civic:charter': 'the charter', 'civic:election': 'the election',
  'civic:recall': 'the recall',
};
export function topicLabel(topic: string): string {
  return CIVIC_LABEL[topic] ?? (topic.startsWith('civic:') ? 'what this town is failing at' : topic);
}

/** A short first-person line, varying by warmth and topic. Deterministic in rng. */
function utteranceFor(warm: number, topic: string, isShared: boolean, rng: () => number): string {
  if (isShared) {
    if (warm > 0.5) return pick(rng, [
      `Oh you like ${topic} too? We should do that together sometime.`,
      `Honestly I could talk about ${topic} all day.`,
      `No way — ${topic} is my whole thing.`,
    ]);
    if (warm > 0.1) return pick(rng, [
      `Oh, you like ${topic} too?`,
      `I've been getting really into ${topic} lately.`,
      `${topic}, huh? Same here, actually.`,
    ]);
    if (warm > -0.1) return pick(rng, [
      `Yeah, ${topic}'s alright I suppose.`,
      `I dabble in ${topic}, nothing serious.`,
    ]);
    return pick(rng, [
      `Hm, maybe ${topic} just isn't landing today.`,
      `I don't have much to say about ${topic} right now.`,
    ]);
  }
  if (warm > 0.4) return pick(rng, [`Nice to actually chat for a bit.`, `Good to see a friendly face.`]);
  if (warm > 0.1) return pick(rng, [`So, how's your day going?`, `Bit of a quiet one today, isn't it?`]);
  if (warm > -0.1) return pick(rng, [`Anyway.`, `Right, well.`]);
  return pick(rng, [`I should probably get going.`, `Well — this is a little awkward.`]);
}

/** civic beats read as neighbours comparing notes, warm or wary. */
function civicUtterance(warm: number, label: string, rng: () => number): string {
  if (warm > 0.3) return pick(rng, [
    `It's not just you — everyone I ask is carrying ${label}.`,
    `Honestly, if enough of us said it out loud, ${label} might actually move.`,
  ]);
  if (warm > -0.1) return pick(rng, [
    `Yeah, ${label}… I don't know what anyone does about that.`,
    `${label.charAt(0).toUpperCase()}${label.slice(1)} — same everywhere, I suppose.`,
  ]);
  return pick(rng, [
    `I'd rather not get pulled into anything about ${label}, honestly.`,
    `People keep on about ${label}; I keep my head down.`,
  ]);
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

/** Deterministic seed from a character id (FNV-1a) for a fresh ledger entry. */
function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
