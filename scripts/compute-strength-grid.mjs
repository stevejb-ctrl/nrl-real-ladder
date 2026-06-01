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

// Top 8 / bottom 9 split based on the official ladder (the cron is the source
// of truth — we deliberately don't recompute the real-ladder rank here so the
// grid story stays anchored to the ladder Steve's readers see at nrl.com).
const sortedByOfficial = [...ladder.teams].sort((a, b) => a.officialPosition - b.officialPosition);
const topSlugs = new Set(sortedByOfficial.slice(0, TOP_CUTOFF).map(t => t.slug));
const bottomSlugs = new Set(sortedByOfficial.slice(TOP_CUTOFF).map(t => t.slug));

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
const teams = sortedByOfficial.map(t => {
  const tt = tally[t.slug];
  return {
    slug: t.slug,
    shortName: t.shortName,
    fullName: t.fullName,
    initials: t.initials,
    primary: t.primary,
    secondary: t.secondary,
    officialPosition: t.officialPosition,
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
console.log(`  Top 8: ${[...topSlugs].join(', ')}`);
console.log(`  Bot 9: ${[...bottomSlugs].join(', ')}`);
for (const t of teams) {
  const xs = t.vsTop.winPct === null ? 'n/a' : `${(t.vsTop.winPct * 100).toFixed(1)}%`;
  const ys = t.vsBottom.winPct === null ? 'n/a' : `${(t.vsBottom.winPct * 100).toFixed(1)}%`;
  console.log(`  ${t.shortName.padEnd(11)} vsTop=${xs.padStart(6)} (${t.vsTop.wins}-${t.vsTop.losses}-${t.vsTop.draws}/${t.vsTop.played})  vsBot=${ys.padStart(6)} (${t.vsBottom.wins}-${t.vsBottom.losses}-${t.vsBottom.draws}/${t.vsBottom.played})`);
}
