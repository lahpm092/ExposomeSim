// =============================================================================
// company.ts — the office as an emergent organisation. The company GOAL is never
// stored as state the engine reads; it lives ONLY in the boss's memory GRAPH as
// seeded prose, and the machine-readable theme priorities are a PROJECTION re-
// derived by a mood-congruent retrieval over that graph. Teams coordinate over an
// internal net (text threads, location-independent so they span floors) toward a
// subgoal; each net message's contribution is scored by the SAME relationship
// ledgers and Big-Five compatibility that spark hallway conversations — so a warm,
// compatible team compounds and a tense one stalls. Delivered output is fed to the
// boss as an event that moves her soma and grows her memory; every plan interval
// she RE-DERIVES the goal from that evolved memory. Pressure → behaviour → output
// → goal → pressure, entirely through the substrate — the trajectory has no closed
// form, so you must run the sim (computational irreducibility).
//
// PURE except the threaded rng: no DOM/THREE, no Math.random.
// =============================================================================
import type {
  Character,
} from '../mind/character';
import type {
  Ledger, WorkPsych, WorldEvent, NetMessage, NetMsgKind, Subgoal, TeamState,
  GoalTheme, CompanyGoal, TeamOutput, CompanySnapshot,
} from '../core/types';
import { updateBond, newRelationship } from './relationship';
import { socialReward, socialThreat, bigFiveCompat } from './socialaffect';
import { fallbackResponse } from '../llm/prompt';
import {
  WORK_TOPICS, workTopicsFor, TEAM_NAMES, INITIAL_THEMES, type WorkTopic,
} from '../mind/roster';
import { clamp, lerp, mulberry32, sigmoid, type RNG } from '../core/util/num';

// ---- cadence + tuning ------------------------------------------------------
const POST_BEAT = 0.12;      // sim-hours between net beats
const STANDUP_INT = 2;       // sim-hours between team standups
const PLAN_INT = 12;         // sim-hours between goal re-derivations…
const PLAN_OUTPUTS = 6;      // …or after this many delivered outputs, whichever first
const PROG_BASE = 0.08;
const DELIVER = 0.85;
const MAX_FEED = 40;
const MAX_OUTPUTS = 14;
const LR = 0.3;
const REPLY_WINDOW = 1.5;    // sim-hours a message stays a live reply target

const KF: Record<NetMsgKind, number> = {
  directive: 0.2, propose: 0.5, report: 1.0, support: 0.4, question: 0.1, block: -0.5, ack: 0.1,
};

let _cid = 800000;
const cid = () => `m${(_cid++).toString(36)}`;

/** the live per-member context the Society hands the Company each tick. */
export interface CompanyMemberView {
  idx: number;
  id: string;
  role: string;         // 'office_worker' | 'office_boss'
  team: number;         // -1 for the boss
  ch: Character;
  ledger: Ledger;
  wp: WorkPsych;
  interests: string[];
  atDesk: boolean;      // at their desk, free to post to the net
  inConvo: boolean;     // in a face-to-face chat (won't post)
}

export interface CompanyCfg {
  members: { idx: number; id: string; name: string; role: string; team: number }[];
  bossId: string;
  bossName: string;
  seed?: number;
}

export class Company {
  private rng: RNG;
  private readonly bossId: string;
  private readonly bossName: string;
  private readonly workTopics = new Map<string, WorkTopic[]>();   // member id → strong topics
  private readonly nameById = new Map<string, string>();
  private teams: TeamState[] = [];
  private goal: CompanyGoal;
  private feed: NetMessage[] = [];
  private outputs: TeamOutput[] = [];
  private netInfluence = new Map<string, number>();
  private leaderByTeam = new Map<number, string>();

  private postAcc = 0;
  private standupAcc = 0;
  private planAcc = 0;
  private outputsSincePlan = 0;
  private bossValence = 0;

