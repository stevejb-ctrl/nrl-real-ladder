#!/usr/bin/env node
// Monte Carlo: simulate every remaining match 10,000 times and aggregate
// where each team finishes. Reads data/ladder.json + data/draw.json,
// writes data/forecast.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LADDER_PATH = resolve(REPO_ROOT, 'data', 'ladder.json');
const DRAW_PATH = resolve(REPO_ROOT, 'data', 'draw.json');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'forecast.json');

const N_SIMS = 10_000;
const FORM_WEIGHT = 0.30;            // weight on last-5 form vs season-long win%
const PRIOR_GAMES = 8;               // Bayesian prior: pretend each team has N "ghost games" at 50%.
                                     // A 9-1 team becomes (9+4)/(10+8) = 72%, not 90%. Reflects that
                                     // observed records after 10 games are noisy estimates of true skill.
const FORM_PRIOR_GAMES = 1;          // Lighter prior on the 5-game form sample (Laplace smoothing).
const SKILL_SCALE = 4;               // Logistic spread on skill diff. ≈Elo 175-scale.
const HFA_LOGIT = 0.25;              // ~56% home win rate in an evenly matched game.
const MIN_WIN_PROB = 0.05;           // floor/ceiling so 0% teams don't get truly 0
const MAX_WIN_PROB = 0.95;

// Bayesian-regress an observed (wins, draws, played) toward 50% with a prior strength of `prior` games.
function regressWp(wins, draws, played, prior) {
  const w = wins + 0.5 * draws;
  return (w + 0.5 * prior) / (played + prior);
}

// Parse "4 - 1" → { wins, losses }; null on failure.
function parseFormPair(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return null;
  return { wins: +m[1], losses: +m[2] };
}

const ladder = JSON.parse(readFileSync(LADDER_PATH, 'utf8'));
const draw = JSON.parse(readFileSync(DRAW_PATH, 'utf8'));

const N_TEAMS = ladder.teams.length;
const FINALS_CUTOFF = 8;
const TOP_4 = 4;

// Build immutable per-team baseline.
const baseline = {};
for (const t of ladder.teams) {
  // Raw observed (kept for display purposes only).
  const rawSeasonWp = t.played > 0 ? (t.wins + 0.5 * t.draws) / t.played : 0.5;

  // Regressed estimates — the model uses these.
  const regressedSeasonWp = regressWp(t.wins, t.draws, t.played, PRIOR_GAMES);

  const formPair = parseFormPair(t.form);
  const rawFormWp = formPair && (formPair.wins + formPair.losses) > 0
    ? formPair.wins / (formPair.wins + formPair.losses)
    : null;
  const regressedFormWp = formPair
    ? regressWp(formPair.wins, 0, formPair.wins + formPair.losses, FORM_PRIOR_GAMES)
    : regressedSeasonWp;

  const skill = (1 - FORM_WEIGHT) * regressedSeasonWp + FORM_WEIGHT * regressedFormWp;
  baseline[t.slug] = {
    slug: t.slug,
    shortName: t.shortName,
    fullName: t.fullName,
    primary: t.primary,
    wins: t.wins,
    losses: t.losses,
    draws: t.draws,
    played: t.played,
    pointsDiff: t.pointsDiff,
    skill,
    rawSeasonWp,
    rawFormWp,
    regressedSeasonWp,
    regressedFormWp,
    officialPosition: t.officialPosition,
  };
}

function clamp(p) {
  if (p < MIN_WIN_PROB) return MIN_WIN_PROB;
  if (p > MAX_WIN_PROB) return MAX_WIN_PROB;
  return p;
}

function homeWinProb(homeSlug, awaySlug) {
  const sH = baseline[homeSlug].skill;
  const sA = baseline[awaySlug].skill;
  // Logistic on skill difference + home advantage logit.
  // SKILL_SCALE = 4 spreads the curve so a 30-pt skill gap gives ~76% win prob,
  // a 10-pt gap gives ~60%. HFA_LOGIT = 0.25 gives ~56% home in evenly matched.
  const z = SKILL_SCALE * (sH - sA) + HFA_LOGIT;
  return clamp(1 / (1 + Math.exp(-z)));
}

// Position arrays per team.
const positions = Object.fromEntries(Object.keys(baseline).map(s => [s, []]));
const projectedWins = Object.fromEntries(Object.keys(baseline).map(s => [s, []]));

const matches = draw.matches;
const slugs = Object.keys(baseline);

