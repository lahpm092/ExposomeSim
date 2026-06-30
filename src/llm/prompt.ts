// =============================================================================
// prompt.ts — the neurosymbolic coupling seam.
//   renderInteroception: turns the soma into FELT bodily language so the model's
//                        behavior is biased by physiology, not just the situation.
//   buildMessages:       system role-play contract + situation.
//   parseResponse:       tolerant JSON parsing with a soma-derived fallback,
//                        so a tiny model can never stall the simulation.
// =============================================================================
import type {
  Profile, SomaState, EmotionReadout, MemoryItem, WorldEvent,
  ChatMessage, LLMResponse, Appraisal, RegulationStrategy,
} from '../types';
import { clamp } from '../util/num';

const REGULATIONS: RegulationStrategy[] = [
  'reappraisal', 'suppression', 'situation-selection', 'distraction', 'rumination', 'acceptance', 'none',
];
const ACTIONS = ['greet', 'take_order', 'serve', 'thank', 'apologize', 'wait', 'gesture', 'deep_breath', 'call_manager'];

const clockOf = (t: number) => {
  const h = Math.floor(((t % 24) + 24) % 24);
  const m = Math.floor((t - Math.floor(t)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** the body, in words the LLM can feel */
export function renderInteroception(soma: SomaState, readout: EmotionReadout): string {
  const L: string[] = [];
  if (soma.arousal > 0.7) L.push('Your heart is quick and your body feels wired.');
  else if (soma.arousal < 0.3) L.push('Your body feels heavy, slowed-down.');
  if (soma.valence > 0.3) L.push('There is a warm, light feeling in your chest.');
  else if (soma.valence < -0.3) L.push('A sour, heavy weight sits in your chest.');
  if (soma.cortisol > 1.4) L.push('Stress hums under your skin; your jaw is tight.');
  if (soma.amygdala > 0.5) L.push('You feel on edge, braced for the next thing to go wrong.');
  if (soma.da_meso < 0.8) L.push('Everything feels flat; it is hard to care or feel any reward.');
  else if (soma.da_meso > 1.2) L.push('You feel a pull of motivation, like things could go well.');
  if (soma.fatigue > 0.6) L.push('You are bone-tired and your patience is paper-thin.');
  if (soma.oxytocin > 1.2) L.push('You feel unexpectedly tender toward the people in front of you.');
  if (soma.dominance < -0.3) L.push('You feel small, at the mercy of the moment.');
  else if (soma.dominance > 0.3) L.push('You feel steady, in control.');
  if (soma.RAGE > 0.4) L.push('Anger is rising; part of you wants to snap.');
  if (soma.FEAR > 0.4) L.push('Fear flickers; part of you wants to get away.');
  if (soma.PANIC_GRIEF > 0.4) L.push('A lonely, sinking ache sits behind everything.');
  const head = `Right now you feel ${readout.label} (intensity ${Math.round(readout.intensity * 100)}%).`;
  return [head, ...L].join(' ');
}

export function buildMessages(
  profile: Profile, soma: SomaState, readout: EmotionReadout,
  memories: MemoryItem[], ev: WorldEvent,
): ChatMessage[] {
  const b = profile.bigFive;
  const system =
`You ARE ${profile.name}, a ${profile.age}-year-old ${profile.role}. This is a role-play for a psychology study. Stay fully in character — including ${profile.name}'s flaws and limits. Never break character; never mention being an AI or a model.

${profile.backstory}

Temperament (Big Five z-scores): Openness ${b.O.toFixed(1)}, Conscientiousness ${b.C.toFixed(1)}, Extraversion ${b.E.toFixed(1)}, Agreeableness ${b.A.toFixed(1)}, Neuroticism ${b.N.toFixed(1)}.
Goals: ${profile.goals.join('; ')}.

You react to each moment based on how your BODY and MIND actually feel right now — you will be told. Let that physical state drive you: if you feel flat and exhausted, be flat and exhausted; if warm, be warm; if on edge, be short. Do not be a cheerful assistant — be ${profile.name}.

Reply with ONLY a JSON object, no prose, exactly this shape:
{
  "appraisal": {
    "novelty": 0..1, "pleasantness": -1..1, "goalRelevance": 0..1, "goalCongruence": -1..1,
    "agency": "self" | "other" | "circumstance", "blameworthiness": -1..1,
    "copingPotential": 0..1, "certainty": 0..1, "normCompatibility": -1..1, "urgency": 0..1
  },
  "emotion": "<one lowercase word>",
  "regulation": "${REGULATIONS.join(' | ')}",
  "speech": "<one or two sentences you say aloud>",
  "action": "${ACTIONS.join(' | ')}",
  "innerMonologue": "<a short private thought>"
}`;

  const memLine = memories.length
    ? `On your mind: ${memories.map((m) => m.text).join(' | ')}\n`
    : '';
  const user =
`The time is ${clockOf(soma.t)}. ${renderInteroception(soma, readout)}
${memLine}What happens now: ${ev.description}

Respond as ${profile.name}, in JSON only.`;

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ---- parsing -------------------------------------------------------------
const num = (x: any, lo: number, hi: number, d = 0) =>
  clamp(typeof x === 'number' && isFinite(x) ? x : d, lo, hi);

function coerceAppraisal(a: any): Appraisal {
  a = a ?? {};
  const agency = ['self', 'other', 'circumstance'].includes(a.agency) ? a.agency : 'circumstance';
  return {
    novelty: num(a.novelty, 0, 1, 0.3),
    pleasantness: num(a.pleasantness, -1, 1, 0),
    goalRelevance: num(a.goalRelevance, 0, 1, 0.5),
    goalCongruence: num(a.goalCongruence, -1, 1, 0),
    agency,
    blameworthiness: num(a.blameworthiness, -1, 1, 0),
    copingPotential: num(a.copingPotential, 0, 1, 0.5),
    certainty: num(a.certainty, 0, 1, 0.6),
    normCompatibility: num(a.normCompatibility, -1, 1, 0),
    urgency: num(a.urgency, 0, 1, 0.4),
  };
}

function extractJson(raw: string): any | null {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { return null; }
}

/** parse the model output; if it's unusable, derive a plausible response from the soma */
export function parseResponse(raw: string, soma: SomaState, readout: EmotionReadout): LLMResponse {
  const o = extractJson(raw);
  if (!o) return fallbackResponse(soma, readout);
  const regulation: RegulationStrategy = REGULATIONS.includes(o.regulation) ? o.regulation : 'none';
  const action = ACTIONS.includes(o.action) ? o.action : 'wait';
  return {
    appraisal: coerceAppraisal(o.appraisal),
    emotion: typeof o.emotion === 'string' && o.emotion ? o.emotion.toLowerCase().split(/\s+/)[0] : readout.label,
    regulation,
    speech: typeof o.speech === 'string' && o.speech ? o.speech.slice(0, 240) : '…',
    action,
    innerMonologue: typeof o.innerMonologue === 'string' ? o.innerMonologue.slice(0, 240) : undefined,
  };
}

/** soma-grounded fallback so a flaky tiny model never freezes the world */
export function fallbackResponse(soma: SomaState, readout: EmotionReadout): LLMResponse {
  const neg = soma.valence < -0.1;
  return {
    appraisal: {
      novelty: 0.3, pleasantness: soma.valence, goalRelevance: 0.5,
      goalCongruence: soma.valence, agency: 'circumstance', blameworthiness: 0,
      copingPotential: clamp(0.5 + soma.dominance * 0.4, 0, 1), certainty: 0.5,
      normCompatibility: 0, urgency: soma.arousal,
    },
    emotion: readout.label,
    regulation: neg && soma.dlPFC > 0.3 ? 'reappraisal' : 'none',
    speech: neg ? 'Sorry — one moment.' : 'Sure, coming right up.',
    action: 'wait',
    innerMonologue: undefined,
  };
}
