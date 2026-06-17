import { ImageResponse } from "next/og";
import { resolveBest, topGames, bestStaticParams, GAME_COUNT } from "@/lib/best";

// Terminal-styled social card for each /best/[slug] page. Prebuilt at build time
// for the curated slugs (same params as the page).
export const alt = "game-ranker — best-of list";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamicParams = false;

export function generateStaticParams() {
  return bestStaticParams();
}

const BG = "#0d1117";
const FG = "#e6edf3";
const GREEN = "#3fb950";
const MUTED = "#8b949e";
const DIM = "#7d8590";
const PURPLE = "#a371f7";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const v = resolveBest(slug);
  const heading = v ? v.heading : "game-ranker";
  const top = v ? topGames(v, 5) : [];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: BG,
          padding: "64px 72px",
          fontFamily: "monospace",
          color: FG,
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 30, color: MUTED }}>
            <span style={{ color: GREEN }}>$</span>
            <span style={{ marginLeft: 14 }}>game-ranker</span>
          </div>
          <div style={{ display: "flex", marginTop: 28, fontSize: 76, fontWeight: 700, lineHeight: 1.1 }}>
            {heading}
          </div>
          <div style={{ display: "flex", marginTop: 16, fontSize: 30, color: MUTED }}>
            ranked by Metacritic critics + real player sentiment
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {top.map((g, i) => (
            <div key={g.title} style={{ display: "flex", alignItems: "center", fontSize: 34, marginTop: i === 0 ? 0 : 14 }}>
              <span style={{ display: "flex", width: 52, color: DIM }}>{i + 1}.</span>
              <span style={{ display: "flex", flex: 1, color: FG }}>{g.title}</span>
              <span style={{ display: "flex", color: GREEN, fontWeight: 700 }}>{g.composite}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: DIM }}>
          <span style={{ color: PURPLE }}>games.hendragunawan.com</span>
          <span>{GAME_COUNT} games · refreshed weekly</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
