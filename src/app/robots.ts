import type { MetadataRoute } from "next";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function robots(): Promise<MetadataRoute.Robots> {
  await guardStableAppEntrypoint("CEP-010");
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL || "https://tivdoc.com"}/sitemap.xml`,
  };
}
