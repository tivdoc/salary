from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from typing import Any, Iterable


VERIFIER_VERSION = "tivdoc-independent-v04-verifier-1.0.0"
EXPECTED_ZIP_SHA256 = "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c"
EXPECTED_MANIFEST_SHA256 = "9fa62f6848c5bef1e4bfae1654b5e0673bf61589c6ca985d1578a44d95c7c5bf"
EXPECTED_MEMBERS = 115
EXPECTED_MANIFEST_ENTRIES = 114
MANIFEST_NAME = "package-manifest.json"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA64 = re.compile(r"^[0-9a-f]{64}$")
DEVICE = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE)
RULES = (
    "source_zip_sha256",
    "manifest_sha256",
    "manifest_self_exclusion",
    "exact_115_members_and_114_manifest_entries",
    "posix_relative_nfc_paths",
    "no_traversal_or_backslash",
    "no_windows_device_or_drive_paths",
    "no_duplicate_or_casefold_collision",
    "regular_files_only_no_links",
    "no_encrypted_members",
    "manifest_exact_member_set_byte_count_sha256",
    "safe_extract_to_new_empty_directory",
    "nested_evidence_manifest_hashes",
    "command_stdout_stderr_hashes_and_result_identity",
    "git_object_parent_tree_patch_and_inventory_reachability",
)
RULE_SET_SHA256 = hashlib.sha256(("\n".join(RULES) + "\n").encode()).hexdigest()


class VerificationError(ValueError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fail(code: str, detail: str = "") -> None:
    raise VerificationError(f"{code}:{detail}" if detail else code)


def safe_name(raw: str) -> pathlib.PurePosixPath:
    if not raw or "\x00" in raw or "\\" in raw:
        fail("unsafe_archive_path", raw)
    if unicodedata.normalize("NFC", raw) != raw:
        fail("non_nfc_archive_path", raw)
    path_value = pathlib.PurePosixPath(raw)
    if path_value.is_absolute() or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        fail("absolute_or_drive_archive_path", raw)
    if not path_value.parts or any(part in ("", ".", "..") for part in path_value.parts):
        fail("archive_traversal", raw)
    for part in path_value.parts:
        if part.endswith((" ", ".")) or ":" in part or DEVICE.match(part):
            fail("device_or_nonportable_archive_path", raw)
    return path_value


def load_archive(source: pathlib.Path, expected_zip_sha256: str, expected_manifest_sha256: str) -> tuple[dict[str, bytes], dict[str, Any]]:
    source_bytes = source.read_bytes()
    if digest(source_bytes) != expected_zip_sha256:
        fail("source_zip_sha256_mismatch", digest(source_bytes))
    members: dict[str, bytes] = {}
    folded: set[str] = set()
    with zipfile.ZipFile(source, "r") as archive:
        for info in archive.infolist():
            name = str(safe_name(info.filename))
            folded_name = name.casefold()
            if name in members:
                fail("duplicate_archive_member", name)
            if folded_name in folded:
                fail("case_collision_archive_member", name)
            folded.add(folded_name)
            mode = info.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if info.is_dir() or name.endswith("/"):
                fail("directory_archive_member", name)
            if file_type not in (0, stat.S_IFREG):
                fail("non_regular_archive_member", name)
            if info.flag_bits & 0x1:
                fail("encrypted_archive_member", name)
            members[name] = archive.read(info)
    if len(members) != EXPECTED_MEMBERS:
        fail("archive_member_count_mismatch", str(len(members)))
    manifest_bytes = members.get(MANIFEST_NAME)
    if manifest_bytes is None:
        fail("package_manifest_missing")
    if digest(manifest_bytes) != expected_manifest_sha256:
        fail("manifest_sha256_mismatch", digest(manifest_bytes))
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError("package_manifest_invalid_json") from error
    if manifest.get("manifest_self_excluded_to_avoid_recursive_hash") is not True:
        fail("manifest_self_exclusion_missing")
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) != EXPECTED_MANIFEST_ENTRIES:
        fail("manifest_entry_count_mismatch", str(len(entries) if isinstance(entries, list) else -1))
    expected: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            fail("manifest_entry_invalid")
        name = str(safe_name(str(entry.get("path", ""))))
        if name == MANIFEST_NAME or name in expected:
            fail("manifest_path_duplicate_or_self", name)
        data = members.get(name)
        if data is None:
            fail("manifest_member_missing", name)
        if entry.get("byte_count") != len(data) or entry.get("sha256") != digest(data):
            fail("manifest_member_changed", name)
        expected.add(name)
    actual = set(members) - {MANIFEST_NAME}
    if actual != expected:
        fail("manifest_member_set_mismatch", f"extra={sorted(actual-expected)} missing={sorted(expected-actual)}")
    return members, manifest


