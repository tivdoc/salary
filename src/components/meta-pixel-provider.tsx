"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";
import { trackMetaBrowserEvent, trackMetaViewContentOnce } from "@/lib/meta-browser";

export function MetaPixelProvider({ pixelId }: { pixelId?: string }) {
  const pathname = usePathname();
  const lastPathname = useRef<string | null>(null);

  useEffect(() => {
    if (!pixelId || lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    trackMetaBrowserEvent("PageView");
    if (pathname === "/check") trackMetaViewContentOnce();
  }, [pathname, pixelId]);

  if (!pixelId) return null;
  const serializedPixelId = JSON.stringify(pixelId);

  return (
    <Script id="tivdoc-meta-pixel" strategy="afterInteractive">
      {`
        !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
        n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
        (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
        fbq('init', ${serializedPixelId});
        (window.tivdocMetaPixelQueue || []).forEach(function(args) { fbq.apply(window, args); });
        window.tivdocMetaPixelQueue = [];
      `}
    </Script>
  );
}
