"""Deterministic scan/photo simulations of synthetic input, never live OCR."""
import hashlib
import json
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

directory = Path("docs/release-evidence/automatic-dev-live-extraction")
manifest_path = directory / "independent-input-oracles.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
pdf_entries = [entry for entry in manifest["files"] if entry["mimeType"] == "application/pdf"]
rendered = []
for entry in pdf_entries:
    with pdfplumber.open(entry["path"]) as document:
        text = "\n".join(page.extract_text() or "" for page in document.pages)
        assert "SYNTHETIC PAYSLIP" in text
        assert "01/06/2026 - 30/06/2026" in text
        assert f'{entry["oracle"]["baseMinor"] / 100:.2f} ILS' in text
        assert len(document.pages) == 1
    document = pdfium.PdfDocument(entry["path"])
    bitmap = document[0].render(scale=150 / 72)
    image = bitmap.to_pil().convert("RGB").copy()
    rendered.append((entry["id"], image))
    bitmap.close()
    document.close()

clear = rendered[0][1]
scan_path = directory / "live-ocr-scan-clear-june-2026.png"
ImageOps.grayscale(clear).save(scan_path, optimize=False)
photo_path = directory / "live-ocr-photo-simulation-clear-june-2026.jpg"
photo = ImageEnhance.Brightness(clear).enhance(0.93).filter(ImageFilter.GaussianBlur(0.35))
photo = ImageOps.expand(photo, border=30, fill=(220, 217, 211))
photo = photo.rotate(1.4, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(220, 217, 211))
photo = photo.resize((1100, round(photo.height * 1100 / photo.width)), Image.Resampling.LANCZOS)
photo.save(photo_path, quality=72, optimize=False)
files = list(pdf_entries)
for name, path, mime in [("scan-clear", scan_path, "image/png"), ("photo-simulation-clear", photo_path, "image/jpeg")]:
    content = path.read_bytes()
    files.append({"id": name, "path": path.as_posix(), "sha256": hashlib.sha256(content).hexdigest(),
                  "sizeBytes": len(content), "mimeType": mime, "oracle": pdf_entries[0]["oracle"],
                  "derivedFromSha256": pdf_entries[0]["sha256"], "syntheticRasterSimulation": True,
                  "actualCameraCapture": False})
    with Image.open(path) as image:
        rendered.append((name, image.convert("RGB").copy()))
manifest["files"] = files
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

review = Path("output/release-completion/automatic-dev-live-extraction")
review.mkdir(parents=True, exist_ok=True)
sheet = Image.new("RGB", (1040, 800), "#eeeeee")
draw = ImageDraw.Draw(sheet)
for index, (name, image) in enumerate(rendered):
    image.thumbnail((240, 345))
    x, y = (index % 4) * 260 + 10, (index // 4) * 400 + 30
    sheet.paste(image, (x, y))
    draw.text((x, y - 19), name, fill="black")
sheet.save(review / "input-contact-sheet.png")
receipt = {"state": "synthetic_inputs_generated_and_text_checked", "pdfCount": len(pdf_entries), "rasterCount": 2,
           "providerCalled": False, "liveOcrProved": False, "actualCameraCapture": False,
           "renderer": "pypdfium2", "textVerification": "pdfplumber", "visualReview": "pending"}
(directory / "fixture-preparation.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(json.dumps(receipt))
