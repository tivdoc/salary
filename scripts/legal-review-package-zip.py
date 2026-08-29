from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import zipfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: legal-review-package-zip.py PACKAGE_DIR OUTPUT_ZIP")
    package_dir = pathlib.Path(sys.argv[1]).resolve()
    output_zip = pathlib.Path(sys.argv[2]).resolve()
    manifest_path = package_dir / "package-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {entry["path"]: entry for entry in manifest["files"]}
    for relative, entry in expected.items():
        target = (package_dir / relative).resolve()
        if package_dir not in target.parents:
            raise ValueError("package_manifest_path_escape")
        data = target.read_bytes()
        if len(data) != entry["byte_count"] or digest(data) != entry["sha256"]:
            raise ValueError(f"package_manifest_mismatch:{relative}")

    names = sorted(
        str(item.relative_to(package_dir)).replace("\\", "/")
        for item in package_dir.rglob("*")
        if item.is_file()
    )
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_zip.with_suffix(output_zip.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            data = (package_dir / name).read_bytes()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    temporary.replace(output_zip)

    with zipfile.ZipFile(output_zip, "r") as archive:
        archive_names = sorted(archive.namelist())
        if archive_names != names:
            raise ValueError("zip_inventory_mismatch")
        for relative, entry in expected.items():
            data = archive.read(relative)
            if len(data) != entry["byte_count"] or digest(data) != entry["sha256"]:
                raise ValueError(f"zip_content_mismatch:{relative}")
    result = {
        "zip_path": str(output_zip),
        "zip_sha256": digest(output_zip.read_bytes()),
        "package_files": len(names),
        "manifest_entries": len(expected),
        "verified": True,
        "deterministic_timestamp": "1980-01-01T00:00:00Z",
    }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