  constructor(cfg: CompanyCfg) {
    this.rng = mulberry32(((cfg.seed ?? 7) ^ 0xC0FFEE) >>> 0);
    this.bossId = cfg.bossId;
    this.bossName = cfg.bossName;
    for (const m of cfg.members) {
      this.nameById.set(m.id, m.name);
      this.workTopics.set(m.id, workTopicsFor(m.role));
    }
    // initial goal = the projection of the boss's seed memory.
    const themes: GoalTheme[] = INITIAL_THEMES.map((t) => ({ topic: t.topic, priority: t.priority }));
    this.goal = { themes, version: 1, revisedAt: 0, narrative: narrativeFrom(themes) };
    // partition into teams; each team's opening subgoal is the theme it best fits.
    const byTeam = new Map<number, string[]>();
    for (const m of cfg.members) {
      if (m.team < 0) continue;
      const arr = byTeam.get(m.team) ?? []; arr.push(m.id); byTeam.set(m.team, arr);
    }
    for (const [tid, ids] of [...byTeam.entries()].sort((a, b) => a[0] - b[0])) {
      this.teams.push({
        id: tid, name: TEAM_NAMES[tid] ?? `Team ${tid}`, memberIds: ids,
        subgoal: { id: `sg${tid}`, topic: 'platform', target: 1, progress: 0.05, momentum: 0, dependsOn: [], lastActivity: 0 },
        cohesion: 0.3, tension: 0, demand: 0.2, output: 0,
      });
    }
    // give each team a DISTINCT theme (greedy by fit) so the teams pull in different
    // directions and genuinely have to coordinate team-to-team, not all chase one thing.
    const assign = this.assignTeamTopics(themes);
    for (const t of this.teams) { t.subgoal.topic = assign.get(t.id) ?? t.subgoal.topic; t.demand = clamp(0.15 + 0.6 * this.priorityOf(t.subgoal.topic), 0, 1); }
    this.recomputeDependencies();
  }

  /** assign each team a theme, DISTINCT where possible (greedy: the highest-priority
   *  theme goes to the team that fits it best, then the next, …). Spreads the org. */
  private assignTeamTopics(themes: GoalTheme[]): Map<number, WorkTopic> {
    const out = new Map<number, WorkTopic>();
    const byPriority = themes.slice().sort((a, b) => b.priority - a.priority);
    const unassigned = new Set(this.teams.map((t) => t.id));
    for (const th of byPriority) {
      if (!unassigned.size) break;
      let bestTeam = -1, bestFit = -Infinity;
      for (const t of this.teams) {
        if (!unassigned.has(t.id)) continue;
        const fit = t.memberIds.reduce((s, id) => s + this.topicFit(id, th.topic), 0) / Math.max(1, t.memberIds.length);
        if (fit > bestFit) { bestFit = fit; bestTeam = t.id; }
      }
      if (bestTeam >= 0) { out.set(bestTeam, th.topic as WorkTopic); unassigned.delete(bestTeam); }
    }
    // more teams than themes → the rest take their single best-fit theme.
    for (const t of this.teams) if (!out.has(t.id)) out.set(t.id, this.bestThemeFor(t.memberIds, themes));
    return out;
  }

  // ===================== per-tick ==========================================
  step(dt: number, views: CompanyMemberView[], env: { clock: number }): void {
    const clock = env.clock;
    const byId = new Map(views.map((v) => [v.id, v]));

    // idle rot: neglected subgoals cool.
    for (const t of this.teams) {
      t.subgoal.progress *= Math.exp(-0.002 * dt);
      t.subgoal.momentum *= Math.exp(-0.5 * dt);
    }

    this.postAcc += dt;
    if (this.postAcc >= POST_BEAT) {
      this.postAcc = 0;
      this.runNetBeat(views, byId, clock);
    }

    this.standupAcc += dt;
    if (this.standupAcc >= STANDUP_INT) {
      this.standupAcc = 0;
      this.runStandups(byId, clock);
    }

    this.planAcc += dt;
    if (this.planAcc >= PLAN_INT || this.outputsSincePlan >= PLAN_OUTPUTS) {
      const boss = byId.get(this.bossId);
      if (boss) { this.rederiveGoal(boss, clock); this.retask(views); }
      this.planAcc = 0; this.outputsSincePlan = 0;
    }
  }

