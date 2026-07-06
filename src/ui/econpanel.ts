// =============================================================================
// econpanel.ts — a dashboard panel making the ECONOMY's emergent life legible:
//   the macro top-line (prices, joblessness, the business cycle), the Tier-B
//   firms grinding out profit or sliding into bankruptcy, the goods + housing
//   markets clearing by excess demand, the labour ticker of who got hired or
//   laid off, and the vast Tier-C shadow population whose demand drives it all.
//
//   Reads a pure EconSnapshot that the orchestrator hangs off the TownSnapshot
//   as `economy?`. Fully defensive: if the economy is still warming up it shows
//   a muted placeholder and returns. Self-mounts into the dashboard aside like
//   CompanyPanel, redraws only when a cheap signature changes (so it stays free
//   at 60fps — the econ clock ticks far slower than the frame loop), injects its
//   own scoped <style> once (house palette CSS vars), and never throws into the
//   render loop. Mirrors CompanyPanel / SocialFeedPanel.
// =============================================================================
import type {
  EconSnapshot,
  MacroAggregates,
  BusinessView,
  MarketView,
  HousingMarket,
  LaborMarketView,
  LaborEvent,
  ShadowPopView,
  ConstructionView,
  BankView,
  SupermarketView,
  MonetaryView,
} from '../sim/econ/types';

const STYLE_ID = 'econ-panel-style';

// affect anchors sampled straight from the house palette so interpolated ramps
// (unemployment green→red, firm-health red→green) sit on the same axis as the
// static --good / --accent used everywhere else.
const GOOD_RGB: readonly [number, number, number] = [53, 94, 59]; // --good  deep green
const BAD_RGB: readonly [number, number, number] = [122, 31, 18]; // --accent oxblood

// labour-event kind → glyph + affect class (colour lives in the stylesheet).
// growth/reward reads green, loss/ruin reads oxblood, lateral moves stay ink.
const EVENT_STYLE: Record<
  LaborEvent['kind'],
  { glyph: string; tone: 'good' | 'bad' | 'flat' }
> = {
  hire:     { glyph: '▲', tone: 'good' },
  found:    { glyph: '✦', tone: 'good' },
  promote:  { glyph: '★', tone: 'good' },
  quit:     { glyph: '↩', tone: 'flat' },
  fire:     { glyph: '▼', tone: 'bad' },
  layoff:   { glyph: '▼', tone: 'bad' },
  evict:    { glyph: '⌂', tone: 'bad' },
  bankrupt: { glyph: '✕', tone: 'bad' },
};