const t0 = Date.now();
for (let s = 0; s < N_SIMS; s++) {
  // Per-sim state — just wins/losses/played per team. We don't track
  // diff per-sim; we use frozen current pointsDiff as the tie-breaker.
  const sim = {};
  for (const slug of slugs) {
    const b = baseline[slug];
    sim[slug] = { wins: b.wins, losses: b.losses, draws: b.draws, played: b.played };
  }

  for (const m of matches) {
    const pHome = homeWinProb(m.home, m.away);
    if (Math.random() < pHome) {
      sim[m.home].wins++;
      sim[m.away].losses++;
    } else {
      sim[m.away].wins++;
      sim[m.home].losses++;
    }
    sim[m.home].played++;
    sim[m.away].played++;
  }

  // Final ladder for this sim — sort by win% desc, then frozen current pointsDiff.
  const standings = slugs.map(slug => {
    const x = sim[slug];
    const wp = x.played > 0 ? (x.wins + 0.5 * x.draws) / x.played : 0;
    return { slug, wp, diff: baseline[slug].pointsDiff, wins: x.wins };
  });
  standings.sort((a, b) => (b.wp - a.wp) || (b.diff - a.diff));
  standings.forEach((row, idx) => {
    positions[row.slug].push(idx + 1);
    projectedWins[row.slug].push(row.wins);
  });
}
const dur = Date.now() - t0;

// Aggregate.
function pct(arr, p) {
  // arr already sorted ascending. percentile by nearest-rank.
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)));
  return arr[idx];
}

const teams = {};
for (const slug of slugs) {
  const posArr = positions[slug].slice().sort((a, b) => a - b);
  const winsArr = projectedWins[slug].slice().sort((a, b) => a - b);

  const dist = new Array(N_TEAMS).fill(0);
  for (const p of posArr) dist[p - 1]++;
  for (let i = 0; i < N_TEAMS; i++) dist[i] /= N_SIMS;

  const finals = posArr.filter(p => p <= FINALS_CUTOFF).length / N_SIMS;
  const top4 = posArr.filter(p => p <= TOP_4).length / N_SIMS;
  const minor = posArr.filter(p => p === 1).length / N_SIMS;
  const spoon = posArr.filter(p => p === N_TEAMS).length / N_SIMS;

  teams[slug] = {
    shortName: baseline[slug].shortName,
    fullName: baseline[slug].fullName,
    primary: baseline[slug].primary,
    officialPosition: baseline[slug].officialPosition,
    currentWins: baseline[slug].wins,
    currentLosses: baseline[slug].losses,
    currentDraws: baseline[slug].draws,
    currentPlayed: baseline[slug].played,
    rawSeasonWp: +baseline[slug].rawSeasonWp.toFixed(4),
    regressedSeasonWp: +baseline[slug].regressedSeasonWp.toFixed(4),
    rawFormWp: baseline[slug].rawFormWp != null ? +baseline[slug].rawFormWp.toFixed(4) : null,
    regressedFormWp: +baseline[slug].regressedFormWp.toFixed(4),
    skill: +baseline[slug].skill.toFixed(4),
    finalsPct: +finals.toFixed(4),
    top4Pct: +top4.toFixed(4),
    minorPremPct: +minor.toFixed(4),
    woodenSpoonPct: +spoon.toFixed(4),
    projectedWins: {
      median: pct(winsArr, 0.5),
      p10: pct(winsArr, 0.1),
      p90: pct(winsArr, 0.9),
      mean: +(winsArr.reduce((a, b) => a + b, 0) / winsArr.length).toFixed(2),
    },
    projectedPosition: {
      median: pct(posArr, 0.5),
      p10: pct(posArr, 0.1),
      p90: pct(posArr, 0.9),
    },
    distribution: dist.map(x => +x.toFixed(4)),
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  ladderRound: ladder.round,
  ladderFetchedAt: ladder.fetchedAt,
  drawFetchedAt: draw.fetchedAt,
  remainingMatches: matches.length,
  nSims: N_SIMS,
  modelVersion: '1.1',
  modelDescription: 'Bayesian-regressed skill = 0.7 × regressed season win% + 0.3 × regressed last-5 form. Each team gets 8 ghost games at 50% as a prior, so a 9-1 record is treated as ~72% true skill, not 90%. P(home wins) = sigmoid(4 × (skill_home − skill_away) + 0.25). 10,000 sims.',
  weights: { formWeight: FORM_WEIGHT, priorGames: PRIOR_GAMES, formPriorGames: FORM_PRIOR_GAMES, skillScale: SKILL_SCALE, hfaLogit: HFA_LOGIT },
  durationMs: dur,
  teams,
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

// Validation print-out.
const totalFinals = Object.values(teams).reduce((s, t) => s + t.finalsPct, 0);
console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${N_SIMS.toLocaleString()} sims in ${dur}ms (${(dur / N_SIMS).toFixed(2)}ms/sim)`);
console.log(`  total finalsPct = ${totalFinals.toFixed(3)} (expect ≈ 8.00)`);
const top10 = Object.entries(teams)
  .sort((a, b) => b[1].finalsPct - a[1].finalsPct)
  .slice(0, 5);
console.log('  finals odds top 5:');
for (const [slug, t] of top10) {
  console.log(`    ${t.shortName.padEnd(11)} finals ${(t.finalsPct * 100).toFixed(1).padStart(5)}%  minor ${(t.minorPremPct * 100).toFixed(1).padStart(4)}%  spoon ${(t.woodenSpoonPct * 100).toFixed(1).padStart(4)}%`);
}
