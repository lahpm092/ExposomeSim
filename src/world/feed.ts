// =============================================================================
// feed.ts — the public social network (the ONE phone app): short text posts,
// replies forming threads. NOTHING about the content is scripted:
//   · WHAT a member posts EMERGES from their soma mood + a recent salient memory
//     + a seeded interest (composed from readEmotion + memgraph, mirroring how
//     conversation.ts picks an utterance and fallbackResponse picks a line);
//   · WHO likes/replies EMERGES from interest overlap + the relationship ledger +
//     Big-Five compatibility (the SAME resonance metrics that spark a hallway chat);
//   · being replied-to / liked feeds BACK — it raises the poster's oxytocin/opioid/
//     da_meso and eases their PANIC_GRIEF, so being LISTENED-TO becomes a sense of
//     belonging and purpose, while posting into the void does almost nothing.
//
// The conversion of received contact into felt warmth is GATED by theory-of-mind
// (params.neuro.theoryOfMind): a high-ToM mind turns a warm reply into real
// connection; a low-ToM mind barely registers it and is left driving on the hollow
// dopamine/habit channel of phone.ts alone — so the connection/purpose gradient the
// world exhibits is an emergent consequence of neurobiology, not an assignment.
//
// Only members who are ON THE PHONE this beat author, scroll, or cash in their
// notifications — the app is the sole reason a phone is out, so all network
// activity is downstream of the phone-pickup hazard.
//
// PURE & deterministic: no DOM/THREE, no Math.random. Every draw uses the rng.
// =============================================================================
import type { Character } from '../mind/character';
import type { Ledger, FeedPost, FeedComment, FeedView } from '../core/types';
import { newRelationship, updateBond } from './relationship';
import { socialReward, socialThreat, somaWarmth, bigFiveCompat } from './socialaffect';
import { sharedInterests } from './interests';
import { clamp } from '../core/util/num';

/** what the caller hands the feed for each participant this beat. */
export interface FeedMember {
  idx: number;
  id: string;
  name: string;
  hatColor: number;
  ch: Character;          // soma + memory (shared object — writes land on the real substrate)
  ledger: Ledger;         // this member's relationship map, keyed by other member id
  interests: string[];
  onPhone: boolean;       // only an on-phone member authors / scrolls / sees notifications
  tom: number;            // theory-of-mind ∈ ~[0.05,1] — the connection-conversion gain
}

const MAX_POSTS = 60;         // ring buffer
const MAX_COMMENTS = 8;       // per post
const FEED_BEAT = 0.12;       // sim-hours between feed beats (mirrors society EVENT_INT)
const POST_RATE = 0.7;        // scales the per-beat post hazard
const POST_COOLDOWN = 2.0;    // sim-hours between one member's posts
const LIKE_TH = 0.58;         // resonance to like
const REPLY_TH = 0.92;        // resonance to reply
const REPLIES_PER_SESSION = 2;
const FRESH_WINDOW = 6;       // sim-hours a post is "fresh" enough to surface while scrolling
const K_LIKE = 0.05;          // a like's warmth to the author
const K_REPLY = 0.22;         // a reply validates far more than a like
const G_FEED = 1.0;           // scale of the cashed-in feed reward

let _fid = 700000;
const fid = (p: string) => `${p}${(_fid++).toString(36)}`;

interface PostRec extends FeedPost { cashedLikes: number; }

export class PublicFeed {
  private posts: PostRec[] = [];
  private cooldown = new Map<string, number>();  // member id → sim-hours until next post
  private beatAcc = 0;
  private postCount = 0;
  private belongingBump = new Map<string, number>(); // member id → belonging delta this drain window