export class EconomyPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private cache = '';

  constructor(opts?: { mount?: HTMLElement }) {
    injectStyleOnce();

    // self-mount: honour an explicit mount, else the dashboard aside, else body.
    const mount =
      opts?.mount ??
      (typeof document !== 'undefined'
        ? document.getElementById('dashboard') ?? document.body
        : (undefined as unknown as HTMLElement));

    this.panel = el('div', 'panel econ-panel');

    // collapsible header — a .toggle button in the title folds the body away,
    // matching the brain panel's LIVE-toggle idiom (house .toggle class).
    const h2 = document.createElement('h2');
    h2.textContent = 'The Economy · prices, jobs, the cycle';
    const fold = document.createElement('button');
    fold.className = 'toggle econ-fold';
    fold.textContent = '−';
    fold.title = 'collapse';
    fold.onclick = () => {
      const hidden = this.body.classList.toggle('econ-hidden');
      fold.textContent = hidden ? '+' : '−';
      fold.classList.toggle('off', hidden);
    };
    h2.appendChild(fold);
    this.panel.appendChild(h2);

    this.body = el('div', 'econ-body');
    this.panel.appendChild(this.body);

    if (mount) mount.appendChild(this.panel);

    this.renderWarming();
  }

  update(snap: { economy?: EconSnapshot }): void {
    try {
      const econ = snap?.economy;
      if (!econ || !econ.macro) {
        if (this.cache !== '∅') {
          this.cache = '∅';
          this.renderWarming();
        }
        return;
      }

      // cheap signature — the econ clock advances on its own slow tick, so a
      // change here means the whole readout genuinely moved. Fold in the visible
      // cycle/price scalars + per-firm headcount + newest labour event so text-
      // only shifts between clock ticks still repaint.
      const sig = signature(econ);
      if (sig === this.cache) return;
      this.cache = sig;

      this.body.textContent = '';
      this.body.appendChild(this.buildMacro(econ.macro));
      this.body.appendChild(subHead('Businesses'));
      this.body.appendChild(this.buildBusinesses(econ.businesses));
      this.body.appendChild(subHead('Markets'));
      this.body.appendChild(this.buildMarkets(econ.markets, econ.housing));
      this.body.appendChild(subHead('Labour'));
      this.body.appendChild(this.buildLabour(econ.labor));
      if (econ.construction || econ.bank || econ.supermarket) {
        this.body.appendChild(subHead('City · construction · bank'));
        this.body.appendChild(this.buildCityDev(econ.construction, econ.bank, econ.supermarket));
      }
      if (econ.monetary) {
        this.body.appendChild(subHead('Money · Fed · banking'));
        this.body.appendChild(this.buildMoney(econ.monetary));
      }
      this.body.appendChild(subHead('Shadow population'));
      this.body.appendChild(this.buildShadow(econ.shadow));
    } catch {
      // the dashboard must never throw into the render loop
    }
  }

  dispose(): void {
    this.panel.remove();
  }

  // -- macro top-line ------------------------------------------------------
  // a grid of stat tiles: each is label / big value / affect sub-line. Colour
  // carries the mood — rising CPI + high joblessness read oxblood, growth green.
  private buildMacro(m: MacroAggregates): HTMLElement {
    const grid = el('div', 'econ-macro');

    // CPI — value stays ink; the arrow + inflation sub-line carry the affect.
    const infl = m.inflation ?? 0;
    const rising = infl > 0.002;
    const falling = infl < -0.002;
    const cpiArrow = rising ? '▲' : falling ? '▼' : '·';
    const cpiTone = rising ? BAD_RGB : falling ? GOOD_RGB : undefined;
    grid.appendChild(
      tile(
        'CPI',
        `${(m.cpi ?? 1).toFixed(2)} ${cpiArrow}`,
        `inflation ${signPct(infl, 1)}`,
        cpiTone ? rgb(cpiTone) : undefined,
      ),
    );

    // unemployment — green→red ramp, saturating to full oxblood by ~25%.
    const u = clamp01(m.unemployment ?? 0);
    grid.appendChild(
      tile('Unemployment', pct(u, 1), 'of the labour force', ramp(u / 0.25)),
    );

    // business cycle — a centred gauge with a marker at boom ∈ [-1,1].
    grid.appendChild(cycleTile(m.boom ?? 0));

    grid.appendChild(tile('GDP proxy', money(m.gdp ?? 0), 'produced / tick'));
    grid.appendChild(tile('Mean wage', money(m.meanWage ?? 0), 'per hour'));

    const homeless = Math.round(m.homelessCount ?? 0);
    grid.appendChild(
      tile(
        'Homeless',
        String(homeless),
        homeless > 0 ? 'without shelter' : 'all housed',
        homeless > 0 ? rgb(BAD_RGB) : rgb(GOOD_RGB),
      ),
    );

    // Gini — 0 equal .. 1 unequal; ramps toward oxblood as inequality rises.
    const g = clamp01(m.gini ?? 0);
    grid.appendChild(tile('Gini', g.toFixed(2), 'wealth inequality', ramp(g)));

    return grid;
  }

  // -- business grid -------------------------------------------------------
  private buildBusinesses(biz: BusinessView[]): HTMLElement {
    const grid = el('div', 'econ-biz-grid');
    if (!biz || !biz.length) {
      grid.appendChild(empty('— no firms trading —'));
      return grid;
    }
    for (const b of biz) grid.appendChild(bizCard(b));
    return grid;
  }

  // -- markets strip -------------------------------------------------------
  private buildMarkets(mk: MarketView[], housing: HousingMarket): HTMLElement {
    const wrap = el('div', 'econ-markets');
    if (mk && mk.length) for (const m of mk) wrap.appendChild(marketRow(m));
    else wrap.appendChild(empty('— markets quiet —'));
    if (housing) wrap.appendChild(housingRow(housing));
    return wrap;
  }

  // -- labour ticker -------------------------------------------------------
  private buildLabour(labor: LaborMarketView): HTMLElement {
    const wrap = el('div', 'econ-ticker');
    const evs = (labor?.recentEvents ?? []).slice(0, 8); // most-recent-first
    if (!evs.length) {
      wrap.appendChild(empty('— no moves on the labour market —'));
      return wrap;
    }
    for (const ev of evs) wrap.appendChild(eventRow(ev));
    return wrap;
  }

  // -- shadow summary ------------------------------------------------------
  private buildShadow(s: ShadowPopView): HTMLElement {
    const wrap = el('div', 'econ-shadow');
    if (!s || !s.n) {
      wrap.appendChild(empty('— no shadow households —'));
      return wrap;
    }
    // headline: the split of the crowd into employed / jobless / homeless.
    const head = el('div', 'econ-shadow-head');
    head.appendChild(shChip(`${s.n} households`, undefined));
    head.appendChild(shChip(`${s.employed} employed`, rgb(GOOD_RGB)));
    head.appendChild(
      shChip(`${s.unemployed} jobless`, s.unemployed > 0 ? rgb(BAD_RGB) : undefined),
    );
    head.appendChild(
      shChip(`${s.homeless} homeless`, s.homeless > 0 ? rgb(BAD_RGB) : undefined),
    );
    wrap.appendChild(head);

    // money distribution + the aggregate demand these households project.
    const stats = el('div', 'econ-shadow-stats');
    stats.appendChild(kv('mean', money(s.meanMoney ?? 0)));
    stats.appendChild(kv('median', money(s.medianMoney ?? 0)));
    stats.appendChild(kv('gini', clamp01(s.gini ?? 0).toFixed(2)));
    stats.appendChild(kv('agg. demand', fmtNum(s.aggregateDemand ?? 0)));
    wrap.appendChild(stats);
    return wrap;
  }

  // -- city development: construction firm + bank + supermarket inventory ----
  private buildCityDev(c?: ConstructionView, bk?: BankView, sm?: SupermarketView): HTMLElement {
    const wrap = el('div', 'econ-shadow');
    if (c) {
      const head = el('div', 'econ-shadow-head');
      head.appendChild(shChip(c.name, undefined));
      head.appendChild(shChip(`${c.workers} crew`, undefined));
      head.appendChild(shChip(`${c.completedBuildings} built`, rgb(GOOD_RGB)));
      if (c.activeProjects > 0) head.appendChild(shChip('building…', rgb(GOOD_RGB)));
      head.appendChild(shChip(`${c.lotsFree} lots free`, undefined));
      wrap.appendChild(head);
      const stats = el('div', 'econ-shadow-stats');
      stats.appendChild(kv('site cash', money(c.cash)));
      stats.appendChild(kv('loan owed', money(c.loanBalance)));
      wrap.appendChild(stats);
    }
    if (bk) {
      const stats = el('div', 'econ-shadow-stats');
      stats.appendChild(kv('bank capital', money(bk.capital)));
      stats.appendChild(kv('loans out', money(bk.balanceOutstanding)));
      stats.appendChild(kv('total lent', money(bk.totalLent)));
      stats.appendChild(kv('interest earned', money(bk.interestIncome)));
      wrap.appendChild(stats);
    }
    if (sm) {
      const head = el('div', 'econ-shadow-head');
      head.appendChild(shChip(sm.name, undefined));
      head.appendChild(shChip(`${Math.round((sm.fillLevel ?? 0) * 100)}% stocked`, (sm.fillLevel ?? 0) < 0.3 ? rgb(BAD_RGB) : rgb(GOOD_RGB)));
      head.appendChild(shChip(`${fmtNum(sm.trips ?? 0)} trips`, undefined));
      wrap.appendChild(head);
      const stats = el('div', 'econ-shadow-stats');
      for (const cat of sm.categories ?? []) stats.appendChild(kv(cat.label, `${Math.round((cat.stock / Math.max(1, cat.capacity)) * 100)}%`));
      wrap.appendChild(stats);
    }
    return wrap;
  }

  // -- money & banking: Fed policy, base/broad money, per-bank balance sheets ---
  private buildMoney(m: MonetaryView): HTMLElement {
    const wrap = el('div', 'econ-shadow');
    const f = m.fed;
    // Fed policy header
    const head = el('div', 'econ-shadow-head');
    head.appendChild(shChip(`Fed ${pct(f.policyRate, 2)}`, undefined));
    head.appendChild(shChip(`IORB ${pct(f.iorb, 2)}`, undefined));
    head.appendChild(shChip(`prime ${pct(f.policyRate + 0.03, 2)}`, undefined));
    // conservation LED — green when the double-entry balances, red if money leaks.
    const ok = Math.abs(m.conservationError) < Math.max(1, m.broadMoney) * 1e-3;
    head.appendChild(shChip(ok ? '✓ money conserved' : '⚠ leak', ok ? rgb(GOOD_RGB) : rgb(BAD_RGB)));
    wrap.appendChild(head);
    // money stocks
    const stats = el('div', 'econ-shadow-stats');
    stats.appendChild(kv('base money M0', money(m.baseMoney)));
    stats.appendChild(kv('broad money M2', money(m.broadMoney)));
    stats.appendChild(kv('money growth', pct(m.moneyGrowth, 3) + '/tick'));
    stats.appendChild(kv('avg loan rate', pct(m.avgLendingRate, 2)));
    stats.appendChild(kv('credit created', money(m.creditCreated)));
    stats.appendChild(kv('Fed securities', money(f.securities)));
    wrap.appendChild(stats);
    // per-bank balance sheets
    for (const b of m.banks) {
      const row = el('div', 'econ-shadow-head');
      row.appendChild(shChip(b.name, b.solvent ? undefined : rgb(BAD_RGB)));
      row.appendChild(shChip(`dep ${money(b.deposits)}`, undefined));
      row.appendChild(shChip(`loans ${money(b.loans)}`, undefined));
      row.appendChild(shChip(`cap ${money(b.capital)}`, rgb(GOOD_RGB)));
      row.appendChild(shChip(`CET1 ${pct(b.capitalRatio, 0)}`, undefined));
      if (!b.solvent) row.appendChild(shChip('INSOLVENT', rgb(BAD_RGB)));
      wrap.appendChild(row);
    }
    return wrap;
  }

  private renderWarming(): void {
    this.body.textContent = '';
    const e = empty('economy: warming up…');
    this.body.appendChild(e);
  }
}

