"use client";

import { useEffect } from "react";
import { recordFunnelEvent } from "@/lib/attribution";

export function AttributionProvider() {
  useEffect(() => {
    recordFunnelEvent("landing_view");
  }, []);
  return null;
}
