// Headless validation of the soma dynamics — no browser, no LLM.
// Run: npx tsx scripts/harness-smoke.ts
import { Character } from '../src/mind/character';
import { CASHIER_PROFILE } from '../src/mind/params';
import type { WorldEvent, LLMResponse, Appraisal } from '../src/core/types';

const char = new Character(CASHIER_PROFILE, { seed: 7, startHour: 11 });

const ev = (kind: string, d: string, s: number, v: number): WorldEvent =>
  ({ id: kind, kind, description: d, salienceHint: s, valenceHint: v });

const resp = (a: Partial<Appraisal>, emotion: string, regulation: LLMResponse['regulation']): LLMResponse => ({
  appraisal: {
    novelty: 0.4, pleasantness: 0, goalRelevance: 0.7, goalCongruence: 0, agency: 'other',
    blameworthiness: 0, copingPotential: 0.5, certainty: 0.7, normCompatibility: 0, urgency: 0.5, ...a,
  },
  emotion, regulation, speech: '...', action: 'wait',
});

const RUDE = ev('rude', 'A customer snaps at you to hurry up.', 0.8, -0.85);
const WARM = ev('compliment', 'A customer warmly says you are doing great.', 0.45, 0.75);

let nan = false;
const check = () => {
  for (const [k, val] of Object.entries(char.soma)) {
    if (typeof val === 'number' && !isFinite(val)) { console.error('NaN/Inf in', k); nan = true; }
  }
};

const cols = ['t', 'valence', 'arousal', 'dominance', 'cortisol', 'da_meso', 'amygdala', 'fatigue', 'allostaticLoad'] as const;
const header = ['clock', ...cols.slice(1), 'emotion'].map((s) => s.padStart(9)).join(' ');
console.log(header);

const dt = 0.05; // ~3 sim-min
const STEPS = 240; // 12 simulated hours
for (let i = 0; i < STEPS; i++) {
  if (i === 30) { char.perceive(RUDE); char.applyDriverResponse(RUDE, resp({ goalCongruence: -0.7, copingPotential: 0.25, blameworthiness: -0.6, pleasantness: -0.6, normCompatibility: -0.7 }, 'anxious', 'suppression')); }
  if (i === 33) { char.perceive(RUDE); char.applyDriverResponse(RUDE, resp({ goalCongruence: -0.8, copingPotential: 0.2, blameworthiness: -0.7, pleasantness: -0.7 }, 'angry', 'rumination')); }
  if (i === 120) { char.perceive(WARM); char.applyDriverResponse(WARM, resp({ goalCongruence: 0.6, pleasantness: 0.7, normCompatibility: 0.8, copingPotential: 0.7 }, 'touched', 'acceptance')); }

  char.step(dt);
  check();

  if (i % 20 === 0 || i === 31 || i === 122) {
    const s = char.soma;
    const clock = `${String(Math.floor(s.t)).padStart(2, '0')}:${String(Math.floor((s.t % 1) * 60)).padStart(2, '0')}`;
    const row = [clock, ...cols.slice(1).map((c) => (s[c] as number).toFixed(3).padStart(9))];
    console.log(row.map((x, j) => (j === 0 ? x.padStart(9) : x)).join(' '), '  ', char.readout().label);
  }
}

console.log('\nIntegrals (sim-minutes / area):');
console.log(JSON.stringify(char.integrals, (_k, v) => (typeof v === 'number' ? +v.toFixed(2) : v), 2));
console.log('\nderived params:', JSON.stringify({
  amygdalaGain: char.params.amygdalaGain, hpaFeedbackGain: char.params.hpaFeedbackGain,
  d2Density: char.params.d2Density, rewardSensitivity: char.params.rewardSensitivity,
  controlGain: char.params.controlGain, recoveryRate: char.params.recoveryRate,
}, (_k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
console.log(nan ? '\n❌ NON-FINITE VALUES DETECTED' : '\n✅ all finite, dynamics ran clean');