  /** advance the feed. Call once per society tick with the current participants. */
  step(dt: number, env: { clock: number; rng: () => number }, members: FeedMember[]): void {
    for (const [id, cd] of this.cooldown) this.cooldown.set(id, Math.max(0, cd - dt));
    this.beatAcc += dt;
    if (this.beatAcc < FEED_BEAT) return;
    const beat = this.beatAcc; this.beatAcc = 0;
    const rng = env.rng, clock = env.clock;

    const onPhone = members.filter((m) => m.onPhone);
    if (!onPhone.length) return;

    // 1) cash in each on-phone member's pending notifications (they see them now).
    for (const m of onPhone) this.cashIn(m);

    // 2) authoring — an on-phone member with a strong expressive urge posts.
    for (const m of onPhone) {
      if ((this.cooldown.get(m.id) ?? 0) > 0) continue;
      const urge = this.expressiveUrge(m);
      if (rng() < urge * beat * POST_RATE * 8) {          // ×8: beat≈0.12h, keep the feed alive
        this.authorPost(m, clock, rng);
        this.cooldown.set(m.id, POST_COOLDOWN);
      }
    }

    // 3) scrolling — each on-phone member engages a few fresh posts by others.
    for (const m of onPhone) {
      const urge = this.scrollUrge(m);
      if (rng() >= clamp(urge, 0, 1)) continue;
      let replyBudget = REPLIES_PER_SESSION;
      const fresh = this.posts.filter((p) => p.authorId !== m.id && clock - p.t < FRESH_WINDOW);
      // most-recent first, look at a handful
      for (const p of fresh.slice(-6).reverse()) {
        const author = members.find((x) => x.id === p.authorId);
        const res = this.resonance(m, p, author, clock);
        if (res > LIKE_TH && !p.likes.includes(m.id)) p.likes.push(m.id);
        if (res > REPLY_TH && replyBudget > 0 && author) {
          this.reply(m, p, author, clock, rng);
          replyBudget--;
        }
      }
    }
  }

  // ---- authoring ------------------------------------------------------------
  private authorPost(m: FeedMember, clock: number, rng: () => number): void {
    const s = m.ch.soma;
    const readout = m.ch.readout();
    // topic: prefer a recalled memory that is actually ABOUT one of their interests,
    // so the post reads as a first-person thought, not a leaked second-person work log.
    const mem = m.ch.recall(m.interests.join(' '), 3).find((x) => /love|really|my|paint|read|game|match|book/i.test(x.text));
    const topic = pick(rng, m.interests.length ? m.interests : ['today']);
    const text = composePost(readout.label, s.valence, s.arousal, topic, mem?.text, rng);
    const post: PostRec = {
      id: fid('p'), authorId: m.id, authorName: m.name, hatColor: m.hatColor,
      t: clock, topic, text, valence: clamp(s.valence, -1, 1),
      likes: [], comments: [], cashedLikes: 0,
    };
    this.posts.push(post);
    this.postCount++;
    if (this.posts.length > MAX_POSTS) {
      const dropped = this.posts.shift();
      if (dropped) this.cashInPost(this.findMemberless(dropped)); // best-effort: nothing if author absent
    }
    // the tiny relief of getting it off your chest (too small to replace being heard)
    s.da_meso = clamp(s.da_meso + 0.03, 0, 4);
    s.arousal = clamp(s.arousal + 0.02, 0, 1);
  }

  private reply(reader: FeedMember, post: PostRec, author: FeedMember, clock: number, rng: () => number): void {
    if (post.comments.length >= MAX_COMMENTS) return;
    const shared = sharedInterests(reader.interests, [post.topic]).length > 0;
    const aff = reader.ledger.get(author.id)?.affection ?? 0;
    const warm = clamp(
      0.35 + 0.4 * (bigFiveCompat(reader.ch.profile.bigFive, author.ch.profile.bigFive) - 0.5) +
      0.3 * (shared ? 1 : 0) + 0.3 * aff + 0.2 * somaWarmth(reader.ch.soma) + 0.2 * (rng() - 0.5),
      -1, 1,
    );
    const c: FeedComment = {
      id: fid('c'), authorId: reader.id, authorName: reader.name, t: clock,
      text: composeReply(warm, post.topic, rng), warmth: warm,
    };
    post.comments.push(c);
    // giving support feels good to the replier (prosocial reward); lay a memory + bond.
    if (warm > 0) {
      reader.ch.soma.CARE = clamp(reader.ch.soma.CARE + 0.04 * warm, 0, 1);
      reader.ch.soma.oxytocin = clamp(reader.ch.soma.oxytocin + 0.03 * warm, 0, 4);
    }
    reader.ch.memory.add(clock, `Replied to ${author.name} about ${post.topic} online; it felt ${warm > 0.2 ? 'good' : 'flat'}.`, reader.ch.soma);
    // move the two-sided ledger a little from this online contact.
    this.ensureBond(reader.ledger, author.id, author.name);
    this.ensureBond(author.ledger, reader.id, reader.name);
    const rel = reader.ledger.get(author.id)!;
    updateBond(rel, reader.ch.soma, author.ch.soma, 0.15 * warm, 0.1 * warm, 0.2, 0.05);
  }

