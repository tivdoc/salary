import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export const alt = "תבדוק — המסמכים שלך. התמונה המלאה.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default async function OpenGraphImage() {
  const logo = await readFile(
    join(process.cwd(), "public/brand/tivdoc-he-original.png"),
  );
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#FAF8F5",
        borderBottom: "22px solid #E8845C",
      }}
    >
      {/* Original approved Hebrew lettering, without server-side font substitution. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={"data:image/png;base64," + logo.toString("base64")}
        width={1000}
        height={500}
        alt="תבדוק"
      />
    </div>,
    size,
  );
}
