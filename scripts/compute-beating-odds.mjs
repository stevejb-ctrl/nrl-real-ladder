#!/usr/bin/env node
// Joins data/odds.json (closing odds) with data/results.json (match results)
// and aggregates per-team performance against the closing market:
//   - cumulative units betting 1 unit on each team every game
//   - actual wins vs expected (overround-normalised implied prob)
//
// Output: data/beating-odds.json with per-team aggregates AND per-round
// cumulative-units trajectories, plus a flat list of joined games so the
// page can render hover tooltips without re-joining.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ODDS_PATH = resolve(REPO_ROOT, 'data', 'odds.json');
const RESULTS_PATH = resolve(REPO_ROOT, 'data', 'results.json');
const LADDER_PATH = resolve(REPO_ROOT, 'data', 'ladder.json');
const LOGOS_DIR = resolve(REPO_ROOT, 'assets', 'logos');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'beating-odds.json');

const FUZZY_DAYS = 3; // tolerance for the date join — Vegas openers shift ±1 day

const odds = JSON.parse(readFileSync(ODDS_PATH, 'utf8'));
const results = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
const ladder = JSON.parse(readFileSync(LADDER_PATH, 'utf8'));

const logoBySlug = existsSync(LOGOS_DIR)
  ? Object.fromEntries(
      readdirSync(LOGOS_DIR)
        .filter(f => /\.(svg|png|jpe?g|webp)$/i.test(f))
        .map(f => [basename(f, extname(f)), `assets/logos/${f}`])
    )
  : {};

const teamMeta = Object.fromEntries(
  ladder.teams.map(t => [t.slug, {
    slug: t.slug,
    shortName: t.shortName,
    fullName: t.fullName,
    primary: t.primary,
    secondary: t.secondary,
    initials: t.initials,
    logo: logoBySlug[t.slug] ?? null,
  }])
);

function daysBetween(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Math.abs((tb - ta) / 86_400_000);
}

