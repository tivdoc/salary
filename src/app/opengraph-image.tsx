import { ImageResponse } from "next/og";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const alt = "Tivdoc בודק את מה שמאחורי התלוש";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  await guardStableAppEntrypoint("CEP-012");
  return new ImageResponse(
    <div
      dir="rtl"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "76px 82px",
        color: "#111111",
        background: "#F7F3E8",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", width: 620, gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 34, fontWeight: 700 }}>
          <div style={{ display: "flex", background: "#2155FF", color: "white", padding: "4px 15px" }}>T</div>
          Tivdoc
        </div>
        <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.08 }}>
          התלוש הוא רק השכבה הראשונה.
        </div>
        <div style={{ fontSize: 30, color: "#6C6A63" }}>בודקים גם את מה שמאחוריו.</div>
      </div>
      <div
        style={{
          width: 350,
          height: 450,
          display: "flex",
          flexDirection: "column",
          padding: 34,
          gap: 18,
          background: "white",
          border: "2px solid #111111",
          boxShadow: "18px 18px 0 #FFD84D",
          transform: "rotate(-3deg)",
        }}
      >
        <div style={{ fontSize: 24, fontWeight: 700 }}>תלוש שכר לדוגמה</div>
        {["שכר בסיס", "שעות נוספות", "פנסיה", "נסיעות", "סה״כ נטו"].map((row, index) => (
          <div
            key={row}
            style={{
              display: "flex",
              justifyContent: "space-between",
              paddingBottom: 13,
              borderBottom: "1px solid #D8D2C5",
              background: index === 1 ? "#FFD84D" : "transparent",
              fontSize: 20,
            }}
          >
            <span>{row}</span><span>{index === 1 ? "620 ₪" : `${5_200 + index * 840} ₪`}</span>
          </div>
        ))}
        <div style={{ marginTop: "auto", color: "#C63D32", fontWeight: 700, fontSize: 20 }}>
          נמצא פער אפשרי
        </div>
      </div>
    </div>,
    size,
  );
}