  // ---- engagement cash-in (the "being listened to" reward, ToM-gated) --------
  private cashIn(m: FeedMember): void {
    let bump = 0;
    for (const p of this.posts) {
      if (p.authorId !== m.id) continue;
      const newLikes = p.likes.length - p.cashedLikes;
      let replyWarm = 0, uncashed = 0;
      for (const c of p.comments as (FeedComment & { cashed?: boolean })[]) {
        if (c.cashed) continue;
        c.cashed = true; uncashed++; replyWarm += c.warmth;
      }
      if (newLikes <= 0 && uncashed === 0) continue;
      p.cashedLikes = p.likes.length;
      const value = K_LIKE * newLikes + K_REPLY * replyWarm;
      // connection conversion is gated by theory-of-mind: the same likes/replies
      // land as real warmth for a high-ToM mind, and barely register for a low one.
      const felt = value * m.tom;
      if (felt > 0) {
        socialReward(m.ch.soma, clamp(felt * G_FEED, 0, 1));
        m.ch.soma.PANIC_GRIEF = clamp(m.ch.soma.PANIC_GRIEF * (1 - 0.25 * clamp(felt, 0, 1)), 0, 1);
        bump += felt;
      } else if (felt < 0) {
        socialThreat(m.ch.soma, clamp(felt, -1, 0));
        bump += felt;
      }
    }
    if (bump !== 0) this.belongingBump.set(m.id, (this.belongingBump.get(m.id) ?? 0) + bump);
  }

  private cashInPost(_m: FeedMember | null): void { /* no-op safety for dropped posts */ }
  private findMemberless(_p: PostRec): FeedMember | null { return null; }

  // ---- emergent engagement scoring -----------------------------------------
  private resonance(reader: FeedMember, post: PostRec, author: FeedMember | undefined, clock: number): number {
    const interestHit = sharedInterests(reader.interests, [post.topic]).length > 0 ? 1 : 0.2;
    const aff = author ? Math.max(0, reader.ledger.get(author.id)?.affection ?? 0) : 0;
    const compat = author ? bigFiveCompat(reader.ch.profile.bigFive, author.ch.profile.bigFive) : 0.5;
    const moodFit = 1 - Math.abs(reader.ch.soma.valence - post.valence) / 2;
    const recency = Math.pow(0.9, Math.max(0, clock - post.t));
    return 0.9 * interestHit + 0.7 * aff + 0.5 * (compat - 0.5) + 0.4 * moodFit + 0.3 * recency;
  }

  private expressiveUrge(m: FeedMember): number {
    const s = m.ch.soma;
    const b = m.ch.profile.bigFive;
    const loneliness = clamp(0.6 * s.PANIC_GRIEF + 0.4 * clamp(1 - s.oxytocin, 0, 1), 0, 1);
    const intensity = clamp(0.5 * Math.abs(s.valence) + 0.5 * s.arousal, 0, 1);
    const fresh = m.ch.memory.recent(1)[0]?.salience ?? 0;
    const trait = 1 / (1 + Math.exp(-(0.6 * b.E - 0.3 * b.C + 0.3 * b.O)));
    return clamp(0.12 + 0.4 * loneliness + 0.3 * intensity + 0.25 * fresh + 0.2 * clamp(s.SEEKING, 0, 1), 0, 1) * trait;
  }

  private scrollUrge(m: FeedMember): number {
    const s = m.ch.soma;
    const loneliness = clamp(0.6 * s.PANIC_GRIEF + 0.4 * clamp(1 - s.oxytocin, 0, 1), 0, 1);
    return clamp(0.25 + 0.4 * loneliness + 0.35 * clamp(s.SEEKING, 0, 1), 0, 1);
  }

