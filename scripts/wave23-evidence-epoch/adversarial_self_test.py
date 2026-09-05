#!/usr/bin/env python3
"""Synthetic end-to-end and adversarial matrix for the independent epoch tooling."""

from __future__ import annotations

# L8-1 / D2: scripts refuse a production environment, before anything else.
import os as _tivdoc_os, sys as _tivdoc_sys
if _tivdoc_os.environ.get("NODE_ENV") == "production" or _tivdoc_os.environ.get("VERCEL_ENV") in ("production", "preview"):
    _tivdoc_sys.stderr.write("PRODUCTION_ENVIRONMENT_REFUSED\n")
    _tivdoc_sys.exit(2)

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


def stable_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, separators=(",", ": ")) + "\n").encode("utf-8")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def run(command: list[str], cwd: Path, expected: int | None = None) -> subprocess.CompletedProcess:
    result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if expected is not None and result.returncode != expected:
        raise RuntimeError(f"command_exit_mismatch:{command[0]}:{result.returncode}:{result.stdout.decode('utf-8', 'ignore')}")
    return result


def git(repo: Path, *args: str) -> str:
    return run(["git", "-C", str(repo), *args], repo, 0).stdout.decode().strip()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(stable_json(value))


def synthetic_claims(root: Path) -> tuple[Path, Path, Path]:
    w1 = root / "claims-w1"
    w2 = root / "claims-w2"
    orchestrator = root / "claims-orchestrator"
    incident_ids = [f"INCIDENT_{index:03d}" for index in range(1, 12)]
    references = [
        {"reference_id": f"HISTORICAL_REFERENCE_{index:03d}", "incident_id": incident_ids[(index - 1) % 11], "package_id": "V0.4" if index <= 11 else "V0.4.1"}
        for index in range(1, 16)
    ]
    write_json(w1 / "cross-package-incident-registry.json", {
        "schema_version": "synthetic-incident-v0.5.0", "references": references,
        "unique_incidents": [{"incident_id": value} for value in incident_ids],
        "crosswalk": [{"reference_id": row["reference_id"], "incident_id": row["incident_id"]} for row in references],
        "summary": {"reference_count": 15, "unique_path_hash_incident_count": 11},
        "historical_roots_repaired": False,
    })
    disposition_records = []
    for root_id in ("V0.4", "V0.4.1"):
        disposition_records.extend([
            {"root_id": root_id, "sequence": 1, "state": "quarantined_failed", "current_admission": False, "record_hash": "a" * 64},
            {"root_id": root_id, "sequence": 2, "state": "forensic_only", "current_admission": False, "record_hash": "b" * 64},
        ])
    disposition_records.append({"root_id": "V0.4.2", "sequence": 1, "state": "forensic_only", "current_admission": False, "record_hash": "c" * 64})
    write_json(w1 / "evidence-root-disposition-registry.json", {
        "schema_version": "synthetic-disposition-v0.5.0", "append_only": True, "hash_bound": True,
        "historical_roots_can_satisfy_current_admission": False, "records": disposition_records,
    })
    write_json(w2 / "lifecycle-reconciliation.json", {
        "schema_version": "synthetic-lifecycle-v0.5.0",
        "sources": [{"case_id": f"SOURCE_LIFECYCLE_{index:03d}", "technical_parse_status": "parsed", "activation_status": "inactive"} for index in range(1, 18)],
        "totals": {
            "source_count": 17, "technical_parsed_sources": 16, "technical_failed_sources": 1,
            "parsed_but_instrument_quarantined_sources": 2, "extracted_chunks": 274,
            "instrument_resolved_chunks": 202, "quarantined_chunk_cardinality": 72,
            "retrievable_review_chunks": 202, "canonical_binding_candidate_chunks": 86,
            "explanatory_or_corroborative_chunks": 116, "needs_review_sources": 17,
            "reviewed_sources": 0, "inactive_sources": 17, "active_sources": 0, "operative_sources": 0,
        },
        "invariants": {"arithmetic_reconciles": True, "inactive_unreviewed_not_operative": True},
    })
    write_json(w2 / "stable-transitions.json", {
        "schema_version": "synthetic-transitions-v0.5.0",
        "records": [{"case_id": f"CHUNK_TRANSITION_{index:03d}", "passed": True} for index in range(1, 73)],
        "totals": {"record_count": 72, "cardinality_delta": -72, "corrected_reason_count": 4},
    })
    delegates = ["diagnostic_cli", "strict_cli", "corpus_topic_gate", "server_resolver_admission", "future_activation_adapter", "future_shadow_admission_adapter"]
    write_json(w2 / "readiness-delegate-matrix.json", {
        "schema_version": "synthetic-readiness-v0.5.0",
        "delegates": [{"delegate_id": value} for value in delegates],
        "synthetic_ready": {"fixture_controls": {"synthetic_only": True}, "status": "READY", "decision_sha256": "d" * 64, "all_six_identical": True},
        "real_blocked": [{"case_id": f"REAL_BLOCKED_{index:03d}", "actual": "BLOCKED_NOT_READY", "expected": "BLOCKED_NOT_READY"} for index in range(1, 29)],
        "static_guard": {"passed": True, "test_fixture_production_reachable": False},
    })
    write_json(w2 / "readiness-mutation-matrix.json", {
        "schema_version": "synthetic-mutations-v0.5.0",
        "cases": [{"case_id": f"READINESS_MUTATION_{index:03d}", "expected": "BLOCKED_NOT_READY", "actual": "BLOCKED_NOT_READY"} for index in range(1, 12)],
    })
    write_json(w2 / "temporal-sector-population-matrix.json", {
        "schema_version": "synthetic-temporal-v0.5.0",
        "cases": [{"case_id": f"TEMPORAL_CASE_{index:03d}", "passed": True} for index in range(1, 7)],
    })
    write_json(w2 / "multi-instrument-matrix.json", {
        "schema_version": "synthetic-multi-instrument-v0.5.0",
        "cases": [{"case_id": f"MULTI_INSTRUMENT_CASE_{index:03d}", "passed": True} for index in range(1, 5)],
    })
    write_json(w2 / "reporting-reconciliation.json", {
        "schema_version": "synthetic-reporting-v0.5.0",
        "reconciliations": [{"case_id": f"REPORT_RECONCILIATION_{index:03d}", "passed": True} for index in range(1, 5)],
    })
    zero_keys = [
        "customer_files_read", "openai_calls", "external_supabase_connections", "migrations",
        "production_preview_deploy_actions", "persistent_owner_imports", "reviewed_sources", "active_sources",
        "real_numeric_candidates", "real_numeric_attestations", "active_parameters", "israeli_rules", "findings", "shadow_runs",
    ]
    write_json(w2 / "zero-invariants.json", {"schema_version": "synthetic-zeros-v0.5.0", "counters": {key: 0 for key in zero_keys}, "all_zero": True})
    write_json(orchestrator / "command-ledger.json", {
        "schema_version": "synthetic-command-ledger-v0.5.0",
        "commands": [{
            "command_id": "COMMAND_001", "purpose": "synthetic fixture verification",
            "command_reference": "SYNTHETIC_COMMAND_REFERENCE_001", "expected_exit": 0, "actual_exit": 0,
            "expectation_matched": True, "subject_passed": True,
            "subject_status": "passed", "subject_reason": "synthetic_fixture_only",
        }],
    })
    return w1, w2, orchestrator