  // ---- one net beat: everyone at a desk may contribute a message ------------
  private runNetBeat(views: CompanyMemberView[], byId: Map<string, CompanyMemberView>, clock: number): void {
    // the boss occasionally steers the highest-priority team (goal → team channel).
    const boss = byId.get(this.bossId);
    if (boss && boss.atDesk && this.rng() < 0.06) {
      const top = [...this.teams].sort((a, b) => this.priorityOf(b.subgoal.topic) - this.priorityOf(a.subgoal.topic))[0];
      if (top) this.pushMessage({
        id: cid(), t: clock, fromId: this.bossId, fromName: this.bossName, team: top.id,
        threadId: `t${top.id}`, kind: 'directive', topic: top.subgoal.topic,
        text: `Let's push ${top.subgoal.topic} this week — that's where the quarter is won.`,
        valence: clamp(boss.ch.soma.valence, -1, 1), quality: 0.6, coord: 1,
      });
    }

    for (const m of views) {
      if (m.team < 0 || !m.atDesk || m.inConvo) continue;
      const team = this.teams[m.team]; if (!team) continue;
      const drive = this.contribDrive(m, team);
      if (this.rng() >= drive * 0.7) continue;

      // reply target = pattern-completion of the team thread (argmax over live msgs).
      const candidates = this.feed.filter((x) => x.team === m.team && x.fromId !== m.id && clock - x.t < REPLY_WINDOW);
      let parent: NetMessage | undefined; let best = 0;
      for (const p of candidates) {
        const u = byId.get(p.fromId);
        const aff = m.ledger.get(p.fromId)?.affection ?? 0;
        const ten = m.ledger.get(p.fromId)?.tension ?? 0;
        const compat = u ? bigFiveCompat(m.ch.profile.bigFive, u.ch.profile.bigFive) : 0.5;
        const score = 0.5 * this.topicFit(m.id, p.topic) + 0.4 * aff + 0.2 * (compat - 0.5) - 0.6 * ten + 0.15 * Math.pow(0.995, clock - p.t);
        if (score > best) { best = score; parent = p; }
      }

      const parentAuthor = parent ? byId.get(parent.fromId) : undefined;
      const kind = this.arbitrateKind(m, team, parent, parentAuthor);
      const coord = this.coordFor(m, parentAuthor);
      const quality = this.quality(m, team.subgoal.topic);
      const msg: NetMessage = {
        id: cid(), t: clock, fromId: m.id, fromName: this.nameById.get(m.id) ?? m.id, team: m.team,
        threadId: `t${m.team}`, parentId: parent?.id, kind, topic: team.subgoal.topic,
        text: composeNet(kind, team.subgoal.topic, parentAuthor?.id ? this.nameById.get(parentAuthor.id) : undefined, m.ch.soma.valence),
        valence: clamp(m.ch.soma.valence, -1, 1), quality, coord,
      };
      this.pushMessage(msg);
      this.applyProgress(team, msg);
      this.applyCollabCoupling(m, parentAuthor, msg, clock);
    }
  }