// ---------------------------------------------------------------------------
// component builders
// ---------------------------------------------------------------------------
function tile(label: string, value: string, sub: string, valueColor?: string): HTMLElement {
  const t = el('div', 'econ-tile');
  const l = el('div', 'econ-tile-l');
  l.textContent = label;
  const v = el('div', 'econ-tile-v');
  v.textContent = value;
  if (valueColor) v.style.color = valueColor;
  const s = el('div', 'econ-tile-s');
  s.textContent = sub;
  t.append(l, v, s);
  return t;
}

// the business-cycle gauge: a track with a centre (0) tick and a marker slid to
// boom's position; the marker + word turn green in a boom, oxblood in a bust.
function cycleTile(boom: number): HTMLElement {
  const b = clamp(boom, -1, 1);
  const t = el('div', 'econ-tile');
  const l = el('div', 'econ-tile-l');
  l.textContent = 'Cycle';

  const word = b > 0.15 ? 'BOOM' : b < -0.15 ? 'BUST' : 'steady';
  const color = b > 0.15 ? rgb(GOOD_RGB) : b < -0.15 ? rgb(BAD_RGB) : undefined;
  const v = el('div', 'econ-tile-v');
  v.textContent = word;
  if (color) v.style.color = color;

  const gauge = el('div', 'econ-gauge');
  const mid = el('div', 'econ-gauge-mid'); // the zero line
  const mark = el('div', 'econ-gauge-mark');
  mark.style.left = `${Math.round(((b + 1) / 2) * 100)}%`;
  if (color) mark.style.background = color;
  gauge.append(mid, mark);

  t.append(l, v, gauge);
  return t;
}

