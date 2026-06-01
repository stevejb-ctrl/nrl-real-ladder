#!/usr/bin/env node
// One-shot fetch of NRL club crests from en.wikipedia.org. The filenames are
// curated — auto-detection via the page-image list is fragile (each article
// has historic logos and kit images mixed in) and these crests don't change
// often enough to justify the complexity.
//
// Run this manually when a club rebrands; the cron does NOT call it. Logos
// are committed as binaries in assets/logos/.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'assets', 'logos');

// slug → Wikipedia File: name. Pick the SVG variant where possible so the
// logo stays crisp at any size; fall back to PNG only if no SVG exists.
const LOGOS = {
  broncos:        'Brisbane_Broncos_Logo_2026.svg',
  bulldogs:       'Canterbury-Bankstown_Bulldogs_logo_2026.svg',
  cowboys:        'North_Queensland_Cowboys_logo.svg',
  dolphins:       'Dolphins_(NRL)_Logo.svg',
  dragons:        'St._George_Illawarra_Dragons_logo.svg',
  eels:           'Parramatta_Eels_logo.svg',
  knights:        'Newcastle_Knights_logo.svg',
  panthers:       'Penrith_Panthers_Logo.svg',
  rabbitohs:      'South_Sydney_Rabbitohs_Logo.svg',
  raiders:        'Canberra_Raiders_Logo.svg',
  roosters:       'Sydney_Roosters_logo.svg',
  'sea-eagles':   'Manly-Warringah_Sea_Eagles_logo.svg',
  sharks:         'Cronulla-Sutherland_Sharks_logo.svg',
  storm:          'Melbourne_Storm_Logo.svg',
  'wests-tigers': 'Wests_Tigers_2022_Logo.svg',
  titans:         'Gold_Coast_Titans_logo.svg',
  warriors:       'Warriors_(NRL)_Logo.svg',
};

const UA = 'nrl-real-ladder/1.0 (https://github.com/stevejb-ctrl/nrl-real-ladder)';

async function download(slug, wikiFilename) {
  // Special:FilePath redirects to the canonical CDN URL for the file.
  const url = `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(wikiFilename)}`;
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status} fetching ${wikiFilename}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = extname(wikiFilename).toLowerCase();
  const out = resolve(OUT_DIR, `${slug}${ext}`);
  writeFileSync(out, buf);
  return { slug, src: wikiFilename, out, bytes: buf.length };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const force = process.argv.includes('--force');
  let downloaded = 0, skipped = 0, failed = 0;

  for (const [slug, filename] of Object.entries(LOGOS)) {
    const ext = extname(filename).toLowerCase();
    const existing = resolve(OUT_DIR, `${slug}${ext}`);
    if (!force && existsSync(existing)) {
      console.log(`  · ${slug.padEnd(13)} skip (already on disk)`);
      skipped++;
      continue;
    }
    try {
      const r = await download(slug, filename);
      console.log(`  ✓ ${slug.padEnd(13)} ${(r.bytes / 1024).toFixed(1)}KB  ${r.src}`);
      downloaded++;
      // Be polite to Wikipedia's CDN.
      await new Promise(r => setTimeout(r, 750));
    } catch (e) {
      console.error(`  ✗ ${slug.padEnd(13)} ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDownloaded ${downloaded}, skipped ${skipped}, failed ${failed} → ${OUT_DIR}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('fetch-logos failed:', err.message);
  process.exit(1);
});
