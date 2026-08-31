"use strict";

if (process.env.TIVDOC_V091_FONT_MOCK_ALLOWED !== "1") {
  throw new Error("V091_NEXT_FONT_MOCK_NOT_AUTHORIZED");
}

const ALLOWED_FAMILIES = new Map([
  ["IBM Plex Mono", "ibm-plex-mono"],
  ["IBM Plex Sans Hebrew", "ibm-plex-sans-hebrew"],
]);

module.exports = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    const url = new URL(property);
    if (url.protocol !== "https:" || url.hostname !== "fonts.googleapis.com" || url.pathname !== "/css2") {
      return undefined;
    }
    const familySpec = url.searchParams.get("family") ?? "";
    const family = [...ALLOWED_FAMILIES.keys()].find((candidate) => familySpec.startsWith(candidate));
    if (!family) return undefined;
    const slug = ALLOWED_FAMILIES.get(family);
    return `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 100 900;\n  src: url(https://fonts.gstatic.com/s/tivdoc-v091/${slug}.woff2) format('woff2');\n}\n`;
  },
});
