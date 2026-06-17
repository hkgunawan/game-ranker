<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# game-ranker

Interactive cross-platform game leaderboard. Data is built fully automatically
from the RAWG API by `scripts/fetch-rawg.mjs` (`npm run data`, needs
`RAWG_API_KEY`) into `src/data/games.json`, then enriched with Steam player
sentiment by `scripts/enrich-steam.mjs` (`npm run enrich`, keyless). A weekly
GitHub Actions cron (`.github/workflows/refresh.yml`) regenerates and commits it,
triggering a Vercel redeploy. No runtime API calls — the app is fully static. The
ranking algorithm (critics ↔ players blend, player-leaning default) lives in
`src/lib/rank.ts` and is unit-tested. The old markdown-doc parser is kept as
`scripts/parse-games.mjs` (`npm run data:docs`) for reference only.