  // ---- standups: emit team output, feed the boss ----------------------------
  private runStandups(byId: Map<string, CompanyMemberView>, clock: number): void {
    this.recomputeInfluence(byId);
    const boss = byId.get(this.bossId);
    for (const team of this.teams) {
      // cohesion/tension are pure reads of the intra-team relationship ledgers — the
      // same ledgers hallway chats AND net collaboration write. Emergent, not assigned.
      let sumAff = 0, pairs = 0, maxTen = 0;
      for (const a of team.memberIds) {
        const va = byId.get(a); if (!va) continue;
        for (const bId of team.memberIds) {
          if (bId === a) continue;
          const rel = va.ledger.get(bId);
          if (!rel) continue;
          sumAff += rel.affection; maxTen = Math.max(maxTen, rel.tension); pairs++;
        }
      }
      team.cohesion = clamp(pairs ? 0.5 + 0.5 * (sumAff / pairs) : 0.3, 0, 1);
      team.tension = clamp(maxTen, 0, 1);
      const contribs = this.feed.filter((x) => x.team === team.id && x.fromId !== this.bossId && clock - x.t < STANDUP_INT + 0.5);
      const deliver = team.subgoal.progress >= DELIVER;
      if (!contribs.length && !deliver) continue;
      const coordQuality = contribs.length ? contribs.reduce((s, m) => s + m.coord, 0) / contribs.length : 1;
      const driftTopics = this.driftTopics(contribs, team.subgoal.topic);
      const out: TeamOutput = {
        t: clock, team: team.id, topic: team.subgoal.topic, progress: team.subgoal.progress,
        coordQuality, leaderId: this.leaderByTeam.get(team.id), tensionFlag: team.tension > 0.5, driftTopics,
      };
      this.outputs.push(out);
      if (this.outputs.length > MAX_OUTPUTS) this.outputs.shift();
      this.outputsSincePlan++;
      team.output = team.subgoal.progress;
      if (deliver) team.subgoal.progress = 0.2;   // shipped → reset to a residual

      // BOSS INGEST: the output becomes a felt event that moves her soma + memory.
      if (boss) {
        const good = out.progress > 0.6 && out.coordQuality > 1.0;
        const e = ev(
          good ? 'report' : 'stall',
          good
            ? `Team ${team.name} delivered on ${team.subgoal.topic}: strong and coordinated.`
            : `Team ${team.name} is stalling on ${team.subgoal.topic}${out.tensionFlag ? ' — there is friction in the group.' : '.'}`,
          clamp(0.2 + 0.6 * Math.abs(out.progress - 0.5), 0, 1),
          clamp((out.progress - 0.5) * out.coordQuality * 2, -1, 1),
        );
        boss.ch.perceive(e);
        boss.ch.applyDriverResponse(e, fallbackResponse(boss.ch.soma, boss.ch.readout(), e));
        this.bossValence = boss.ch.soma.valence;
      }
    }
  }

  // ---- goal re-derivation: the irreducible step -----------------------------
  // The goal is re-read from the boss's evolved memory GRAPH: a mood-congruent
  // retrieval scores each topic by how much of what she now remembers (weighted by
  // salience × valence) is ABOUT it. The priority update is a BOUNDED reallocation
  // around the mean support — winners rise, losers fall — with a floor so the whole
  // vector drifts unpredictably across the run without collapsing to one obsession
  // or flattening to indifference. Which topic leads at week 6 has no closed form:
  // it is a function of the entire, seed-determined history of who delivered what.
  private rederiveGoal(boss: CompanyMemberView, clock: number): void {
    const cue = 'company goal quarter team ' + this.goal.themes.map((t) => t.topic).join(' ');
    const nodes = boss.ch.memory.retrieveNodes(cue, 12, boss.ch.soma.valence);
    const support = new Map<string, number>();
    for (const topic of WORK_TOPICS) support.set(topic, 0);
    for (const n of nodes) {
      for (const topic of WORK_TOPICS) {
        if (n.tokens.has(topic)) support.set(topic, (support.get(topic) ?? 0) + n.salience * n.valence);
      }
    }
    const mean = [...support.values()].reduce((a, b) => a + b, 0) / WORK_TOPICS.length;
    const FLOOR = 0.04, UNIFORM = 1 / WORK_TOPICS.length, DECAY = 0.1;
    // A gentle reversion toward uniform is the RESTORING FORCE: a consistently-
    // supported topic settles at an equilibrium above uniform rather than running
    // away to 1, so the goal vector stays differentiated AND alive (it can be
    // overtaken later). No compounding — the state is the raw priority, re-normalized.
    const next = new Map<string, number>();
    for (const topic of WORK_TOPICS) {
      const cur = this.goal.themes.find((t) => t.topic === topic)?.priority ?? UNIFORM;
      const pulled = lerp(cur, UNIFORM, DECAY);
      const s = (support.get(topic) ?? 0) - mean;                // relative pull
      next.set(topic, clamp(pulled + LR * Math.tanh(s), FLOOR, 1));
    }
    let sum = 0;
    for (const [, p] of next) sum += p;
    const themes: GoalTheme[] = [...next.entries()]
      .map(([topic, p]) => ({ topic, priority: sum > 0 ? p / sum : UNIFORM }))
      .sort((a, b) => b.priority - a.priority);

    const changed = themes[0]?.topic !== this.goal.themes[0]?.topic
      || themes.slice(0, 3).map((t) => t.topic).join() !== this.goal.themes.slice(0, 3).map((t) => t.topic).join()
      || Math.abs((themes[0]?.priority ?? 0) - (this.goal.themes[0]?.priority ?? 0)) > 0.04;
    this.goal = {
      themes,
      version: this.goal.version + (changed ? 1 : 0),
      revisedAt: clock,
      narrative: narrativeFrom(themes),
    };
    if (changed) {
      // the decision is written back into the substrate — it becomes memory too.
      boss.ch.memory.add(clock, `New direction: prioritize ${themes.slice(0, 2).map((t) => t.topic).join(' and ')}.`, boss.ch.soma);
    }
  }

