# Real NRL Ladder

The official NRL ladder gives 2 competition points for a bye. Each team has 3 byes per season but they're scheduled unevenly — so mid-season some teams have banked free points and others haven't, distorting the table.

This page re-ranks the same teams by **(wins + 0.5 × draws) ÷ games played**, with points differential as the tiebreaker. Byes are still shown, but never count as games.

The data refreshes automatically every 6 hours via GitHub Actions.

## Run locally

```bash
# from the project root
npx serve .
# or
python -m http.server 8000
```

Then open http://localhost:8000. Don't open `index.html` directly via `file://` — most browsers block `fetch` for local files.

To pull the latest ladder snapshot:

```bash
node scripts/fetch-ladder.mjs
```

This rewrites `data/ladder.json` from `nrl.com/ladder/data/`.

## Deploy on GitHub Pages

1. Create a new GitHub repo and push:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:<user>/<repo>.git
   git push -u origin main
   ```
2. Repo → **Settings** → **Pages** → Source: **Deploy from a branch**, Branch: `main` / `/ (root)`.
3. Repo → **Actions** tab → **Refresh NRL ladder** → **Run workflow** to seed the first commit of `data/ladder.json`.
4. Visit `https://<user>.github.io/<repo>/`.

The cron job will keep the data fresh from then on.

## Layout

```
.
├── index.html                    # the page (single file, no build step)
├── data/ladder.json              # snapshot, updated by the action
├── scripts/fetch-ladder.mjs      # Node 20 script: fetch nrl.com → normalise → write snapshot
└── .github/workflows/refresh.yml # cron + workflow_dispatch action
```
