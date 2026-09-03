# PDF extraction venv - setup + capability report

Pinned SHA: `761a63bedeb16a36968b8722e8de201d9e8f2119` (HEAD at start of run; HEAD moved to `0cee3e3bef3937c027786722e8b6a87009a8c933` mid-run - another process is committing to this branch.)

- **Script contract** - `scripts/legal-pdf-extract.py` imports stdlib `json`/`sys` plus **`pypdf`** only (`PdfReader`). It uses `reader.trailer`, `is_encrypted`/`decrypt("")`, and `page.extract_text(extraction_mode="layout")` - layout mode requires pypdf >= 4.0. Caps at 1000 pages / 20M chars. No OCR path anywhere in it.
- **Python**: 3.13.5, found via `py -3`. Bare `python`/`python3` resolve to the Microsoft Store stub and fail.
- **Venv**: `C:\dev\tivdoc\salary\output\pdf-venv` (1015 files, 17 MB).
- **Pinned set** (`output/agents/pdf-setup/requirements.lock`, from `pip freeze --all`):
  - `pip==26.2.1`
  - `pypdf==6.16.2`
- **Tesseract**: present, but NOT on PATH - `C:\Program Files\Tesseract-OCR\tesseract.exe`, v5.4.0.20240606 (leptonica-1.84.1). Not installed by me.
- **Hebrew traineddata**: NO - not usable. Tesseract's tessdata holds only `eng` and `osd`. A stray `heb.traineddata` sits at `C:\Users\smart\AppData\Local\Temp\tivdoc-a2-tessdata\heb.traineddata`, but `TESSDATA_PREFIX` is unset, so Tesseract cannot see it.
- **One-file proof**: `001-knesset-hours-work-rest-amendment-18.pdf`, 113,826 bytes. Exit 0. Embedded text layer FOUND - 4/4 pages non-empty, 29,755 chars total. Nothing written into the corpus directory.
  - First 100 chars (U+FEFF separators interleaved, shown here stripped): `תו מו ש ר םיקוחהרפס 2 018 ינויב21 272 5 ח"עשתהזומתב'ח דומע 698`

## Cannot do
- **Hebrew extracts reversed.** Layout mode emits glyphs in visual order: `תו מו ש ר` is `רשומות`, `םיקוחה רפס` is `ספר החוקים`. Any downstream string matching must re-order RTL runs first - this is a correctness trap, not cosmetic.
- **No OCR.** Image-only/scanned PDFs yield empty text and the script still exits 0 (reports success, not failure). Older scans in this corpus are the exposure.
- **No AES-encrypted PDFs.** `cryptography` is deliberately not installed (the script never imports it); `decrypt("")` on AES files falls through to `encrypted_pdf_unsupported`.
- **`output/pdf-venv/` is NOT git-ignored** - `git check-ignore` exits 1; `.gitignore` lists `/output/...` paths individually and has no entry for it. The venv now shows as 1015 untracked files. I did not edit `.gitignore` (tracked file). Add `/output/pdf-venv/` to it to keep the tree clean.
