// =============================================================================
// roster.ts — the CAST of ten fully-simulated characters. Each entry pairs a
// psychologically-vivid Profile (→ its own SomaParams via deriveParams, its own
// soma, its own memory GRAPH) with a role, a home flat, a hat colour, and a set
// of everyday INTERESTS. The interests are seeded into each character's memory
// graph (see sim/interests.ts) so that shared ones can spark an unscripted
// conversation when two of them are near and both are disposed to talk.
//
//   fast-food venue ("The Counter"): Mara (cashier) · Gus (boss) · Rosa (cleaner)
//   office:                          Dana (boss) · six employees
//
// Nothing about their day is scheduled here — this is only WHO they are. Where
// they go and what they do emerges in town.ts from each one's needs + soma +
// work-psychology, exactly as Mara's day already emerges from the arbiter.
// =============================================================================
import type { Profile, BigFive, Attachment, RoleKind, Workplace, Genotype } from '../types';
import { CASHIER_PROFILE, sampleProfile } from './params';

export interface RosterEntry {
  profile: Profile;
  role: RoleKind;
  workplace: Workplace;
  hatColor: number;       // distinct per agent — the coloured hat
  interests: string[];
  homeIndex: number;      // which apartment flat (0..N)
  officeFloor?: number;   // office agents only: which office storey (1..3) their desk is on
}

// ---------------------------------------------------------------------------
// OFFICE FLOOR PLAN — the single source of truth shared by the geometry
// (render/office.ts builds desks in exactly this order) and the desk assignment
// (below, consumed by the Society + the body router). Floor 1 keeps the original
// six offices + the boss's corner room; floors 2 and 3 add four desks each, so the
// eight new hires sit on two storeys separate from the original crew.
// ---------------------------------------------------------------------------
export interface OfficeFloorSpec { floor: number; workerDesks: number; hasBoss: boolean; }
export const OFFICE_FLOORS: OfficeFloorSpec[] = [
  { floor: 1, workerDesks: 6, hasBoss: true },
  { floor: 2, workerDesks: 4, hasBoss: false },
  { floor: 3, workerDesks: 4, hasBoss: false },
];
/** hallway gathering spots per office floor (shared by geometry + the Society's
 *  wander/matchmake so a station index maps to the same spot on each side). */
export const OFFICE_COMMONS_PER_FLOOR = 4;

export interface DeskSlot { index: number; floor: number; isBoss: boolean; }

/** The ordered desk slots, EXACTLY as render/office.ts emits them: for each floor
 *  in order, its worker desks, then (if present) its boss desk. The global index is
 *  the position in this list, so desks[i].index === i on both sides. */
export function officeDeskSlots(): DeskSlot[] {
  const slots: DeskSlot[] = [];
  let idx = 0;
  for (const f of OFFICE_FLOORS) {
    for (let i = 0; i < f.workerDesks; i++) slots.push({ index: idx++, floor: f.floor, isBoss: false });
    if (f.hasBoss) slots.push({ index: idx++, floor: f.floor, isBoss: true });
  }
  return slots;
}

// ---- profile authoring -----------------------------------------------------
interface Over {
  name: string; age: number; role: string; backstory: string; goals: string[];
  bigFive: BigFive; attachment: Attachment; aceScore?: number; ses?: number;
  stressors?: string[]; mems?: string[];
  // optional genotype overrides — used to place a new hire deliberately on the
  // ADHD (DRD4/DAT/DRD2/COMT) or autism (OXTR) axis while keeping the rest sampled.
  geno?: Partial<Genotype>;
}

/** Draw a valid, individualized base profile from a seed, then overwrite the
 *  psychologically-salient fields by hand. Keeps genotypes valid + varied while
 *  letting us author temperament, role and formative memory precisely. */
function author(seed: number, o: Over): Profile {
  const base = sampleProfile(seed);
  return {
    ...base,
    id: `agent-${o.name.toLowerCase().replace(/[^a-z]/g, '')}`,
    name: o.name,
    age: o.age,
    role: o.role,
    backstory: o.backstory,
    goals: o.goals,
    bigFive: o.bigFive,
    genotype: o.geno ? { ...base.genotype, ...o.geno } : base.genotype,
    experiosome: {
      ...base.experiosome,
      attachment: o.attachment,
      aceScore: o.aceScore ?? base.experiosome.aceScore,
      ses: o.ses ?? base.experiosome.ses,
      chronicStressors: o.stressors ?? base.experiosome.chronicStressors,
      formativeMemories: o.mems ?? base.experiosome.formativeMemories,
    },
  };
}

