from __future__ import annotations

import hashlib
import json
import pathlib
import stat
import sys
import tempfile
import unicodedata
import zipfile


FIXED_TIME = (1980, 1, 1, 0, 0, 0)
WINDOWS_DEVICES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(name: str) -> pathlib.PurePosixPath:
    if not name or "\x00" in name or "\\" in name or unicodedata.normalize("NFC", name) != name:
        raise ValueError(f"unsafe_archive_path:{name}")
    value = pathlib.PurePosixPath(name)
    if value.is_absolute() or not value.parts or ".." in value.parts or ":" in value.parts[0]:
        raise ValueError(f"unsafe_archive_path:{name}")
    for part in value.parts:
        stem = part.rstrip(" .").split(".", 1)[0].upper()
        if part in ("", ".") or part != part.rstrip(" .") or stem in WINDOWS_DEVICES or ":" in part:
            raise ValueError(f"device_or_nonportable_archive_path:{name}")
    return value


def build(package_dir: pathlib.Path, target: pathlib.Path, names: list[str]) -> None:
    if target.exists():
        target.unlink()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            data = (package_dir / pathlib.Path(*safe_name(name).parts)).read_bytes()
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_and_extract(archive_path: pathlib.Path, expected: dict[str, dict[str, object]]) -> int:
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave22-consumer-") as temporary:
        root = pathlib.Path(temporary).resolve()
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise ValueError("duplicate_archive_member")
            folded = [unicodedata.normalize("NFC", name).casefold() for name in names]
            if len(folded) != len(set(folded)):
                raise ValueError("case_collision_archive_member")
            if set(names) != set(expected) | {"package-manifest.json"}:
                raise ValueError("archive_member_set_mismatch")
            for info in infos:
                relative = safe_name(info.filename)
                mode = info.external_attr >> 16
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                    raise ValueError(f"archive_non_regular_member:{info.filename}")
                target = (root / pathlib.Path(*relative.parts)).resolve()
                if root not in target.parents:
                    raise ValueError(f"archive_path_escape:{info.filename}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
        for relative, entry in expected.items():
            data = (root / pathlib.Path(*safe_name(relative).parts)).read_bytes()
            if len(data) != entry["byte_count"] or digest(data) != entry["sha256"]:
                raise ValueError(f"consumer_extract_mismatch:{relative}")
        return len(names)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: parallel-wave22-review-package-zip.py PACKAGE_DIR OUTPUT_ZIP")
    package_dir = pathlib.Path(sys.argv[1]).resolve()
    output_zip = pathlib.Path(sys.argv[2]).resolve()
    manifest_bytes = (package_dir / "package-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("manifest_self_excluded_to_avoid_recursive_hash") is not True:
        raise ValueError("manifest_self_exclusion_not_declared")
    expected = {entry["path"]: entry for entry in manifest["files"]}
    names = sorted(str(item.relative_to(package_dir)).replace("\\", "/") for item in package_dir.rglob("*") if item.is_file())
    if set(names) != set(expected) | {"package-manifest.json"}:
        raise ValueError("package_member_set_mismatch")
    for relative, entry in expected.items():
        data = (package_dir / pathlib.Path(*safe_name(relative).parts)).read_bytes()
        if len(data) != entry["byte_count"] or digest(data) != entry["sha256"]:
            raise ValueError(f"package_manifest_mismatch:{relative}")
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    build(package_dir, output_zip, names)
    extracted = verify_and_extract(output_zip, expected)
    print(json.dumps({
        "zip_sha256": digest(output_zip.read_bytes()),
        "zip_byte_count": output_zip.stat().st_size,
        "package_files": len(names),
        "manifest_entries": len(expected),
        "manifest_sha256": digest(manifest_bytes),
        "consumer_safe_extraction_verified": True,
        "consumer_extracted_files": extracted,
        "deterministic_timestamp": "1980-01-01T00:00:00Z",
        "rejected_member_classes": ["traversal", "absolute", "backslash", "duplicate", "case_collision", "link", "device", "extra", "missing", "changed_bytes"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
