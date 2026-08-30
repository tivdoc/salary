#!/usr/bin/env python3
"""Independent Python verifier for evidence_epoch_2; imports no generator code."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import unicodedata
import zipfile

EPOCH_ID = "TIVDOC_EVIDENCE_EPOCH_2_V0.5.0"
MANIFEST = "package-manifest.json"
SCANNER = "independent-secret-pii-scan.json"
ZERO_KEYS = {
    "customer_files_read", "openai_calls", "external_supabase_connections", "migrations",
    "production_preview_deploy_actions", "persistent_owner_imports", "reviewed_sources", "active_sources",
    "real_numeric_candidates", "real_numeric_attestations", "active_parameters", "israeli_rules", "findings", "shadow_runs",
}
DELEGATES = {
    "diagnostic_cli", "strict_cli", "corpus_topic_gate", "server_resolver_admission",
    "future_activation_adapter", "future_shadow_admission_adapter",
}
HISTORICAL_HASHES = {
    "V0.4": "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c",
    "V0.4.1": "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2",
    "V0.4.2": "c3c7135821097e68e00717b93300939cc84d565932a0dacd6cc239a684db6636",
}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, separators=(",", ": ")) + "\n").encode("utf-8")


def git(repo: Path, *args: str, binary: bool = False) -> bytes | str:
    result = subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout if binary else result.stdout.decode("utf-8", "strict").strip()


def safe_name(value: str) -> str:
    if not value or "\\" in value or "\x00" in value or value != unicodedata.normalize("NFC", value):
        raise ValueError("archive_path_not_canonical")
    pure = PurePosixPath(value)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise ValueError("archive_path_traversal")
    if re.match(r"^[A-Za-z]:", value) or value.startswith("//"):
        raise ValueError("archive_absolute_or_drive_path")
    for part in pure.parts:
        if ":" in part or part.endswith((" ", ".")) or any(ord(char) < 32 for char in part):
            raise ValueError("archive_windows_unsafe_path")
        if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part.split(".", 1)[0]):
            raise ValueError("archive_reserved_device_path")
    return value


def archive_files(package: Path) -> tuple[dict[str, bytes], list[dict]]:
    files: dict[str, bytes] = {}
    entries: list[dict] = []
    folded: set[str] = set()
    with zipfile.ZipFile(package, "r") as archive:
        if len(archive.infolist()) > 10000:
            raise ValueError("archive_member_limit")
        total = 0
        previous_name = ""
        for info in archive.infolist():
            name = safe_name(info.filename)
            if name <= previous_name:
                raise ValueError("archive_nondeterministic_order")
            previous_name = name
            key = name.casefold()
            if name in files:
                raise ValueError("archive_duplicate_member")
            if key in folded:
                raise ValueError("archive_case_collision")
            folded.add(key)
            mode = (info.external_attr >> 16) & 0xFFFF
            if info.is_dir() or stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                raise ValueError("archive_non_regular_member")
            if info.flag_bits & 1 or info.compress_type != zipfile.ZIP_STORED:
                raise ValueError("archive_encryption_or_compression_policy")
            if (info.create_system != 3 or info.extra or info.comment
                    or info.date_time != (1980, 1, 1, 0, 0, 0) or stat.S_IMODE(mode) != 0o644):
                raise ValueError("archive_nondeterministic_metadata")
            total += info.file_size
            if info.file_size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024:
                raise ValueError("archive_size_limit")
            data = archive.read(info)
            files[name] = data
            entries.append({"path": name, "byte_length": len(data), "content_sha256": sha256(data), "file_mode": "100644"})
    return files, entries


def json_file(files: dict[str, bytes], name: str) -> dict:
    if name not in files:
        raise ValueError(f"required_member_missing:{name}")
    value = json.loads(files[name])
    if not isinstance(value, dict):
        raise ValueError(f"json_object_required:{name}")
    return value


def claim_json_by_basename(files: dict[str, bytes], basename: str) -> dict:
    matches = [name for name in files if name.startswith("current-claims/") and PurePosixPath(name).name == basename]
    if len(matches) != 1:
        raise ValueError(f"claim_member_count_invalid:{basename}")
    return json_file(files, matches[0])


def values(value: object):
    yield value
    if isinstance(value, dict):
        for item in value.values():
            yield from values(item)
    elif isinstance(value, list):
        for item in value:
            yield from values(item)


def stable_ids(records: list, prefix: str) -> list[str]:
    pattern = re.compile(rf"^{re.escape(prefix)}[0-9]{{3}}(?:_[A-Z0-9_]+)?$")
    found: list[str] = []
    for record in records:
        candidates = [item for item in values(record) if isinstance(item, str) and pattern.fullmatch(item)]
        if len(set(candidates)) != 1:
            raise ValueError(f"stable_case_id_missing_or_ambiguous:{prefix}")
        found.append(candidates[0])
    if len(set(found)) != len(found):
        raise ValueError(f"stable_case_id_duplicate:{prefix}")
    return found


def validate_cases(cases: object, label: str) -> int:
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"case_matrix_empty:{label}")
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError(f"case_not_object:{label}")
        passed = case.get("passed") is True or case.get("reconciled") is True
        expected_actual = "expected" in case and "actual" in case and case["expected"] == case["actual"]
        if not passed and not expected_actual:
            raise ValueError(f"case_failed:{label}")
    return len(cases)


def validate_claims(files: dict[str, bytes]) -> dict:
    incident = claim_json_by_basename(files, "cross-package-incident-registry.json")
    references = incident.get("references")
    unique_incidents = incident.get("unique_incidents")
    summary = incident.get("summary")
    if not isinstance(references, list) or len(references) != 15 or not isinstance(unique_incidents, list) or not isinstance(summary, dict):
        raise ValueError("incident_registry_counts_invalid")
    reference_ids = [row.get("reference_id") for row in references if isinstance(row, dict)]
    incident_ids = {row.get("incident_id") for row in unique_incidents if isinstance(row, dict)}
    if len(set(reference_ids)) != 15 or any(not isinstance(value, str) for value in reference_ids):
        raise ValueError("incident_reference_ids_invalid")
    if any(not isinstance(row, dict) or row.get("incident_id") not in incident_ids for row in references):
        raise ValueError("incident_crosswalk_incomplete")
    if summary.get("reference_count") != 15 or summary.get("unique_path_hash_incident_count") != len(unique_incidents):
        raise ValueError("incident_summary_count_collapse")
    if incident.get("historical_roots_repaired") is not False:
        raise ValueError("historical_roots_repaired_claim_denied")

    disposition = claim_json_by_basename(files, "evidence-root-disposition-registry.json")
    if disposition.get("append_only") is not True or disposition.get("hash_bound") is not True or disposition.get("historical_roots_can_satisfy_current_admission") is not False:
        raise ValueError("disposition_registry_policy_invalid")
    records = disposition.get("records")
    if not isinstance(records, list):
        raise ValueError("disposition_records_invalid")
    def disposition_package_id(row: dict) -> object:
        identity = row.get("package_identity")
        return identity.get("package_id") if isinstance(identity, dict) else row.get("root_id")

    for root_id in ("V0.4", "V0.4.1"):
        states = {row.get("state") for row in records if isinstance(row, dict) and disposition_package_id(row) == root_id}
        if not {"quarantined_failed", "forensic_only"}.issubset(states) or "trusted_current" in states:
            raise ValueError(f"historical_disposition_invalid:{root_id}")
    for row in records:
        if not isinstance(row, dict):
            raise ValueError("disposition_record_not_object")
        if disposition_package_id(row) in ("V0.4", "V0.4.1", "V0.4.2"):
            for key, value in row.items():
                if ("admission" in key or "authoritative" in key) and isinstance(value, bool) and value:
                    raise ValueError("historical_root_admission_true")

    lifecycle = claim_json_by_basename(files, "lifecycle-reconciliation.json")
    sources = lifecycle.get("sources")
    totals = lifecycle.get("totals")
    if not isinstance(sources, list) or len(sources) != 17 or not isinstance(totals, dict):
        raise ValueError("lifecycle_source_or_totals_invalid")
    stable_ids(sources, "SOURCE_LIFECYCLE_")
    for key in ("reviewed_sources", "active_sources", "operative_sources"):
        if key in totals and totals[key] != 0:
            raise ValueError(f"real_lifecycle_zero_violated:{key}")
    corrected_counts = {
        "source_count": 17, "technical_parsed_sources": 16, "technical_failed_sources": 1,
        "parsed_but_instrument_quarantined_sources": 2, "extracted_chunks": 274,
        "instrument_resolved_chunks": 202, "quarantined_chunk_cardinality": 72,
        "retrievable_review_chunks": 202, "canonical_binding_candidate_chunks": 86,
        "explanatory_or_corroborative_chunks": 116, "needs_review_sources": 17,
        "reviewed_sources": 0, "inactive_sources": 17, "active_sources": 0, "operative_sources": 0,
    }
    if any(key in totals and totals[key] != value for key, value in corrected_counts.items()):
        raise ValueError("corrected_lifecycle_count_invalid")
    if all(key in totals for key in corrected_counts) and not (
            totals["technical_parsed_sources"] + totals["technical_failed_sources"] == totals["source_count"]
            and totals["extracted_chunks"] - totals["quarantined_chunk_cardinality"] == totals["retrievable_review_chunks"]
            and totals["canonical_binding_candidate_chunks"] + totals["explanatory_or_corroborative_chunks"] == totals["retrievable_review_chunks"]):
        raise ValueError("corrected_lifecycle_arithmetic_invalid")
    invariants = lifecycle.get("invariants", {})
    if not isinstance(invariants, dict) or any(value is not True for value in invariants.values() if isinstance(value, bool)):
        raise ValueError("lifecycle_invariant_failed")

    transitions = claim_json_by_basename(files, "stable-transitions.json")
    transition_records = transitions.get("records")
    if not isinstance(transition_records, list) or len(transition_records) != 72:
        raise ValueError("transition_count_invalid")
    stable_ids(transition_records, "CHUNK_TRANSITION_")
    transition_totals = transitions.get("totals", {})
    if isinstance(transition_totals, dict):
        raw = transition_totals.get("raw_chunks", transition_totals.get("before"))
        retrievable = transition_totals.get("retrievable_chunks", transition_totals.get("after"))
        removed = transition_totals.get("transition_count", transition_totals.get("removed"))
        if all(isinstance(item, int) for item in (raw, retrievable, removed)) and raw - retrievable != removed:
            raise ValueError("transition_arithmetic_invalid")
        if ("record_count" in transition_totals and transition_totals["record_count"] != 72
                or "cardinality_delta" in transition_totals and transition_totals["cardinality_delta"] != -72):
            raise ValueError("transition_corrected_totals_invalid")

    readiness = claim_json_by_basename(files, "readiness-delegate-matrix.json")
    delegates = readiness.get("delegates")
    if not isinstance(delegates, list):
        raise ValueError("readiness_delegates_invalid")
    delegate_names = {
        item if isinstance(item, str) else item.get("delegate") or item.get("delegate_id")
        for item in delegates if isinstance(item, (str, dict))
    }
    if delegate_names != DELEGATES:
        raise ValueError("readiness_delegate_set_diverged")
    synthetic = readiness.get("synthetic_ready")
    if isinstance(synthetic, list):
        validate_cases(synthetic, "synthetic_ready")
        decision_hashes = {item.get("decision_hash") or item.get("decision_sha256") for item in synthetic if isinstance(item, dict)}
        if len(decision_hashes) != 1 or None in decision_hashes:
            raise ValueError("synthetic_ready_decision_hash_diverged")
    elif (not isinstance(synthetic, dict) or synthetic.get("status") != "READY"
            or synthetic.get("all_six_identical") is not True
            or not re.fullmatch(r"[a-f0-9]{64}", str(synthetic.get("decision_sha256")))):
        raise ValueError("synthetic_ready_missing_or_failed")
    static_guard = readiness.get("static_guard")
    if not isinstance(static_guard, dict) or static_guard.get("passed") is not True:
        raise ValueError("readiness_static_guard_missing_or_failed")
    production_flags = [
        static_guard.get("production_manifest_reachable"), static_guard.get("production_reachable"),
        static_guard.get("test_fixture_production_reachable"),
    ]
    if False not in production_flags:
        raise ValueError("test_only_ready_fixture_production_reachability_not_denied")
    real_blocked = readiness.get("real_blocked")
    validate_cases(real_blocked, "real_blocked")
    for case in real_blocked:
        serialized = json.dumps(case, sort_keys=True)
        if "READY" in serialized and "BLOCKED_NOT_READY" not in serialized:
            raise ValueError("real_readiness_case_not_blocked")

    mutations = claim_json_by_basename(files, "readiness-mutation-matrix.json")
    mutation_count = validate_cases(mutations.get("cases"), "readiness_mutations")
    temporal = claim_json_by_basename(files, "temporal-sector-population-matrix.json")
    temporal_cases = temporal.get("cases")
    temporal_count = validate_cases(temporal_cases, "temporal_sector_population")
    stable_ids(temporal_cases, "TEMPORAL_CASE_")
    multi = claim_json_by_basename(files, "multi-instrument-matrix.json")
    multi_count = validate_cases(multi.get("cases"), "multi_instrument")
    reporting = claim_json_by_basename(files, "reporting-reconciliation.json")
    reporting_rows = reporting.get("reconciliations")
    reporting_count = validate_cases(reporting_rows, "reporting_reconciliation")
    stable_ids(reporting_rows, "REPORT_RECONCILIATION_")

    command_ledger = claim_json_by_basename(files, "command-ledger.json")
    commands = command_ledger.get("commands")
    if not isinstance(commands, list) or not commands:
        raise ValueError("command_ledger_empty")
    command_ids = []
    for index, row in enumerate(commands, start=1):
        if not isinstance(row, dict) or not isinstance(row.get("command_id"), str):
            raise ValueError("command_ledger_row_invalid")
        command_ids.append(row["command_id"])
        if (row["command_id"] != f"COMMAND_{index:03d}" or not isinstance(row.get("purpose"), str) or not row["purpose"]
                or not isinstance(row.get("command") or row.get("command_reference"), str)
                or not isinstance(row.get("subject_status"), str) or not isinstance(row.get("subject_reason"), str)):
            raise ValueError("command_ledger_required_fields_invalid")
        expected_exit, actual_exit = row.get("expected_exit"), row.get("actual_exit")
        if not isinstance(expected_exit, int) or not isinstance(actual_exit, int):
            raise ValueError("command_ledger_exit_invalid")
        if row.get("expectation_matched") is not (expected_exit == actual_exit) or not isinstance(row.get("subject_passed"), bool):
            raise ValueError("command_ledger_result_invalid")
        artifact_path = row.get("output_artifact_path")
        artifact_sha = row.get("output_artifact_sha256")
        if ((artifact_path is None) != (artifact_sha is None)
                or artifact_path is not None and (not isinstance(artifact_path, str) or not re.fullmatch(r"[a-f0-9]{64}", str(artifact_sha)))):
            raise ValueError("command_ledger_output_binding_invalid")
    if len(set(command_ids)) != len(command_ids):
        raise ValueError("command_ledger_duplicate_id")

    zeros = claim_json_by_basename(files, "zero-invariants.json")
    counters = zeros.get("counters")
    if not isinstance(counters, dict) or set(counters) != ZERO_KEYS or any(value != 0 for value in counters.values()) or zeros.get("all_zero") is not True:
        raise ValueError("zero_invariants_invalid")
    return {
        "incident_reference_count": 15, "unique_incident_count": len(unique_incidents),
        "lifecycle_source_count": 17, "transition_count": 72,
        "delegate_count": len(delegates), "real_blocked_count": len(real_blocked),
        "readiness_mutation_count": mutation_count, "temporal_case_count": temporal_count,
        "multi_instrument_count": multi_count, "reporting_reconciliation_count": reporting_count,
        "command_count": len(commands),
        "zero_invariant_count": len(counters), "passed": True,
    }


def verify_package(package: Path, repo: Path) -> dict:
    package_bytes = package.read_bytes()
    files, raw_entries = archive_files(package)
    manifest = json_file(files, MANIFEST)
    if (manifest.get("schema_version") != "tivdoc-evidence-epoch-package-manifest-v0.5.0"
            or manifest.get("epoch_id") != EPOCH_ID or manifest.get("manifest_self_excluded") is not True):
        raise ValueError("manifest_identity_invalid")
    declared = manifest.get("files")
    if not isinstance(declared, list):
        raise ValueError("manifest_files_invalid")
    if manifest.get("file_count") != len(declared):
        raise ValueError("manifest_count_invalid")
    expected_names = sorted(name for name in files if name != MANIFEST)
    declared_names = [row.get("path") for row in declared if isinstance(row, dict)]
    if sorted(declared_names) != expected_names or len(set(declared_names)) != len(declared_names):
        raise ValueError("manifest_membership_invalid")
    for row in declared:
        data = files[row["path"]]
        if row.get("byte_length") != len(data) or row.get("content_sha256") != sha256(data) or row.get("file_mode") != "100644":
            raise ValueError("manifest_member_binding_invalid")

    epoch = json_file(files, "evidence-epoch-2.json")
    if (epoch.get("schema_version") != "tivdoc-evidence-epoch-v2" or epoch.get("epoch_id") != EPOCH_ID
            or epoch.get("parent_trust_root") is not None or epoch.get("authoritative_bytes_source") != "git_object_database"
            or epoch.get("historical_packages_are_incident_references_only") is not True):
        raise ValueError("epoch_no_parent_trust_invalid")
    historical = epoch.get("historical_disposition_references")
    if not isinstance(historical, list) or {row.get("package_id") for row in historical if isinstance(row, dict)} != set(HISTORICAL_HASHES):
        raise ValueError("epoch_historical_dispositions_incomplete")
    for row in historical:
        if row.get("package_sha256") != HISTORICAL_HASHES[row["package_id"]] or row.get("authority") in ("trusted", "trusted_current"):
            raise ValueError("epoch_historical_fallback_or_identity_invalid")
        if row["package_id"] in ("V0.4", "V0.4.1") and not {"quarantined_failed", "forensic_only"}.issubset(set(row.get("disposition", []))):
            raise ValueError("epoch_historical_quarantine_missing")

    head = epoch.get("final_head")
    tree = epoch.get("final_tree")
    if git(repo, "rev-parse", head) != head or git(repo, "rev-parse", f"{head}^{{tree}}") != tree:
        raise ValueError("epoch_head_or_tree_unreachable")
    inventory = json_file(files, "git-object-inventory.json")
    entries = inventory.get("entries")
    if not isinstance(entries, list) or inventory.get("entry_count") != len(entries) or inventory.get("unreachable_count") != 0:
        raise ValueError("git_inventory_counts_invalid")
    paths = [row.get("path") for row in entries if isinstance(row, dict)]
    if len(paths) != len(entries) or len(set(paths)) != len(paths) or len({path.casefold() for path in paths}) != len(paths):
        raise ValueError("git_inventory_path_identity_invalid")
    for row in entries:
        path_value = safe_name(row["path"])
        package_path = row.get("package_path")
        if package_path != f"git-object-bytes/{path_value}" or package_path not in files:
            raise ValueError("git_inventory_package_path_swapped")
        data = files[package_path]
        oid = row.get("git_blob_oid_sha1")
        calculated_oid = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        if oid != calculated_oid or row.get("content_sha256") != sha256(data) or row.get("byte_length") != len(data):
            raise ValueError("git_inventory_byte_binding_invalid")
        if git(repo, "cat-file", "-e", f"{head}:{path_value}") != "" or git(repo, "rev-parse", f"{head}:{path_value}") != oid:
            raise ValueError("git_inventory_object_unreachable")
        mode_line = git(repo, "ls-tree", head, "--", path_value)
        if not isinstance(mode_line, str) or mode_line.split(" ", 1)[0] != row.get("file_mode"):
            raise ValueError("git_inventory_mode_mismatch")
        if git(repo, "cat-file", "blob", oid, binary=True) != data:
            raise ValueError("git_inventory_git_bytes_mismatch")
    tool_sources = {row["path"]: row["content_sha256"] for row in entries}
    if (epoch.get("generator_version") != "v0.5.0"
            or epoch.get("generator_sources") != {"scripts/wave23-evidence-epoch/epoch_builder.py": tool_sources.get("scripts/wave23-evidence-epoch/epoch_builder.py")}):
        raise ValueError("generator_source_or_version_binding_invalid")
    for implementation, path_value in (
        ("python", "scripts/wave23-evidence-epoch/verify_epoch_python.py"),
        ("typescript", "scripts/wave23-evidence-epoch/verify_epoch_ts.mts"),
    ):
        if epoch.get("verifier_sources", {}).get(implementation) != tool_sources.get(path_value):
            raise ValueError("verifier_source_hash_binding_invalid")
        if epoch.get("verifier_rules", {}).get(implementation) != tool_sources.get(path_value):
            raise ValueError("verifier_rules_hash_binding_invalid")
    if epoch.get("verifier_rules", {}).get("schema_version") != "tivdoc-evidence-epoch-independent-rules-v0.5.0":
        raise ValueError("verifier_rules_schema_invalid")

    claim_inventory = json_file(files, "current-claim-inventory.json")
    claim_rows = claim_inventory.get("claims")
    if not isinstance(claim_rows, list) or claim_inventory.get("claim_count") != len(claim_rows):
        raise ValueError("claim_inventory_counts_invalid")
    for row in claim_rows:
        data = files.get(row.get("package_path"))
        if data is None or row.get("content_sha256") != sha256(data) or row.get("byte_length") != len(data) or row.get("authority_class") != "derived_post_commit_evidence":
            raise ValueError("claim_inventory_binding_invalid")
    claim_results = validate_claims(files)

    scanner = json_file(files, SCANNER)
    expected_scope = sorted(name for name in files if name not in (SCANNER, MANIFEST))
    if (scanner.get("scope") != expected_scope or scanner.get("scope_count") != len(expected_scope)
            or scanner.get("findings_count") != len(scanner.get("raw_findings", [])) or scanner.get("findings_count") != 0
            or scanner.get("passed") is not True or not re.fullmatch(r"[a-f0-9]{64}", str(scanner.get("rules_sha256")))):
        raise ValueError("scanner_scope_or_findings_invalid")
    return {
        "schema_version": "tivdoc-evidence-epoch-python-verification-v0.5.0",
        "implementation": "python", "implementation_runtime": "python_standard_library",
        "implementation_source_sha256": epoch["verifier_sources"]["python"],
        "rules_sha256": epoch["verifier_rules"]["python"],
        "package_sha256": sha256(package_bytes), "package_byte_length": len(package_bytes),
        "manifest_sha256": sha256(files[MANIFEST]), "zip_member_count": len(files),
        "manifest_entry_count": len(declared), "head": head, "tree": tree,
        "git_object_count": len(entries), "unreachable_current_references": 0,
        "claim_validation": claim_results, "scanner_scope_count": len(expected_scope),
        "scanner_rules_sha256": scanner["rules_sha256"], "passed": True,
    }


def verify_receipt(receipt_path: Path, package: Path, python_report: Path, ts_report: Path) -> dict:
    receipt = json.loads(receipt_path.read_text("utf-8"))
    payload_hash = receipt.pop("receipt_payload_sha256", None)
    if payload_hash != sha256(stable_json(receipt)):
        raise ValueError("receipt_payload_hash_invalid")
    package_sha = sha256(package.read_bytes())
    if receipt.get("package", {}).get("package_sha256") != package_sha or receipt.get("package", {}).get("byte_length") != package.stat().st_size:
        raise ValueError("receipt_package_binding_invalid")
    with zipfile.ZipFile(package, "r") as archive:
        epoch = json.loads(archive.read("evidence-epoch-2.json"))
        manifest_sha = sha256(archive.read(MANIFEST))
    if (receipt.get("epoch_id") != EPOCH_ID or receipt.get("parent_trust_root") is not None
            or receipt.get("final_head") != epoch.get("final_head") or receipt.get("final_tree") != epoch.get("final_tree")
            or receipt.get("manifest_sha256") != manifest_sha
            or receipt.get("verifier_sources") != epoch.get("verifier_sources")
            or receipt.get("verifier_rules") != epoch.get("verifier_rules")):
        raise ValueError("receipt_epoch_or_git_binding_invalid")
    for implementation, report_path in (("python", python_report), ("typescript", ts_report)):
        if receipt.get("verifier_results", {}).get(implementation, {}).get("report_sha256") != sha256(report_path.read_bytes()):
            raise ValueError(f"receipt_verifier_report_swapped:{implementation}")
    return {"receipt_sha256": sha256(receipt_path.read_bytes()), "package_sha256": package_sha, "passed": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest="command", required=True)
    verify = subs.add_parser("verify")
    verify.add_argument("--package", required=True)
    verify.add_argument("--repo", required=True)
    verify.add_argument("--output")
    receipt = subs.add_parser("verify-receipt")
    receipt.add_argument("--receipt", required=True)
    receipt.add_argument("--package", required=True)
    receipt.add_argument("--python-report", required=True)
    receipt.add_argument("--typescript-report", required=True)
    receipt.add_argument("--output")
    args = parser.parse_args()
    try:
        result = verify_package(Path(args.package), Path(args.repo).resolve()) if args.command == "verify" else verify_receipt(
            Path(args.receipt), Path(args.package), Path(args.python_report), Path(args.typescript_report),
        )
        code = 0
    except Exception as error:
        message = str(error)
        safe = message if re.fullmatch(r"[a-z0-9_.:,/-]{1,300}", message) else "python_independent_verification_failed"
        result = {"schema_version": "tivdoc-evidence-epoch-python-verification-error-v0.5.0", "implementation": "python", "safe_error_code": safe, "passed": False}
        code = 7
    rendered = stable_json(result)
    if args.output:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(rendered)
    print(rendered.decode("utf-8"), end="")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