def copy_tooling(source_repo: Path, target_repo: Path) -> None:
    for relative in (
        "scripts/wave23-evidence-epoch",
        "src/engine/wave23/evidence-epoch",
        "docs/wave23-evidence-epoch-v0.5.0.md",
    ):
        source = source_repo / relative
        target = target_repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target)
        elif source.exists():
            shutil.copy2(source, target)


def load_zip(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path, "r") as archive:
        return {info.filename: archive.read(info) for info in archive.infolist()}


def write_zip(path: Path, files: dict[str, bytes], special: tuple[str, bytes, int] | None = None, duplicate: str | None = None) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, files[name])
        if special:
            name, data, mode = special
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = mode << 16
            archive.writestr(info, data)
        if duplicate:
            info = zipfile.ZipInfo(duplicate, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, files[duplicate])


def refresh_manifest(files: dict[str, bytes]) -> None:
    files.pop("package-manifest.json", None)
    manifest = {
        "schema_version": "tivdoc-evidence-epoch-package-manifest-v0.5.0", "epoch_id": "TIVDOC_EVIDENCE_EPOCH_2_V0.5.0",
        "manifest_self_excluded": True,
        "files": [{"path": name, "byte_length": len(data), "content_sha256": sha256(data), "file_mode": "100644"} for name, data in sorted(files.items())],
        "file_count": len(files),
    }
    files["package-manifest.json"] = stable_json(manifest)