  // ---- re-tasking: the goal reshapes each team's subgoal + felt demand -------
  private retask(views: CompanyMemberView[]): void {
    const assign = this.assignTeamTopics(this.goal.themes);
    for (const team of this.teams) {
      const topic = assign.get(team.id) ?? team.subgoal.topic;
      const prio = this.priorityOf(topic);
      if (topic !== team.subgoal.topic) {
        team.subgoal = {
          id: team.subgoal.id, topic, target: 1,
          progress: team.subgoal.progress * 0.3,   // partial carry-over into the new direction
          momentum: 0, dependsOn: [], lastActivity: team.subgoal.lastActivity,
        };
      }
      team.demand = clamp(0.15 + 0.6 * prio, 0, 1);
    }
    this.recomputeDependencies();
    void views;
  }

  /** a team depends on any HIGHER-priority team whose topic differs (an emergent
   *  upstream/downstream DAG: a downstream team can't outrun its dependency). */
  private recomputeDependencies(): void {
    for (const team of this.teams) {
      const myP = this.priorityOf(team.subgoal.topic);
      team.subgoal.dependsOn = this.teams
        .filter((o) => o.id !== team.id && o.subgoal.topic !== team.subgoal.topic && this.priorityOf(o.subgoal.topic) > myP)
        .map((o) => o.subgoal.id);
    }
  }

  // ===================== scoring helpers ===================================
  private contribDrive(m: CompanyMemberView, team: TeamState): number {
    const s = m.ch.soma, b = m.ch.profile.bigFive, wp = m.wp;
    const Cn = sigmoid(b.C), En = sigmoid(b.E);
    return clamp(
      0.28 * Cn + 0.22 * Math.max(0, s.da_meso - 1) + 0.18 * clamp(s.SEEKING, 0, 1) +
      0.18 * wp.stimulation + 0.14 * Math.max(0, s.oxytocin - 1) + 0.10 * En +
      0.25 * team.demand - 0.30 * wp.workAnxiety - 0.28 * s.fatigue - 0.15 * Math.max(0, s.amygdala - 0.5),
      0, 1,
    );
  }

  private topicFit(id: string, topic: string): number {
    return (this.workTopics.get(id) ?? []).includes(topic as WorkTopic) ? 1 : 0.25;
  }

  private quality(m: CompanyMemberView, topic: string): number {
    const s = m.ch.soma, b = m.ch.profile.bigFive, wp = m.wp;
    const Cn = sigmoid(b.C);
    const competence = clamp(0.5 * Cn + 0.3 * wp.stimulation + 0.2 * (1 - s.fatigue), 0, 1);
    return clamp(0.4 * competence + 0.3 * this.topicFit(m.id, topic) + 0.3 * Math.max(0, s.da_meso - 1), 0, 1);
  }