function bizCard(b: BusinessView): HTMLElement {
  const card = el('div', 'econ-biz');
  if (b.bankrupt) card.classList.add('bankrupt');

  // header: name + sector chip
  const head = el('div', 'econ-biz-head');
  const name = el('span', 'econ-biz-n');
  name.textContent = b.name || b.id;
  name.title = b.name || b.id;
  const chip = el('span', 'econ-chip');
  chip.textContent = (b.sector ?? '').toUpperCase();
  head.append(name, chip);
  card.appendChild(head);

  // money line: cash · price · wage
  const money$ = el('div', 'econ-biz-money');
  money$.innerHTML =
    `<span title="cash on hand">${money(b.cash ?? 0)}</span>` +
    `<span class="econ-dot">·</span>` +
    `<span title="unit price">${money(b.price ?? 0)}</span>` +
    `<span class="econ-dot">·</span>` +
    `<span title="offered wage">${money(b.wage ?? 0)}/h</span>`;
  card.appendChild(money$);

  // staffing: headcount / desired + a hiring / steady / layoffs badge
  const staff = el('div', 'econ-biz-staff');
  const count = el('span', 'econ-biz-count');
  count.textContent = `${b.headcount}/${b.desiredHeadcount} staff`;
  const gap = (b.desiredHeadcount ?? 0) - (b.headcount ?? 0);
  const badge = el('span', 'econ-badge');
  if (b.hiring && gap > 0) {
    badge.classList.add('good');
    badge.textContent = 'hiring ▲';
  } else if (gap < 0) {
    badge.classList.add('bad');
    badge.textContent = 'layoffs ▼';
  } else {
    badge.classList.add('flat');
    badge.textContent = 'steady';
  }
  staff.append(count, badge);
  card.appendChild(staff);

  // profit (last tick), coloured ±
  const profit = b.profit ?? 0;
  const pf = el('div', 'econ-biz-profit');
  pf.textContent = `${profit >= 0 ? 'profit' : 'loss'} ${money(profit)}/tick`;
  pf.style.color = profit >= 0 ? rgb(GOOD_RGB) : rgb(BAD_RGB);
  card.appendChild(pf);

  // health bar (0..1): fill width = health, colour ramps red(low)→green(high)
  const h = clamp01(b.health ?? 0);
  const track = el('div', 'econ-hbar');
  const fill = el('div', 'econ-hbar-f');
  fill.style.width = `${Math.round(h * 100)}%`;
  fill.style.background = ramp(1 - h);
  track.appendChild(fill);
  card.appendChild(track);

  if (b.bankrupt) {
    const flag = el('div', 'econ-flag');
    flag.textContent = 'BANKRUPT';
    card.appendChild(flag);
  }
  return card;
}

