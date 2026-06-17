import type { MetadataRoute } from "next";
import { bestStaticParams } from "@/lib/best";

const BASE = "https://games.hendragunawan.com";

// Lists the home page + every static /best/[slug] page so crawlers index them.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: BASE, lastModified: now, changeFrequency: "weekly", priority: 1 },
    ...bestStaticParams().map(({ slug }) => ({
      url: `${BASE}/best/${slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}
