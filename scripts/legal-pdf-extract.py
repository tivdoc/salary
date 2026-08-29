import json
import sys

from pypdf import PdfReader


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"safe_error_code": "pdf_path_required"}))
        return 2
    try:
        reader = PdfReader(sys.argv[1], strict=False)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                print(json.dumps({"safe_error_code": "encrypted_pdf_unsupported"}))
                return 3
        pages = []
        for index, page in enumerate(reader.pages):
            text = page.extract_text(extraction_mode="layout") or ""
            pages.append({"page": index + 1, "text": text})
        print(json.dumps({"pages": pages}, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"safe_error_code": "pdf_parse_failed"}))
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