  private coordFor(m: CompanyMemberView, parent?: CompanyMemberView): number {
    if (!parent) return 1;
    const aff = m.ledger.get(parent.id)?.affection ?? 0;
    const ten = m.ledger.get(parent.id)?.tension ?? 0;
    const compat = bigFiveCompat(m.ch.profile.bigFive, parent.ch.profile.bigFive);
    return clamp(1 + 0.6 * aff - 0.8 * ten + 0.4 * (compat - 0.5) * 2, 0, 2);
  }

  private arbitrateKind(m: CompanyMemberView, team: TeamState, parent: NetMessage | undefined, parentAuthor?: CompanyMemberView): NetMsgKind {
    const s = m.ch.soma, b = m.ch.profile.bigFive, wp = m.wp;
    const Cn = sigmoid(b.C), On = sigmoid(b.O), Nn = sigmoid(b.N);
    const aff = parentAuthor ? (m.ledger.get(parentAuthor.id)?.affection ?? 0) : 0;
    const ten = parentAuthor ? (m.ledger.get(parentAuthor.id)?.tension ?? 0) : 0;
    const scores: Record<NetMsgKind, number> = {
      report: 0.4 * Cn + 0.3 * wp.workAnxiety + 0.3 * (1 - team.subgoal.progress),
      propose: 0.4 * wp.boredom + 0.3 * clamp(s.SEEKING, 0, 1) + 0.2 * On,
      support: 0.5 * sigmoid(b.A) + 0.4 * Math.max(0, aff) + 0.2 * Math.max(0, s.oxytocin - 1),
      question: 0.3 * (1 - Math.min(1, team.subgoal.momentum + 0.3)) + 0.3 * On + 0.2 * Nn,
      block: 0.5 * ten + 0.4 * Nn + 0.3 * clamp(s.RAGE, 0, 1),
      ack: 0.2,
      directive: -1,   // workers never issue directives
    };
    if (!parent) { scores.support -= 1; scores.block -= 1; scores.ack -= 0.5; } // a root can't reply
    let bestK: NetMsgKind = 'report', bestV = -Infinity;
    for (const k of Object.keys(scores) as NetMsgKind[]) {
      const v = scores[k] + (this.rng() - 0.5) * 0.15;
      if (v > bestV) { bestV = v; bestK = k; }
    }
    return bestK;
  }

  private applyProgress(team: TeamState, msg: NetMessage): void {
    const depGate = team.subgoal.dependsOn.length
      ? Math.min(...team.subgoal.dependsOn.map((id) => this.teams.find((t) => t.subgoal.id === id)?.subgoal.progress ?? 1))
      : 1;
    const delta = PROG_BASE * msg.quality * msg.coord * KF[msg.kind] * depGate;
    team.subgoal.progress = clamp(team.subgoal.progress + delta, 0, 1);
    team.subgoal.momentum = lerp(team.subgoal.momentum, clamp(delta / PROG_BASE, 0, 1), 0.3);
    team.subgoal.lastActivity = msg.t;
  }

  /** the two-way coupling: coordinated work rewards both bodies + deepens the SAME
   *  ledger a hallway chat builds; friction sours it. Work IS a social channel. */
  private applyCollabCoupling(m: CompanyMemberView, parent: CompanyMemberView | undefined, msg: NetMessage, clock: number): void {
    if (!parent) return;
    // both sides must have a ledger entry for the other before we can move the bond
    // (a first collaboration between strangers creates it — same as the commons chat).
    ensureBond(m.ledger, parent.id, this.nameById.get(parent.id) ?? parent.id);
    ensureBond(parent.ledger, m.id, this.nameById.get(m.id) ?? m.id);
    const warm = msg.coord - 1;                     // >0 synergy, <0 friction
    if (warm > 0 || msg.kind === 'support' || msg.kind === 'report') {
      const w = Math.max(0.05, warm);
      socialReward(m.ch.soma, 0.5 * w);
      socialReward(parent.ch.soma, 0.4 * w);
      updateBond(m.ledger.get(parent.id)!, m.ch.soma, parent.ch.soma, 0.12 * w, 0.1 * w, 0.2, 0.05);
      updateBond(parent.ledger.get(m.id)!, parent.ch.soma, m.ch.soma, 0.1 * w, 0.12 * w, 0.2, 0.05);
      m.ch.memory.add(clock, `Worked with ${this.nameById.get(parent.id)} on ${msg.topic}; it clicked.`, m.ch.soma);
    } else if (msg.kind === 'block' || msg.coord < 0.6) {
      const bad = Math.max(0.1, 0.6 - msg.coord);
      socialThreat(m.ch.soma, -bad);
      socialThreat(parent.ch.soma, -bad);
      updateBond(m.ledger.get(parent.id)!, m.ch.soma, parent.ch.soma, -0.12 * bad, -0.1 * bad, 0.2, 0.05);
      updateBond(parent.ledger.get(m.id)!, parent.ch.soma, m.ch.soma, -0.1 * bad, -0.12 * bad, 0.2, 0.05);
    }
  }

