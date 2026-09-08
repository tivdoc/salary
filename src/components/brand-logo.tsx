import Image from "next/image";

// Preserve the original artwork; crop only empty margins with the CSS viewport.
export function BrandLogo() {
  return (
    <span className="brand-logo">
      <Image
        src="/brand/tivdoc-he-original.png"
        alt="תבדוק"
        width={1774}
        height={887}
        sizes="200px"
        fetchPriority="high"
        loading="eager"
      />
    </span>
  );
}
export function BrandSymbol({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-symbol ${className}`}>
      <Image
        src="/brand/tivdoc-symbol-original.png"
        alt=""
        width={1280}
        height={1280}
        sizes="(max-width: 768px) 160px, 280px"
      />
    </span>
  );
}
