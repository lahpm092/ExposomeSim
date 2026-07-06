// =============================================================================
// ExposomeSim — the emergent relationship ledger.
// -----------------------------------------------------------------------------
// Bonds are NOT actions. There is no 'befriend' or 'fall_in_love' verb the
// driver can emit. A relationship is the slow integral of *two-sided* affect:
// every interaction beat carries Mara's affect delta AND the partner's, and the
// bond moves only to the extent the two RECIPROCATE. Familiarity accretes from
// mere repeated contact; affection needs mutual warmth (CARE × oxytocin) on a
// reciprocated beat; trust tracks how safely Mara can be vulnerable (dominance,
// low cortisol); tension feeds on threat (FEAR/RAGE) when the beat is discordant;
// attraction is an ORTHOGONAL romance axis that only opens once there is real
// affection to stand on. Stages are re-derived from these scalars by threshold
// crossings every beat, and are REVERSIBLE — enough tension demotes a bond.
//
// Pure & deterministic: no rendering, no DOM, no RNG. The Town owns the clock and
// the somas; we only read them and move the ledger.
// =============================================================================

import type { Relationship, RelStage, SomaState } from '../core/types';
import { clamp } from '../core/util/num';

// ---- the stage ladder (monotonic; index = depth of bond) --------------------
const STAGES: readonly RelStage[] = [
  'stranger', 'acquaintance', 'friend', 'close', 'romantic',
] as const;

// ---- construction -----------------------------------------------------------

/**
 * A fresh bond: a stranger with every affective channel at zero. Everything else
 * accrues only through reciprocated interaction.
 */
export function newRelationship(npcId: string, profileSeed: number, name: string): Relationship {
  return {
    npcId,
    profileSeed,
    name,
    familiarity: 0,
    affection: 0,
    trust: 0,
    attraction: 0,
    tension: 0,
    cumValence: 0,
    encounters: 0,
    lastSeen: 0,
    stage: 'stranger',
    summary: 'A stranger.',
  };
}

// ---- reciprocity ------------------------------------------------------------

/**
 * Sign-agreement of the two affect deltas, in [-1,1]. Mutual warmth reads +1;
 * a discordant beat (one lifted, one stung) reads -1; mutual sourness is partial
 * negative (a shared bad beat still registers, but doesn't *bond*); a one-sided
 * beat (the other unmoved) carries no reciprocity signal.
 */
function reciprocity(dMara: number, dNpc: number): number {
  const sM = Math.sign(dMara);
  const sN = Math.sign(dNpc);
  if (sM > 0 && sN > 0) return 1;       // both lifted — full positive reciprocity
  if (sM * sN < 0) return -1;           // opposite signs — felt at cross purposes
  if (sM < 0 && sN < 0) return -0.5;    // both stung — partial (co-misery, not a bond)
  return 0;                             // at least one unmoved — no signal
}

// ---- stage derivation -------------------------------------------------------

/**
 * Re-derive the stage from the scalar channels by threshold crossings, then
 * demote one rung if tension dominates affection. Monotonic ladder: each deeper
 * stage layers an extra condition on the one below.
 */
function recomputeStage(rel: Relationship): void {
  let s: RelStage = 'stranger';
  if (rel.familiarity > 0.15) s = 'acquaintance';
  if (rel.familiarity > 0.4 && rel.affection > 0.3) s = 'friend';
  if (rel.affection > 0.6 && rel.trust > 0.4) s = 'close';
  if (rel.affection > 0.6 && rel.attraction > 0.5 && rel.trust > 0.4) s = 'romantic';

  let idx = STAGES.indexOf(s);
  // Reversible: a bond soured past affection+0.3 of tension slips back a rung.
  if (rel.tension > rel.affection + 0.3) idx = Math.max(0, idx - 1);
  rel.stage = STAGES[idx];
}

// ---- the per-beat update ----------------------------------------------------

/**
 * Fold one interaction beat into the bond. `dMaraValence` / `dNpcValence` are the
 * two sides' core-affect deltas over the beat; `beatSalience` ∈ [0,1] is how much
 * the moment mattered (drives familiarity and scales every accrual). Mutates `rel`
 * in place. The partner's soma is read for its CARE/RAGE/oxytocin contribution so
 * the bond is genuinely two-sided.
 */
