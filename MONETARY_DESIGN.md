# Monetary System Design — a causal, stock-flow-consistent money layer

Research-grounded (BoE 2014 "Money creation in the modern economy"; Werner 2014;
Taylor 1993; Basel III; the modern US ample-reserves floor system). Two agents
produced this: a research pass built the causal US-banking model, a strategy pass
adapted it to the sim. See MONETARY_REPORT on the Desktop for the plain-language
account of how it all works.

## The causal spine
- **Money is a liability of its issuer, an asset of its holder.** Every transaction
  is a paired ± double-entry; the stock-flow invariant (`assets = liabilities +
  equity` for every entity; every instrument nets to zero across holders) is
  asserted each tick and surfaced as `conservationError`.
- **Base money (M0 = reserves + currency) is created ONLY by the Fed** — by
  acquiring assets (open-market operations / QE credit reserves) or lending to
  banks. `src/sim/econ/fed.ts`.
- **Broad money (deposits) is created ONLY when a bank makes a loan** (a loan asset
  + a matching deposit liability appear together — "loans create deposits", not the
  money multiplier) and destroyed on repayment. `src/sim/econ/banking.ts`.
- **Capital, not reserves, gates lending** (US reserve requirement = 0 since 2020):
  `CapitalGate = clamp((CET1 − CET1min)/buffer, 0, 1)`, CET1 floor 7%, target ~12%.
- **Interest is a transfer** of existing deposits into bank equity, never creation.

## The three balance sheets
- **Fed** — assets: securities, discount loans; liabilities: reserves, currency.
- **Commercial banks (2: Meridian Trust, Harbor Mutual)** — assets: reserves +
  loans + securities; liability: deposits; equity: capital.
- **Public (23 agents, 5 firms, the 240-household shadow sector)** — assets:
  deposits; liabilities: loans. Money the public holds = Σ deposits = broad money.
- A **rest-of-economy / External** sector is the counterparty for everything the sim
  doesn't model in full (COGS suppliers, wider-economy wages, external building
  buyers, landlords) so no flow appears from nowhere.

## Policy loop (this is what makes it causal)
```
Taylor rule (weekly):  i = ρ·i_prev + (1−ρ)[ r* + π + 1.5(π−π*) + 0.5·gap ]
   → banks price loans  r_L = policy + 3% + credit_spread
   → firms/construction draw/repay working-capital CREDIT LINES (create/destroy money)
   → investment + hiring move → output gap + unemployment (Okun) move
   → Phillips curve  π = π^e + κ·gap  drives a monetary price-level P (CPI = goods × P)
   → the Fed reacts to π and the gap … (loop closes)
```
IORB pays banks interest on reserves; net-interest margin drives bank equity, which
capital-gates the next round of lending (the macro-financial feedback).

## Financial services
Every firm (and construction) holds a deposit account + a working-capital **credit
line**: it draws when cash is low (money created) and repays when flush (money
destroyed) — so all companies can borrow to fund payroll and build projects, and
the business cycle becomes monetary (credit booms grow money; deleveraging shrinks it).

## Files
`fed.ts` (central bank), `banking.ts` (`CommercialBank`), `monetary.ts`
(`MonetarySystem` — accounts, credit primitives, the tick, conservation). Wired into
`econsim.ts`; construction borrows via the `Financier` interface. Rendered as the
Federal Reserve + a commercial bank building (`render/civicbank.ts`) with
proximity-only staff (`render/bankcrowd.ts`). Parameters scaled to the sim's
$100s–1000s money world (see `config.ts` `// ---- monetary ----`).

Conservation is exact by double-entry; `MonetaryView.conservationError` is the
standing regression guard (≈0).