function marketRow(m: MarketView): HTMLElement {
  const row = el('div', 'econ-mkt');
  const name = el('span', 'econ-mkt-n');
  name.textContent = m.sector ?? '—';
  const price = el('span', 'econ-mkt-p');
  price.textContent = money(m.price ?? 0);

  const infl = m.inflation ?? 0;
  const inf = el('span', 'econ-mkt-i');
  inf.textContent = signPct(infl, 1);
  inf.style.color = infl > 0.002 ? rgb(BAD_RGB) : infl < -0.002 ? rgb(GOOD_RGB) : '';

  // shortage bar: unmet demand fraction, oxblood as scarcity bites.
  const sh = clamp01(m.shortage ?? 0);
  const track = el('div', 'econ-mkt-bar');
  const fill = el('div', 'econ-mkt-bar-f');
  fill.style.width = `${Math.round(sh * 100)}%`;
  fill.title = `shortage ${pct(sh, 0)}`;
  track.appendChild(fill);

  row.append(name, price, inf, track);
  return row;
}

function housingRow(h: HousingMarket): HTMLElement {
  const row = el('div', 'econ-mkt econ-housing');
  const name = el('span', 'econ-mkt-n');
  name.textContent = 'housing';
  const price = el('span', 'econ-mkt-p');
  price.textContent = `${money(h.rent ?? 0)}/mo`;

  const vac = clamp01(h.vacancyRate ?? 0);
  const v = el('span', 'econ-mkt-i');
  v.textContent = `${pct(vac, 0)} vac`;
  // tight housing (low vacancy) reads oxblood; slack housing reads green.
  v.style.color = vac < 0.05 ? rgb(BAD_RGB) : vac > 0.2 ? rgb(GOOD_RGB) : '';

  const track = el('div', 'econ-mkt-bar');
  const fill = el('div', 'econ-mkt-bar-f');
  fill.style.width = `${Math.round((1 - vac) * 100)}%`; // occupancy fills the bar
  fill.style.background = 'var(--ink-soft)';
  fill.title = `occupancy ${pct(1 - vac, 0)}`;
  track.appendChild(fill);

  row.append(name, price, v, track);
  return row;
}

