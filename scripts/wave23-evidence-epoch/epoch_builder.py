#!/usr/bin/env python3
"""Post-commit deterministic evidence_epoch_2 package and detached receipt builder."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import unicodedata
import zipfile

EPOCH_ID = "TIVDOC_EVIDENCE_EPOCH_2_V0.5.0"
EPOCH_SCHEMA = "tivdoc-evidence-epoch-v2"
MANIFEST = "package-manifest.json"
SCANNER = "independent-secret-pii-scan.json"
DEFAULT_PREFIXES = (
    "src/engine/wave23/",
    "src/engine/legal-knowledge/canonical-readiness/",
    "scripts/wave23-evidence-incident/",
    "scripts/wave23-corpus-trust/",
    "scripts/wave23-evidence-epoch/",
    "docs/wave23-evidence-incident-v0.5.0.md",
    "docs/wave23-corpus-trust-v0.5.0.md",
    "docs/wave23-evidence-epoch-v0.5.0.md",
)
REQUIRED_CLAIMS = {
    "cross-package-incident-registry.json",
    "evidence-root-disposition-registry.json",
    "lifecycle-reconciliation.json",
    "stable-transitions.json",
    "readiness-delegate-matrix.json",
    "readiness-mutation-matrix.json",
    "temporal-sector-population-matrix.json",
    "multi-instrument-matrix.json",
    "reporting-reconciliation.json",
    "zero-invariants.json",
    "command-ledger.json",
}
HISTORICAL = (
    {
        "package_id": "V0.4",
        "package_sha256": "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c",
        "manifest_sha256": "9fa62f6848c5bef1e4bfae1654b5e0673bf61589c6ca985d1578a44d95c7c5bf",
        "related_sha256": "98e709e5a22fe269f5e11f2934930c1220f6d00ce1c078c5ebb961e0927198a4",
        "disposition": ["quarantined_failed", "forensic_only"],
        "authority": "historical_incident_only",
    },
    {
        "package_id": "V0.4.1",
        "package_sha256": "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2",
        "manifest_sha256": "f4a4ea363abdaf15a2a3cdbba925937360a08d14d704bc3fe6060b2264fcf16b",
        "related_sha256": None,
        "disposition": ["quarantined_failed", "forensic_only"],
        "authority": "historical_incident_only",
    },
    {
        "package_id": "V0.4.2",
        "package_sha256": "c3c7135821097e68e00717b93300939cc84d565932a0dacd6cc239a684db6636",
        "manifest_sha256": "6b8082a2aa4149cba35ead01500114323658d58ac8e2899694a2873b0d50a9c1",
        "related_sha256": None,
        "disposition": ["forensic_only"],
        "authority": "component_evidence_not_historical_chain_root",
    },
)
RULES = (
    ("PRIVATE_KEY", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("OPENAI_STYLE_SECRET", re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}")),
    ("SUPABASE_ACCESS_TOKEN", re.compile(rb"\bsbp_[A-Za-z0-9_-]{20,}")),
    ("PERSONAL_HOME_PATH", re.compile(rb"\bC:\\Users\\[^\\\s]+", re.I)),
)


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, separators=(",", ": ")) + "\n").encode("utf-8")


def git(repo: Path, *args: str, binary: bool = False, input_bytes: bytes | None = None) -> bytes | str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], input=input_bytes, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return result.stdout if binary else result.stdout.decode("utf-8", "strict").strip()


def canonical_path(value: str) -> str:
    if not value or "\\" in value or "\x00" in value or value != unicodedata.normalize("NFC", value):
        raise ValueError("path_not_canonical")
    pure = PurePosixPath(value)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise ValueError("path_escape")
    if re.match(r"^[A-Za-z]:", value) or value.startswith("//"):
        raise ValueError("path_absolute_or_drive")
    for part in pure.parts:
        if ":" in part or part.endswith((" ", ".")) or any(ord(char) < 32 for char in part):
            raise ValueError("path_windows_unsafe")
        if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part.split(".", 1)[0]):
            raise ValueError("path_reserved_device")
    return value


def assert_unique_paths(paths: list[str]) -> None:
    exact: set[str] = set()
    folded: set[str] = set()
    for value in paths:
        canonical = canonical_path(value)
        case_key = canonical.casefold()
        if canonical in exact:
            raise ValueError("duplicate_path")
        if case_key in folded:
            raise ValueError("case_collision")
        exact.add(canonical)
        folded.add(case_key)


def tracked_clean(repo: Path) -> bool:
    return git(repo, "status", "--porcelain=v1", "--untracked-files=no") == ""


def authoritative_paths_clean(repo: Path, prefixes: list[str]) -> bool:
    return git(repo, "status", "--porcelain=v1", "--untracked-files=all", "--", *prefixes) == ""


def parse_ls_tree(raw: bytes) -> list[dict]:
    entries: list[dict] = []
    for record in raw.split(b"\0"):
        if not record:
            continue
        header, encoded_path = record.split(b"\t", 1)
        mode, object_type, oid = header.decode("ascii").split(" ")
        path_value = encoded_path.decode("utf-8", "strict")
        entries.append({"file_mode": mode, "object_type": object_type, "git_blob_oid_sha1": oid, "path": canonical_path(path_value)})
    return entries


def check_attributes(repo: Path, head: str, path_value: str) -> dict:
    raw = git(repo, "check-attr", f"--source={head}", "-z", "filter", "working-tree-encoding", "diff", "text", "eol", "--", path_value, binary=True)
    fields = raw.split(b"\0")
    attributes: dict[str, str] = {}
    for index in range(0, len(fields) - 2, 3):
        key = fields[index + 1].decode("utf-8", "strict")
        value = fields[index + 2].decode("utf-8", "strict")
        attributes[key] = value
    for dangerous in ("filter", "working-tree-encoding", "diff"):
        if attributes.get(dangerous, "unspecified") not in ("unspecified", "unset"):
            raise ValueError(f"authoritative_path_filter_anomaly:{path_value}:{dangerous}")
    # This is deliberately advisory only: checkout text/eol transforms are never read.
    return {"head": head, "filter": attributes.get("filter"), "working_tree_encoding": attributes.get("working-tree-encoding"), "diff": attributes.get("diff"), "text": attributes.get("text"), "eol": attributes.get("eol")}


def git_object_inventory(repo: Path, head: str, prefixes: list[str]) -> tuple[list[dict], dict[str, bytes]]:
    raw = git(repo, "ls-tree", "-rz", "--full-tree", head, "--", *prefixes, binary=True)
    entries = parse_ls_tree(raw)
    if not entries:
        raise ValueError("authoritative_git_inventory_empty")
    assert_unique_paths([entry["path"] for entry in entries])
    files: dict[str, bytes] = {}
    result: list[dict] = []
    for entry in sorted(entries, key=lambda item: item["path"]):
        if entry["object_type"] != "blob" or entry["file_mode"] not in ("100644", "100755"):
            raise ValueError(f"authoritative_git_entry_type_or_mode_denied:{entry['path']}")
        blob = git(repo, "cat-file", "blob", entry["git_blob_oid_sha1"], binary=True)
        oid = hashlib.sha1(b"blob " + str(len(blob)).encode("ascii") + b"\0" + blob).hexdigest()
        if oid != entry["git_blob_oid_sha1"]:
            raise ValueError(f"git_object_oid_mismatch:{entry['path']}")
        attributes = check_attributes(repo, head, entry["path"])
        package_path = f"git-object-bytes/{entry['path']}"
        files[package_path] = blob
        result.append({
            "path": entry["path"], "file_mode": entry["file_mode"],
            "git_blob_oid_sha1": entry["git_blob_oid_sha1"], "byte_length": len(blob),
            "content_sha256": sha256(blob), "package_path": package_path,
            "attribute_guard": attributes,
        })
    return result, files


def collect_claims(claim_roots: list[str]) -> tuple[list[dict], dict[str, bytes]]:
    records: list[dict] = []
    files: dict[str, bytes] = {}
    basenames: set[str] = set()
    for binding in claim_roots:
        if "=" not in binding:
            raise ValueError("claim_root_binding_invalid")
        role, raw_root = binding.split("=", 1)
        if not re.fullmatch(r"[a-z][a-z0-9_-]{1,39}", role):
            raise ValueError("claim_root_role_invalid")
        root = Path(raw_root).resolve()
        if not root.is_dir():
            raise ValueError(f"claim_root_missing:{role}")
        for candidate in sorted(root.rglob("*")):
            if candidate.is_symlink():
                raise ValueError("claim_symlink_denied")
            if not candidate.is_file():
                continue
            relative = canonical_path(str(candidate.relative_to(root)).replace("\\", "/"))
            if candidate.suffix.lower() in (".zip", ".pdf", ".png", ".jpg", ".jpeg"):
                raise ValueError("claim_binary_or_historical_package_denied")
            package_path = canonical_path(f"current-claims/{role}/{relative}")
            data = candidate.read_bytes()
            files[package_path] = data
            basenames.add(candidate.name)
            records.append({
                "role": role, "source_relative_path": relative, "package_path": package_path,
                "byte_length": len(data), "content_sha256": sha256(data),
                "authority_class": "derived_post_commit_evidence",
            })
    missing = sorted(REQUIRED_CLAIMS - basenames)
    if missing:
        raise ValueError(f"required_current_claims_missing:{','.join(missing)}")
    assert_unique_paths(list(files))
    return sorted(records, key=lambda item: item["package_path"]), files


def scanner_report(files: dict[str, bytes]) -> dict:
    scope = sorted(files)
    findings: list[dict] = []
    for path_value in scope:
        for rule_id, pattern in RULES:
            for match in pattern.finditer(files[path_value]):
                findings.append({"rule_id": rule_id, "path": path_value, "byte_offset": match.start()})
    rule_rows = [{"rule_id": rule_id, "pattern_sha256": sha256(pattern.pattern)} for rule_id, pattern in RULES]
    return {
        "schema_version": "tivdoc-evidence-epoch-secret-pii-scan-v0.5.0",
        "scanner_name": "tivdoc-evidence-epoch-independent-byte-scanner",
        "scanner_version": "2.0.0",
        "rules": rule_rows,
        "rules_sha256": sha256(stable_json(rule_rows)),
        "scope": scope,
        "scope_count": len(scope),
        "excluded_files": [SCANNER, MANIFEST],
        "raw_findings": findings,
        "findings_count": len(findings),
        "passed": not findings,
    }


def deterministic_zip(output: Path, files: dict[str, bytes]) -> None:
    assert_unique_paths(list(files))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    if temporary.exists():
        raise ValueError("stale_package_temporary_file")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
            for name in sorted(files):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.flag_bits = 0x800
                archive.writestr(info, files[name])
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def build(args: argparse.Namespace) -> dict:
    repo = Path(args.repo).resolve()
    output = Path(args.output).resolve()
    requested_head = args.head
    actual_head = git(repo, "rev-parse", "HEAD")
    if requested_head != actual_head or not re.fullmatch(r"[a-f0-9]{40}", requested_head):
        raise ValueError("stale_or_invalid_head")
    if not tracked_clean(repo):
        raise ValueError("dirty_tracked_worktree")
    tree = git(repo, "rev-parse", f"{requested_head}^{{tree}}")
    prefixes = args.include_prefix or list(DEFAULT_PREFIXES)
    if not authoritative_paths_clean(repo, prefixes):
        raise ValueError("uncommitted_authoritative_path_claim")
    inventory, git_files = git_object_inventory(repo, requested_head, prefixes)
    claims, claim_files = collect_claims(args.claim_root)
    source_hashes = {
        item["path"]: item["content_sha256"]
        for item in inventory if item["path"].startswith("scripts/wave23-evidence-epoch/")
    }
    required_tools = {
        "scripts/wave23-evidence-epoch/epoch_builder.py",
        "scripts/wave23-evidence-epoch/verify_epoch_python.py",
        "scripts/wave23-evidence-epoch/verify_epoch_ts.mts",
    }
    if not required_tools.issubset(source_hashes):
        raise ValueError("committed_tool_source_inventory_incomplete")
    allowlist_hash = sha256(stable_json(sorted(item["path"] for item in inventory)))
    claim_inventory = {
        "schema_version": "tivdoc-evidence-epoch-current-claim-inventory-v0.5.0",
        "claims": claims,
        "claim_count": len(claims),
        "authority_boundary": "generated claims are arithmetic-verified evidence; only git-object inventory entries are authoritative tracked bytes",
    }
    git_inventory = {
        "schema_version": "tivdoc-evidence-epoch-git-object-inventory-v0.5.0",
        "head": requested_head,
        "tree": tree,
        "include_prefixes": prefixes,
        "allowlist_sha256": allowlist_hash,
        "entries": inventory,
        "entry_count": len(inventory),
        "unreachable_count": 0,
    }
    epoch = {
        "schema_version": EPOCH_SCHEMA,
        "epoch_id": EPOCH_ID,
        "baseline_id": f"{EPOCH_ID}:{requested_head}",
        "parent_trust_root": None,
        "authoritative_bytes_source": "git_object_database",
        "historical_packages_are_incident_references_only": True,
        "historical_disposition_references": list(HISTORICAL),
        "final_head": requested_head,
        "final_tree": tree,
        "hash_namespaces": {
            "git_blob_oid_sha1": "git object identity only",
            "content_sha256": "exact content bytes only",
            "package_sha256": "detached package identity only",
            "decision_sha256": "canonical readiness decision only",
        },
        "generator_version": "v0.5.0",
        "generator_sources": {"scripts/wave23-evidence-epoch/epoch_builder.py": source_hashes["scripts/wave23-evidence-epoch/epoch_builder.py"]},
        "verifier_sources": {
            "python": source_hashes["scripts/wave23-evidence-epoch/verify_epoch_python.py"],
            "typescript": source_hashes["scripts/wave23-evidence-epoch/verify_epoch_ts.mts"],
        },
        "verifier_rules": {
            "schema_version": "tivdoc-evidence-epoch-independent-rules-v0.5.0",
            "python": source_hashes["scripts/wave23-evidence-epoch/verify_epoch_python.py"],
            "typescript": source_hashes["scripts/wave23-evidence-epoch/verify_epoch_ts.mts"],
        },
        "authoritative_tracked_file_count": len(inventory),
        "current_claim_count": len(claims),
        "allowlist_sha256": allowlist_hash,
    }
    files = {
        **git_files,
        **claim_files,
        "evidence-epoch-2.json": stable_json(epoch),
        "git-object-inventory.json": stable_json(git_inventory),
        "current-claim-inventory.json": stable_json(claim_inventory),
        "index.json": stable_json({
            "schema_version": "tivdoc-evidence-epoch-index-v0.5.0", "epoch_id": EPOCH_ID,
            "scope": "development_audit_only", "legal_runtime_coupled_to_package": False,
            "historical_roots_authoritative": False, "product_readiness_claimed": False,
        }),
    }
    scan = scanner_report(files)
    if not scan["passed"]:
        raise ValueError("package_secret_or_personal_path_scan_failed")
    files[SCANNER] = stable_json(scan)
    manifest_rows = [
        {"path": name, "byte_length": len(data), "content_sha256": sha256(data), "file_mode": "100644"}
        for name, data in sorted(files.items())
    ]
    manifest = {
        "schema_version": "tivdoc-evidence-epoch-package-manifest-v0.5.0",
        "epoch_id": EPOCH_ID,
        "manifest_self_excluded": True,
        "files": manifest_rows,
        "file_count": len(manifest_rows),
    }
    files[MANIFEST] = stable_json(manifest)
    deterministic_zip(output, files)
    if git(repo, "rev-parse", "HEAD") != requested_head or git(repo, "rev-parse", "HEAD^{tree}") != tree:
        raise ValueError("head_or_tree_changed_during_build")
    if not tracked_clean(repo):
        raise ValueError("tracked_worktree_changed_during_build")
    if not authoritative_paths_clean(repo, prefixes):
        raise ValueError("authoritative_paths_changed_during_build")
    package_bytes = output.read_bytes()
    return {
        "schema_version": "tivdoc-evidence-epoch-build-result-v0.5.0",
        "epoch_id": EPOCH_ID, "head": requested_head, "tree": tree,
        "package_file": output.name, "package_byte_length": len(package_bytes),
        "package_sha256": sha256(package_bytes), "manifest_sha256": sha256(files[MANIFEST]),
        "zip_member_count": len(files), "manifest_entry_count": len(manifest_rows),
        "git_object_count": len(inventory), "current_claim_count": len(claims),
        "scanner_scope_count": scan["scope_count"], "scanner_rules_sha256": scan["rules_sha256"],
        "allowlist_sha256": allowlist_hash, "passed": True,
    }


def read_zip_json(package: Path, name: str) -> tuple[dict, bytes]:
    with zipfile.ZipFile(package, "r") as archive:
        raw = archive.read(name)
    return json.loads(raw), raw


def receipt(args: argparse.Namespace) -> dict:
    package = Path(args.package).resolve()
    python_report_path = Path(args.python_report).resolve()
    ts_report_path = Path(args.typescript_report).resolve()
    epoch, _ = read_zip_json(package, "evidence-epoch-2.json")
    manifest, manifest_raw = read_zip_json(package, MANIFEST)
    scanner, _ = read_zip_json(package, SCANNER)
    claim_inventory, _ = read_zip_json(package, "current-claim-inventory.json")
    python_report = json.loads(python_report_path.read_text("utf-8"))
    ts_report = json.loads(ts_report_path.read_text("utf-8"))
    package_bytes = package.read_bytes()
    package_sha = sha256(package_bytes)
    for report, implementation in ((python_report, "python"), (ts_report, "typescript")):
        if (report.get("implementation") != implementation or report.get("passed") is not True
                or report.get("package_sha256") != package_sha
                or report.get("implementation_source_sha256") != epoch["verifier_sources"][implementation]
                or report.get("rules_sha256") != epoch["verifier_rules"][implementation]):
            raise ValueError(f"receipt_verifier_result_invalid:{implementation}")
    claim_by_basename = {Path(item["package_path"]).name: item for item in claim_inventory["claims"]}
    if "command-ledger.json" not in claim_by_basename or "zero-invariants.json" not in claim_by_basename:
        raise ValueError("receipt_required_claim_binding_missing")
    payload = {
        "schema_version": "tivdoc-evidence-epoch-detached-receipt-v0.5.0",
        "epoch_id": epoch["epoch_id"], "baseline_id": epoch["baseline_id"],
        "package": {"package_sha256": package_sha, "byte_length": len(package_bytes), "filename": package.name},
        "manifest_sha256": sha256(manifest_raw),
        "final_head": epoch["final_head"], "final_tree": epoch["final_tree"],
        "verifier_sources": epoch["verifier_sources"],
        "verifier_rules": epoch["verifier_rules"],
        "verifier_results": {
            "python": {"report_sha256": sha256(python_report_path.read_bytes()), "passed": True},
            "typescript": {"report_sha256": sha256(ts_report_path.read_bytes()), "passed": True},
        },
        "scanner": {"rules_sha256": scanner["rules_sha256"], "scope_count": scanner["scope_count"], "findings_count": scanner["findings_count"]},
        "command_ledger_sha256": claim_by_basename["command-ledger.json"]["content_sha256"],
        "zero_invariant_report_sha256": claim_by_basename["zero-invariants.json"]["content_sha256"],
        "zip_member_count": manifest["file_count"] + 1,
        "parent_trust_root": None,
    }
    payload_hash = sha256(stable_json(payload))
    document = {**payload, "receipt_payload_sha256": payload_hash}
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(stable_json(document))
    return {
        "schema_version": "tivdoc-evidence-epoch-receipt-build-result-v0.5.0",
        "receipt_file": target.name, "receipt_byte_length": target.stat().st_size,
        "receipt_sha256": sha256(target.read_bytes()), "receipt_payload_sha256": payload_hash,
        "package_sha256": package_sha, "passed": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest="command", required=True)
    build_parser = subs.add_parser("build")
    build_parser.add_argument("--repo", required=True)
    build_parser.add_argument("--head", required=True)
    build_parser.add_argument("--output", required=True)
    build_parser.add_argument("--claim-root", action="append", default=[], required=True)
    build_parser.add_argument("--include-prefix", action="append", default=[])
    build_parser.add_argument("--result")
    receipt_parser = subs.add_parser("receipt")
    receipt_parser.add_argument("--package", required=True)
    receipt_parser.add_argument("--python-report", required=True)
    receipt_parser.add_argument("--typescript-report", required=True)
    receipt_parser.add_argument("--output", required=True)
    receipt_parser.add_argument("--result")
    args = parser.parse_args()
    try:
        result = build(args) if args.command == "build" else receipt(args)
        code = 0
    except Exception as error:
        message = str(error)
        safe = message if re.fullmatch(r"[a-z0-9_.:,/-]{1,300}", message) else "evidence_epoch_builder_failed"
        result = {"schema_version": "tivdoc-evidence-epoch-builder-error-v0.5.0", "safe_error_code": safe, "passed": False}
        code = 7
    rendered = stable_json(result)
    if args.result:
        target = Path(args.result)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(rendered)
    print(rendered.decode("utf-8"), end="")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