  private recomputeInfluence(byId: Map<string, CompanyMemberView>): void {
    this.netInfluence.clear();
    // influence = how much others BUILD ON your contributions (a later message replies
    // to yours) PLUS how much affection teammates hold toward you PLUS a little for
    // being outgoing. All three are emergent reads — nobody is appointed.
    const raw = new Map<string, number>();
    for (const msg of this.feed) {
      if (!msg.parentId) continue;
      const parent = this.feed.find((x) => x.id === msg.parentId);
      if (parent) raw.set(parent.fromId, (raw.get(parent.fromId) ?? 0) + msg.quality * msg.coord);
    }
    this.leaderByTeam.clear();
    for (const team of this.teams) {
      let bestId: string | undefined; let bestV = -Infinity;
      for (const id of team.memberIds) {
        // affection others on the team hold toward this member
        let aff = 0;
        for (const other of team.memberIds) {
          if (other === id) continue;
          const rel = byId.get(other)?.ledger.get(id);
          if (rel) aff += Math.max(0, rel.affection);
        }
        const En = byId.get(id) ? sigmoid(byId.get(id)!.ch.profile.bigFive.E) : 0.5;
        const infl = clamp((raw.get(id) ?? 0) + aff + 0.2 * En, 0, 3) / 3;
        this.netInfluence.set(id, infl);
        if (infl > bestV) { bestV = infl; bestId = id; }
      }
      const leader = bestId && bestV > 0.05 ? bestId : undefined;
      if (leader) this.leaderByTeam.set(team.id, leader);
      team.leaderId = leader;   // surface the emergent leader for the panel + output
    }
  }