export function updateBond(
  rel: Relationship,
  maraSoma: SomaState,
  npcSoma: SomaState,
  dMaraValence: number,
  dNpcValence: number,
  beatSalience: number,
  dtHours: number,
): void {
  const sal = clamp(beatSalience, 0, 1);
  const R = reciprocity(dMaraValence, dNpcValence);

  // Familiarity: mere repeated, salient contact. Accrues regardless of valence.
  rel.familiarity = clamp(rel.familiarity + sal * 0.15, 0, 1);

  // Affection: mutual warmth on a reciprocated beat (oxytocin-gated CARE), eroded
  // by any threat in the air. Positive accrual only when the beat reciprocates.
  const oxytocinFactor = 0.5 * (maraSoma.oxytocin + npcSoma.oxytocin); // ~1 at baseline
  const warmth = (maraSoma.CARE + npcSoma.CARE);
  const affGain = oxytocinFactor * Math.max(0, R) * sal * warmth * 0.4;
  // threat erodes affection — but MOSTLY on discordant beats. Ambient anxiety
  // shouldn't poison an otherwise warm exchange (else an anxious person could
  // never warm to anyone). Scale erosion by how discordant the beat was.
  const tensionErode = (maraSoma.FEAR + maraSoma.RAGE) * sal * 0.1 * Math.max(0.2, -R);
  rel.affection = clamp(rel.affection + affGain - tensionErode, -1, 1);

  // Trust: how safely Mara can be vulnerable — high dominance, low cortisol — paid
  // out in the direction of reciprocity (a discordant beat withdraws trust).
  const coping = clamp(0.5 + 0.5 * maraSoma.dominance - 0.2 * (maraSoma.cortisol - 1), 0, 1);
  rel.trust = clamp(rel.trust + coping * R * sal * 0.2, 0, 1);

  // Tension: discordant beats let threat (Mara's FEAR/RAGE + the other's RAGE)
  // crystallize into standing friction.
  if (R < 0) {
    rel.tension = clamp(
      rel.tension + (maraSoma.RAGE + maraSoma.FEAR + npcSoma.RAGE) * 0.1 * sal,
      0, 1,
    );
  }

  // Attraction: an ORTHOGONAL romance axis. Wanting (da_meso above tone), LUST and
  // novelty-seeking, but only once affection has a footing (>0.2) and the beat
  // reciprocates. Never opens on its own.
  if (rel.affection > 0.2) {
    const drive = Math.max(0, (maraSoma.da_meso - 1) + maraSoma.LUST + maraSoma.SEEKING);
    rel.attraction = clamp(rel.attraction + drive * Math.max(0, R) * sal * 0.1, 0, 1);
  }

  // Bookkeeping.
  rel.cumValence += dMaraValence;
  rel.encounters += 1;
  rel.lastSeen = maraSoma.t;
  rel.somaSnapshot = {
    valence: maraSoma.valence,
    arousal: maraSoma.arousal,
    oxytocin: maraSoma.oxytocin,
    CARE: maraSoma.CARE,
  };

  // dtHours is the beat length; affect folding above is salience-weighted (a beat
  // is an event, not a duration), so dt only matters to between-beat decay.
  void dtHours;

  recomputeStage(rel);
}

// ---- narrative gist ---------------------------------------------------------

/**
 * A one-line human-readable gist of the bond for the dashboard, e.g.
 * 'Friendly regular (warm, content); 4 visits'. Pure — does not mutate `rel`.
 */
export function distillSummary(rel: Relationship, maraEmotionLabel: string, lastSpeech: string): string {
  const who =
    rel.stage === 'romantic' ? 'Romantic interest'
    : rel.stage === 'close' ? 'Close confidant'
    : rel.stage === 'friend' ? 'Friendly regular'
    : rel.stage === 'acquaintance' ? 'Familiar face'
    : 'A stranger';

  // tone from the standing affect balance
  let tone: string;
  if (rel.tension > rel.affection + 0.3) tone = 'strained';
  else if (rel.affection > 0.5) tone = 'warm';
  else if (rel.affection > 0.2) tone = 'friendly';
  else if (rel.affection < -0.2) tone = 'cold';
  else tone = 'neutral';

  const mood = maraEmotionLabel.trim() || 'neutral';
  const visits = `${rel.encounters} visit${rel.encounters === 1 ? '' : 's'}`;

  let line = `${who} (${tone}, ${mood}); ${visits}`;
  const speech = lastSpeech.trim();
  if (speech) {
    const snip = speech.length > 40 ? speech.slice(0, 39).trimEnd() + '…' : speech;
    line += ` — "${snip}"`;
  }
  return line;
}

// ---- between-encounter decay ------------------------------------------------

/**
 * Slow forgetting applied to the whole ledger while bonds are dormant. Familiarity
 * fades exponentially; affection and attraction drift toward zero; tension cools
 * fastest (grudges soften with time). Stages are re-derived afterward so a bond
 * can quietly slip back a rung over a long absence. Mutates every entry in place.
 */
export function decayBonds(ledger: Map<string, Relationship>, dtHours: number): void {
  const dt = Math.max(0, dtHours);
  if (dt === 0) return;

  const fFamiliarity = Math.exp(-0.01 * dt);  // ~70h half-life
  const fAffection = Math.exp(-0.004 * dt);   // slow drift toward 0
  const fAttraction = Math.exp(-0.006 * dt);  // romance cools a touch faster
  const fTension = Math.exp(-0.05 * dt);      // grudges soften fastest

  for (const rel of ledger.values()) {
    rel.familiarity = clamp(rel.familiarity * fFamiliarity, 0, 1);
    rel.affection = clamp(rel.affection * fAffection, -1, 1);
    rel.attraction = clamp(rel.attraction * fAttraction, 0, 1);
    rel.tension = clamp(rel.tension * fTension, 0, 1);
    recomputeStage(rel);
  }
}
