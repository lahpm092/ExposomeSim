// =============================================================================
// ExposomeSim — CIVIC SEEDS: the spark, as memory. Nothing here commands.
// -----------------------------------------------------------------------------
// Three roster characters whose authored temperament makes a civic awakening
// PLAUSIBLE get durable first-person memories via ch.memory.seed() (the
// interests.ts:51 precedent — semantic nodes, near-permanent). Each set is
// grievance-adjacent lived experience plus ONE memory of successful collective
// action somewhere else. They raise salience; they dictate no action. The
// arbiter, needs and social physics decide whether anything ever comes of it —
// most runs, nothing does.
//
//   Sol Rivera  — the warm connector (reads rooms, turns talk into decisions);
//                 if anyone gets neighbours talking to each other, it is Sol.
//   Rosa Vidal  — hardship in the body (aching knees, thin months, low SES);
//                 she has SEEN mutual aid work, jar by jar.
//   Hassan      — the ambitious steelworker who builds floors he could never
//                 rent; wage-price arithmetic as lived fact, not ideology.
// =============================================================================

export interface CivicSeed {
  characterId: string;    // profile.id from roster.ts
  texts: string[];        // 3–5 first-person prose memories
}

export const CIVIC_SEEDS: readonly CivicSeed[] = [
  {
    characterId: 'agent-solrivera',
    texts: [
      'Back in my old neighbourhood, the block on Vester Street pooled money and fixed their own stairwell — nobody waited for permission.',
      'I once watched a landlord raise the rent three times in a year, and everyone absorbed it separately, in private, like it was weather.',
      'When people finally say out loud what they are each carrying alone, the whole room changes — I have watched it happen.',
      'My aunt lost her flat over one missed month; the neighbours only learned of it when the van came.',
    ],
  },
  {
    characterId: 'agent-rosavidal',
    texts: [
      'In Valdez the cleaners kept a common jar; when Elena’s boiler died in January, the jar bought her a new one that same week.',
      'My knees know exactly how many years of floors I have paid into this town.',
      'Some winters the rent took so much of the envelope that supper went thin the last week of every month.',
      'Nobody asks the evening shift what the neighbourhood needs, and we are the ones who watch it empty out.',
    ],
  },
  {
    characterId: 'agent-hassan',
    texts: [
      'On the Almere site the crews held one meeting in the laydown yard and won the harness money back by Friday — one meeting.',
      'I have built floors for buildings whose rent I could never pay; you feel that in your hands after a while.',
      'My father worked forty years and retired into a room smaller than the ones he plastered.',
      'Wages move slower than prices here; I keep the receipts, and the gap is a fact, not a feeling.',
    ],
  },
];

/** the plan the world consumes at Society construction:
 *  rt.ch.memory.seed(texts, clock) per character. */
export function civicSeedPlan(): { characterId: string; texts: string[] }[] {
  return CIVIC_SEEDS.map((s) => ({ characterId: s.characterId, texts: s.texts.slice() }));
}
