from __future__ import annotations

# L8-1 / D2: scripts refuse a production environment, before anything else.
import os as _tivdoc_os, sys as _tivdoc_sys
if _tivdoc_os.environ.get("NODE_ENV") == "production" or _tivdoc_os.environ.get("VERCEL_ENV") in ("production", "preview"):
    _tivdoc_sys.stderr.write("PRODUCTION_ENVIRONMENT_REFUSED\n")
    _tivdoc_sys.exit(2)

import pathlib
import sys
import zipfile


def main() -> int:
    if len(sys.argv) < 4:
        raise ValueError("usage: deterministic_zip.py FINAL_ROOT ZIP_PATH ENTRY...")
    root = pathlib.Path(sys.argv[1]).resolve(strict=True)
    output = pathlib.Path(sys.argv[2]).resolve()
    entries = sys.argv[3:]
    if len(entries) != len(set(entries)):
        raise ValueError("duplicate_archive_entry")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in entries:
            normalized = pathlib.PurePosixPath(name)
            if normalized.is_absolute() or ".." in normalized.parts or str(normalized) != name:
                raise ValueError(f"unsafe_archive_entry:{name}")
            source = (root / pathlib.Path(*normalized.parts)).resolve(strict=True)
            if root not in source.parents:
                raise ValueError(f"archive_entry_escape:{name}")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
