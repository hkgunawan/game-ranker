// Maps RAWG's genre list for a game onto the single bucket the UI filters by.

const canonicalGenre = (raw) => {
  const t = (raw || "").toLowerCase();
  // "Indie" describes who made a game, not what kind of game it is, and it has
  // its own flag + filter. Treating it as a genre used to sweep every indie
  // action game (Valheim, Deep Rock Galactic, Beat Saber…) into "Narrative".
  if (/^indie$/.test(t.trim())) return "Other";
  if (/soulslike/.test(t)) return "Soulslike";
  if (/fighting/.test(t)) return "Fighting";
  if (/racing|vehicular|sports/.test(t)) return "Racing & Sports";
  if (/massively|mmo|moba/.test(t)) return "MMO & Online";
  if (/metroidvania|platformer/.test(t)) return "Platformer & Metroidvania";
  if (/fps|shooter|run-and-gun|battle royale/.test(t)) return "Shooter & FPS";
  if (/horror/.test(t)) return "Horror";
  if (/rpg|role-playing/.test(t)) return "RPG";
  if (/strategy|4x|\brts\b/.test(t)) return "Strategy & 4X";
  if (/roguelike|rogue-like/.test(t)) return "Roguelike";
  if (/puzzle|exploration|mystery|point-and-click|educational/.test(t)) return "Puzzle & Exploration";
  if (/stealth/.test(t)) return "Stealth";
  if (/simulation|survival|sim|card|board/.test(t)) return "Survival & Sim";
  if (/narrative|visual novel|tactics/.test(t)) return "Narrative & Tactics";
  if (/action|adventure|arcade|casual|family|western/.test(t)) return "Action & Adventure";
  return "Other";
};

// Most specific bucket wins. RPG ranks above Strategy on purpose: RAWG tags
// turn-based RPGs as "RPG, Strategy" (Baldur's Gate 3, Divinity: Original Sin 2),
// and those are RPGs first — pure strategy games carry no RPG tag at all.
const ORDER = [
  "Soulslike", "Fighting", "Racing & Sports", "MMO & Online", "Platformer & Metroidvania",
  "Shooter & FPS", "Horror", "RPG", "Strategy & 4X", "Roguelike", "Puzzle & Exploration",
  "Stealth", "Survival & Sim", "Narrative & Tactics", "Action & Adventure", "Other",
];

export function bestGenre(genreNames) {
  let best = "Other";
  let bestRank = ORDER.length;
  for (const name of genreNames) {
    const bucket = canonicalGenre(name);
    const r = ORDER.indexOf(bucket);
    if (r < bestRank) {
      bestRank = r;
      best = bucket;
    }
  }
  // A game tagged only "Indie" still needs a home in the filter.
  return best === "Other" && genreNames.length ? "Action & Adventure" : best;
}