// Fuzzy join: for each odds row, find the results row with the same (home,
// away) and the smallest |date_diff|. If two-leg matchups exist, the nearest
// date wins. Drops rows that have no result within FUZZY_DAYS.
function joinOddsToResults() {
  const byPair = new Map();
  for (const r of results.matches) {
    const k = `${r.home}|${r.away}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }

  const joined = [];
  const missing = [];
  for (const o of odds.matches) {
    const candidates = byPair.get(`${o.home}|${o.away}`) || [];
    let best = null, bestDiff = Infinity;
    for (const c of candidates) {
      const d = daysBetween(o.date, c.date);
      if (d <= FUZZY_DAYS && d < bestDiff) { best = c; bestDiff = d; }
    }
    if (!best) { missing.push(o); continue; }
    joined.push({ odds: o, result: best });
  }
  return { joined, missing };
}

// Three-way overround removal: divide each raw implied prob by the sum so
// the normalised probs add to 1.
function normaliseProbs(home_close, away_close, draw_close) {
  const ph = home_close > 0 ? 1 / home_close : 0;
  const pa = away_close > 0 ? 1 / away_close : 0;
  const pd = draw_close > 0 ? 1 / draw_close : 0;
  const total = ph + pa + pd;
  if (total <= 0) return { home: 0, away: 0, draw: 0, overround: null };
  return {
    home: ph / total,
    away: pa / total,
    draw: pd / total,
    overround: total - 1, // bookmaker margin
  };
}

const { joined, missing } = joinOddsToResults();

// Per-team accumulators.
const teams = {};
for (const slug of Object.keys(teamMeta)) {
  teams[slug] = {
    ...teamMeta[slug],
    games_with_odds: 0,
    actual_wins: 0,
    actual_losses: 0,
    actual_draws: 0,
    expected_wins: 0,
    units_total: 0,
    units_by_round: {},   // round → cumulative units AFTER that round
    games: [],            // per-game ledger (for tooltips)
  };
}

// Walk joined games in round order, then chronological within round, so the
// units_by_round series is monotone-by-round.
joined.sort((a, b) => a.result.round - b.result.round
  || a.result.date.localeCompare(b.result.date)
  || (a.result.kickOff ?? '').localeCompare(b.result.kickOff ?? ''));

for (const { odds: o, result: r } of joined) {
  const ho = o.home_close, ao = o.away_close, dc = o.draw_close;
  if (ho == null || ao == null) continue;

  const probs = normaliseProbs(ho, ao, dc);

  // Resolve outcome from the result row (authoritative — odds row has scores
  // too but the NRL API is the source of truth).
  let homeOutcome, awayOutcome; // 'W' | 'L' | 'D'
  if (r.draw) { homeOutcome = 'D'; awayOutcome = 'D'; }
  else if (r.winner === r.home) { homeOutcome = 'W'; awayOutcome = 'L'; }
  else { homeOutcome = 'L'; awayOutcome = 'W'; }

  const unitFor = (outcome, closingOdds) => {
    if (outcome === 'W') return +(closingOdds - 1);
    if (outcome === 'L') return -1;
    return 0; // draw → push
  };

  for (const [slug, side, outcome, closeOdds, prob] of [
    [r.home, 'home', homeOutcome, ho, probs.home],
    [r.away, 'away', awayOutcome, ao, probs.away],
  ]) {
    const t = teams[slug];
    if (!t) continue;
    const delta = unitFor(outcome, closeOdds);
    t.units_total += delta;
    t.units_by_round[r.round] = +(t.units_total).toFixed(4);
    t.games_with_odds++;
    if (outcome === 'W') t.actual_wins++;
    else if (outcome === 'L') t.actual_losses++;
    else t.actual_draws++;
    t.expected_wins += prob;
    t.games.push({
      round: r.round,
      date: r.date,
      side,
      opponent: side === 'home' ? r.away : r.home,
      score: side === 'home' ? `${r.homeScore}-${r.awayScore}` : `${r.awayScore}-${r.homeScore}`,
      outcome,
      closeOdds,
      impliedProb: +prob.toFixed(4),
      units: +delta.toFixed(4),
      cumulative: +t.units_total.toFixed(4),
    });
  }
}

// Build per-team round-trajectory arrays. The chart needs an entry for
// EVERY round through the latest played round, so a team that had a bye in
// round R just carries its running total forward.
const playedRounds = [...new Set(joined.map(j => j.result.round))].sort((a, b) => a - b);
const lastRound = playedRounds.length ? Math.max(...playedRounds) : 0;

for (const slug of Object.keys(teams)) {
  const t = teams[slug];
  const series = [];
  let last = 0;
  for (let r = 1; r <= lastRound; r++) {
    if (t.units_by_round[r] != null) last = t.units_by_round[r];
    series.push({ round: r, cumulative: +last.toFixed(4) });
  }
  t.units_series = series;
  t.units_total = +t.units_total.toFixed(4);
  t.expected_wins = +t.expected_wins.toFixed(4);
  t.wins_above_expected = +(t.actual_wins - t.expected_wins).toFixed(4);
  delete t.units_by_round; // dropped — series is the canonical form
}

const out = {
  generatedAt: new Date().toISOString(),
  season: ladder.season,
  ladderRound: ladder.round,
  oddsSource: odds.source,
  oddsFetchedAt: odds.fetchedAt,
  resultsFetchedAt: results.fetchedAt,
  matchesWithOddsAndResult: joined.length,
  matchesWithOddsButNoResult: missing.length,
  fuzzyDays: FUZZY_DAYS,
  lastRound,
  teams,
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

// Console summary — sanity-check + visibility in the cron log.
console.log(`Wrote ${OUT_PATH}`);
console.log(`  joined ${joined.length} games, missing ${missing.length}, last round ${lastRound}`);
if (missing.length) {
  console.warn(`  missing rows (no result within ${FUZZY_DAYS} days):`);
  missing.slice(0, 5).forEach(o => console.warn(`    ${o.date}  ${o.home} vs ${o.away}`));
}

const list = Object.values(teams).filter(t => t.games_with_odds > 0);
const topUnits = [...list].sort((a, b) => b.units_total - a.units_total).slice(0, 5);
const topWAE = [...list].sort((a, b) => b.wins_above_expected - a.wins_above_expected).slice(0, 5);
console.log(`  Top 5 cumulative units:`);
topUnits.forEach(t => console.log(`    ${t.shortName.padEnd(11)} ${t.units_total >= 0 ? '+' : ''}${t.units_total.toFixed(2)}u  (${t.actual_wins}W ${t.actual_losses}L ${t.actual_draws ? t.actual_draws + 'D' : ''} from ${t.games_with_odds} games)`));
console.log(`  Top 5 wins above expected:`);
topWAE.forEach(t => console.log(`    ${t.shortName.padEnd(11)} ${t.wins_above_expected >= 0 ? '+' : ''}${t.wins_above_expected.toFixed(2)}  (actual ${t.actual_wins}, expected ${t.expected_wins.toFixed(2)})`));
