#!/usr/bin/env node
// Fetches every COMPLETED fixture in the 2026 NRL premiership.
// Walks rounds 1 → current round (from the probe), keeps any match
// whose matchMode === "Post" (i.e. already played, score finalised).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'results.json');

const COMPETITION = 111;
const SEASON = 2026;
const FINAL_REGULAR_ROUND = 27;
const UA = 'Mozilla/5.0 (compatible; NRL-Real-Ladder/1.0; +https://github.com)';

async function fetchRound(round) {
  const url = `https://www.nrl.com/draw/data/?competition=${COMPETITION}&season=${SEASON}&round=${round}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`Round ${round}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const probe = await fetchRound('');
  const currentRound = probe.selectedRoundId;
  if (!Number.isInteger(currentRound) || currentRound < 1 || currentRound > FINAL_REGULAR_ROUND) {
    throw new Error(`Unexpected current round: ${currentRound}`);
  }

  const matches = [];

  // Walk rounds 1 → currentRound. The current round is included because some of
  // its matches may already have finished (matchMode === 'Post') while others
  // haven't kicked off yet.
  for (let r = 1; r <= currentRound; r++) {
    const data = r === currentRound ? probe : await fetchRound(r);

    for (const f of data.fixtures ?? []) {
      if (f.matchMode !== 'Post') continue;
      const homeKey = f.homeTeam?.theme?.key;
      const awayKey = f.awayTeam?.theme?.key;
      const homeScore = f.homeTeam?.score;
      const awayScore = f.awayTeam?.score;
      if (!homeKey || !awayKey) continue;
      if (typeof homeScore !== 'number' || typeof awayScore !== 'number') continue;

      let winner;
      if (homeScore > awayScore) winner = homeKey;
      else if (awayScore > homeScore) winner = awayKey;
      else winner = null;

      matches.push({
        round: r,
        roundTitle: f.roundTitle ?? `Round ${r}`,
        home: homeKey,
        away: awayKey,
        homeScore,
        awayScore,
        winner,
        draw: winner === null,
        venue: f.venue ?? '',
        venueCity: f.venueCity ?? '',
      });
    }
  }

  const out = {
    season: SEASON,
    competitionId: COMPETITION,
    fromRound: 1,
    toRound: currentRound,
    fetchedAt: new Date().toISOString(),
    matches,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${matches.length} completed matches (rounds 1–${currentRound}) → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('fetch-results failed:', err.message);
  process.exit(1);
});
