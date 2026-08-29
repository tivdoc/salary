import json
import sys

from pypdf import PdfReader


MAX_PAGES = 1000
MAX_TEXT_CHARACTERS = 20_000_000
FORBIDDEN_PDF_TOKENS = {"/JavaScript", "/JS", "/Launch", "/GoToR", "/SubmitForm", "/EmbeddedFiles"}


def contains_active_content(value, depth=0, seen=None) -> bool:
    if depth > 12:
        return False
    if seen is None:
        seen = set()
    try:
        if hasattr(value, "get_object"):
            value = value.get_object()
    except Exception:
        return True
    identity = id(value)
    if identity in seen:
        return False
    seen.add(identity)
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key) in FORBIDDEN_PDF_TOKENS:
                return True
            if contains_active_content(item, depth + 1, seen):
                return True
    elif isinstance(value, (list, tuple)):
        return any(contains_active_content(item, depth + 1, seen) for item in value)
    return False


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"safe_error_code": "pdf_path_required"}))
        return 2
    try:
        reader = PdfReader(sys.argv[1], strict=False)
        if len(reader.pages) > MAX_PAGES:
            print(json.dumps({"safe_error_code": "pdf_page_limit_exceeded"}))
            return 5
        if contains_active_content(reader.trailer.get("/Root", {})):
            print(json.dumps({"safe_error_code": "pdf_active_content_rejected"}))
            return 6
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                print(json.dumps({"safe_error_code": "encrypted_pdf_unsupported"}))
                return 3
        pages = []
        total_characters = 0
        for index, page in enumerate(reader.pages):
            text = page.extract_text(extraction_mode="layout") or ""
            total_characters += len(text)
            if total_characters > MAX_TEXT_CHARACTERS:
                print(json.dumps({"safe_error_code": "pdf_text_limit_exceeded"}))
                return 7
            pages.append({"page": index + 1, "text": text})
        print(json.dumps({"pages": pages}, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"safe_error_code": "pdf_parse_failed"}))
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
