#!/usr/bin/env node
// Pulls historical NRL closing odds from aussportsbetting.com and emits a
// flat JSON list of 2026 matches with normalised team slugs.
//
// Source: https://www.aussportsbetting.com/historical_data/nrl.xlsx — free
// per their personal-use Terms of Use, attribution required (see odds.html).

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const XLSX_URL = 'https://www.aussportsbetting.com/historical_data/nrl.xlsx';
const RAW_PATH = resolve(REPO_ROOT, 'data', 'raw', 'nrl-aussportsbetting.xlsx');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'odds.json');
const UA = 'nrl-real-ladder/1.0 (https://github.com/stevejb-ctrl/nrl-real-ladder)';
const SEASON_YEAR_SUFFIX = '-26'; // 2026 season; the xlsx dates are dd-MMM-YY

// Map the aussportsbetting team strings to the slugs the rest of this repo
// uses (the same slugs NRL.com returns as theme.key). Historical variants
// are included so the script keeps working when older rows appear.
const TEAM_SLUG = {
  'Brisbane Broncos':              'broncos',
  'Canberra Raiders':              'raiders',
  'Canterbury Bulldogs':           'bulldogs',
  'Canterbury-Bankstown Bulldogs': 'bulldogs',
  'Cronulla Sharks':               'sharks',
  'Cronulla-Sutherland Sharks':    'sharks',
  'Dolphins':                      'dolphins',
  'Gold Coast Titans':             'titans',
  'Manly Sea Eagles':              'sea-eagles',
  'Manly-Warringah Sea Eagles':    'sea-eagles',
  'Melbourne Storm':               'storm',
  'New Zealand Warriors':          'warriors',
  'Newcastle Knights':             'knights',
  'North QLD Cowboys':             'cowboys',
  'North Queensland Cowboys':      'cowboys',
  'Parramatta Eels':               'eels',
  'Penrith Panthers':              'panthers',
  'South Sydney Rabbitohs':        'rabbitohs',
  'St George Dragons':             'dragons',
  'St. George Illawarra Dragons':  'dragons',
  'Sydney Roosters':               'roosters',
  'Wests Tigers':                  'wests-tigers',
};

const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

// "31-May-26" → "2026-05-31"
function parseDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const dd = +m[1];
  const mm = MONTHS[m[2]];
  if (mm == null) return null;
  const yyyy = 2000 + +m[3];
  return `${yyyy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

async function download() {
  console.log(`Downloading ${XLSX_URL}`);
  const res = await fetch(XLSX_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(RAW_PATH), { recursive: true });
  writeFileSync(RAW_PATH, buf);
  console.log(`  ${(buf.length / 1024).toFixed(1)}KB → ${RAW_PATH}`);
  return buf;
}

function main(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  if (!wb.SheetNames.includes('Data')) throw new Error(`No 'Data' sheet (found: ${wb.SheetNames})`);
  const ws = wb.Sheets['Data'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  // Row 0 is metadata, row 1 is column headers, row 2+ is data.
  const header = rows[1];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const need = ['Date', 'Home Team', 'Away Team', 'Home Score', 'Away Score',
                'Home Odds Open', 'Home Odds Close', 'Away Odds Open', 'Away Odds Close', 'Draw Odds'];
  for (const n of need) {
    if (idx[n] == null) throw new Error(`Missing column '${n}' in xlsx header`);
  }

  const unmapped = new Set();
  const matches = [];

  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const dateStr = r[idx['Date']];
    const date = parseDate(dateStr);
    if (!date) continue;
    if (!dateStr?.endsWith(SEASON_YEAR_SUFFIX)) continue;

    const homeName = (r[idx['Home Team']] ?? '').trim();
    const awayName = (r[idx['Away Team']] ?? '').trim();
    const home = TEAM_SLUG[homeName];
    const away = TEAM_SLUG[awayName];
    if (!home) unmapped.add(homeName);
    if (!away) unmapped.add(awayName);
    if (!home || !away) continue;

    matches.push({
      date,
      kickOff: r[idx['Kick-off (local)']] ?? null,
      home,
      away,
      homeScore: num(r[idx['Home Score']]),
      awayScore: num(r[idx['Away Score']]),
      home_open: num(r[idx['Home Odds Open']]),
      home_close: num(r[idx['Home Odds Close']]),
      away_open: num(r[idx['Away Odds Open']]),
      away_close: num(r[idx['Away Odds Close']]),
      draw_close: num(r[idx['Draw Odds']]),
    });
  }

  if (unmapped.size) {
    throw new Error(`Unmapped team names: ${[...unmapped].map(s => JSON.stringify(s)).join(', ')}. Add to TEAM_SLUG.`);
  }

  // Sort chronologically — useful for downstream consumers.
  matches.sort((a, b) =>
    a.date < b.date ? -1 :
    a.date > b.date ?  1 :
    (a.kickOff ?? '').localeCompare(b.kickOff ?? '')
  );

  const out = {
    season: 2026,
    source: XLSX_URL,
    fetchedAt: new Date().toISOString(),
    rowsInSheet: rows.length - 2,
    matches,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${matches.length} 2026 matches to ${OUT_PATH}`);
}

const buf = await download();
main(buf);