// distinct, legible hat colours (they pop against the ink-on-sepia world).
const HAT = {
  crimson: 0xb23020, orange: 0xc8791f, teal: 0x2f8f83, purple: 0x6d3fb0,
  green: 0x3f8f4a, steel: 0x3f6fb0, gold: 0xc9a227, magenta: 0xb0407f,
  cyan: 0x2fa3b0, brown: 0x8a5a2b,
  // the eight new hires
  indigo: 0x4636a8, coral: 0xd06a4f, olive: 0x7c7a2c, rose: 0xc65a86,
  slate: 0x556070, amber: 0xd39a1e, jade: 0x2f8f5f, plum: 0x884a8a,
} as const;

// ---- the ten -----------------------------------------------------------------
export const ROSTER: RosterEntry[] = [
  // 0 — Mara: the protagonist (hand-authored in params.ts), cashier at the counter.
  {
    profile: CASHIER_PROFILE,
    role: 'cashier', workplace: 'foodcourt', hatColor: HAT.crimson,
    interests: ['cooking', 'books', 'music'], homeIndex: 0,
  },
  // 1 — Gus: the counter's boss. Blunt, steady, exacting; keeps the line moving.
  {
    profile: author(1201, {
      name: 'Gus Hale', age: 47, role: 'shift manager',
      backstory: 'Gus runs the burger counter. Twenty years in fast food have made him blunt and unflappable; he rides his crew hard but backs them when it counts.',
      goals: ['keep the counter running clean', 'hit the numbers', 'no walkouts on my shift'],
      bigFive: { O: 0.0, C: 1.4, E: 0.6, A: 0.1, N: 0.3 }, attachment: 'secure',
      aceScore: 1, ses: 0.1, stressors: ['regional targets'],
      mems: ['I came up working every station myself.', 'A crew that respects the line runs itself.', 'I follow football every weekend without fail.'],
    }),
    role: 'food_boss', workplace: 'foodcourt', hatColor: HAT.orange,
    interests: ['football', 'history', 'coffee'], homeIndex: 1,
  },
  // 2 — Rosa: the venue's cleaner. Diligent and warm; her body tires by evening.
  {
    profile: author(1202, {
      name: 'Rosa Vidal', age: 56, role: 'cleaner',
      backstory: 'Rosa keeps the venue spotless on the evening clean. Her knees ache after hours on her feet; she takes her breaks in the little supply room with a strong coffee and a sit-down.',
      goals: ['leave the floor spotless', 'rest my legs when they go', 'be done in good time'],
      bigFive: { O: 0.4, C: 1.2, E: 0.1, A: 1.2, N: 0.6 }, attachment: 'anxious',
      aceScore: 2, ses: -0.6, stressors: ['aching knees', 'long evenings'],
      mems: ['A clean floor is a kind of dignity.', 'My legs tell me when I have done enough.', 'I love tending my little balcony garden.'],
    }),
    role: 'cleaner', workplace: 'foodcourt', hatColor: HAT.teal,
    interests: ['gardening', 'coffee', 'music'], homeIndex: 2,
  },
  // 3 — Dana: the office boss. Charismatic, driven, a touch self-important.
  {
    profile: author(1203, {
      name: 'Dana Okafor', age: 44, role: 'office director',
      backstory: 'Dana runs the office from the big corner room. Quick, charming and impatient, she measures the day in wins and expects the floor to keep pace.',
      goals: ['ship the quarter', 'keep the team sharp', 'be seen to lead'],
      bigFive: { O: 0.7, C: 1.1, E: 1.3, A: -0.2, N: 0.4 }, attachment: 'avoidant',
      aceScore: 1, ses: 0.9, stressors: ['the board', 'the quarter'],
      // The ONLY authored company goal. It lives here, in Dana's memory graph, as
      // prose — the machine-readable theme priorities (INITIAL_THEMES) are just a
      // projection of it. From here the goal EVOLVES only as her memory does.
      mems: ['I built this team out of nothing.', 'Momentum is everything; do not lose it.', 'I unwind with long-distance travel and history podcasts.',
        'Our goal this quarter: ship the platform, win the enterprise clients, and keep the team sharp — growth follows if the product is right.'],
    }),
    role: 'office_boss', workplace: 'office', hatColor: HAT.purple,
    interests: ['travel', 'history', 'films'], homeIndex: 3, officeFloor: 1,
  },
  // 4 — Ivo: office. Laid-back, sociable; happiest talking football.
  {
    profile: author(1204, {
      name: 'Ivo Petrov', age: 29, role: 'analyst',
      backstory: 'Ivo does the numbers but would rather be talking about the weekend match. Easy company; drifts off-task the moment the room goes quiet.',
      goals: ['clear my tickets eventually', 'find someone to talk to', 'dodge Dana on a Monday'],
      bigFive: { O: 0.5, C: -0.3, E: 0.9, A: 0.6, N: -0.2 }, attachment: 'secure',
      aceScore: 0, ses: 0.2,
      mems: ['I never miss a match if I can help it.', 'Work goes faster when there is someone to talk to.', 'I got deep into a co-op game this month.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.green,
    interests: ['football', 'video games', 'coffee'], homeIndex: 4, officeFloor: 1,
  },
  // 5 — Lena: office. Introverted, creative; heads-down, anxious under scrutiny.
  {
    profile: author(1205, {
      name: 'Lena Sato', age: 33, role: 'designer',
      backstory: 'Lena designs with headphones on and a sketchbook to the side. She warms slowly but deeply, and frays when Dana hovers.',
      goals: ['make something good', 'not be watched while I do it', 'protect my quiet'],
      bigFive: { O: 1.2, C: 0.6, E: -0.6, A: 0.7, N: 0.6 }, attachment: 'anxious',
      aceScore: 2, ses: -0.1, stressors: ['being watched'],
      mems: ['I paint on my evenings; it is where I go quiet.', 'A good coffee and no one hovering — that is enough.', 'I read a novel a week.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.steel,
    interests: ['painting', 'books', 'coffee'], homeIndex: 5, officeFloor: 1,
  },
  // 6 — Marco: office. Gregarious; loves the match and a good lunch.
  {
    profile: author(1206, {
      name: 'Marco Ricci', age: 38, role: 'account lead',
      backstory: 'Marco knows everyone and everything happening in the building. Loud, generous, always mid-story; the desk is where he lands between conversations.',
      goals: ['keep the clients happy', 'organise the lunch', 'catch up on the match'],
      bigFive: { O: 0.2, C: 0.3, E: 1.1, A: 0.5, N: 0.1 }, attachment: 'secure',
      aceScore: 0, ses: 0.3,
      mems: ['A shared lunch fixes half the problems in an office.', 'I cook a proper Sunday ragu.', 'I follow the league table like scripture.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.gold,
    interests: ['football', 'cooking', 'films'], homeIndex: 6, officeFloor: 1,
  },
  // 7 — Priya: office. Thoughtful, warm; a reader and a traveller.
  {
    profile: author(1207, {
      name: 'Priya Nair', age: 31, role: 'researcher',
      backstory: 'Priya asks the question everyone forgot to. Measured and kind, she keeps a stack of half-read books and a list of places to go.',
      goals: ['get it right, not just fast', 'help whoever is stuck', 'plan the next trip'],
      bigFive: { O: 1.1, C: 0.8, E: 0.2, A: 0.9, N: 0.3 }, attachment: 'secure',
      aceScore: 1, ses: 0.2,
      mems: ['A book and a train window is my idea of peace.', 'I keep a list of every place I mean to see.', 'A film club night is the best kind of evening.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.magenta,
    interests: ['books', 'travel', 'films'], homeIndex: 7, officeFloor: 1,
  },
  // 8 — Ken: office. Chill; a gamer who keeps to himself but comes alive on a shared game.
  {
    profile: author(1208, {
      name: 'Ken Adeyemi', age: 27, role: 'developer',
      backstory: 'Ken ships code in long silent stretches, earbuds in. He runs cool and self-contained, but lights up the instant someone mentions a game he loves.',
      goals: ['get in the zone', 'ship it', 'find a co-op partner'],
      bigFive: { O: 0.6, C: -0.1, E: 0.5, A: 0.3, N: -0.4 }, attachment: 'avoidant',
      aceScore: 0, ses: 0.0,
      mems: ['The zone is where the day disappears.', 'I ride my bike everywhere, rain or shine.', 'A good co-op game is worth a late night.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.cyan,
    interests: ['video games', 'cycling', 'music'], homeIndex: 8, officeFloor: 1,
  },
  // 9 — Bea: office. Sensitive artist; deep feeler, easily rattled, quick to warm.
  {
    profile: author(1209, {
      name: 'Bea Lindqvist', age: 35, role: 'copywriter',
      backstory: 'Bea feels everything a little too much and writes the better for it. A hard word can sink her afternoon; a shared coffee can save it.',
      goals: ['find the right words', 'steady my own weather', 'be around warm people'],
      bigFive: { O: 1.3, C: 0.4, E: -0.3, A: 0.5, N: 0.8 }, attachment: 'anxious',
      aceScore: 3, ses: -0.3, stressors: ['a sharp word landing hard'],
      mems: ['I paint to let the day out.', 'A film and a good coffee can turn a whole mood.', 'Kind company is medicine to me.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.brown,
    interests: ['painting', 'films', 'coffee'], homeIndex: 9, officeFloor: 1,
  },

  // ===========================================================================
  // THE EIGHT NEW HIRES — four on floor 2, four on floor 3 (both storeys separate
  // from the original crew on floor 1). Genotypes are nudged onto the ADHD axis
  // (DRD4 7R · DAT1 · DRD2 A1 · COMT) or the autism axis (OXTR A) so a real spread
  // of phone-pull, task-switching and social-connection capacity EMERGES — nothing
  // about their behaviour is scripted; only who they are is authored here. Team and
  // desk are assigned below; team membership deliberately SPANS floors.
  // ---------------------------------------------------------------------------
  // 10 — Theo: floor 2. Restless, novelty-hungry, phone-magnetic (high-ADHD axis).
  {
    profile: author(1210, {
      name: 'Theo Marsh', age: 26, role: 'growth analyst',
      backstory: 'Theo has nine tabs open and a phone face-up on the desk. Quick and full of ideas, he starts three things for every one he finishes, and the moment a task goes dull his hand drifts to the screen.',
      goals: ['ship something today, anything', 'chase the interesting thread', 'not get bored'],
      bigFive: { O: 1.0, C: -1.1, E: 1.0, A: 0.3, N: 0.4 }, attachment: 'secure',
      aceScore: 1, ses: 0.1,
      geno: { DRD4_7R: 2, DAT1_VNTR: 2, DRD2_Taq1A: 1, COMT_Met: 1 },
      mems: ['I get my best ideas at 2am and forget them by nine.', 'A new toy beats a finished chore every time.', 'I follow six leagues and can name every transfer.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.indigo,
    interests: ['football', 'video games', 'music'], homeIndex: 10, officeFloor: 2,
  },
  // 11 — Wren: floor 2. Quiet, literal, deep focus; reads intent poorly (autism axis).
  {
    profile: author(1211, {
      name: 'Wren Oduya', age: 30, role: 'systems engineer',
      backstory: 'Wren builds flawless systems in long silent hours and finds the small talk around them baffling. Sarcasm sails past; a raised eyebrow means nothing. Given a clear spec she is the best on the floor; given a hint she is lost.',
      goals: ['get the spec exactly right', 'be left to concentrate', 'avoid the guessing game of moods'],
      bigFive: { O: 1.1, C: 1.3, E: -1.2, A: 0.1, N: 0.3 }, attachment: 'avoidant',
      aceScore: 1, ses: 0.0,
      geno: { OXTR_A: 2, DRD4_7R: 0, DAT1_VNTR: 1 },
      mems: ['I like rules that are actually written down.', 'People say one thing and mean another and expect me to know.', 'A clean architecture is the most beautiful thing I know.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.coral,
    interests: ['astronomy', 'video games', 'books'], homeIndex: 11, officeFloor: 2,
  },
  // 12 — Sol: floor 2. Warm connector, reads the room, everyone's confidant.
  {
    profile: author(1212, {
      name: 'Sol Rivera', age: 34, role: 'product lead',
      backstory: 'Sol notices when someone has gone quiet and asks the right question. Warm and quick to read a mood, Sol turns a stalled thread into a plan and makes people feel heard — the natural centre of any team.',
      goals: ['keep everyone rowing together', 'hear the person no one is hearing', 'turn talk into a decision'],
      bigFive: { O: 0.6, C: 0.7, E: 1.1, A: 1.2, N: -0.3 }, attachment: 'secure',
      aceScore: 0, ses: 0.3,
      geno: { OXTR_A: 0, DRD4_7R: 0 },
      mems: ['If you listen for a minute people tell you what they need.', 'A team is just a set of people who trust each other.', 'I cook for the whole floor when a launch lands.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.olive,
    interests: ['cooking', 'travel', 'films'], homeIndex: 12, officeFloor: 2,
  },
  // 13 — Nika: floor 2. Anxious perfectionist, mid-ADHD, doomscrolls under pressure.
  {
    profile: author(1213, {
      name: 'Nika Sorensen', age: 28, role: 'data scientist',
      backstory: 'Nika is sharp and thorough and never quite sure it is good enough. When the pressure climbs she reaches for the phone to escape the feeling, then hates that she did — a small loop she runs several times a day.',
      goals: ['get it right so no one can fault it', 'quiet the noise in my head', 'stop checking the phone'],
      bigFive: { O: 0.8, C: 0.9, E: -0.4, A: 0.6, N: 1.3 }, attachment: 'anxious',
      aceScore: 3, ses: -0.2, stressors: ['never good enough'],
      geno: { DRD4_7R: 1, DAT1_VNTR: 1, DRD2_Taq1A: 2, COMT_Met: 2 },
      mems: ['I check my phone the second a task turns hard.', 'The escape never actually helps and I do it anyway.', 'A good dataset is the one honest thing in my day.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.rose,
    interests: ['books', 'coffee', 'astronomy'], homeIndex: 13, officeFloor: 2,
  },
  // 14 — Kai: floor 3. Easy-going high-ADHD gamer; lights up on a shared game.
  {
    profile: author(1214, {
      name: 'Kai Fischer', age: 25, role: 'front-end developer',
      backstory: 'Kai codes in bursts between long scrolls, earbuds in, half a game running in another window. Restless and friendly, he will drop anything for a co-op session or a good thread.',
      goals: ['stay in flow if I can find it', 'find someone to game with', 'ride the fun where it goes'],
      bigFive: { O: 0.7, C: -0.8, E: 0.6, A: 0.5, N: -0.1 }, attachment: 'secure',
      aceScore: 0, ses: 0.1,
      geno: { DRD4_7R: 2, DAT1_VNTR: 2, DRD2_Taq1A: 1 },
      mems: ['I ship my best work in a two-hour burst then vanish.', 'A co-op night beats a full night of sleep.', 'My phone is basically an extra limb.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.slate,
    interests: ['video games', 'music', 'cycling'], homeIndex: 14, officeFloor: 3,
  },
  // 15 — Mira: floor 3. Gentle, socially attuned artist; strong mirror-empathy.
  {
    profile: author(1215, {
      name: 'Mira Kovac', age: 32, role: 'UX researcher',
      backstory: "Mira feels the room's mood before anyone speaks it and carries it home with her. She builds trust fast and deep, and frays when the people around her are hurting — she cannot not feel it.",
      goals: ['understand what people actually feel', 'keep the work humane', 'protect my own weather'],
      bigFive: { O: 1.2, C: 0.5, E: 0.3, A: 1.1, N: 0.7 }, attachment: 'anxious',
      aceScore: 2, ses: -0.1,
      geno: { OXTR_A: 0 },
      mems: ['I catch other people’s moods like a cold.', 'When I really listen, people soften.', 'I paint at night to put down what I carried all day.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.amber,
    interests: ['painting', 'books', 'travel'], homeIndex: 15, officeFloor: 3,
  },
  // 16 — Dex: floor 3. Blunt, self-contained, low mirroring (autism axis); precise.
  {
    profile: author(1216, {
      name: 'Dex Nakamura', age: 37, role: 'backend engineer',
      backstory: 'Dex says exactly what he means and expects the same. He does not soften things and cannot always tell when he has landed hard; the work is immaculate and the bedside manner is not.',
      goals: ['make it correct', 'say the true thing', 'not waste words on theatre'],
      bigFive: { O: 0.5, C: 1.2, E: -0.9, A: -0.6, N: 0.2 }, attachment: 'avoidant',
      aceScore: 1, ses: 0.1,
      geno: { OXTR_A: 2, MAOA_low: 1 },
      mems: ['I tell people the truth and they call it harsh.', 'Correct beats kind when they conflict.', 'I would rather read the spec than read the room.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.jade,
    interests: ['history', 'cycling', 'coffee'], homeIndex: 16, officeFloor: 3,
  },
  // 17 — Lux: floor 3. Bright, sociable, purpose-driven; a natural bridge between teams.
  {
    profile: author(1217, {
      name: 'Lux Abara', age: 29, role: 'design technologist',
      backstory: 'Lux moves easily between the engineers and the researchers, translating one to the other. Curious and generous, Lux is happiest when an idea jumps the gap between two teams and becomes real.',
      goals: ['connect the people who should be talking', 'make the idea real', 'keep the momentum kind'],
      bigFive: { O: 1.0, C: 0.6, E: 0.9, A: 0.8, N: 0.0 }, attachment: 'secure',
      aceScore: 0, ses: 0.2,
      geno: { OXTR_A: 0, DRD4_7R: 1 },
      mems: ['The best ideas live in the gap between two teams.', 'I like being the person who introduces people.', 'A shared reference turns strangers into collaborators.'],
    }),
    role: 'office_worker', workplace: 'office', hatColor: HAT.plum,
    interests: ['films', 'music', 'photography'], homeIndex: 17, officeFloor: 3,
  },
];

// ---- desk assignment: agent id → global office desk index ------------------
// Workers take the worker slots on their own floor in roster order; the boss takes
// the (single) boss slot. Shared by the Society (seats the body) and the body
// router (render), so geometry + sim never drift. See officeDeskSlots().
export const OFFICE_DESK_BY_ID: Record<string, number> = (() => {
  const slots = officeDeskSlots();
  const bossSlot = slots.find((s) => s.isBoss);
  const freeByFloor = new Map<number, number[]>();
  for (const s of slots) {
    if (s.isBoss) continue;
    const arr = freeByFloor.get(s.floor) ?? [];
    arr.push(s.index); freeByFloor.set(s.floor, arr);
  }
  const map: Record<string, number> = {};
  for (const r of ROSTER) {
    if (r.role === 'office_boss') { if (bossSlot) map[r.profile.id] = bossSlot.index; }
    else if (r.role === 'office_worker') {
      const floor = r.officeFloor ?? 1;
      const free = freeByFloor.get(floor);
      if (free && free.length) map[r.profile.id] = free.shift()!;
    }
  }
  return map;
})();

// ===========================================================================
// COMPANY CONFIG — authored SEED only (teams, the work-topic vocabulary, and the
// initial machine-readable projection of Dana's goal memory). Everything after
// t=0 emerges: who leads, what stalls, which theme the boss elevates next. See
// sim/company.ts.
// ===========================================================================

/** the vocabulary a subgoal/theme can be ABOUT. Derived per worker from their
 *  role title, so "fit" for a theme is a property of who is on a team. */
export const WORK_TOPICS = ['platform', 'design', 'research', 'growth', 'clients'] as const;
export type WorkTopic = typeof WORK_TOPICS[number];

/** which work topics a role is strong at (keyword scan of the role title). */
export function workTopicsFor(role: string): WorkTopic[] {
  const r = role.toLowerCase();
  const out = new Set<WorkTopic>();
  if (/engineer|developer|systems|backend|front-end|technolog|analyst/.test(r)) out.add('platform');
  if (/design|ux|copywriter/.test(r)) out.add('design');
  if (/research|scientist|ux/.test(r)) out.add('research');
  if (/growth|analyst|data/.test(r)) out.add('growth');
  if (/product|account|lead|client|copywriter/.test(r)) out.add('clients');
  if (!out.size) out.add('platform');
  return [...out];
}

/** how many coordinating teams the office runs (subsets that SPAN floors). */
export const NTEAMS = 4;
export const TEAM_NAMES = ['Signal', 'Canvas', 'Relay', 'Forge'];

/** office_worker id → team index (rank % NTEAMS over roster order — because the
 *  roster interleaves floors, teams end up spanning storeys, exactly as required:
 *  a team is a subset of the org, never of the floor plan). */
export const OFFICE_TEAM_BY_ID: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let rank = 0;
  for (const r of ROSTER) {
    if (r.role === 'office_worker') map[r.profile.id] = (rank++) % NTEAMS;
  }
  return map;
})();

/** the machine-readable projection of Dana's SEED goal memory (see her mems).
 *  Priorities sum to 1; from here they drift as her memory graph evolves. */
export const INITIAL_THEMES: { topic: WorkTopic; priority: number }[] = [
  { topic: 'platform', priority: 0.34 },
  { topic: 'clients', priority: 0.28 },
  { topic: 'design', priority: 0.16 },
  { topic: 'research', priority: 0.12 },
  { topic: 'growth', priority: 0.10 },
];

/** convenience: the roster indices that work at each venue. */
export const FOOD_STAFF = ROSTER.map((r, i) => ({ r, i })).filter((x) => x.r.workplace === 'foodcourt').map((x) => x.i);
export const OFFICE_STAFF = ROSTER.map((r, i) => ({ r, i })).filter((x) => x.r.workplace === 'office').map((x) => x.i);
