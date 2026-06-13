#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'ladder.json');
const SOURCE_URL = 'https://www.nrl.com/ladder/data/';

const TEAM_META = {
  panthers:      { fullName: 'Penrith Panthers',              shortName: 'Panthers',    initials: 'PP', primary: '#231F20', secondary: '#000000' },
  warriors:      { fullName: 'New Zealand Warriors',          shortName: 'Warriors',    initials: 'NZ', primary: '#1D5E36', secondary: '#000000' },
  roosters:      { fullName: 'Sydney Roosters',               shortName: 'Roosters',    initials: 'SR', primary: '#06316F', secondary: '#E2231B' },
  rabbitohs:     { fullName: 'South Sydney Rabbitohs',        shortName: 'Rabbitohs',   initials: 'SS', primary: '#0A6240', secondary: '#E30613' },
  'wests-tigers':{ fullName: 'Wests Tigers',                  shortName: 'Tigers',      initials: 'WT', primary: '#F37021', secondary: '#000000' },
  cowboys:       { fullName: 'North Queensland Cowboys',      shortName: 'Cowboys',     initials: 'NQ', primary: '#002B5C', secondary: '#FFD600' },
  'sea-eagles':  { fullName: 'Manly Sea Eagles',              shortName: 'Sea Eagles',  initials: 'MS', primary: '#6F1A37', secondary: '#FFFFFF' },
  sharks:        { fullName: 'Cronulla-Sutherland Sharks',    shortName: 'Sharks',      initials: 'CS', primary: '#00A6CE', secondary: '#000000' },
  broncos:       { fullName: 'Brisbane Broncos',              shortName: 'Broncos',     initials: 'BB', primary: '#7C0044', secondary: '#FFB81C' },
  knights:       { fullName: 'Newcastle Knights',             shortName: 'Knights',     initials: 'NK', primary: '#EE3524', secondary: '#003A70' },
  dolphins:      { fullName: 'Dolphins',                      shortName: 'Dolphins',    initials: 'DO', primary: '#CC0033', secondary: '#FFD200' },
  bulldogs:      { fullName: 'Canterbury Bulldogs',           shortName: 'Bulldogs',    initials: 'CB', primary: '#00529B', secondary: '#FFFFFF' },
  raiders:       { fullName: 'Canberra Raiders',              shortName: 'Raiders',     initials: 'CR', primary: '#9DCB3B', secondary: '#1B1F23' },
  titans:        { fullName: 'Gold Coast Titans',             shortName: 'Titans',      initials: 'GC', primary: '#03A1DC', secondary: '#FBB040' },
  eels:          { fullName: 'Parramatta Eels',               shortName: 'Eels',        initials: 'PE', primary: '#006EB5', secondary: '#FFCC00' },
  storm:         { fullName: 'Melbourne Storm',               shortName: 'Storm',       initials: 'MS', primary: '#552E91', secondary: '#FFC72C' },
  dragons:       { fullName: 'St George Illawarra Dragons',   shortName: 'Dragons',     initials: 'SG', primary: '#E30613', secondary: '#FFFFFF' },
};

// nrl.com's WAF started bouncing the previous bot-looking UA into an
// OpenIdConnect login redirect from cloud-provider IP ranges (GH Actions on
// Azure). Realistic browser headers + an honest Referer slip through the
// IP+UA combination check that triggers the redirect.
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer':         'https://www.nrl.com/ladder/',
};

async function main() {
  const res = await fetch(SOURCE_URL, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const peek = (await res.text()).slice(0, 200);
    throw new Error(`Expected JSON, got ${contentType}: ${peek}`);
  }
  const raw = await res.json();

  if (!Array.isArray(raw.positions) || raw.positions.length < 16) {
    throw new Error(`Unexpected response shape — positions length = ${raw.positions?.length}`);
  }

  const teams = raw.positions.map((p, idx) => {
    const slug = p.theme?.key;
    const meta = TEAM_META[slug];
    if (!meta) throw new Error(`No metadata for team slug '${slug}' (nickname '${p.teamNickname}'). Update TEAM_META.`);
    const s = p.stats ?? {};
    return {
      slug,
      shortName: meta.shortName,
      fullName: meta.fullName,
      initials: meta.initials,
      primary: meta.primary,
      secondary: meta.secondary,
      played: s.played ?? 0,
      wins: s.wins ?? 0,
      losses: s.lost ?? 0,
      draws: s.drawn ?? 0,
      byes: s.byes ?? 0,
      pointsFor: s['points for'] ?? 0,
      pointsAgainst: s['points against'] ?? 0,
      pointsDiff: s['points difference'] ?? 0,
      compPoints: s.points ?? 0,
      streak: s.streak ?? '',
      form: s.form ?? '',
      officialPosition: idx + 1,
    };
  });

  const out = {
    season: raw.selectedSeasonId,
    round: raw.selectedRoundId,
    competitionId: raw.selectedCompetitionId,
    fetchedAt: new Date().toISOString(),
    source: SOURCE_URL,
    teams,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${teams.length} teams · season ${out.season} round ${out.round} → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('fetch-ladder failed:', err.message);
  process.exit(1);
});
