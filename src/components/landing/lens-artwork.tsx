"use client";
import Image from "next/image";
import { useRef, type PointerEvent } from "react";

export function LensArtwork() {
  const art = useRef<HTMLDivElement>(null);
  function tilt(event: PointerEvent<HTMLElement>) {
    if (
      event.pointerType !== "mouse" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    if (art.current)
      art.current.style.transform =
        "perspective(1100px) rotateY(" +
        x * 7 +
        "deg) rotateX(" +
        -y * 7 +
        "deg)";
  }
  return (
    <figure
      className="lens-artwork"
      onPointerMove={tilt}
      onPointerLeave={() => {
        if (art.current) art.current.style.transform = "";
      }}
    >
      <div className="lens-artwork__scroll">
        <div className="lens-artwork__object" ref={art}>
          <Image
            src="/brand/lens-study.webp"
            alt="המחשה: זכוכית מגדלת חושפת שכבות נוספות מתחת למסמך"
            width={1000}
            height={1000}
            sizes="(max-width: 767px) 90vw, 55vw"
            unoptimized
            loading="eager"
            fetchPriority="high"
          />
        </div>
      </div>
    </figure>
  );
}
