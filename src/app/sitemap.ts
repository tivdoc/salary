import type { MetadataRoute } from "next";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await guardStableAppEntrypoint("CEP-011");
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://tivdoc.com";
  return ["", "/privacy", "/terms"].map((path) => ({
    url: `${baseUrl}${path}`,
    changeFrequency: path ? "yearly" : "weekly",
    priority: path ? 0.3 : 1,
  }));
}
