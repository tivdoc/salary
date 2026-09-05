"""Deterministic OCR for scanned legal PDFs.

This is a different parser path from ``legal-pdf-extract.py`` and must stay
distinguishable from it. Text lifted from an embedded text layer is what the
document contains; text produced here is *derived* from an image of the
document by a recognizer that can be wrong. Every artifact this produces carries
``ocr_derived: true`` with the recognizer version and the language data it used,
never satisfies a citation that needs exact bytes, and needs human attestation
before anything downstream treats it as authoritative.

Determinism matters as much as accuracy: the render DPI and the recognizer
arguments are fixed here rather than passed in, so the same bytes produce the
same text on a second run and a changed version shows up as a changed version
rather than as changed text.
"""

# L8-1 / D2: scripts refuse a production environment, before anything else.
import os as _tivdoc_os, sys as _tivdoc_sys
if _tivdoc_os.environ.get("NODE_ENV") == "production" or _tivdoc_os.environ.get("VERCEL_ENV") in ("production", "preview"):
    _tivdoc_sys.stderr.write("PRODUCTION_ENVIRONMENT_REFUSED\n")
    _tivdoc_sys.exit(2)

import json
import os
import shutil
import subprocess
import sys
import tempfile

import fitz  # pymupdf

RENDER_DPI = 300
MAX_PAGES = 400
LANGUAGE = "heb"
TESSERACT_CANDIDATES = (
    os.environ.get("TIVDOC_TESSERACT_PATH", ""),
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    "tesseract",
)


def find_tesseract() -> str:
    for candidate in TESSERACT_CANDIDATES:
        if not candidate:
            continue
        if os.path.isfile(candidate):
            return candidate
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return ""


def recognizer_version(binary: str) -> str:
    out = subprocess.run([binary, "--version"], capture_output=True, text=True, check=False)
    first = (out.stdout or out.stderr or "").strip().splitlines()
    return first[0].strip() if first else "unknown"


def has_language(binary: str, prefix: str) -> bool:
    env = dict(os.environ)
    if prefix:
        env["TESSDATA_PREFIX"] = prefix
    out = subprocess.run([binary, "--list-langs"], capture_output=True, text=True,
                         check=False, env=env)
    listed = (out.stdout or "") + (out.stderr or "")
    return any(line.strip() == LANGUAGE for line in listed.splitlines())


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"safe_error_code": "pdf_path_required"}))
        return 2
    binary = find_tesseract()
    if not binary:
        print(json.dumps({"safe_error_code": "ocr_recognizer_absent"}))
        return 8
    prefix = os.environ.get("TESSDATA_PREFIX", "")
    if not has_language(binary, prefix):
        # Language data is what makes the output meaningful; without it the
        # recognizer would happily return confident nonsense in the wrong script.
        print(json.dumps({"safe_error_code": "ocr_language_data_absent",
                          "language": LANGUAGE}))
        return 9
    try:
        document = fitz.open(sys.argv[1])
    except Exception:
        print(json.dumps({"safe_error_code": "pdf_parse_failed"}))
        return 4
    if document.needs_pass:
        print(json.dumps({"safe_error_code": "encrypted_pdf_unsupported"}))
        return 3
    if document.page_count > MAX_PAGES:
        print(json.dumps({"safe_error_code": "pdf_page_limit_exceeded"}))
        return 5

    env = dict(os.environ)
    if prefix:
        env["TESSDATA_PREFIX"] = prefix
    pages = []
    with tempfile.TemporaryDirectory() as scratch:
        for index in range(document.page_count):
            page = document.load_page(index)
            pixmap = page.get_pixmap(dpi=RENDER_DPI)
            image_path = os.path.join(scratch, f"page-{index + 1:04d}.png")
            pixmap.save(image_path)
            result = subprocess.run(
                [binary, image_path, "stdout", "-l", LANGUAGE, "--psm", "6"],
                capture_output=True, text=True, encoding="utf-8", check=False, env=env,
            )
            if result.returncode != 0:
                print(json.dumps({"safe_error_code": "ocr_recognizer_failed",
                                  "page": index + 1}))
                return 10
            pages.append({"page": index + 1, "text": result.stdout or ""})
    document.close()

    print(json.dumps({
        "pages": pages,
        "ocr_derived": True,
        "recognizer_version": recognizer_version(binary),
        "language": LANGUAGE,
        "render_dpi": RENDER_DPI,
        "renderer_version": f"pymupdf-{fitz.__doc__.strip().split()[-1] if fitz.__doc__ else 'unknown'}",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
