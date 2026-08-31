from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageOps
from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject


FORBIDDEN_KEYS = {
    "/JavaScript",
    "/JS",
    "/Launch",
    "/GoToR",
    "/SubmitForm",
    "/EmbeddedFiles",
    "/AcroForm",
}

REQUIRED_PHRASES = [
    "נתוני בדיקה סינתטיים בלבד",
    "דוח בדיקה קנוני",
    "סיכום שבעת הנושאים",
    "שכר מינימום",
    "שעות עבודה ומנוחה",
    "פנסיה",
    "נסיעות",
    "דמי הבראה",
    "חופשה",
    "מחלה",
    "סכום ביניים",
    "נושא חסום או לא ידוע אינו שווה לאפס",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def walk_forbidden(value: object, visited: set[tuple[int, int]]) -> set[str]:
    if isinstance(value, IndirectObject):
        identity = (value.idnum, value.generation)
        if identity in visited:
            return set()
        visited.add(identity)
        return walk_forbidden(value.get_object(), visited)
    if isinstance(value, DictionaryObject):
        found = {str(key) for key in value if str(key) in FORBIDDEN_KEYS}
        for child in value.values():
            found.update(walk_forbidden(child, visited))
        return found
    if isinstance(value, ArrayObject):
        found: set[str] = set()
        for child in value:
            found.update(walk_forbidden(child, visited))
        return found
    return set()


def inspect_fonts(reader: PdfReader) -> list[dict[str, object]]:
    fonts: dict[str, dict[str, object]] = {}
    for page in reader.pages:
        resources = page.get("/Resources", {}).get_object()
        page_fonts = resources.get("/Font", {}).get_object()
        for _, reference in page_fonts.items():
            font = reference.get_object()
            base_name = str(font.get("/BaseFont", ""))
            descendants = font.get("/DescendantFonts", [])
            descendant = descendants[0].get_object() if descendants else font
            descriptor_ref = descendant.get("/FontDescriptor")
            descriptor = descriptor_ref.get_object() if descriptor_ref else {}
            embedded_key = next((key for key in ("/FontFile", "/FontFile2", "/FontFile3") if key in descriptor), None)
            embedded_bytes = 0
            if embedded_key:
                stream = descriptor[embedded_key].get_object()
                embedded_bytes = len(stream.get_data())
            fonts[base_name] = {
                "base_font": base_name,
                "subtype": str(font.get("/Subtype", "")),
                "encoding": str(font.get("/Encoding", "")),
                "to_unicode": "/ToUnicode" in font,
                "embedded_stream": embedded_key,
                "embedded_bytes": embedded_bytes,
            }
    return [fonts[key] for key in sorted(fonts)]


def inspect_images(image_paths: list[Path], contact_sheet: Path) -> list[dict[str, object]]:
    opened = [Image.open(path).convert("RGB") for path in image_paths]
    if not opened:
        raise RuntimeError("POPPLER_RENDERED_PAGE_MISSING")
    expected_size = opened[0].size
    results: list[dict[str, object]] = []
    for path, image in zip(image_paths, opened, strict=True):
        if image.size != expected_size:
            raise RuntimeError("POPPLER_PAGE_DIMENSION_MISMATCH")
        gray = ImageOps.grayscale(image)
        histogram = gray.histogram()
        pixels = image.width * image.height
        nonwhite = pixels - sum(histogram[248:])
        dark = sum(histogram[:25])
        bbox = ImageChops.difference(image, Image.new("RGB", image.size, "white")).getbbox()
        nonwhite_ratio = nonwhite / pixels
        dark_ratio = dark / pixels
        if bbox is None or nonwhite_ratio < 0.005 or nonwhite_ratio > 0.75 or dark_ratio > 0.20:
            raise RuntimeError(f"POPPLER_PAGE_VISUAL_SANITY_FAILED:{path.name}")
        results.append({
            "path": path.name,
            "sha256": sha256(path),
            "width": image.width,
            "height": image.height,
            "nonwhite_ratio": round(nonwhite_ratio, 6),
            "dark_ratio": round(dark_ratio, 6),
            "ink_bbox": list(bbox),
        })

    thumb_width = 360
    thumb_height = round(expected_size[1] * thumb_width / expected_size[0])
    gap = 20
    contact = Image.new("RGB", (thumb_width * 2 + gap * 3, thumb_height * 2 + gap * 3), "#e8eceb")
    for index, image in enumerate(opened):
        thumb = image.resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        x = gap + (index % 2) * (thumb_width + gap)
        y = gap + (index // 2) * (thumb_height + gap)
        contact.paste(thumb, (x, y))
    contact_sheet.parent.mkdir(parents=True, exist_ok=True)
    contact.save(contact_sheet, format="PNG", optimize=False, compress_level=9)
    return results


def main() -> int:
    if len(sys.argv) < 4:
        raise RuntimeError("usage: inspect_pdf.py REPORT_PDF RENDERED_DIR CONTACT_SHEET")
    pdf_path = Path(sys.argv[1]).resolve()
    rendered_dir = Path(sys.argv[2]).resolve()
    contact_sheet = Path(sys.argv[3]).resolve()
    reader = PdfReader(str(pdf_path), strict=True)
    page_count = len(reader.pages)
    if page_count < 3:
        raise RuntimeError("HEBREW_REPORT_PAGE_COUNT_BELOW_MINIMUM")
    sizes = []
    extracted_pages = []
    annotations = 0
    for page in reader.pages:
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        sizes.append({"width_points": round(width, 2), "height_points": round(height, 2)})
        if abs(width - 595.28) > 0.1 or abs(height - 841.89) > 0.1:
            raise RuntimeError("HEBREW_REPORT_PAGE_NOT_A4")
        extracted_pages.append(page.extract_text() or "")
        annotations += len(page.get("/Annots", []))
    extracted_text = "\n".join(extracted_pages)
    missing_phrases = [phrase for phrase in REQUIRED_PHRASES if phrase not in extracted_text]
    hebrew_codepoints = sum(1 for character in extracted_text if "\u0590" <= character <= "\u05ff")
    if missing_phrases:
        raise RuntimeError("HEBREW_REPORT_REQUIRED_TEXT_MISSING:" + "|".join(missing_phrases))
    if hebrew_codepoints < 100 or "\ufffd" in extracted_text or "\x00" in extracted_text:
        raise RuntimeError("HEBREW_REPORT_UNICODE_EXTRACTION_FAILED")

    fonts = inspect_fonts(reader)
    if len(fonts) != 1 or fonts[0]["base_font"] != "/DejaVuSans" or fonts[0]["embedded_stream"] != "/FontFile2" or not fonts[0]["to_unicode"]:
        raise RuntimeError("HEBREW_REPORT_FONT_NOT_EMBEDDED")
    forbidden = sorted(walk_forbidden(reader.trailer, set()))
    if forbidden or annotations:
        raise RuntimeError("HEBREW_REPORT_ACTIVE_CONTENT_FOUND")

    image_paths = sorted(rendered_dir.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    if len(image_paths) != page_count:
        raise RuntimeError("POPPLER_RENDER_PAGE_COUNT_MISMATCH")
    images = inspect_images(image_paths, contact_sheet)
    result = {
        "schema_version": "tivdoc-hebrew-pdf-native-inspection-v0.8.0",
        "status": "PASSED",
        "page_count": page_count,
        "page_sizes": sizes,
        "hebrew_unicode_codepoints": hebrew_codepoints,
        "required_phrases": REQUIRED_PHRASES,
        "missing_phrases": [],
        "replacement_glyph_count": 0,
        "fonts": fonts,
        "annotations": annotations,
        "forbidden_active_content_keys": forbidden,
        "rendered_pages": images,
        "contact_sheet": {"path": contact_sheet.name, "sha256": sha256(contact_sheet)},
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - verifier must emit one deterministic safe error
        print(json.dumps({"status": "FAILED", "error": str(error)}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        raise SystemExit(1)
