from __future__ import annotations

# L8-1 / D2: scripts refuse a production environment, before anything else.
import os as _tivdoc_os, sys as _tivdoc_sys
if _tivdoc_os.environ.get("NODE_ENV") == "production" or _tivdoc_os.environ.get("VERCEL_ENV") in ("production", "preview"):
    _tivdoc_sys.stderr.write("PRODUCTION_ENVIRONMENT_REFUSED\n")
    _tivdoc_sys.exit(2)

import argparse
import hashlib
import json
import pathlib
import shutil
import sys
import tempfile
import zipfile
from typing import Any


FIXED_TIME = (1980, 1, 1, 0, 0, 0)
MANIFEST_NAME = "package-manifest.json"


class VerificationError(ValueError):
    pass


class SimulatedInterruption(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(name: str) -> pathlib.PurePosixPath:
    if "\\" in name:
        raise VerificationError(f"unsafe_archive_path:{name}")
    value = pathlib.PurePosixPath(name)
    if (
        value.is_absolute()
        or not value.parts
        or any(part in {"", ".", ".."} for part in value.parts)
        or ":" in value.parts[0]
    ):
        raise VerificationError(f"unsafe_archive_path:{name}")
    return value


def load_members(source_zip: pathlib.Path, expected_sha256: str) -> dict[str, bytes]:
    source_bytes = source_zip.read_bytes()
    actual = digest(source_bytes)
    if actual != expected_sha256:
        raise VerificationError(f"source_zip_sha256_mismatch:{actual}")
    members: dict[str, bytes] = {}
    casefolded: set[str] = set()
    with zipfile.ZipFile(source_zip, "r") as archive:
        for info in archive.infolist():
            name = str(safe_name(info.filename))
            if info.is_dir():
                raise VerificationError(f"directory_member_rejected:{name}")
            mode = info.external_attr >> 16
            if mode & 0o170000 == 0o120000:
                raise VerificationError(f"archive_symlink_rejected:{name}")
            if name in members or name.casefold() in casefolded:
                raise VerificationError(f"duplicate_archive_member:{name}")
            casefolded.add(name.casefold())
            members[name] = archive.read(info)
    return members


def validate_members(members: dict[str, bytes]) -> dict[str, Any]:
    for name in members:
        safe_name(name)
    if MANIFEST_NAME not in members:
        raise VerificationError("package_manifest_missing")
    try:
        manifest = json.loads(members[MANIFEST_NAME].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError("package_manifest_corrupt") from error
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise VerificationError("package_manifest_entries_missing")
    expected_names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise VerificationError("package_manifest_entry_invalid")
        relative = str(safe_name(str(entry.get("path", ""))))
        if relative == MANIFEST_NAME or relative in expected_names:
            raise VerificationError(f"package_manifest_path_invalid:{relative}")
        expected_names.add(relative)
        data = members.get(relative)
        if data is None:
            raise VerificationError(f"package_member_missing:{relative}")
        if len(data) != entry.get("byte_count") or digest(data) != entry.get("sha256"):
            raise VerificationError(f"package_manifest_mismatch:{relative}")
    actual_names = set(members) - {MANIFEST_NAME}
    if actual_names != expected_names:
        extras = sorted(actual_names - expected_names)
        missing = sorted(expected_names - actual_names)
        raise VerificationError(f"package_member_set_mismatch:extra={extras}:missing={missing}")

    try:
        inventory = json.loads(members["input-output-inventory.json"].decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError("input_output_inventory_invalid") from error
    worker = inventory.get("copied_worker_evidence")
    central = inventory.get("copied_central_evidence")
    if not isinstance(worker, list) or not isinstance(central, list):
        raise VerificationError("copied_evidence_inventory_invalid")
    copied_evidence = len(worker) + len(central)
    if len(members) != 140 or len(entries) != 139 or copied_evidence != 133:
        raise VerificationError(
            f"wave1_package_count_mismatch:files={len(members)}:manifest={len(entries)}:evidence={copied_evidence}"
        )
    generated_paths = sorted(set(members) - {item["copied_to"] for item in worker} - {item["copied_to"] for item in central})
    return {
        "package_file_count": len(members),
        "manifest_entry_count": len(entries),
        "copied_evidence_file_count": copied_evidence,
        "generated_package_file_count_including_manifest": len(generated_paths),
        "generated_package_paths": generated_paths,
        "count_explanation": {
            "140": "all ZIP members, including package-manifest.json",
            "139": "manifest-covered members; the manifest excludes itself to avoid a recursive hash",
            "133": "copied worker and central legal evidence rows in input-output-inventory.json",
            "remaining_7": "six generated audit/index/scan files plus package-manifest.json",
        },
        "manifest_sha256": digest(members[MANIFEST_NAME]),
    }


def verify_directory(package_root: pathlib.Path, members: dict[str, bytes]) -> None:
    actual: dict[str, bytes] = {}
    for item in package_root.rglob("*"):
        if item.is_symlink():
            raise VerificationError(f"package_symlink_rejected:{item}")
        if item.is_file():
            relative = item.relative_to(package_root).as_posix()
            safe_name(relative)
            actual[relative] = item.read_bytes()
    if actual != members:
        raise VerificationError("reconstructed_directory_member_mismatch")
    validate_members(actual)


def build_zip(package_root: pathlib.Path, target: pathlib.Path, names: list[str]) -> None:
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            data = (package_root / pathlib.Path(*safe_name(name).parts)).read_bytes()
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    temporary.replace(target)


def consumer_safe_extract(archive_path: pathlib.Path, expected: dict[str, bytes]) -> int:
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave1-audit-consumer-") as temporary:
        root = pathlib.Path(temporary).resolve()
        observed: dict[str, bytes] = {}
        with zipfile.ZipFile(archive_path, "r") as archive:
            for info in archive.infolist():
                relative = safe_name(info.filename)
                target = (root / pathlib.Path(*relative.parts)).resolve()
                if root not in target.parents:
                    raise VerificationError(f"consumer_path_escape:{info.filename}")
                target.parent.mkdir(parents=True, exist_ok=True)
                data = archive.read(info)
                target.write_bytes(data)
                observed[str(relative)] = data
        if observed != expected:
            raise VerificationError("consumer_extract_member_mismatch")
        validate_members(observed)
        return len(observed)


def reconstruct(
    members: dict[str, bytes],
    output_root: pathlib.Path,
    run_name: str,
    fault_after_members: int | None = None,
) -> dict[str, Any]:
    safe_name(run_name)
    resolved_output = output_root.resolve()
    run_root = (resolved_output / run_name).resolve()
    staging = (resolved_output / f".{run_name}.building").resolve()
    if resolved_output not in run_root.parents or resolved_output not in staging.parents:
        raise VerificationError("rebuild_output_path_escape")
    shutil.rmtree(run_root, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=False)
    (staging / ".incomplete").write_text("wave1-package-rebuild-incomplete\n", encoding="utf-8")
    for index, name in enumerate(sorted(members), start=1):
        relative = safe_name(name)
        target = staging / pathlib.Path(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(members[name])
        if fault_after_members is not None and index == fault_after_members:
            raise SimulatedInterruption(f"simulated_interrupt_after_member:{index}")
    (staging / ".incomplete").unlink()
    staging.replace(run_root)
    verify_directory(run_root, members)
    archive_path = resolved_output / f"{run_name}.zip"
    archive_path.unlink(missing_ok=True)
    build_zip(run_root, archive_path, sorted(members))
    extracted = consumer_safe_extract(archive_path, members)
    return {
        "run_name": run_name,
        "package_path": str(run_root),
        "zip_path": str(archive_path),
        "zip_sha256": digest(archive_path.read_bytes()),
        "consumer_extracted_files": extracted,
        "consumer_safe_extraction_verified": True,
        "stale_output_removed": not (run_root / "stale-output.txt").exists(),
    }


def normal_verification(source_zip: pathlib.Path, expected_sha256: str, output_root: pathlib.Path) -> dict[str, Any]:
    members = load_members(source_zip, expected_sha256)
    inventory = validate_members(members)
    output_root.mkdir(parents=True, exist_ok=True)
    first = reconstruct(members, output_root, "run-a")
    second = reconstruct(members, output_root, "run-b")
    passed = first["zip_sha256"] == second["zip_sha256"] == expected_sha256
    if not passed:
        raise VerificationError("deterministic_reconstruction_hash_mismatch")
    return {
        "schema_version": "tivdoc-wave1-review-package-verification-v0.4",
        "source_zip": str(source_zip),
        "source_zip_sha256": expected_sha256,
        **inventory,
        "rebuilds": [first, second],
        "byte_identical_rebuilds": True,
        "byte_identical_to_canonical_zip": True,
        "consumer_safe_extraction_verified": True,
        "legal_meaning_mutated": False,
    }


def expect_failure(name: str, action: Any, expected_prefix: str) -> dict[str, Any]:
    try:
        action()
    except (VerificationError, SimulatedInterruption) as error:
        message = str(error)
        if not message.startswith(expected_prefix):
            raise VerificationError(f"adversarial_check_wrong_error:{name}:{message}") from error
        return {"name": name, "passed": True, "reason": message}
    raise VerificationError(f"adversarial_check_did_not_fail:{name}")


def self_test(source_zip: pathlib.Path, expected_sha256: str, output_root: pathlib.Path) -> dict[str, Any]:
    members = load_members(source_zip, expected_sha256)
    validate_members(members)
    output_root.mkdir(parents=True, exist_ok=True)

    stale_root = output_root / "run-a"
    stale_root.mkdir(parents=True, exist_ok=True)
    (stale_root / "stale-output.txt").write_text("stale\n", encoding="utf-8")
    baseline = normal_verification(source_zip, expected_sha256, output_root)
    stale_passed = not (output_root / "run-a" / "stale-output.txt").exists()
    if not stale_passed:
        raise VerificationError("stale_output_cleanup_failed")

    checks: list[dict[str, Any]] = []
    checks.append(expect_failure(
        "forced_source_hash_mismatch",
        lambda: load_members(source_zip, "0" * 64),
        "source_zip_sha256_mismatch:",
    ))

    corrupt_manifest = dict(members)
    manifest = json.loads(corrupt_manifest[MANIFEST_NAME].decode("utf-8"))
    manifest["files"][0]["sha256"] = "0" * 64
    corrupt_manifest[MANIFEST_NAME] = (json.dumps(manifest, sort_keys=True) + "\n").encode("utf-8")
    checks.append(expect_failure(
        "corrupt_manifest",
        lambda: validate_members(corrupt_manifest),
        "package_manifest_mismatch:",
    ))

    changed_member = dict(members)
    changed_name = next(name for name in sorted(changed_member) if name != MANIFEST_NAME)
    changed_member[changed_name] = changed_member[changed_name] + b"corrupt"
    checks.append(expect_failure(
        "changed_zip_member",
        lambda: validate_members(changed_member),
        "package_manifest_mismatch:",
    ))

    unexpected_member = dict(members)
    unexpected_member["unexpected.txt"] = b"unexpected"
    checks.append(expect_failure(
        "unexpected_zip_member",
        lambda: validate_members(unexpected_member),
        "package_member_set_mismatch:",
    ))

    unsafe_member = dict(members)
    unsafe_member["../escape.txt"] = b"escape"
    checks.append(expect_failure(
        "unsafe_archive_path",
        lambda: validate_members(unsafe_member),
        "unsafe_archive_path:",
    ))

    interruption = expect_failure(
        "interrupted_build",
        lambda: reconstruct(members, output_root, "recovery", fault_after_members=4),
        "simulated_interrupt_after_member:4",
    )
    checks.append(interruption)
    partial_marker_observed = (output_root / ".recovery.building" / ".incomplete").exists()
    recovered = reconstruct(members, output_root, "recovery")
    recovery_passed = (
        partial_marker_observed
        and recovered["zip_sha256"] == expected_sha256
        and not (output_root / ".recovery.building").exists()
    )
    if not recovery_passed:
        raise VerificationError("interrupted_build_recovery_failed")

    return {
        "schema_version": "tivdoc-wave1-review-package-adversarial-self-test-v0.4",
        "baseline": baseline,
        "checks": checks,
        "stale_output_cleanup": {"passed": stale_passed},
        "interrupted_build_recovery": {
            "passed": recovery_passed,
            "partial_marker_observed": partial_marker_observed,
            "recovered_zip_sha256": recovered["zip_sha256"],
        },
        "passed": all(check["passed"] for check in checks) and stale_passed and recovery_passed,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["verify", "self-test"])
    parser.add_argument("--source-zip", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    source_zip = pathlib.Path(args.source_zip).resolve()
    output_root = pathlib.Path(args.output_root).resolve()
    result = (
        normal_verification(source_zip, args.expected_sha256, output_root)
        if args.command == "verify"
        else self_test(source_zip, args.expected_sha256, output_root)
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (VerificationError, SimulatedInterruption) as error:
        print(f"WAVE1_REVIEW_PACKAGE_VERIFICATION_FAILED {error}", file=sys.stderr)
        raise SystemExit(2) from error
