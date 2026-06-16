<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# game-ranker

Interactive cross-platform game leaderboard. Data is a curated, static dataset
parsed from two markdown ranking docs in `data-sources/` via
`scripts/parse-games.mjs` (`npm run data`) into `src/data/games.json`. No runtime
API calls — the app is fully static. The ranking algorithm lives in
`src/lib/rank.ts` and is unit-tested.
