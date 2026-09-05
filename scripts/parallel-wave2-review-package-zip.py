from __future__ import annotations

# L8-1 / D2: scripts refuse a production environment, before anything else.
import os as _tivdoc_os, sys as _tivdoc_sys
if _tivdoc_os.environ.get("NODE_ENV") == "production" or _tivdoc_os.environ.get("VERCEL_ENV") in ("production", "preview"):
    _tivdoc_sys.stderr.write("PRODUCTION_ENVIRONMENT_REFUSED\n")
    _tivdoc_sys.exit(2)

import hashlib
import json
import pathlib
import sys
import tempfile
import zipfile


FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(name: str) -> pathlib.PurePosixPath:
    value = pathlib.PurePosixPath(name)
    if value.is_absolute() or not value.parts or ".." in value.parts or ":" in value.parts[0]:
        raise ValueError(f"unsafe_archive_path:{name}")
    return value


def build(package_dir: pathlib.Path, target: pathlib.Path, names: list[str]) -> None:
    if target.exists():
        target.unlink()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            data = (package_dir / name).read_bytes()
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_and_extract(archive_path: pathlib.Path, expected: dict[str, dict[str, object]]) -> int:
    extracted = 0
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave2-consumer-") as temporary:
        root = pathlib.Path(temporary).resolve()
        with zipfile.ZipFile(archive_path, "r") as archive:
            for info in archive.infolist():
                relative = safe_name(info.filename)
                mode = info.external_attr >> 16
                if mode & 0o170000 == 0o120000:
                    raise ValueError(f"archive_symlink_rejected:{info.filename}")
                target = (root / pathlib.Path(*relative.parts)).resolve()
                if root not in target.parents:
                    raise ValueError(f"archive_path_escape:{info.filename}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
                extracted += 1
        for relative, entry in expected.items():
            data = (root / pathlib.Path(*safe_name(relative).parts)).read_bytes()
            if len(data) != entry["byte_count"] or digest(data) != entry["sha256"]:
                raise ValueError(f"consumer_extract_mismatch:{relative}")
    return extracted


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: parallel-wave2-review-package-zip.py PACKAGE_DIR OUTPUT_ZIP")
    package_dir = pathlib.Path(sys.argv[1]).resolve()
    output_zip = pathlib.Path(sys.argv[2]).resolve()
    manifest_bytes = (package_dir / "package-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    expected = {entry["path"]: entry for entry in manifest["files"]}
    for relative, entry in expected.items():
        data = (package_dir / pathlib.Path(*safe_name(relative).parts)).read_bytes()
        if len(data) != entry["byte_count"] or digest(data) != entry["sha256"]:
            raise ValueError(f"package_manifest_mismatch:{relative}")

    names = sorted(
        str(item.relative_to(package_dir)).replace("\\", "/")
        for item in package_dir.rglob("*")
        if item.is_file()
    )
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    build(package_dir, output_zip, names)
    extracted = verify_and_extract(output_zip, expected)
    print(json.dumps({
        "zip_sha256": digest(output_zip.read_bytes()),
        "package_files": len(names),
        "manifest_entries": len(expected),
        "manifest_sha256": digest(manifest_bytes),
        "consumer_safe_extraction_verified": True,
        "consumer_extracted_files": extracted,
        "deterministic_timestamp": "1980-01-01T00:00:00Z",
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