  private driftTopics(msgs: NetMessage[], subgoalTopic: string): string[] {
    const counts = new Map<string, number>();
    for (const m of msgs) if (m.topic !== subgoalTopic) counts.set(m.topic, (counts.get(m.topic) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
  }

  private bestThemeFor(ids: string[], themes: GoalTheme[]): WorkTopic {
    let best: WorkTopic = themes[0]?.topic as WorkTopic ?? 'platform'; let bestFit = -1;
    for (const th of themes) {
      const fit = ids.reduce((s, id) => s + this.topicFit(id, th.topic), 0) / Math.max(1, ids.length) * th.priority;
      if (fit > bestFit) { bestFit = fit; best = th.topic as WorkTopic; }
    }
    return best;
  }

  private priorityOf(topic: string): number { return this.goal.themes.find((t) => t.topic === topic)?.priority ?? 0; }

  private pushMessage(msg: NetMessage): void {
    this.feed.push(msg);
    if (this.feed.length > MAX_FEED) this.feed.shift();
  }

  // ===================== public API ========================================
  /** the felt task-pressure a team's re-derived priority exerts (→ WorkCtx.demand). */
  demandFor(team: number): number {
    if (team < 0) return 0.12;
    return this.teams[team]?.demand ?? 0.15;
  }

  teamOf(id: string): number {
    for (const t of this.teams) if (t.memberIds.includes(id)) return t.id;
    return -1;
  }
  influenceOf(id: string): number { return this.netInfluence.get(id) ?? 0; }
  isLeader(id: string): boolean { for (const [, lid] of this.leaderByTeam) if (lid === id) return true; return false; }

  snapshot(): CompanySnapshot {
    return {
      goal: { ...this.goal, themes: this.goal.themes.map((t) => ({ ...t })) },
      teams: this.teams.map((t) => ({ ...t, subgoal: { ...t.subgoal, dependsOn: [...t.subgoal.dependsOn] }, memberIds: [...t.memberIds] })),
      feed: this.feed.slice(-MAX_FEED).reverse(),
      outputs: this.outputs.slice(-8).reverse(),
      bossId: this.bossId, bossName: this.bossName,
      bossValence: this.bossValence,
      planCountdown: Math.max(0, PLAN_INT - this.planAcc),
    };
  }

  // ---- persistence (identity/config rebuilt by the ctor; state overwritten) --
  toJSON(): CompanyJSON {
    return {
      rng: this.rng.save ? this.rng.save() : 0,
      teams: this.teams, goal: this.goal, feed: this.feed, outputs: this.outputs,
      netInfluence: [...this.netInfluence.entries()],
      leaderByTeam: [...this.leaderByTeam.entries()],
      postAcc: this.postAcc, standupAcc: this.standupAcc, planAcc: this.planAcc,
      outputsSincePlan: this.outputsSincePlan, bossValence: this.bossValence,
    };
  }
  loadJSON(j: CompanyJSON): void {
    if (this.rng.load) this.rng.load(j.rng);
    this.teams = j.teams; this.goal = j.goal; this.feed = j.feed; this.outputs = j.outputs;
    this.netInfluence = new Map(j.netInfluence);
    this.leaderByTeam = new Map(j.leaderByTeam);
    this.postAcc = j.postAcc; this.standupAcc = j.standupAcc; this.planAcc = j.planAcc;
    this.outputsSincePlan = j.outputsSincePlan; this.bossValence = j.bossValence;
  }
}

export interface CompanyJSON {
  rng: number;
  teams: TeamState[];
  goal: CompanyGoal;
  feed: NetMessage[];
  outputs: TeamOutput[];
  netInfluence: [string, number][];
  leaderByTeam: [number, string][];
  postAcc: number; standupAcc: number; planAcc: number;
  outputsSincePlan: number; bossValence: number;
}

// ---- helpers ---------------------------------------------------------------
let _eid = 900000;
function ev(kind: string, description: string, s: number, v: number): WorldEvent {
  return { id: `ce${(_eid++).toString(36)}`, kind, description, salienceHint: s, valenceHint: v, source: 'company' };
}

function ensureBond(ledger: Ledger, id: string, name: string): void {
  if (!ledger.has(id)) ledger.set(id, newRelationship(id, seedFromId(id), name));
}
function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function narrativeFrom(themes: GoalTheme[]): string {
  const top = themes.slice(0, 3).map((t) => t.topic);
  if (!top.length) return 'Keep the lights on.';
  const verbs: Record<string, string> = {
    platform: 'ship the platform', clients: 'win the enterprise clients', design: 'sharpen the design',
    research: 'go deep on research', growth: 'chase growth',
  };
  return `This quarter: ${top.map((t) => verbs[t] ?? t).join(', then ')}.`;
}

function composeNet(kind: NetMsgKind, topic: string, parentName: string | undefined, valence: number): string {
  const to = parentName ? `@${parentName} ` : '';
  switch (kind) {
    case 'directive': return `Focus everyone on ${topic}.`;
    case 'report': return `${to}Pushed ${topic} forward — got the core path working.`;
    case 'propose': return `What if we approached ${topic} differently? I have an idea.`;
    case 'support': return `${to}Yes — building on that, I can take the ${topic} side.`;
    case 'question': return `${to}Quick q on ${topic}: are we aligned on the approach?`;
    case 'block': return `${to}I don't think ${topic} works like that. We're going in circles.`;
    case 'ack': return `${to}Noted, thanks.`;
    default: return valence > 0 ? `On it.` : `Fine.`;
  }
}

// module id-counter accessors (for save/load reconciliation)
export function getCompanySeq(): [number, number] { return [_cid, _eid]; }
export function setCompanySeq(m: number, e: number): void { _cid = m; _eid = e; }
