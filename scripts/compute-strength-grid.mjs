#!/usr/bin/env node
// Compute "strength grid": for each team, what's their win-rate against the
// top-8 (strong opposition) vs the bottom-9 (weak opposition).
//
// Inputs:  data/ladder.json (defines the top-8 split via officialPosition)
//          data/results.json (head-to-head completed matches)
// Output:  data/strength-grid.json
//
// Win-rate uses the site convention: (wins + 0.5 × draws) ÷ played.
// A team's own self-game is naturally never in its own count.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LADDER_PATH = resolve(REPO_ROOT, 'data', 'ladder.json');
const RESULTS_PATH = resolve(REPO_ROOT, 'data', 'results.json');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'strength-grid.json');

const TOP_CUTOFF = 8;

const ladder = JSON.parse(readFileSync(LADDER_PATH, 'utf8'));
const results = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));

// Top 8 / bottom 9 split based on THIS SITE'S real ladder — (W + 0.5D) / P
// desc with pointsDiff as tiebreak, mirroring the sort in index.html. This is
// the whole point of the chart: read strength against the same teams the site
// elsewhere calls finals-bound, not the bye-inflated official top 8.
function realWp(t) {
  return t.played > 0 ? (t.wins + 0.5 * t.draws) / t.played : 0;
}
const realLadder = [...ladder.teams].sort((a, b) => {
  const w = realWp(b) - realWp(a);
  if (Math.abs(w) > 1e-9) return w;
  return b.pointsDiff - a.pointsDiff;
});
realLadder.forEach((t, i) => { t.realPosition = i + 1; });
const topSlugs = new Set(realLadder.slice(0, TOP_CUTOFF).map(t => t.slug));
const bottomSlugs = new Set(realLadder.slice(TOP_CUTOFF).map(t => t.slug));

// Per-team tallies against each pool.
const tally = {};
for (const t of ladder.teams) {
  tally[t.slug] = {
    vsTop: { wins: 0, draws: 0, losses: 0, played: 0 },
    vsBottom: { wins: 0, draws: 0, losses: 0, played: 0 },
  };
}

for (const m of results.matches) {
  const { home, away, winner, draw } = m;
  if (!(home in tally) || !(away in tally)) continue;

  const bucketFor = (selfSlug, oppSlug) => {
    if (topSlugs.has(oppSlug)) return tally[selfSlug].vsTop;
    if (bottomSlugs.has(oppSlug)) return tally[selfSlug].vsBottom;
    return null;
  };

  const homeBucket = bucketFor(home, away);
  const awayBucket = bucketFor(away, home);
  if (!homeBucket || !awayBucket) continue;

  homeBucket.played++;
  awayBucket.played++;

  if (draw) {
    homeBucket.draws++;
    awayBucket.draws++;
  } else if (winner === home) {
    homeBucket.wins++;
    awayBucket.losses++;
  } else {
    awayBucket.wins++;
    homeBucket.losses++;
  }
}

function wp(bucket) {
  if (bucket.played === 0) return null;
  return (bucket.wins + 0.5 * bucket.draws) / bucket.played;
}

// Project the result with display metadata baked in so the page stays dumb.
// Iterate in real-ladder order so the page can lean on the array order if it
// ever wants to (currently it doesn't, but it's cheap insurance).
const teams = realLadder.map(t => {
  const tt = tally[t.slug];
  return {
    slug: t.slug,
    shortName: t.shortName,
    fullName: t.fullName,
    initials: t.initials,
    primary: t.primary,
    secondary: t.secondary,
    officialPosition: t.officialPosition,
    realPosition: t.realPosition,
    pool: topSlugs.has(t.slug) ? 'top' : 'bottom',
    vsTop: { ...tt.vsTop, winPct: wp(tt.vsTop) },
    vsBottom: { ...tt.vsBottom, winPct: wp(tt.vsBottom) },
  };
});

const omitted = teams.filter(t => t.vsTop.winPct === null || t.vsBottom.winPct === null);

const out = {
  generatedAt: new Date().toISOString(),
  season: ladder.season,
  round: ladder.round,
  ladderFetchedAt: ladder.fetchedAt,
  resultsFetchedAt: results.fetchedAt,
  matchesConsidered: results.matches.length,
  topCutoff: TOP_CUTOFF,
  topSlugs: [...topSlugs],
  bottomSlugs: [...bottomSlugs],
  teams,
  // Teams without data in one or both pools are flagged so the page can list
  // them in a footnote rather than plotting them at the origin.
  omittedSlugs: omitted.map(t => t.slug),
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`Wrote ${teams.length} teams (omitted: ${omitted.length}) → ${OUT_PATH}`);
console.log(`  Top 8 (real ladder): ${[...topSlugs].join(', ')}`);
console.log(`  Bot 9 (real ladder): ${[...bottomSlugs].join(', ')}`);
// Show pool flips vs the official ladder so they're visible in the cron log.
const officialTop = ladder.teams.filter(t => t.officialPosition <= TOP_CUTOFF).map(t => t.slug);
const officialTopSet = new Set(officialTop);
const promoted = [...topSlugs].filter(s => !officialTopSet.has(s));
const demoted = officialTop.filter(s => !topSlugs.has(s));
if (promoted.length || demoted.length) {
  console.log(`  Pool flips vs official: +${promoted.join(',') || '∅'}  −${demoted.join(',') || '∅'}`);
} else {
  console.log(`  Pool flips vs official: none`);
}
for (const t of teams) {
  const xs = t.vsTop.winPct === null ? 'n/a' : `${(t.vsTop.winPct * 100).toFixed(1)}%`;
  const ys = t.vsBottom.winPct === null ? 'n/a' : `${(t.vsBottom.winPct * 100).toFixed(1)}%`;
  console.log(`  ${t.shortName.padEnd(11)} vsTop=${xs.padStart(6)} (${t.vsTop.wins}-${t.vsTop.losses}-${t.vsTop.draws}/${t.vsTop.played})  vsBot=${ys.padStart(6)} (${t.vsBottom.wins}-${t.vsBottom.losses}-${t.vsBottom.draws}/${t.vsBottom.played})`);
}
