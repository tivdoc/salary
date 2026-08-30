#!/usr/bin/env python3
"""Independent V0.4/V0.4.1/V0.4.2 verifier; imports no Tivdoc generators."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import unicodedata
import zipfile

V04_ZIP_SHA256 = "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c"
V04_MANIFEST_SHA256 = "9fa62f6848c5bef1e4bfae1654b5e0673bf61589c6ca985d1578a44d95c7c5bf"
V041_ZIP_SHA256 = "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2"
V041_MANIFEST_SHA256 = "f4a4ea363abdaf15a2a3cdbba925937360a08d14d704bc3fe6060b2264fcf16b"
V04_HEAD = "5ce3eba6ab816cd6a20e101c913f7f1177c7598a"
V041_HEAD = "48be587d5a394e37656e20a1276b4cebb85c60bb"
MANIFEST_NAME = "package-manifest.json"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA_RE = re.compile(r"^[a-f0-9]{40}$")

RULES = (
    ("PRIVATE_KEY", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("OPENAI_STYLE_SECRET", re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}")),
    ("SUPABASE_ACCESS_TOKEN", re.compile(rb"\bsbp_[A-Za-z0-9_-]{20,}")),
    ("CUSTOMER_EVAL_IDENTIFIER", re.compile(rb"\bCUSTOMER_EVAL_\d{3}\b")),
    ("PROHIBITED_CUSTOMER_DATASET", re.compile(rb"customer-payslip-data-only-v3", re.I)),
    ("PERSONAL_HOME_PATH", re.compile(rb"\bC:\\Users\\[^\\\s]+", re.I)),
)

REQUIRED_MATRIX_IDS = {
    "crash": [
        "SECURITY_CRASH_001_AFTER_RECEIVED", "SECURITY_CRASH_002_AFTER_PRIVATE_COPY",
        "SECURITY_CRASH_003_AFTER_VALIDATION", "SECURITY_CRASH_004_AFTER_ARTIFACT_PUBLISH",
        "SECURITY_CRASH_005_AFTER_EVENT_PUBLISH", "SECURITY_CRASH_006_AFTER_LEDGER_APPEND",
        "SECURITY_CRASH_007_AFTER_COMMIT_MARKER",
    ],
    "corruption": [
        "SECURITY_CORRUPTION_001_JOURNAL", "SECURITY_CORRUPTION_002_EVENT",
        "SECURITY_CORRUPTION_003_LEDGER", "SECURITY_CORRUPTION_004_COMMIT_MARKER",
    ],
    "multi_process": [
        "SECURITY_MULTIPROCESS_001_IDENTICAL_CONCURRENT",
        "SECURITY_MULTIPROCESS_002_DIFFERENT_BYTES_ONE_IDENTITY",
        "SECURITY_MULTIPROCESS_003_IDENTICAL_BYTES_CONFLICTING_IDENTITY",
        "SECURITY_MULTIPROCESS_004_STALE_LOCK", "SECURITY_MULTIPROCESS_005_PID_REUSE_POISON",
        "SECURITY_MULTIPROCESS_006_RESTART_HOLDING_LOCK",
    ],
    "reader_race": ["SECURITY_READER_RACE_001_PUBLICATION"],
    "rule_input": [
        "RULE_INPUT_NEG_001_MISSING", "RULE_INPUT_NEG_002_CONFLICTED", "RULE_INPUT_NEG_003_UNCONFIRMED",
        "RULE_INPUT_NEG_004_STALE", "RULE_INPUT_NEG_005_LOW_CONFIDENCE",
    ],
    "ground_truth": [
        "GT_NEG_001_DISTINCT_ANNOTATORS", "GT_NEG_002_EMPTY_TEMPLATE", "GT_NEG_003_MISSING_EVIDENCE",
        "GT_NEG_004_HASH_MISMATCH", "GT_NEG_005_INVALID_GEOMETRY",
    ],
}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, separators=(",", ": ")) + "\n"


def run_git(repo: Path, *args: str, binary: bool = False) -> bytes | str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return result.stdout if binary else result.stdout.decode("utf-8", "strict").strip()


def clean_member_name(name: str) -> str:
    if not name or "\x00" in name or "\\" in name:
        raise ValueError("archive_member_name_invalid")
    if name != unicodedata.normalize("NFC", name):
        raise ValueError("archive_member_unicode_not_nfc")
    value = PurePosixPath(name)
    if value.is_absolute() or any(part in ("", ".", "..") for part in value.parts):
        raise ValueError("archive_member_path_escape")
    if re.match(r"^[A-Za-z]:", name) or name.startswith("//"):
        raise ValueError("archive_member_absolute_or_device_path")
    for part in value.parts:
        if any(ord(character) < 32 for character in part) or ":" in part:
            raise ValueError("archive_member_windows_unsafe_component")
        if part.endswith((" ", ".")):
            raise ValueError("archive_member_windows_unsafe_component")
        stem = part.split(".", 1)[0]
        if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", stem):
            raise ValueError("archive_member_absolute_or_device_path")
    if len(name) > 500:
        raise ValueError("archive_member_name_too_long")
    return name


def validate_zip_members(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    infos = zf.infolist()
    if len(infos) > 5000:
        raise ValueError("archive_member_limit_exceeded")
    exact: set[str] = set()
    folded: set[str] = set()
    total = 0
    for info in infos:
        name = clean_member_name(info.filename)
        if name in exact:
            raise ValueError("archive_duplicate_member")
        canonical = unicodedata.normalize("NFC", name).casefold()
        if canonical in folded:
            raise ValueError("archive_case_or_unicode_collision")
        exact.add(name)
        folded.add(canonical)
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode) or stat.S_ISCHR(mode) or stat.S_ISBLK(mode) or stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode):
            raise ValueError("archive_link_or_device_member")
        if info.flag_bits & 0x1:
            raise ValueError("archive_encrypted_member")
        if info.file_size > 128 * 1024 * 1024:
            raise ValueError("archive_member_size_limit_exceeded")
        if info.compress_size and info.file_size / info.compress_size > 200:
            raise ValueError("archive_compression_ratio_limit_exceeded")
        total += info.file_size
    if total > 512 * 1024 * 1024:
        raise ValueError("archive_total_size_limit_exceeded")
    return infos


def safe_extract(zf: zipfile.ZipFile, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    root = destination.resolve()
    for info in validate_zip_members(zf):
        target = (root / PurePosixPath(info.filename)).resolve()
        if root not in target.parents:
            raise ValueError("archive_extraction_escape")
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info, "r") as source, target.open("xb") as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)


def manifest_records(zf: zipfile.ZipFile) -> tuple[dict, list[dict]]:
    try:
        raw = zf.read(MANIFEST_NAME)
    except KeyError as error:
        raise ValueError("package_manifest_missing") from error
    manifest = json.loads(raw)
    records = manifest.get("files")
    if not isinstance(records, list):
        raise ValueError("package_manifest_files_invalid")
    return manifest, records


def verify_manifest(zf: zipfile.ZipFile) -> dict:
    infos = validate_zip_members(zf)
    manifest, records = manifest_records(zf)
    names = sorted(info.filename for info in infos if not info.is_dir())
    expected = sorted(name for name in names if name != MANIFEST_NAME)
    declared: list[str] = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            raise ValueError("package_manifest_record_invalid")
        name = clean_member_name(record["path"])
        if name == MANIFEST_NAME:
            raise ValueError("package_manifest_self_reference")
        data = zf.read(name)
        if record.get("byte_count") != len(data) or record.get("sha256") != sha256_bytes(data):
            raise ValueError("package_manifest_member_mismatch")
        declared.append(name)
    if sorted(declared) != expected or len(set(declared)) != len(declared):
        raise ValueError("package_manifest_membership_mismatch")
    return {
        "zip_member_count": len(names),
        "manifest_entry_count": len(records),
        "manifest_sha256": sha256_bytes(zf.read(MANIFEST_NAME)),
        "manifest_self_exclusion": [MANIFEST_NAME],
        "zip_member_exclusions": ["the outer ZIP itself (self-containment is impossible)"],
    }


def package_scanner(zf: zipfile.ZipFile) -> dict:
    names = sorted(info.filename for info in zf.infolist() if not info.is_dir())
    scanner_reports = [
        name for name in names
        if Path(name).name in ("pii-secret-scan.json", "secret-pii-scan.json", "independent-secret-pii-scan.json")
    ]
    exclusions = sorted(set([MANIFEST_NAME, *scanner_reports]))
    scanned: list[str] = []
    binary: list[str] = []
    findings: list[dict] = []
    for name in names:
        if name in exclusions:
            continue
        data = zf.read(name)
        if b"\x00" in data[:8192]:
            binary.append(name)
        scanned.append(name)
        for rule_id, pattern in RULES:
            for match in pattern.finditer(data):
                classification = "policy_reference" if rule_id == "PROHIBITED_CUSTOMER_DATASET" else "unresolved"
                findings.append({"rule_id": rule_id, "path": name, "byte_offset": match.start(), "classification": classification})
    rule_payload = [{"id": rule_id, "pattern_sha256": sha256_bytes(pattern.pattern)} for rule_id, pattern in RULES]
    unresolved = [finding for finding in findings if finding["classification"] == "unresolved"]
    return {
        "scanner_name": "tivdoc-wave22-independent-secret-pii-scanner",
        "scanner_version": "1.0.0",
        "rules_sha256": sha256_bytes(stable_json(rule_payload).encode()),
        "rules": rule_payload,
        "scope": scanned,
        "scope_count": len(scanned),
        "excluded_files": exclusions,
        "binary_files": binary,
        "raw_findings": findings,
        "unresolved_findings_count": len(unresolved),
        "passed": len(unresolved) == 0,
    }


def staging_scanner(staging: Path, output: Path) -> dict:
    root = staging.resolve()
    output_resolved = output.resolve()
    if not root.is_dir() or root not in output_resolved.parents:
        raise ValueError("scanner_staging_or_output_invalid")
    files: list[Path] = []
    for candidate in root.rglob("*"):
        if candidate.is_symlink():
            raise ValueError("scanner_staging_symlink_denied")
        relative = str(candidate.relative_to(root)).replace("\\", "/")
        if candidate.is_file() and candidate.resolve() != output_resolved and relative != MANIFEST_NAME:
            files.append(candidate)
    scope: list[str] = []
    binary: list[str] = []
    findings: list[dict] = []
    for candidate in sorted(files, key=lambda item: str(item.relative_to(root)).replace("\\", "/")):
        relative = str(candidate.relative_to(root)).replace("\\", "/")
        data = candidate.read_bytes()
        scope.append(relative)
        if b"\x00" in data[:8192]:
            binary.append(relative)
        for rule_id, pattern in RULES:
            for match in pattern.finditer(data):
                classification = "policy_reference" if rule_id == "PROHIBITED_CUSTOMER_DATASET" else "unresolved"
                findings.append({"rule_id": rule_id, "path": relative, "byte_offset": match.start(), "classification": classification})
    rule_payload = [{"id": rule_id, "pattern_sha256": sha256_bytes(pattern.pattern)} for rule_id, pattern in RULES]
    unresolved = [finding for finding in findings if finding["classification"] == "unresolved"]
    return {
        "schema_version": "tivdoc-wave22-independent-secret-pii-scan-v0.4.2",
        "scanner_name": "tivdoc-wave22-independent-secret-pii-scanner",
        "scanner_version": "1.0.0",
        "rules_sha256": sha256_bytes(stable_json(rule_payload).encode()),
        "rules": rule_payload,
        "scope": scope,
        "scope_count": len(scope),
        "excluded_files": [MANIFEST_NAME, str(output_resolved.relative_to(root)).replace("\\", "/")],
        "binary_files": binary,
        "raw_findings": findings,
        "unresolved_findings_count": len(unresolved),
        "passed": len(unresolved) == 0,
    }


def json_members(zf: zipfile.ZipFile) -> dict[str, object]:
    result: dict[str, object] = {}
    for info in zf.infolist():
        if info.is_dir() or not info.filename.endswith(".json"):
            continue
        try:
            result[info.filename] = json.loads(zf.read(info.filename))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    return result


def walk_json(value: object, pointer: str = ""):
    yield pointer or "/", value
    if isinstance(value, dict):
        for key, item in value.items():
            escaped = key.replace("~", "~0").replace("/", "~1")
            yield from walk_json(item, f"{pointer}/{escaped}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from walk_json(item, f"{pointer}/{index}")


def find_package_head(documents: dict[str, object], fallback: str | None) -> str | None:
    priorities = ("final_head", "integrated_head", "final_sha", "head_sha", "head")
    for priority in priorities:
        for document in documents.values():
            for _, value in walk_json(document):
                if isinstance(value, dict) and isinstance(value.get(priority), str) and GIT_SHA_RE.match(value[priority]):
                    return value[priority]
    return fallback


def git_reference_report(documents: dict[str, object], all_members: list[str], checkout: Path, package_head: str) -> dict:
    git_objects: dict[str, dict] = {}
    contextual_historical_git_objects: list[dict] = []
    checkout_refs: list[dict] = []
    source_scan_exclusions: list[str] = []
    for member, document in documents.items():
        if member == MANIFEST_NAME or Path(member).name.endswith("scan.json"):
            source_scan_exclusions.append(member)
            continue
        for pointer, value in walk_json(document):
            if isinstance(value, str) and GIT_SHA_RE.match(value):
                key = pointer.rsplit("/", 1)[-1].lower()
                if "patch" in key or "rules" in key or "allowlist" in key:
                    continue
                if any(token in key for token in ("sha", "head", "parent", "base", "commit", "tree", "blob", "object")):
                    embedded_historical_verifier_report = package_head not in (V04_HEAD, V041_HEAD) and Path(member).name in (
                        "strict-result.json", "v0.4.1-independent-verification.json"
                    )
                    if embedded_historical_verifier_report:
                        contextual_historical_git_objects.append({
                            "sha": value, "member": member, "pointer": pointer,
                            "context": "embedded_historical_verifier_report_enforced_by_separate_chain_check",
                        })
                        continue
                    if value not in git_objects:
                        probe = subprocess.run(["git", "-C", str(checkout), "cat-file", "-t", value], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        git_objects[value] = {"reachable": probe.returncode == 0, "object_type": probe.stdout.decode().strip() if probe.returncode == 0 else None}
            if not isinstance(value, dict):
                continue
            path_value = value.get("path")
            if not isinstance(path_value, str) and isinstance(value.get("paths"), list) and len(value["paths"]) == 1:
                path_value = value["paths"][0]
            claimed_value = value.get("target_sha256")
            if isinstance(path_value, str) and isinstance(claimed_value, str) and SHA256_RE.match(claimed_value):
                relative = path_value.replace("\\", "/")
                if relative.startswith("../") or PurePosixPath(relative).is_absolute():
                    checkout_refs.append({"member": member, "pointer": pointer, "path": relative, "passed": False, "reason": "path_escape"})
                    continue
                reference_head = package_head
                reference_context = "current_package_head"
                enforced_for_package_head = True
                if Path(member).name == "complete-git-evidence.json" and pointer.startswith("/historical_v0_4_1_git_proof/"):
                    reference_head = V041_HEAD
                    reference_context = "embedded_historical_v0_4_1_proof_verified_separately"
                    enforced_for_package_head = False
                elif Path(member).name == "complete-git-evidence.json" and pointer.startswith("/historical_v0_4_git_audit/"):
                    reference_head = V04_HEAD
                    reference_context = "embedded_historical_v0_4_proof_verified_with_erratum"
                    enforced_for_package_head = False
                target = checkout / PurePosixPath(relative)
                checkout_hash = sha256_bytes(target.read_bytes()) if reference_head == package_head and target.is_file() else None
                blob = subprocess.run(["git", "-C", str(checkout), "show", f"{reference_head}:{relative}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                blob_hash = sha256_bytes(blob.stdout) if blob.returncode == 0 else None
                claimed = claimed_value
                checkout_refs.append({
                    "member": member, "pointer": pointer, "path": relative, "claimed_sha256": claimed,
                    "reference_head": reference_head, "reference_context": reference_context,
                    "enforced_for_package_head": enforced_for_package_head,
                    "checkout_sha256": checkout_hash, "git_blob_bytes_sha256": blob_hash,
                    "passed": claimed in (checkout_hash, blob_hash),
                })
    mismatches = [item for item in checkout_refs if not item["passed"]]
    return {
        "git_objects": [{"sha": sha, **result} for sha, result in sorted(git_objects.items())],
        "contextual_historical_git_objects": contextual_historical_git_objects,
        "unreachable_git_objects": sorted(sha for sha, value in git_objects.items() if not value["reachable"]),
        "checkout_references": checkout_refs,
        "mismatched_checkout_references": mismatches,
        "enforced_mismatched_checkout_references": [item for item in mismatches if item.get("enforced_for_package_head") is not False],
        "contextual_historical_mismatched_references": [item for item in mismatches if item.get("enforced_for_package_head") is False],
        "source_reference_scan_excluded_files": sorted(source_scan_exclusions),
        "source_reference_scan_scope": sorted(
            member for member in documents if member not in source_scan_exclusions
        ),
        "source_reference_scan_exclusions": [
            {
                "path": member,
                "reason": "manifest_or_scanner_report" if member in source_scan_exclusions else "non_json_no_structured_git_reference",
            }
            for member in sorted(set(all_members) - (set(documents) - set(source_scan_exclusions)))
        ],
    }


def clone_checkout(repo: Path, head: str, parent: Path) -> tuple[Path, dict]:
    checkout = parent / "fresh-checkout"
    subprocess.run(["git", "clone", "--quiet", "--no-hardlinks", str(repo), str(checkout)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "-C", str(checkout), "checkout", "--quiet", "--detach", head], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    actual_head = run_git(checkout, "rev-parse", "HEAD")
    tree = run_git(checkout, "rev-parse", "HEAD^{tree}")
    parents_line = run_git(checkout, "show", "-s", "--format=%P", "HEAD")
    parents = parents_line.split() if isinstance(parents_line, str) and parents_line else []
    clean = run_git(checkout, "status", "--porcelain=v1", "--untracked-files=all") == ""
    return checkout, {"head": actual_head, "tree": tree, "parents": parents, "clean": clean}


def verify_package(package: Path, repo: Path, expected_zip: str, expected_manifest: str, expected_head: str, label: str) -> dict:
    package_bytes = package.read_bytes()
    actual_zip = sha256_bytes(package_bytes)
    if expected_zip and actual_zip != expected_zip:
        raise ValueError(f"{label}_zip_hash_mismatch")
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave22-independent-") as temporary:
        temp = Path(temporary)
        with zipfile.ZipFile(package, "r") as zf:
            manifest = verify_manifest(zf)
            if expected_manifest and manifest["manifest_sha256"] != expected_manifest:
                raise ValueError(f"{label}_manifest_hash_mismatch")
            extraction = temp / "clean-output"
            safe_extract(zf, extraction)
            documents = json_members(zf)
            scanner = package_scanner(zf)
            declared_head = find_package_head(documents, expected_head)
            if declared_head != expected_head:
                raise ValueError(f"{label}_declared_head_mismatch")
            checkout, git_identity = clone_checkout(repo, expected_head, temp)
            member_names = sorted(info.filename for info in zf.infolist() if not info.is_dir())
            refs = git_reference_report(documents, member_names, checkout, expected_head)
            extracted_files = sorted(str(item.relative_to(extraction)).replace("\\", "/") for item in extraction.rglob("*") if item.is_file())
            if len(extracted_files) != manifest["zip_member_count"]:
                raise ValueError("safe_extraction_member_count_mismatch")
            if not scanner["passed"]:
                raise ValueError(f"{label}_independent_scanner_failed")
            reported_scanner_reconciliation = None
            if "secret-pii-scan.json" in documents and isinstance(documents["secret-pii-scan.json"], dict):
                report = documents["secret-pii-scan.json"]
                reported_scanner_reconciliation = {
                    "reported_scanned_file_count": report.get("scanned_file_count"),
                    "expected_scanned_file_count": manifest["zip_member_count"] - 2,
                    "explicit_exclusions": [MANIFEST_NAME, "secret-pii-scan.json"],
                    "passed": report.get("scanned_file_count") == manifest["zip_member_count"] - 2,
                }
            package_count_reconciliation = {
                "zip_member_count": manifest["zip_member_count"],
                "zip_member_count_exclusions": ["outer ZIP itself (self-containment is impossible)"],
                "manifest_entry_count": manifest["manifest_entry_count"],
                "manifest_entry_count_exclusions": [MANIFEST_NAME],
                "independent_scanner_count": scanner["scope_count"],
                "independent_scanner_count_exclusions": scanner["excluded_files"],
                "source_reference_scan_count": len(refs["source_reference_scan_scope"]),
                "source_reference_scan_exclusions": refs["source_reference_scan_exclusions"],
                "manifest_reconciles": manifest["manifest_entry_count"] == manifest["zip_member_count"] - 1,
                "scanner_reconciles": scanner["scope_count"] == manifest["zip_member_count"] - len(scanner["excluded_files"]),
            }
    passed = (
        git_identity["head"] == expected_head and git_identity["clean"] and not refs["unreachable_git_objects"]
        and package_count_reconciliation["manifest_reconciles"] and package_count_reconciliation["scanner_reconciles"]
        and (reported_scanner_reconciliation is None or reported_scanner_reconciliation["passed"])
    )
    return {
        "schema_version": "tivdoc-wave22-independent-package-verification-v0.4.2",
        "label": label,
        "package_file": package.name,
        "package_byte_count": len(package_bytes),
        "package_sha256": actual_zip,
        "expected_package_sha256": expected_zip,
        "manifest": manifest,
        "git_identity": git_identity,
        "evidence_to_git": refs,
        "safe_extraction": {"passed": True, "fresh_temporary_checkout": True, "clean_output_directory": True},
        "scanner": scanner,
        "count_reconciliation": package_count_reconciliation,
        "reported_scanner_reconciliation": reported_scanner_reconciliation,
        "passed_without_checkout_reference_requirement": passed,
        "passed": passed and not refs["enforced_mismatched_checkout_references"],
    }


def pointer_value(document: object, pointer: str) -> object:
    current = document
    if pointer in ("", "/"):
        return current
    for raw in pointer.lstrip("/").split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]  # type: ignore[index]
    return current


def verify_erratum(erratum_path: Path, v04_package: Path, repo: Path) -> dict:
    erratum = json.loads(erratum_path.read_text("utf-8"))
    references = erratum.get("references")
    if erratum.get("append_only") is not True or not isinstance(references, list) or len(references) != 11:
        raise ValueError("v04_erratum_contract_invalid")
    original = erratum.get("original_package", {})
    if original.get("zip_sha256") != V04_ZIP_SHA256 or original.get("manifest_sha256") != V04_MANIFEST_SHA256:
        raise ValueError("v04_erratum_original_binding_invalid")
    with zipfile.ZipFile(v04_package, "r") as zf:
        cases = []
        for reference in references:
            case_id = reference.get("case_id")
            original = reference.get("original_reference", {})
            pointers = original.get("json_pointers", {}) if isinstance(original, dict) else {}
            member = original.get("evidence_member") if isinstance(original, dict) else None
            pointer = pointers.get("sha256") if isinstance(pointers, dict) else None
            claimed = original.get("claimed_sha256") if isinstance(original, dict) else None
            claimed_bytes = original.get("claimed_byte_count") if isinstance(original, dict) else None
            repository_path = original.get("repository_path") if isinstance(original, dict) else None
            if not isinstance(case_id, str) or not re.fullmatch(r"FORENSIC_REF_[0-9]{3}", case_id):
                raise ValueError("v04_erratum_case_id_invalid")
            if (not isinstance(member, str) or member not in zf.namelist() or not isinstance(pointer, str)
                    or not SHA256_RE.match(str(claimed)) or not isinstance(claimed_bytes, int)
                    or not isinstance(repository_path, str)):
                raise ValueError("v04_erratum_reference_invalid")
            document = json.loads(zf.read(member))
            pointer_bound = pointer_value(document, pointer) == claimed
            if isinstance(pointers.get("byte_count"), str):
                pointer_bound = pointer_bound and pointer_value(document, pointers["byte_count"]) == claimed_bytes
            if isinstance(pointers.get("path"), str):
                pointer_bound = pointer_bound and pointer_value(document, pointers["path"]) == repository_path
            root_classes = reference.get("root_cause_classes", [])
            allowed = {
                "historical_worktree_bytes_recovered", "pre_commit_generated_evidence_bug", "post_worker_orchestrator_mutation",
                "line_ending_or_filter_transform", "stale_inventory_reference", "unexplained_possible_integrity_failure",
            }
            classifications_valid = isinstance(root_classes, list) and bool(root_classes) and set(root_classes).issubset(allowed)
            canonical = reference.get("canonical_v0_4_bytes", {})
            canonical_bytes = subprocess.run(
                ["git", "-C", str(repo), "show", f"{V04_HEAD}:{repository_path}"],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            ).stdout
            canonical_blob = run_git(repo, "rev-parse", f"{V04_HEAD}:{repository_path}")
            canonical_bound = (
                isinstance(canonical, dict)
                and canonical.get("commit") == V04_HEAD
                and canonical.get("byte_count") == len(canonical_bytes)
                and canonical.get("sha256") == sha256_bytes(canonical_bytes)
                and canonical.get("blob_id") == canonical_blob
            )
            recovered = reference.get("recovered_bytes")
            recovery_bound = recovered is None
            if isinstance(recovered, dict):
                evidence_path = recovered.get("evidence_path")
                if not isinstance(evidence_path, str):
                    raise ValueError("v04_erratum_recovery_path_invalid")
                recovery_file = (erratum_path.parent / PurePosixPath(evidence_path)).resolve()
                if erratum_path.parent.resolve() not in recovery_file.parents:
                    raise ValueError("v04_erratum_recovery_path_escape")
                recovery_data = recovery_file.read_bytes()
                recovery_bound = (
                    recovered.get("sha256") == claimed == sha256_bytes(recovery_data)
                    and recovered.get("byte_count") == claimed_bytes == len(recovery_data)
                    and recovered.get("normalizes_to_v0_4_canonical_blob") is True
                    and recovered.get("git_clean_filter_blob_id") == canonical_blob
                )
            strict_resolved = reference.get("strict_resolved") is True
            cases.append({
                "case_id": case_id, "member": member, "json_pointer": pointer, "repository_path": repository_path,
                "claimed_sha256": claimed, "claimed_byte_count": claimed_bytes,
                "pointer_bound": pointer_bound, "canonical_git_bound": canonical_bound,
                "recovered_bytes_bound": recovery_bound, "classifications_valid": classifications_valid,
                "strict_resolved": strict_resolved,
                "resolution_status": reference.get("resolution_status"), "claim_authority": reference.get("claim_authority"),
                "passed": pointer_bound and canonical_bound and recovery_bound and classifications_valid,
            })
    structural_passed = all(item["passed"] for item in cases)
    strict_passed = structural_passed and all(item["strict_resolved"] for item in cases)
    return {
        "append_only": True, "reference_count": len(cases), "strict_resolved_count": sum(item["strict_resolved"] for item in cases),
        "cases": cases, "structural_passed": structural_passed, "strict_passed": strict_passed, "passed": strict_passed,
    }


def collect_case_ids(documents: dict[str, object]) -> dict:
    observed: dict[str, list[bool]] = {}
    for document in documents.values():
        for _, value in walk_json(document):
            if isinstance(value, dict) and isinstance(value.get("case_id"), str) and isinstance(value.get("passed"), bool):
                observed.setdefault(value["case_id"], []).append(value["passed"])
    matrices = {}
    for group, required in REQUIRED_MATRIX_IDS.items():
        missing = [case_id for case_id in required if case_id not in observed]
        failed = [case_id for case_id in required if case_id in observed and not any(observed[case_id])]
        matrices[group] = {
            "required_case_ids": required, "missing_case_ids": missing, "failed_case_ids": failed,
            "passed": not missing and not failed,
        }
    return matrices


def historical_matrix_report(package: Path) -> dict:
    required_members = {
        "security": "worker-evidence/W3/local-adversarial-verification.json",
        "rule_input": "worker-evidence/W1/rule-input-negative-matrix.json",
        "ground_truth": "worker-evidence/W1/ground-truth-negative-matrix.json",
    }
    with zipfile.ZipFile(package, "r") as zf:
        documents = {key: json.loads(zf.read(member)) for key, member in required_members.items()}
        member_hashes = {key: sha256_bytes(zf.read(member)) for key, member in required_members.items()}
    security = documents["security"]
    if not isinstance(security, dict) or not isinstance(security.get("matrices"), dict):
        raise ValueError("historical_security_matrix_invalid")
    raw_security = security["matrices"]
    observed_security = {
        "crash": raw_security.get("crash_points"),
        "corruption": raw_security.get("corrupt_records"),
        "multi_process": raw_security.get("real_multi_process"),
        "reader_race": ["concurrent_reader_race"] if raw_security.get("concurrent_reader_race") is True else [],
    }
    expected_security = {
        "crash": [
            "after_received", "after_private_copy", "after_validation", "after_artifact_publish",
            "after_event_publish", "after_ledger_append", "after_commit_marker",
        ],
        "corruption": ["journal", "event", "ledger", "commit_marker"],
        "multi_process": [
            "identical_concurrent_import", "different_bytes_one_identity",
            "identical_bytes_conflicting_identity", "stale_lock", "pid_reuse_poison", "restart_holding_lock",
        ],
        "reader_race": ["concurrent_reader_race"],
    }
    raw_cases: dict[str, list[dict]] = {}
    for group in ("crash", "corruption", "multi_process", "reader_race"):
        observed = observed_security[group]
        expected = expected_security[group]
        if not isinstance(observed, list) or len(observed) != len(expected):
            raise ValueError(f"historical_{group}_matrix_count_invalid")
        raw_cases[group] = [
            {
                "case_id": REQUIRED_MATRIX_IDS[group][index],
                "historical_observation": value,
                "expected_observation": expected[index],
                "passed": value == expected[index],
            }
            for index, value in enumerate(observed)
        ]

    rule_input = documents["rule_input"]
    if not isinstance(rule_input, dict) or not isinstance(rule_input.get("cases"), list):
        raise ValueError("historical_rule_input_matrix_invalid")
    raw_cases["rule_input"] = []
    for case_id in REQUIRED_MATRIX_IDS["rule_input"]:
        matches = [entry for entry in rule_input["cases"] if isinstance(entry, dict) and entry.get("id") == case_id]
        if len(matches) != 1:
            raise ValueError(f"historical_rule_input_case_invalid:{case_id}")
        entry = matches[0]
        raw_cases["rule_input"].append({
            "case_id": case_id,
            "expected_rejection": entry.get("expected_rejection"),
            "observed_rejections": entry.get("observed_rejections"),
            "partial_values_published": entry.get("partial_values_published"),
            "passed": entry.get("passed") is True and entry.get("partial_values_published") == 0,
        })

    ground_truth = documents["ground_truth"]
    if not isinstance(ground_truth, dict) or not isinstance(ground_truth.get("negative_cases"), list):
        raise ValueError("historical_ground_truth_matrix_invalid")
    raw_cases["ground_truth"] = []
    for case_id in REQUIRED_MATRIX_IDS["ground_truth"]:
        matches = [entry for entry in ground_truth["negative_cases"] if isinstance(entry, dict) and entry.get("id") == case_id]
        if len(matches) != 1:
            raise ValueError(f"historical_ground_truth_case_invalid:{case_id}")
        entry = matches[0]
        raw_cases["ground_truth"].append({
            "case_id": case_id,
            "expected_rejection": entry.get("expected_rejection"),
            "observed_error": entry.get("observed_error"),
            "passed": entry.get("passed") is True,
        })

    all_cases = [case for group in raw_cases.values() for case in group]
    counts = {group: len(cases) for group, cases in raw_cases.items()}
    expected_counts = {group: len(ids) for group, ids in REQUIRED_MATRIX_IDS.items()}
    return {
        "schema_version": "tivdoc-wave22-raw-case-matrices-v0.4.2",
        "source_package_file": package.name,
        "source_package_sha256": sha256_bytes(package.read_bytes()),
        "source_members": [
            {"role": role, "member": required_members[role], "sha256": member_hashes[role]}
            for role in sorted(required_members)
        ],
        "independent_mapping_not_generator_import": True,
        "matrices": raw_cases,
        "observed_counts": counts,
        "expected_counts": expected_counts,
        "total_case_count": len(all_cases),
        "passed": counts == expected_counts and all(case["passed"] for case in all_cases),
    }


def verify_final_package_required_evidence(package: Path, erratum_path: Path) -> dict:
    with zipfile.ZipFile(package, "r") as zf:
        names = sorted(info.filename for info in zf.infolist() if not info.is_dir())
        erratum_members = [name for name in names if Path(name).name == "v0.4-immutable-erratum.json"]
        forensic_members = [name for name in names if Path(name).name == "historical-byte-forensics.json"]
        erratum_hash_bound = len(erratum_members) == 1 and sha256_bytes(zf.read(erratum_members[0])) == sha256_bytes(erratum_path.read_bytes())
        external = json.loads(erratum_path.read_text("utf-8"))
        recovery_cases: list[dict] = []
        for reference in external.get("references", []):
            recovered = reference.get("recovered_bytes") if isinstance(reference, dict) else None
            if not isinstance(recovered, dict):
                continue
            relative = recovered.get("evidence_path")
            matches = [name for name in names if isinstance(relative, str) and name.replace("\\", "/").endswith(relative)]
            bound = (
                len(matches) == 1
                and sha256_bytes(zf.read(matches[0])) == recovered.get("sha256")
                and len(zf.read(matches[0])) == recovered.get("byte_count")
            )
            recovery_cases.append({"case_id": reference.get("case_id"), "evidence_path": relative, "matches": matches, "passed": bound})

        scanner_contracts: list[dict] = []
        for name, document in json_members(zf).items():
            for pointer, value in walk_json(document):
                if not isinstance(value, dict) or not all(key in value for key in ("scanner_name", "scanner_version", "rules_sha256", "scope", "raw_findings")):
                    continue
                scope = value.get("scope")
                expected_scope = sorted(set(names) - {MANIFEST_NAME, name})
                valid = (
                    isinstance(value.get("scanner_name"), str)
                    and isinstance(value.get("scanner_version"), str)
                    and SHA256_RE.match(str(value.get("rules_sha256"))) is not None
                    and isinstance(scope, list)
                    and sorted(scope) == expected_scope
                    and isinstance(value.get("raw_findings"), list)
                    and value.get("unresolved_findings_count") == 0
                    and value.get("passed") is True
                )
                scanner_contracts.append({
                    "member": name, "json_pointer": pointer, "scanner_name": value.get("scanner_name"),
                    "scanner_version": value.get("scanner_version"), "rules_sha256": value.get("rules_sha256"),
                    "scope_count": len(value.get("scope", [])) if isinstance(value.get("scope"), list) else None,
                    "expected_scope_count": len(expected_scope),
                    "exact_scope": isinstance(scope, list) and sorted(scope) == expected_scope,
                    "raw_finding_count": len(value.get("raw_findings", [])) if isinstance(value.get("raw_findings"), list) else None,
                    "passed": valid,
                })
    passed = (
        erratum_hash_bound and len(forensic_members) == 1
        and len(external.get("references", [])) == 11
        and all(case["passed"] for case in recovery_cases)
        and any(contract["passed"] for contract in scanner_contracts)
    )
    return {
        "erratum_members": erratum_members,
        "erratum_exact_external_bytes_bound": erratum_hash_bound,
        "historical_byte_forensics_members": forensic_members,
        "forensic_reference_count": len(external.get("references", [])),
        "recovered_byte_members": recovery_cases,
        "scanner_contracts": scanner_contracts,
        "passed": passed,
    }


def verify_final_package_matrix(package: Path) -> dict:
    with zipfile.ZipFile(package, "r") as zf:
        documents = json_members(zf)
        matrices = collect_case_ids(documents)
        decoded = b"\n".join(zf.read(info.filename) for info in zf.infolist() if not info.is_dir() and info.file_size < 16 * 1024 * 1024)
    labels = [
        "PARSER_APPLICATION_ISOLATION_VERIFIED", "PARSER_OS_SANDBOX_NOT_VERIFIED",
        "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
    ]
    missing_labels = [label for label in labels if label.encode() not in decoded]
    required_zeros = [
        "customer_files_read", "openai_calls", "external_supabase_connections", "migrations",
        "production_preview_deploy_actions", "persistent_owner_imports", "reviewed_sources", "active_sources",
        "real_numeric_candidates", "real_numeric_attestations", "active_parameters", "israeli_rules", "findings",
    ]
    zero_candidates: list[dict] = []
    for document in documents.values():
        for _, value in walk_json(document):
            if isinstance(value, dict) and all(name in value for name in required_zeros):
                zero_candidates.append({name: value[name] for name in required_zeros})
    valid_zero_candidates = [candidate for candidate in zero_candidates if all(value == 0 for value in candidate.values())]
    return {
        "raw_case_matrices": matrices,
        "assurance_labels": {"required": labels, "missing": missing_labels, "passed": not missing_labels},
        "zero_invariants": {
            "required": required_zeros, "candidate_count": len(zero_candidates),
            "valid_candidate_count": len(valid_zero_candidates), "passed": bool(valid_zero_candidates),
        },
        "passed": all(item["passed"] for item in matrices.values()) and not missing_labels and bool(valid_zero_candidates),
    }


def verify_chain(args: argparse.Namespace) -> dict:
    repo = Path(args.repo).resolve()
    v04 = verify_package(Path(args.v04), repo, V04_ZIP_SHA256, V04_MANIFEST_SHA256, V04_HEAD, "v0.4")
    erratum = verify_erratum(Path(args.v04_erratum), Path(args.v04), repo)
    v041 = verify_package(Path(args.v041), repo, V041_ZIP_SHA256, V041_MANIFEST_SHA256, V041_HEAD, "v0.4.1")
    v042 = verify_package(Path(args.v042), repo, args.expected_v042_sha256, args.expected_v042_manifest_sha256, args.expected_head, "v0.4.2")
    final_matrix = verify_final_package_matrix(Path(args.v042))
    final_required_evidence = verify_final_package_required_evidence(Path(args.v042), Path(args.v04_erratum))
    v04_effective = v04["passed_without_checkout_reference_requirement"] and erratum["passed"]
    overall = v04_effective and v041["passed"] and v042["passed"] and final_matrix["passed"] and final_required_evidence["passed"]
    return {
        "schema_version": "tivdoc-wave22-independent-chain-verification-v0.4.2",
        "mode": "final-package-post-integration",
        "v0.4_original_unchanged": v04["package_sha256"] == V04_ZIP_SHA256,
        "v0.4": v04,
        "v0.4_append_only_erratum": erratum,
        "v0.4_effective_pass": v04_effective,
        "v0.4.1": v041,
        "v0.4.2": v042,
        "final_operational_evidence": final_matrix,
        "final_required_evidence_members": final_required_evidence,
        "overall": overall,
        "status": "INDEPENDENT_FOUNDATION_CLOSURE_VERIFIED" if overall else "INDEPENDENT_FOUNDATION_CLOSURE_FAILED",
    }


def create_test_archive(path: Path, members: list[tuple[str, bytes, int | None]], manifest_override: dict | None = None) -> None:
    records = [{"path": name, "byte_count": len(data), "sha256": sha256_bytes(data)} for name, data, _ in members if name != MANIFEST_NAME]
    manifest = manifest_override or {"files": records, "manifest_self_excluded": True}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data, mode in members:
            info = zipfile.ZipInfo(name)
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            zf.writestr(info, data)
        if all(name != MANIFEST_NAME for name, _, _ in members):
            zf.writestr(MANIFEST_NAME, stable_json(manifest))


def adversarial_self_test() -> dict:
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave22-archive-selftest-") as temporary:
        root = Path(temporary)
        cases: list[dict] = []

        def run_case(case_id: str, builder, expected_error: str | None) -> None:
            target = root / f"{case_id}.zip"
            builder(target)
            try:
                with zipfile.ZipFile(target) as zf:
                    verify_manifest(zf)
                    safe_extract(zf, root / f"extract-{case_id}")
                observed = None
            except Exception as error:  # deliberate adversarial harness
                observed = str(error)
            passed = observed is None if expected_error is None else expected_error in (observed or "")
            cases.append({"case_id": case_id, "expected_error": expected_error, "observed_error": observed, "passed": passed})

        run_case("ARCHIVE_SAFE_001_VALID", lambda p: create_test_archive(p, [("evidence.json", b"{}\n", None)]), None)
        run_case("ARCHIVE_DENY_001_TRAVERSAL", lambda p: create_test_archive(p, [("../escape", b"x", None)]), "archive_member_path_escape")
        run_case("ARCHIVE_DENY_002_ABSOLUTE", lambda p: create_test_archive(p, [("C:/escape", b"x", None)]), "archive_member_absolute_or_device_path")
        run_case("ARCHIVE_DENY_003_BACKSLASH", lambda p: create_test_archive(p, [("a\\b", b"x", None)]), "archive_member_name_invalid")
        run_case("ARCHIVE_DENY_004_CASE_COLLISION", lambda p: create_test_archive(p, [("A.json", b"1", None), ("a.json", b"2", None)]), "archive_case_or_unicode_collision")
        run_case("ARCHIVE_DENY_005_SYMLINK", lambda p: create_test_archive(p, [("link", b"target", stat.S_IFLNK | 0o777)]), "archive_link_or_device_member")
        run_case("ARCHIVE_DENY_006_DEVICE", lambda p: create_test_archive(p, [("device", b"x", stat.S_IFCHR | 0o600)]), "archive_link_or_device_member")
        run_case("ARCHIVE_DENY_007_EXTRA_MEMBER", lambda p: create_test_archive(p, [("a", b"a", None), ("extra", b"x", None)], {"files": [{"path": "a", "byte_count": 1, "sha256": sha256_bytes(b"a")}] }), "package_manifest_membership_mismatch")
        run_case("ARCHIVE_DENY_008_CHANGED_BYTES", lambda p: create_test_archive(p, [("a", b"b", None)], {"files": [{"path": "a", "byte_count": 1, "sha256": sha256_bytes(b"a")}] }), "package_manifest_member_mismatch")
        run_case("ARCHIVE_DENY_009_WINDOWS_DEVICE_COMPONENT", lambda p: create_test_archive(p, [("safe/CON.txt", b"x", None)]), "archive_member_absolute_or_device_path")
        run_case("ARCHIVE_DENY_010_WINDOWS_ADS", lambda p: create_test_archive(p, [("safe/file.txt:stream", b"x", None)]), "archive_member_windows_unsafe_component")
        run_case("ARCHIVE_DENY_011_TRAILING_DOT", lambda p: create_test_archive(p, [("safe/file.", b"x", None)]), "archive_member_windows_unsafe_component")
    return {"schema_version": "tivdoc-wave22-adversarial-archive-matrix-v0.4.2", "cases": cases, "passed": all(item["passed"] for item in cases)}


def write_result(path: str | None, result: dict) -> None:
    output = stable_json(result)
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(output, "utf-8", newline="\n")
    print(output, end="")


def safe_error_code(error: Exception) -> str:
    message = str(error)
    if re.fullmatch(r"[a-z0-9_.:-]{1,160}", message):
        return message
    if isinstance(error, FileNotFoundError):
        return "verification_input_missing"
    if isinstance(error, zipfile.BadZipFile):
        return "archive_invalid"
    if isinstance(error, (subprocess.CalledProcessError, json.JSONDecodeError, UnicodeDecodeError)):
        return "verification_input_or_git_invalid"
    return "independent_verification_failed"


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    selftest = sub.add_parser("self-test")
    selftest.add_argument("--output")
    package = sub.add_parser("verify-package")
    package.add_argument("--package", required=True)
    package.add_argument("--repo", required=True)
    package.add_argument("--expected-zip-sha256", required=True)
    package.add_argument("--expected-manifest-sha256", required=True)
    package.add_argument("--expected-head", required=True)
    package.add_argument("--label", required=True)
    package.add_argument("--output")
    matrices = sub.add_parser("historical-matrices")
    matrices.add_argument("--v041", required=True)
    matrices.add_argument("--output")
    staging = sub.add_parser("scan-staging")
    staging.add_argument("--staging", required=True)
    staging.add_argument("--output", required=True)
    chain = sub.add_parser("final-package")
    chain.add_argument("--repo", required=True)
    chain.add_argument("--v04", required=True)
    chain.add_argument("--v04-erratum", required=True)
    chain.add_argument("--v041", required=True)
    chain.add_argument("--v042", required=True)
    chain.add_argument("--expected-v042-sha256", required=True)
    chain.add_argument("--expected-v042-manifest-sha256", required=True)
    chain.add_argument("--expected-head", required=True)
    chain.add_argument("--output")
    args = parser.parse_args()
    try:
        if args.command == "self-test":
            result = adversarial_self_test()
        elif args.command == "verify-package":
            result = verify_package(Path(args.package), Path(args.repo), args.expected_zip_sha256, args.expected_manifest_sha256, args.expected_head, args.label)
        elif args.command == "historical-matrices":
            result = historical_matrix_report(Path(args.v041))
        elif args.command == "scan-staging":
            result = staging_scanner(Path(args.staging), Path(args.output))
        else:
            result = verify_chain(args)
        write_result(args.output, result)
        return 0 if result.get("passed", result.get("overall", False)) else 7
    except Exception as error:
        result = {"schema_version": "tivdoc-wave22-independent-verifier-error-v0.4.2", "status": "INDEPENDENT_VERIFICATION_FAILED", "safe_error_code": safe_error_code(error), "passed": False}
        write_result(getattr(args, "output", None), result)
        return 7


if __name__ == "__main__":
    raise SystemExit(main())