  private ensureBond(ledger: Ledger, id: string, name: string): void {
    if (!ledger.has(id)) ledger.set(id, newRelationship(id, seedFromId(id), name));
  }

  // ---- accessors ------------------------------------------------------------
  /** consume + reset the accumulated belonging bump for a member (Town reads Mara's). */
  takeBelonging(id: string): number {
    const v = this.belongingBump.get(id) ?? 0;
    this.belongingBump.delete(id);
    return v;
  }

  view(limit = 12): FeedView {
    const posts = this.posts.slice(-limit).reverse().map((p) => ({
      id: p.id, authorId: p.authorId, authorName: p.authorName, hatColor: p.hatColor,
      t: p.t, topic: p.topic, text: p.text, valence: p.valence,
      likes: p.likes.slice(), comments: p.comments.map((c) => ({ ...c })),
    }));
    return { posts, postCount: this.postCount };
  }

  // ---- persistence ----------------------------------------------------------
  toJSON(): FeedJSON {
    return {
      posts: this.posts, cooldown: [...this.cooldown.entries()],
      beatAcc: this.beatAcc, postCount: this.postCount,
      belongingBump: [...this.belongingBump.entries()],
    };
  }
  loadJSON(j: FeedJSON): void {
    this.posts = j.posts as PostRec[];
    this.cooldown = new Map(j.cooldown);
    this.beatAcc = j.beatAcc; this.postCount = j.postCount;
    this.belongingBump = new Map(j.belongingBump);
  }
}

export interface FeedJSON {
  posts: (FeedPost & { cashedLikes: number })[];
  cooldown: [string, number][];
  beatAcc: number;
  postCount: number;
  belongingBump: [string, number][];
}

// ---- text composition (deterministic templates; LLM-optional later) ---------
function composePost(label: string, valence: number, arousal: number, topic: string, mem: string | undefined, rng: () => number): string {
  const memHint = mem ? cleanMem(mem) : '';
  if (valence < -0.3) return pick(rng, [
    `Rough one today. ${cap(topic)} is the only thing keeping me steady.`,
    `Feeling pretty ${label}. ${memHint || 'Some days just weigh more.'}`,
    `Can't shake this ${label} mood. Anyone else just… tired?`,
  ]);
  if (valence > 0.3) return pick(rng, [
    `Honestly a good day. Got lost in ${topic} again and it was perfect.`,
    `Feeling ${label}. ${memHint || `${cap(topic)} always sorts my head out.`}`,
    `${cap(topic)}. That's the post. That's the whole feeling.`,
  ]);
  if (arousal > 0.6) return pick(rng, [
    `Brain going a mile a minute about ${topic} rn.`,
    `Ok but does anyone actually want to talk ${topic} or is it just me`,
  ]);
  return pick(rng, [
    `Thinking about ${topic} today.`,
    memHint || `Quiet one. Might get into ${topic} later.`,
    `${cap(topic)} thoughts, on and off all day.`,
  ]);
}

function composeReply(warm: number, topic: string, rng: () => number): string {
  if (warm > 0.5) return pick(rng, [`Yes!! ${cap(topic)} people unite 🙌`, `This is so real. We should talk ${topic} sometime.`, `Ugh I feel this. Here if you need to vent.`]);
  if (warm > 0.1) return pick(rng, [`Same honestly.`, `Oh nice, I'm into ${topic} too.`, `Hope the day turns around.`]);
  if (warm > -0.1) return pick(rng, [`Huh. Fair enough.`, `I guess.`]);
  return pick(rng, [`Eh, hard disagree.`, `Not really seeing it tbh.`]);
}

function cleanMem(text: string): string {
  let t = text.split('—')[0].split(';')[0].trim();
  t = t.replace(/^You\b/, 'I').replace(/\byou\b/g, 'I').replace(/\byour\b/g, 'my'); // 2nd→1st person
  return t.length > 90 ? t.slice(0, 88) + '…' : t;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function pick<T>(rng: () => number, xs: T[]): T { return xs[Math.floor(rng() * xs.length)]; }
function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// module id-counter accessors (for save/load reconciliation)
export function getFeedSeq(): number { return _fid; }
export function setFeedSeq(n: number): void { _fid = n; }