def extract_new_empty(members: dict[str, bytes], target: pathlib.Path) -> None:
    if target.exists():
        fail("extraction_target_must_not_exist", str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(f".{target.name}.verifying-{os.getpid()}")
    if staging.exists():
        fail("extraction_staging_exists", str(staging))
    staging.mkdir()
    try:
        root = staging.resolve()
        for name in sorted(members):
            relative = safe_name(name)
            destination = (root / pathlib.Path(*relative.parts)).resolve()
            if root not in destination.parents:
                fail("extraction_path_escape", name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(members[name])
        staging.replace(target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def json_member(members: dict[str, bytes], name: str) -> Any:
    try:
        return json.loads(members[name])
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"referenced_json_invalid:{name}") from error


def validate_reference(members: dict[str, bytes], name: str, expected_sha: Any, expected_bytes: Any = None) -> None:
    data = members.get(name)
    if data is None:
        fail("referenced_member_missing", name)
    if expected_sha != digest(data):
        fail("referenced_member_hash_mismatch", name)
    if expected_bytes is not None and expected_bytes != len(data):
        fail("referenced_member_size_mismatch", name)


def validate_nested_manifests(members: dict[str, bytes]) -> int:
    checks = 0
    inventory = json_member(members, "evidence-input-inventory.json")
    copied = inventory.get("copied")
    if not isinstance(copied, list):
        fail("evidence_input_inventory_missing")
    for entry in copied:
        validate_reference(members, entry["copied_to"], entry["sha256"], entry["byte_count"])
        checks += 1

    final_manifest = json_member(members, "final-verification/evidence-manifest.json")
    validate_reference(members, "final-verification/result.json", final_manifest["result_sha256"])
    checks += 1
    for entry in final_manifest.get("files", []):
        validate_reference(members, f"final-verification/{entry['path']}", entry["sha256"], entry["byte_count"])
        checks += 1

    manifest_specs = (
        ("worker-evidence/B1/evidence-manifest.json", "worker-evidence/B1/", "name", "byte_count"),
        ("worker-evidence/B2/integration-evidence-manifest.json", "worker-evidence/B2/", "path", "byte_count"),
        ("worker-evidence/B3/evidence-manifest.json", "worker-evidence/B3/", "path", "bytes"),
    )
    for manifest_name, prefix, path_key, byte_key in manifest_specs:
        nested = json_member(members, manifest_name)
        for entry in nested.get("files", []):
            validate_reference(members, prefix + entry[path_key], entry["sha256"], entry[byte_key])
            checks += 1

    result = json_member(members, "final-verification/result.json")
    result_by_id = {entry["id"]: entry for entry in result.get("commands", [])}
    command_names = sorted(name for name in members if name.startswith("final-verification/commands/") and name.endswith(".json"))
    if len(command_names) != result.get("command_count") or len(command_names) != 36:
        fail("command_log_count_mismatch")
    for name in command_names:
        command = json_member(members, name)
        expected = result_by_id.get(command.get("id"))
        if expected is None:
            fail("command_result_reference_missing", name)
        for key in ("sequence", "command", "expected_exit_code", "observed_exit_code", "passed", "stdout_sha256", "stderr_sha256"):
            if command.get(key) != expected.get(key):
                fail("command_result_identity_mismatch", f"{name}:{key}")
        if digest(str(command.get("stdout", "")).encode()) != command.get("stdout_sha256"):
            fail("command_stdout_hash_mismatch", name)
        if digest(str(command.get("stderr", "")).encode()) != command.get("stderr_sha256"):
            fail("command_stderr_hash_mismatch", name)
        checks += 2
    return checks


def git(repo: pathlib.Path, args: Iterable[str], input_bytes: bytes | None = None, check: bool = True) -> bytes:
    result = subprocess.run(["git", *args], cwd=repo, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if check and result.returncode != 0:
        fail("git_reference_check_failed", f"{' '.join(args)}:{result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def walk_sha40(value: Any, key: str = "") -> Iterable[tuple[str, str]]:
    if isinstance(value, dict):
        for child_key, child in value.items():
            yield from walk_sha40(child, child_key)
    elif isinstance(value, list):
        for child in value:
            yield from walk_sha40(child, key)
    elif isinstance(value, str) and SHA40.fullmatch(value) and "patch_id" not in key:
        yield key, value


def verify_git_references(repo: pathlib.Path, members: dict[str, bytes]) -> dict[str, Any]:
    audits = [json_member(members, "git/wave2-git-audit.json"), json_member(members, "worker-evidence/A1/wave1-git-audit.json")]
    objects: dict[str, str] = {}
    for audit in audits:
        for _, sha in walk_sha40(audit):
            if sha in objects:
                continue
            obj_type = git(repo, ["cat-file", "-t", sha]).decode().strip()
            if obj_type not in ("commit", "tree", "blob"):
                fail("unexpected_git_object_type", f"{sha}:{obj_type}")
            objects[sha] = obj_type

    final_sha = json_member(members, "final-verification/result.json")["final_head"]
    if final_sha != audits[0].get("final_integration_sha"):
        fail("final_head_git_audit_mismatch")
    if subprocess.run(["git", "merge-base", "--is-ancestor", final_sha, "HEAD"], cwd=repo).returncode != 0:
        fail("package_final_head_not_ancestor_of_current_head")

    inventory_checks = 0
    inventory_mismatches: list[dict[str, Any]] = []
    for inventory_name in (
        "git/original-base-to-head-inventory.json",
        "git/wave2-base-to-head-inventory.json",
    ):
        inventory = json_member(members, inventory_name)
        range_value = inventory.get("range")
        base = range_value.split("..", 1)[0] if isinstance(range_value, str) and ".." in range_value else None
        if not isinstance(base, str) or not SHA40.fullmatch(base):
            fail("inventory_base_missing", inventory_name)
        raw = git(repo, ["diff", "--name-status", "--find-renames=100%", f"{base}..{final_sha}"]).decode().splitlines()
        actual_paths = []
        for line in raw:
            fields = line.split("\t")
            actual_paths.append({"status": fields[0], "paths": fields[1:]})
        expected_entries = inventory.get("entries", [])
        expected_identity = [{"status": entry["status"], "paths": entry["paths"]} for entry in expected_entries]
        if actual_paths != expected_identity:
            fail("git_inventory_changed_path_mismatch", inventory_name)
        for entry in expected_entries:
            target_path = entry["paths"][-1]
            if entry.get("target_sha256") is None:
                continue
            blob = git(repo, ["show", f"{final_sha}:{target_path}"])
            checkout_candidates = [blob]
            if b"\r\n" not in blob and b"\n" in blob:
                checkout_candidates.append(blob.replace(b"\n", b"\r\n"))
            if not any(digest(candidate) == entry["target_sha256"] and len(candidate) == entry["target_byte_count"] for candidate in checkout_candidates):
                inventory_mismatches.append({
                    "inventory": inventory_name,
                    "path": target_path,
                    "expected_sha256": entry["target_sha256"],
                    "expected_byte_count": entry["target_byte_count"],
                    "git_blob_sha256": digest(blob),
                    "git_blob_byte_count": len(blob),
                    "crlf_checkout_sha256": digest(blob.replace(b"\n", b"\r\n")),
                    "crlf_checkout_byte_count": len(blob.replace(b"\n", b"\r\n")),
                })
            inventory_checks += 1

    return {
        "package_final_head": final_sha,
        "package_final_head_is_ancestor_of_current_head": True,
        "referenced_git_object_count": len(objects),
        "referenced_commit_count": sum(value == "commit" for value in objects.values()),
        "referenced_tree_count": sum(value == "tree" for value in objects.values()),
        "referenced_blob_count": sum(value == "blob" for value in objects.values()),
        "inventory_target_hash_checks": inventory_checks,
        "inventory_target_hash_mismatches": inventory_mismatches,
        "reference_comparison_passed": len(inventory_mismatches) == 0,
    }


def verify(source: pathlib.Path, target: pathlib.Path, repo: pathlib.Path, expected_zip: str, expected_manifest: str) -> dict[str, Any]:
    members, manifest = load_archive(source, expected_zip, expected_manifest)
    extract_new_empty(members, target)
    reference_checks = validate_nested_manifests(members)
    git_result = verify_git_references(repo, members)
    return {
        "schema_version": "tivdoc-independent-wave2-package-verification-v0.4.1",
        "verifier_version": VERIFIER_VERSION,
        "rule_set_sha256": RULE_SET_SHA256,
        "rules": list(RULES),
        "source_zip_sha256": digest(source.read_bytes()),
        "manifest_sha256": digest(members[MANIFEST_NAME]),
        "member_count": len(members),
        "manifest_entry_count": len(manifest["files"]),
        "manifest_self_excluded": True,
        "safe_extraction": {"new_empty_directory": str(target), "files_written": len(members), "passed": True},
        "nested_hash_and_command_checks": reference_checks,
        "git": git_result,
        "structural_and_nested_evidence_passed": True,
        "passed": git_result["reference_comparison_passed"],
    }


def write_fixture(target: pathlib.Path, transform: str | None = None) -> None:
    files = {f"fixture/{index:03d}.txt": f"fixture-{index}\n".encode() for index in range(114)}
    entries = [{"path": name, "byte_count": len(data), "sha256": digest(data)} for name, data in sorted(files.items())]
    manifest = {"manifest_self_excluded_to_avoid_recursive_hash": True, "files": entries}
    members = [(name, data, 0o100644 << 16) for name, data in files.items()]
    members.append((MANIFEST_NAME, (json.dumps(manifest, sort_keys=True) + "\n").encode(), 0o100644 << 16))
    if transform == "traversal": members[-2] = ("../escape.txt", members[-2][1], members[-2][2])
    elif transform == "device": members[-2] = ("fixture/CON.txt", members[-2][1], members[-2][2])
    elif transform == "case": members[-2] = ("FIXTURE/000.TXT", members[-2][1], members[-2][2])
    elif transform == "link": members[-2] = (members[-2][0], b"fixture/000.txt", 0o120777 << 16)
    elif transform == "extra": members.insert(-1, ("extra.txt", b"extra", 0o100644 << 16))
    elif transform == "missing": members.pop(-2)
    elif transform == "changed": members[0] = (members[0][0], members[0][1] + b"changed", members[0][2])
    elif transform == "duplicate": members.insert(1, members[0])
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data, mode in members:
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.external_attr = mode
            archive.writestr(info, data)


def self_test() -> dict[str, Any]:
    expected_codes = {
        "traversal": "archive_traversal",
        "device": "device_or_nonportable_archive_path",
        "case": "case_collision_archive_member",
        "link": "non_regular_archive_member",
        "extra": "archive_member_count_mismatch",
        "missing": "archive_member_count_mismatch",
        "changed": "manifest_member_changed",
        "duplicate": "duplicate_archive_member",
    }
    checks = []
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave21-verifier-test-") as temp:
        root = pathlib.Path(temp)
        for variant, expected in expected_codes.items():
            fixture = root / f"{variant}.zip"
            write_fixture(fixture, variant)
            try:
                load_archive(fixture, digest(fixture.read_bytes()), digest(zipfile.ZipFile(fixture).read(MANIFEST_NAME)))
            except VerificationError as error:
                if not str(error).startswith(expected):
                    fail("adversarial_wrong_failure", f"{variant}:{error}")
                checks.append({"id": variant, "expected_rejection": expected, "passed": True})
            else:
                fail("adversarial_variant_accepted", variant)
    return {"verifier_version": VERIFIER_VERSION, "rule_set_sha256": RULE_SET_SHA256, "checks": checks, "passed": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("verify", "self-test"))
    parser.add_argument("--source-zip")
    parser.add_argument("--output-dir")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--expected-zip-sha256", default=EXPECTED_ZIP_SHA256)
    parser.add_argument("--expected-manifest-sha256", default=EXPECTED_MANIFEST_SHA256)
    args = parser.parse_args()
    if args.command == "self-test":
        result = self_test()
    else:
        if not args.source_zip or not args.output_dir:
            parser.error("verify requires --source-zip and --output-dir")
        result = verify(pathlib.Path(args.source_zip).resolve(), pathlib.Path(args.output_dir).resolve(), pathlib.Path(args.repo_root).resolve(), args.expected_zip_sha256, args.expected_manifest_sha256)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"WAVE21_V04_PACKAGE_VERIFICATION_FAILED {error}", file=sys.stderr)
        raise SystemExit(2) from error
