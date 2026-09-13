"use client";
import { useEffect } from "react";

// Progressive enhancement: content remains visible without JavaScript or animation support.
export function StudioMotion() {
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Set<Animation>();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          if (
            preference.matches ||
            !entry.target.animate ||
            entry.boundingClientRect.top < 80
          )
            return;
          const animation = entry.target.animate(
            [
              { opacity: 0.55, transform: "translateY(16px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
            { duration: 440, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
          );
          animations.add(animation);
          animation.onfinish = () => animations.delete(animation);
        });
      },
      { threshold: 0.12 },
    );
    document
      .querySelectorAll(".studio-site [data-reveal]")
      .forEach((element) => observer.observe(element));
    function stopMotion() {
      if (preference.matches)
        animations.forEach((animation) => animation.cancel());
    }
    preference.addEventListener("change", stopMotion);
    return () => {
      observer.disconnect();
      animations.forEach((animation) => animation.cancel());
      preference.removeEventListener("change", stopMotion);
    };
  }, []);
  return null;
}