def mutate_json(files: dict[str, bytes], member: str, change) -> None:
    document = json.loads(files[member])
    change(document)
    files[member] = stable_json(document)
    if member.startswith("current-claims/"):
        inventory = json.loads(files["current-claim-inventory.json"])
        for row in inventory["claims"]:
            if row["package_path"] == member:
                row["byte_length"] = len(files[member])
                row["content_sha256"] = sha256(files[member])
        files["current-claim-inventory.json"] = stable_json(inventory)
    refresh_manifest(files)


def report_from(result: subprocess.CompletedProcess) -> tuple[int, str | None]:
    try:
        document = json.loads(result.stdout)
        return result.returncode, document.get("safe_error_code")
    except Exception:
        return result.returncode, None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", default=".")
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    source_repo = Path(args.source_repo).resolve()
    output_root = Path(args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    builder = source_repo / "scripts/wave23-evidence-epoch/epoch_builder.py"
    py_verifier = source_repo / "scripts/wave23-evidence-epoch/verify_epoch_python.py"
    ts_verifier = source_repo / "scripts/wave23-evidence-epoch/verify_epoch_ts.mts"
    python = sys.executable
    cases: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="tivdoc-wave23-epoch-selftest-") as temporary:
        root = Path(temporary)
        repo = root / "repo"
        repo.mkdir()
        run(["git", "init", "--quiet", str(repo)], root, 0)
        git(repo, "config", "user.email", "synthetic@example.invalid")
        git(repo, "config", "user.name", "Synthetic Fixture")
        copy_tooling(source_repo, repo)
        (repo / "src/engine/wave23/evidence-epoch/synthetic-probe.txt").write_text("synthetic committed object\n", "utf-8", newline="\n")
        (repo / "src/engine/wave23/evidence-epoch/alpha").mkdir()
        (repo / "src/engine/wave23/evidence-epoch/beta").mkdir()
        (repo / "src/engine/wave23/evidence-epoch/alpha/display.json").write_text('{"fixture":"alpha"}\n', "utf-8", newline="\n")
        (repo / "src/engine/wave23/evidence-epoch/beta/display.json").write_text('{"fixture":"beta"}\n', "utf-8", newline="\n")
        git(repo, "add", ".")
        git(repo, "commit", "--quiet", "-m", "synthetic epoch fixture")
        head = git(repo, "rev-parse", "HEAD")
        w1, w2, orchestrator = synthetic_claims(root)
        package_a = root / "epoch-a.zip"
        package_b = root / "epoch-b.zip"
        base_build = [
            str(builder), "build", "--repo", str(repo), "--head", head,
            "--claim-root", f"w1={w1}", "--claim-root", f"w2={w2}", "--claim-root", f"orchestrator={orchestrator}",
        ]
        run([python, *base_build, "--output", str(package_a)], source_repo, 0)
        run([python, *base_build, "--output", str(package_b)], source_repo, 0)
        byte_identical = package_a.read_bytes() == package_b.read_bytes()
        cases.append({"case_id": "EPOCH_POS_001_BYTE_IDENTICAL_BUILDS", "expected": True, "actual": byte_identical, "passed": byte_identical})
        py_report = root / "python-report.json"
        ts_report = root / "typescript-report.json"
        py_ok = run([python, str(py_verifier), "verify", "--package", str(package_a), "--repo", str(repo), "--output", str(py_report)], source_repo)
        ts_ok = run(["node", str(ts_verifier), "verify", "--package", str(package_a), "--repo", str(repo), "--output", str(ts_report)], source_repo)
        cases.append({"case_id": "EPOCH_POS_002_TWO_INDEPENDENT_VERIFIERS", "expected": [0, 0], "actual": [py_ok.returncode, ts_ok.returncode], "passed": py_ok.returncode == ts_ok.returncode == 0})
        receipt = root / "receipt.json"
        receipt_result = run([python, str(builder), "receipt", "--package", str(package_a), "--python-report", str(py_report), "--typescript-report", str(ts_report), "--output", str(receipt)], source_repo)
        py_receipt = run([python, str(py_verifier), "verify-receipt", "--receipt", str(receipt), "--package", str(package_a), "--python-report", str(py_report), "--typescript-report", str(ts_report)], source_repo)
        ts_receipt = run(["node", str(ts_verifier), "verify-receipt", "--receipt", str(receipt), "--package", str(package_a), "--python-report", str(py_report), "--typescript-report", str(ts_report)], source_repo)
        cases.append({"case_id": "EPOCH_POS_003_DETACHED_RECEIPT", "expected": [0, 0, 0], "actual": [receipt_result.returncode, py_receipt.returncode, ts_receipt.returncode], "passed": receipt_result.returncode == py_receipt.returncode == ts_receipt.returncode == 0})

        pristine = load_zip(package_a)
        mutations = [
            ("EPOCH_ADV_001_HISTORICAL_FALLBACK", "evidence-epoch-2.json", lambda doc: doc["historical_disposition_references"][0].update({"authority": "trusted_current"})),
            ("EPOCH_ADV_002_QUARANTINE_OMITTED", "evidence-epoch-2.json", lambda doc: doc["historical_disposition_references"][0].update({"disposition": ["forensic_only"]})),
            ("EPOCH_ADV_003_CROSSWALK_AS_RECOVERY", "current-claims/w1/cross-package-incident-registry.json", lambda doc: doc.update({"historical_roots_repaired": True})),
            ("EPOCH_ADV_004_INCIDENT_REFERENCE_OMITTED", "current-claims/w1/cross-package-incident-registry.json", lambda doc: doc["references"].pop()),
            ("EPOCH_ADV_005_STALE_HEAD", "evidence-epoch-2.json", lambda doc: doc.update({"final_head": "0" * 40})),
            ("EPOCH_ADV_006_TRANSITION_LEDGER_TAMPER", "current-claims/w2/stable-transitions.json", lambda doc: doc["records"].pop()),
            ("EPOCH_ADV_027_LIFECYCLE_ARITHMETIC_TAMPER", "current-claims/w2/lifecycle-reconciliation.json", lambda doc: doc["totals"].update({"extracted_chunks": 275})),
            ("EPOCH_ADV_007_ALTERNATE_READINESS_DELEGATE", "current-claims/w2/readiness-delegate-matrix.json", lambda doc: doc["delegates"].pop()),
            ("EPOCH_ADV_008_READY_FIXTURE_PRODUCTION_REACHABLE", "current-claims/w2/readiness-delegate-matrix.json", lambda doc: doc["static_guard"].update({"test_fixture_production_reachable": True})),
        ]
        for case_id, member, change in mutations:
            files = dict(pristine)
            mutate_json(files, member, change)
            target = root / f"{case_id}.zip"
            write_zip(target, files)
            py_result = run([python, str(py_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            ts_result = run(["node", str(ts_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            py_exit, py_reason = report_from(py_result)
            ts_exit, ts_reason = report_from(ts_result)
            cases.append({"case_id": case_id, "expected": "both_reject", "actual": {"python_exit": py_exit, "python_reason": py_reason, "typescript_exit": ts_exit, "typescript_reason": ts_reason}, "passed": py_exit != 0 and ts_exit != 0})

        object_member = next(name for name in pristine if name.startswith("git-object-bytes/") and name.endswith("synthetic-probe.txt"))
        files = dict(pristine)
        files[object_member] = files[object_member].replace(b"\n", b"\r\n")
        refresh_manifest(files)
        crlf_zip = root / "crlf.zip"
        write_zip(crlf_zip, files)
        for case_id, target in (("EPOCH_ADV_009_CRLF_SUBSTITUTION", crlf_zip),):
            py_result = run([python, str(py_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            ts_result = run(["node", str(ts_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            cases.append({"case_id": case_id, "expected": "both_reject", "actual": {"python": report_from(py_result), "typescript": report_from(ts_result)}, "passed": py_result.returncode != 0 and ts_result.returncode != 0})

        files = dict(pristine)
        files.pop(object_member)
        refresh_manifest(files)
        missing_zip = root / "missing-object.zip"
        write_zip(missing_zip, files)
        files2 = dict(pristine)
        inventory = json.loads(files2["git-object-inventory.json"])
        same_name = [row for row in inventory["entries"] if row["path"].endswith("/display.json")]
        if len(same_name) != 2:
            raise RuntimeError("same_basename_fixture_missing")
        same_name[0]["package_path"] = same_name[1]["package_path"]
        files2["git-object-inventory.json"] = stable_json(inventory)
        refresh_manifest(files2)
        swapped_zip = root / "swapped-object.zip"
        write_zip(swapped_zip, files2)
        for case_id, target in (("EPOCH_ADV_010_MISSING_GIT_OBJECT", missing_zip), ("EPOCH_ADV_011_SWAPPED_SOURCE_PATH", swapped_zip)):
            py_result = run([python, str(py_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            ts_result = run(["node", str(ts_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            cases.append({"case_id": case_id, "expected": "both_reject", "actual": {"python": report_from(py_result), "typescript": report_from(ts_result)}, "passed": py_result.returncode != 0 and ts_result.returncode != 0})

        unsafe_archives = [
            ("EPOCH_ADV_012_DUPLICATE_ZIP_MEMBER", None, "index.json"),
            ("EPOCH_ADV_013_PATH_TRAVERSAL", ("../escape", b"x", stat.S_IFREG | 0o644), None),
            ("EPOCH_ADV_014_ABSOLUTE_PATH", ("/escape", b"x", stat.S_IFREG | 0o644), None),
            ("EPOCH_ADV_015_DRIVE_PREFIX", ("C:/escape", b"x", stat.S_IFREG | 0o644), None),
            ("EPOCH_ADV_016_ADS_NAME", ("safe/file:stream", b"x", stat.S_IFREG | 0o644), None),
            ("EPOCH_ADV_017_RESERVED_DEVICE", ("safe/CON.txt", b"x", stat.S_IFREG | 0o644), None),
            ("EPOCH_ADV_018_CASE_COLLISION", ("INDEX.JSON", b"x", stat.S_IFREG | 0o644), None),
            ("EPOCH_ADV_019_SYMLINK_MEMBER", ("safe/link", b"target", stat.S_IFLNK | 0o777), None),
        ]
        for case_id, special, duplicate in unsafe_archives:
            target = root / f"{case_id}.zip"
            write_zip(target, pristine, special=special, duplicate=duplicate)
            py_result = run([python, str(py_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            ts_result = run(["node", str(ts_verifier), "verify", "--package", str(target), "--repo", str(repo)], source_repo)
            cases.append({"case_id": case_id, "expected": "both_reject", "actual": {"python": report_from(py_result), "typescript": report_from(ts_result)}, "passed": py_result.returncode != 0 and ts_result.returncode != 0})

        probe = repo / "src/engine/wave23/evidence-epoch/synthetic-probe.txt"
        original_probe = probe.read_bytes()
        probe.write_bytes(original_probe + b"dirty")
        dirty_result = run([python, *base_build, "--output", str(root / "dirty.zip")], source_repo)
        probe.write_bytes(original_probe)
        stale_result = run([python, *base_build[:5], head[:-1] + ("0" if head[-1] != "0" else "1"), *base_build[6:], "--output", str(root / "stale.zip")], source_repo)
        cases.append({"case_id": "EPOCH_ADV_020_DIRTY_TRACKED_CHECKOUT", "expected": "builder_reject", "actual": report_from(dirty_result), "passed": dirty_result.returncode != 0})
        cases.append({"case_id": "EPOCH_ADV_021_STALE_HEAD_REQUEST", "expected": "builder_reject", "actual": report_from(stale_result), "passed": stale_result.returncode != 0})

        untracked = repo / "src/engine/wave23/evidence-epoch/untracked-authority.txt"
        untracked.write_text("synthetic untracked authority\n", "utf-8", newline="\n")
        untracked_result = run([python, *base_build, "--output", str(root / "untracked.zip")], source_repo)
        untracked.unlink()
        cases.append({"case_id": "EPOCH_ADV_024_UNCOMMITTED_AUTHORITATIVE_PATH", "expected": "builder_reject", "actual": report_from(untracked_result), "passed": untracked_result.returncode != 0})

        mode_files = dict(pristine)
        mode_inventory = json.loads(mode_files["git-object-inventory.json"])
        mode_inventory["entries"][0]["file_mode"] = "100755" if mode_inventory["entries"][0]["file_mode"] == "100644" else "100644"
        mode_files["git-object-inventory.json"] = stable_json(mode_inventory)
        refresh_manifest(mode_files)
        mode_zip = root / "mode-mismatch.zip"
        write_zip(mode_zip, mode_files)
        mode_py = run([python, str(py_verifier), "verify", "--package", str(mode_zip), "--repo", str(repo)], source_repo)
        mode_ts = run(["node", str(ts_verifier), "verify", "--package", str(mode_zip), "--repo", str(repo)], source_repo)
        cases.append({"case_id": "EPOCH_ADV_025_GIT_MODE_MISMATCH", "expected": "both_reject", "actual": {"python": report_from(mode_py), "typescript": report_from(mode_ts)}, "passed": mode_py.returncode != 0 and mode_ts.returncode != 0})

        for case_id, field, value in (
            ("EPOCH_ADV_022_STALE_RECEIPT_HEAD", "final_head", "0" * 40),
            ("EPOCH_ADV_023_SWAPPED_RECEIPT_REPORT", "verifier_results", {"python": {"report_sha256": "0" * 64, "passed": True}, "typescript": {"report_sha256": "0" * 64, "passed": True}}),
        ):
            document = json.loads(receipt.read_bytes())
            document[field] = value
            payload = dict(document)
            payload.pop("receipt_payload_sha256", None)
            document["receipt_payload_sha256"] = sha256(stable_json(payload))
            target = root / f"{case_id}.json"
            target.write_bytes(stable_json(document))
            py_result = run([python, str(py_verifier), "verify-receipt", "--receipt", str(target), "--package", str(package_a), "--python-report", str(py_report), "--typescript-report", str(ts_report)], source_repo)
            ts_result = run(["node", str(ts_verifier), "verify-receipt", "--receipt", str(target), "--package", str(package_a), "--python-report", str(py_report), "--typescript-report", str(ts_report)], source_repo)
            cases.append({"case_id": case_id, "expected": "both_reject", "actual": {"python": report_from(py_result), "typescript": report_from(ts_result)}, "passed": py_result.returncode != 0 and ts_result.returncode != 0})

        (repo / ".gitattributes").write_text("src/engine/wave23/evidence-epoch/synthetic-probe.txt filter=synthetic-sentinel\n", "utf-8", newline="\n")
        git(repo, "add", ".gitattributes")
        git(repo, "commit", "--quiet", "-m", "synthetic filter anomaly")
        filtered_head = git(repo, "rev-parse", "HEAD")
        filtered_build = [value if value != head else filtered_head for value in base_build]
        filter_result = run([python, *filtered_build, "--output", str(root / "filter-anomaly.zip")], source_repo)
        cases.append({"case_id": "EPOCH_ADV_026_GIT_FILTER_ANOMALY", "expected": "builder_reject", "actual": report_from(filter_result), "passed": filter_result.returncode != 0})

        shutil.copy2(package_a, output_root / "synthetic-epoch-a.zip")
        shutil.copy2(package_b, output_root / "synthetic-epoch-b.zip")
        shutil.copy2(receipt, output_root / "synthetic-receipt.json")
        shutil.copy2(py_report, output_root / "synthetic-python-verifier.json")
        shutil.copy2(ts_report, output_root / "synthetic-typescript-verifier.json")
    report = {
        "schema_version": "tivdoc-evidence-epoch-adversarial-matrix-v0.5.0",
        "synthetic_only": True, "cases": cases, "case_count": len(cases),
        "passed_count": sum(case["passed"] for case in cases), "passed": all(case["passed"] for case in cases),
    }
    write_json(output_root / "adversarial-matrix.json", report)
    print(stable_json(report).decode(), end="")
    return 0 if report["passed"] else 7


if __name__ == "__main__":
    raise SystemExit(main())