function eventRow(ev: LaborEvent): HTMLElement {
  const st = EVENT_STYLE[ev.kind] ?? { glyph: '·', tone: 'flat' as const };
  const row = el('div', `econ-ev econ-ev--${st.tone}`);
  const g = el('span', 'econ-ev-g');
  g.textContent = st.glyph;
  const txt = el('span', 'econ-ev-t');
  txt.textContent = eventText(ev);
  txt.title = txt.textContent;
  row.append(g, txt);
  return row;
}

function shChip(text: string, color?: string): HTMLElement {
  const c = el('span', 'econ-sh-chip');
  c.textContent = text;
  if (color) c.style.color = color;
  return c;
}

function kv(k: string, v: string): HTMLElement {
  const row = el('div', 'econ-kv');
  const kk = el('span', 'econ-kv-k');
  kk.textContent = k;
  const vv = el('span', 'econ-kv-v');
  vv.textContent = v;
  row.append(kk, vv);
  return row;
}

function subHead(text: string): HTMLElement {
  const e = el('div', 'econ-sub');
  e.textContent = text;
  return e;
}

function empty(text: string): HTMLElement {
  const e = el('div', 'econ-empty');
  e.textContent = text;
  return e;
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------
// compose a readable one-liner for the labour ticker from the event's parts.
function eventText(ev: LaborEvent): string {
  const who = ev.agentName || (ev.agentId ? shortId(ev.agentId) : 'someone');
  const at = ev.businessName ? ` at ${ev.businessName}` : '';
  const from = ev.businessName ? ` from ${ev.businessName}` : '';
  switch (ev.kind) {
    case 'hire':     return `${who} hired${at}`;
    case 'fire':     return `${who} fired${from}`;
    case 'layoff':   return `${who} laid off${from}`;
    case 'quit':     return `${who} quit${from}`;
    case 'promote':  return `${who} promoted${at}`;
    case 'evict':    return `${who} evicted`;
    case 'found':    return `${ev.businessName || who} founded`;
    case 'bankrupt': return `${ev.businessName || who} went bankrupt`;
    default:         return ev.detail || `${who} · ${String(ev.kind)}`;
  }
}

// ---------------------------------------------------------------------------
// signature — cheap change-detector (see CompanyPanel.signature)
// ---------------------------------------------------------------------------
function signature(e: EconSnapshot): string {
  const m = e.macro;
  const biz = (e.businesses ?? [])
    .map((b) => `${b.headcount}/${b.desiredHeadcount}${b.bankrupt ? 'x' : ''}${b.hiring ? '+' : ''}`)
    .join(',');
  const evt = e.labor?.recentEvents?.[0]?.t ?? '';
  const dev = e.construction
    ? `${e.construction.completedBuildings}/${e.construction.activeProjects}/${e.construction.workers}`
    : '';
  const sm = e.supermarket ? `${(e.supermarket.fillLevel ?? 0).toFixed(2)}` : '';
  const mon = e.monetary ? `${e.monetary.fed.policyRate.toFixed(4)}:${e.monetary.broadMoney.toFixed(0)}` : '';
  return (
    `${m.clock | 0}|${(m.boom ?? 0).toFixed(2)}|${(m.cpi ?? 1).toFixed(3)}|` +
    `${(m.unemployment ?? 0).toFixed(3)}|${biz}|${evt}|${(e.businesses ?? []).length}|${dev}|${sm}|${mon}`
  );
}

// ---------------------------------------------------------------------------
// formatting + colour helpers
// ---------------------------------------------------------------------------
function money(v: number): string {
  if (!Number.isFinite(v)) return '$0';
  const a = Math.abs(v);
  const s = v < 0 ? '−' : ''; // U+2212 minus for tabular typography
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  if (a >= 100) return `${s}$${a.toFixed(0)}`;
  return `${s}$${a.toFixed(2)}`;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

function pct(v: number, digits = 0): string {
  return `${(clamp01(v) * 100).toFixed(digits)}%`;
}

// signed percentage for inflation-style deltas (may be negative, unclamped).
function signPct(v: number, digits = 1): string {
  const p = (Number.isFinite(v) ? v : 0) * 100;
  const s = p > 0.05 ? '+' : '';
  return `${s}${p.toFixed(digits)}%`;
}

function rgb(c: readonly [number, number, number]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// interpolate good(green)→bad(oxblood) as t: 0→1; used for ramps where higher = worse.
function ramp(t: number): string {
  const k = clamp01(t);
  const r = Math.round(GOOD_RGB[0] + (BAD_RGB[0] - GOOD_RGB[0]) * k);
  const g = Math.round(GOOD_RGB[1] + (BAD_RGB[1] - GOOD_RGB[1]) * k);
  const b = Math.round(GOOD_RGB[2] + (BAD_RGB[2] - GOOD_RGB[2]) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : Number.isFinite(v) ? v : lo;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function shortId(id?: string): string {
  if (!id) return 'someone';
  const stripped = id.replace(/^(agent-|sh)/i, '');
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : 'someone';
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

// ---------------------------------------------------------------------------
// scoped stylesheet — injected exactly once, keyed on the house CSS custom
// props (ink on aged sepia) so it matches the .town-* / .company-* idiom even
// with no external CSS. Greens carry growth/hiring; oxblood carries loss.
// ---------------------------------------------------------------------------
function injectStyleOnce(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.econ-body { display: flex; flex-direction: column; }
.econ-body.econ-hidden { display: none; }
.econ-empty { font-size: 11px; color: var(--ink-faint); font-style: italic; }
.econ-fold { margin-left: auto; padding: 0 6px; font-size: 12px; line-height: 1.4; }

/* shared sub-header (mirrors .town-sub / .company-sub) */
.econ-sub {
  font-size: 10px; font-weight: 600; letter-spacing: 0.28em; text-transform: uppercase;
  color: var(--ink-soft); margin: 11px 0 5px;
}

/* -- macro tiles -- */
.econ-macro {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 6px;
}
.econ-tile {
  border: 1px solid var(--line-faint); padding: 5px 6px 6px;
  display: flex; flex-direction: column; gap: 1px; min-width: 0;
}
.econ-tile-l {
  font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.econ-tile-v {
  font-size: 16px; color: var(--ink); font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em; line-height: 1.15;
}
.econ-tile-s {
  font-size: 8.5px; color: var(--ink-faint); letter-spacing: 0.02em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* business-cycle gauge */
.econ-gauge { position: relative; height: 6px; margin-top: 3px; background: var(--line-faint); }
.econ-gauge-mid { position: absolute; left: 50%; top: -1px; width: 1px; height: 8px; background: var(--ink-faint); }
.econ-gauge-mark {
  position: absolute; top: -2px; width: 3px; height: 10px; background: var(--ink);
  transform: translateX(-50%); transition: left 0.35s;
}

/* -- business grid -- */
.econ-biz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; }
.econ-biz {
  border: 1px solid var(--line-faint); padding: 6px 7px;
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
}
.econ-biz.bankrupt { border-color: rgba(122, 31, 18, 0.5); background: rgba(122, 31, 18, 0.05); opacity: 0.82; }
.econ-biz-head { display: flex; align-items: baseline; gap: 6px; }
.econ-biz-n {
  font-size: 12px; color: var(--ink); flex: 1; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.econ-chip {
  flex-shrink: 0; font-size: 7.5px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-soft); border: 1px solid var(--line-faint); border-radius: 2px; padding: 0 4px;
}
.econ-biz-money {
  font-size: 10.5px; color: var(--ink-soft); font-variant-numeric: tabular-nums;
  display: flex; gap: 4px; align-items: baseline; flex-wrap: wrap;
}
.econ-dot { color: var(--ink-faint); }
.econ-biz-staff { display: flex; align-items: baseline; gap: 6px; }
.econ-biz-count { font-size: 10px; color: var(--ink-soft); flex: 1; font-variant-numeric: tabular-nums; }
.econ-badge {
  flex-shrink: 0; font-size: 8px; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0 4px; border: 1px solid var(--line-faint); border-radius: 2px;
}
.econ-badge.good { color: var(--good); border-color: rgba(53, 94, 59, 0.45); }
.econ-badge.bad  { color: var(--accent); border-color: rgba(122, 31, 18, 0.45); }
.econ-badge.flat { color: var(--ink-faint); }
.econ-biz-profit { font-size: 10px; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.econ-hbar { height: 5px; background: var(--line-faint); margin-top: 1px; }
.econ-hbar-f { height: 100%; width: 0%; transition: width 0.35s; }
.econ-flag {
  font-size: 8.5px; font-weight: 700; letter-spacing: 0.22em; text-align: center;
  color: var(--paper); background: var(--accent); padding: 1px 0; margin-top: 2px;
}

/* -- markets strip -- */
.econ-markets { display: flex; flex-direction: column; gap: 3px; }
.econ-mkt {
  display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.econ-mkt-n { width: 62px; text-transform: capitalize; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.econ-mkt-p { width: 54px; text-align: right; color: var(--ink); }
.econ-mkt-i { width: 52px; text-align: right; }
.econ-mkt-bar { flex: 1; height: 6px; background: var(--line-faint); min-width: 24px; }
.econ-mkt-bar-f { height: 100%; width: 0%; background: var(--accent); transition: width 0.35s; }
.econ-housing { margin-top: 3px; padding-top: 4px; border-top: 1px solid var(--line-faint); }

/* -- labour ticker -- */
.econ-ticker { display: flex; flex-direction: column; gap: 2px; max-height: 128px; overflow-y: auto; }
.econ-ticker::-webkit-scrollbar { width: 8px; }
.econ-ticker::-webkit-scrollbar-thumb { background: var(--line-faint); }
.econ-ev { display: flex; gap: 6px; align-items: baseline; font-size: 10.5px; line-height: 1.35; }
.econ-ev-g { flex-shrink: 0; width: 10px; text-align: center; font-size: 10px; }
.econ-ev-t { color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.econ-ev--good .econ-ev-g { color: var(--good); }
.econ-ev--good .econ-ev-t { color: var(--ink); }
.econ-ev--bad  .econ-ev-g { color: var(--accent); }
.econ-ev--bad  .econ-ev-t { color: var(--ink); }
.econ-ev--flat .econ-ev-g { color: var(--ink-faint); }

/* -- shadow population -- */
.econ-shadow { display: flex; flex-direction: column; gap: 5px; }
.econ-shadow-head { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.econ-sh-chip {
  font-size: 9.5px; color: var(--ink-soft); border: 1px solid var(--line-faint);
  border-radius: 2px; padding: 1px 5px; font-variant-numeric: tabular-nums;
}
.econ-shadow-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
.econ-kv { display: flex; justify-content: space-between; font-size: 10px; color: var(--ink-soft); }
.econ-kv-k { letter-spacing: 0.04em; }
.econ-kv-v { color: var(--ink); font-variant-numeric: tabular-nums; }
`;
  document.head.appendChild(style);
}
