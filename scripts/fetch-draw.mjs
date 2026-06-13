#!/usr/bin/env node
// Fetches every remaining fixture in the 2026 NRL premiership.
// Loops rounds from the current round up to round 27, keeps any match
// whose matchMode === "Pre" (i.e. not yet played).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'draw.json');

const COMPETITION = 111;
const SEASON = 2026;
const FINAL_REGULAR_ROUND = 27;

// See fetch-ladder.mjs for why we mimic a real browser: nrl.com's WAF
// bounces the previous bot UA into an OpenIdConnect login redirect from
// cloud-IP ranges.
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer':         'https://www.nrl.com/draw/',
};

async function fetchRound(round) {
  const url = `https://www.nrl.com/draw/data/?competition=${COMPETITION}&season=${SEASON}&round=${round}`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Round ${round}: ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const peek = (await res.text()).slice(0, 200);
    throw new Error(`Round ${round}: expected JSON, got ${contentType}: ${peek}`);
  }
  return res.json();
}

async function main() {
  // Use a no-round fetch first to discover the current round.
  const probe = await fetchRound('');
  const currentRound = probe.selectedRoundId;
  if (!Number.isInteger(currentRound) || currentRound < 1 || currentRound > FINAL_REGULAR_ROUND) {
    throw new Error(`Unexpected current round: ${currentRound}`);
  }

  const matches = [];
  const byes = [];

  // Walk every round from the current one through the end of the regular season.
  // Filter individual fixtures by matchMode so we capture games not yet played in
  // the current round too (some may have kicked off, some may not have).
  for (let r = currentRound; r <= FINAL_REGULAR_ROUND; r++) {
    const data = r === currentRound ? probe : await fetchRound(r);

    for (const f of data.fixtures ?? []) {
      // matchMode is "Pre" (upcoming), "Post" (finished). Skip anything but Pre.
      if (f.matchMode !== 'Pre') continue;
      const homeKey = f.homeTeam?.theme?.key;
      const awayKey = f.awayTeam?.theme?.key;
      if (!homeKey || !awayKey) continue;
      matches.push({
        round: r,
        roundTitle: f.roundTitle ?? `Round ${r}`,
        home: homeKey,
        away: awayKey,
        venue: f.venue ?? '',
        venueCity: f.venueCity ?? '',
        kickOff: f.clock?.kickOffTimeLong ?? null,
        homeOdds: parseFloat(f.homeTeam?.odds) || null,
        awayOdds: parseFloat(f.awayTeam?.odds) || null,
      });
    }

    for (const b of data.byes ?? []) {
      const slug = b.theme?.key ?? b.themeKey ?? null;
      if (!slug) continue;
      byes.push({ round: r, team: slug });
    }
  }

  if (matches.length === 0) {
    console.warn('No remaining matches found. Season may be over, or schema changed.');
  }

  const out = {
    season: SEASON,
    competitionId: COMPETITION,
    fromRound: currentRound,
    toRound: FINAL_REGULAR_ROUND,
    fetchedAt: new Date().toISOString(),
    matches,
    byes,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${matches.length} remaining matches and ${byes.length} byes (rounds ${currentRound}–${FINAL_REGULAR_ROUND}) → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('fetch-draw failed:', err.message);
  process.exit(1);
});
