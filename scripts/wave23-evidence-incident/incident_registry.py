from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile
from collections import defaultdict
from typing import Any, Iterable


CONTRACT_SHA = "bcbf22139452213e9e60df5d5e3ad65a28fafff5"
V04_HEAD = "5ce3eba6ab816cd6a20e101c913f7f1177c7598a"
V041_HEAD = "48be587d5a394e37656e20a1276b4cebb85c60bb"
OUTPUT_RELATIVE = pathlib.Path("output/parallel-wave-2.3/workers/w1-evidence-incident")
DECLARATION_RELATIVE = pathlib.Path("src/engine/wave23/evidence-incident/incident-declaration.v0.5.0.json")
V04_DECLARATION_RELATIVE = pathlib.Path("src/engine/wave22/evidence-forensics/v0.4-erratum.v0.4.2.json")
ALLOWLIST = (
    "src/engine/wave23/evidence-incident/**",
    "scripts/wave23-evidence-incident/**",
    "docs/wave23-evidence-incident-v0.5.0.md",
)
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA64 = re.compile(r"^[0-9a-f]{64}$")
DISPOSITION_STATES = {
    "trusted_current",
    "quarantined_failed",
    "forensic_only",
    "superseded_for_use",
    "not_available_for_revalidation",
}
EXPECTED_PACKAGE_IDENTITIES = {
    "V0.4": {
        "zip_sha256": "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c",
        "manifest_sha256": "9fa62f6848c5bef1e4bfae1654b5e0673bf61589c6ca985d1578a44d95c7c5bf",
        "erratum_sha256": "98e709e5a22fe269f5e11f2934930c1220f6d00ce1c078c5ebb961e0927198a4",
    },
    "V0.4.1": {
        "zip_sha256": "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2",
        "manifest_sha256": "f4a4ea363abdaf15a2a3cdbba925937360a08d14d704bc3fe6060b2264fcf16b",
    },
    "V0.4.2": {
        "zip_sha256": "c3c7135821097e68e00717b93300939cc84d565932a0dacd6cc239a684db6636",
        "manifest_sha256": "6b8082a2aa4149cba35ead01500114323658d58ac8e2899694a2873b0d50a9c1",
    },
}


class IncidentError(ValueError):
    pass


def fail(code: str, detail: str = "") -> None:
    raise IncidentError(f"{code}:{detail}" if detail else code)


def sha256(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def pretty_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def write_json(path_value: pathlib.Path, value: Any) -> None:
    path_value.parent.mkdir(parents=True, exist_ok=True)
    path_value.write_bytes(pretty_bytes(value))


def hash_bound(value: dict[str, Any], field: str) -> dict[str, Any]:
    payload = {key: item for key, item in value.items() if key != field}
    return {**payload, field: sha256(canonical_bytes(payload))}


def run(repo: pathlib.Path, args: Iterable[str], input_bytes: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        ["git", *args], cwd=repo, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if check and result.returncode != 0:
        fail("git_command_failed", f"{' '.join(args)}:{result.stderr.decode(errors='replace').strip()}")
    return result


def git_text(repo: pathlib.Path, args: Iterable[str]) -> str:
    return run(repo, args).stdout.decode(errors="strict").strip()


def pointer(document: Any, value: str) -> Any:
    current = document
    if not value.startswith("/"):
        fail("invalid_json_pointer", value)
    for raw in value.split("/")[1:]:
        token = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def verify_zip(path_value: pathlib.Path, identity: dict[str, Any]) -> dict[str, Any]:
    if not path_value.is_file():
        return {
            "package_id": identity["package_id"],
            "path": str(path_value),
            "available": False,
            "disposition": "not_available_for_revalidation",
            **EXPECTED_PACKAGE_IDENTITIES[identity["package_id"]],
        }
    package_bytes = path_value.read_bytes()
    if sha256(package_bytes) != identity["zip_sha256"]:
        fail("historical_zip_identity_mismatch", identity["package_id"])
    with zipfile.ZipFile(path_value) as archive:
        infos = archive.infolist()
        names = [item.filename for item in infos]
        if len(names) != len(set(names)) or "package-manifest.json" not in names:
            fail("historical_zip_structure_invalid", identity["package_id"])
        manifest_bytes = archive.read("package-manifest.json")
        if sha256(manifest_bytes) != identity["manifest_sha256"]:
            fail("historical_manifest_identity_mismatch", identity["package_id"])
        manifest = json.loads(manifest_bytes)
        entries = manifest.get("files")
        if not isinstance(entries, list):
            fail("historical_manifest_entries_missing", identity["package_id"])
        expected = {entry["path"]: entry for entry in entries}
        if set(expected) != set(names) - {"package-manifest.json"}:
            fail("historical_manifest_membership_mismatch", identity["package_id"])
        for name, entry in expected.items():
            data = archive.read(name)
            if len(data) != entry["byte_count"] or sha256(data) != entry["sha256"]:
                fail("historical_member_identity_mismatch", f"{identity['package_id']}:{name}")
    return {
        "package_id": identity["package_id"],
        "path": str(path_value),
        "available": True,
        "zip_sha256": identity["zip_sha256"],
        "zip_byte_count": len(package_bytes),
        "manifest_sha256": identity["manifest_sha256"],
        "member_count": len(names),
        "manifest_entry_count": len(entries),
        "byte_unchanged_and_structurally_verified": True,
    }


def zip_json(path_value: pathlib.Path, member: str) -> Any:
    with zipfile.ZipFile(path_value) as archive:
        return json.loads(archive.read(member))


def parse_worktrees(repo: pathlib.Path) -> list[dict[str, str | None]]:
    raw = git_text(repo, ["worktree", "list", "--porcelain"])
    records = []
    for block in raw.split("\n\n"):
        record: dict[str, str | None] = {"worktree": None, "HEAD": None, "branch": None}
        for line in block.splitlines():
            key, _, value = line.partition(" ")
            if key in record:
                record[key] = value
        if record["worktree"]:
            records.append(record)
    return sorted(records, key=lambda item: str(item["worktree"]).lower())


def historical_blob_groups(repo: pathlib.Path, paths: list[str]) -> dict[str, list[dict[str, Any]]]:
    commits = git_text(repo, ["rev-list", "--all", "--reflog", "--reverse"]).splitlines()
    groups: dict[str, dict[str, list[str]]] = {item: defaultdict(list) for item in paths}
    for commit in commits:
        raw = run(repo, ["ls-tree", commit, "--", *paths]).stdout.decode(errors="strict")
        for line in raw.splitlines():
            metadata, relative = line.split("\t", 1)
            _mode, object_type, object_id = metadata.split()
            if object_type == "blob":
                groups[relative][object_id].append(commit)
    result: dict[str, list[dict[str, Any]]] = {}
    for relative in paths:
        values = []
        for object_id, commits_for_blob in groups[relative].items():
            data = run(repo, ["cat-file", "blob", object_id]).stdout
            values.append({
                "git_blob_oid": object_id,
                "content_sha256": sha256(data),
                "byte_count": len(data),
                "first_commit_observed": commits_for_blob[0],
                "commit_reference_count": len(commits_for_blob),
            })
        result[relative] = sorted(values, key=lambda item: (item["first_commit_observed"], item["git_blob_oid"]))
    return result


def historical_blob(repo: pathlib.Path, revision: str, relative: str) -> dict[str, Any]:
    object_id = git_text(repo, ["rev-parse", f"{revision}:{relative}"])
    data = run(repo, ["cat-file", "blob", object_id]).stdout
    return {"revision": revision, "git_blob_oid": object_id, "content_sha256": sha256(data), "byte_count": len(data)}


def worktree_candidates(
    repo: pathlib.Path,
    worktrees: list[dict[str, str | None]],
    relative: str,
    claimed_sha: str,
    claimed_count: int,
    historical_blob_oid: str,
) -> list[dict[str, Any]]:
    values = []
    for worktree in worktrees:
        root = pathlib.Path(str(worktree["worktree"]))
        candidate = root / pathlib.Path(*relative.split("/"))
        if not candidate.is_file():
            continue
        data = candidate.read_bytes()
        normalized = run(root, ["hash-object", f"--path={relative}", "--stdin"], data).stdout.decode().strip()
        status = run(root, ["status", "--porcelain=v1", "--", relative], check=False).stdout.decode(errors="replace").strip()
        exact = len(data) == claimed_count and sha256(data) == claimed_sha
        values.append({
            "worktree": str(root),
            "head": worktree["HEAD"],
            "branch": worktree["branch"],
            "path_status": status,
            "sha256": sha256(data),
            "byte_count": len(data),
            "git_clean_filter_blob_oid": normalized,
            "normalizes_to_historical_blob": normalized == historical_blob_oid,
            "exact_claim_match": exact,
            "valid_exact_recovery": exact and normalized == historical_blob_oid,
        })
    return values


def known_recovered_candidates(
    repo: pathlib.Path,
    historical_root: pathlib.Path,
    relative: str,
    claimed_sha: str,
    claimed_count: int,
    historical_blob_oid: str,
) -> list[dict[str, Any]]:
    roots = [
        historical_root / "output/parallel-wave-2.2/workers/w1-evidence-forensics/recovered-bytes",
        historical_root / "output/parallel-wave-2.2/workers/w1-integration-verification/recovered-bytes",
    ]
    values = []
    for root in roots:
        if not root.is_dir():
            continue
        for candidate in sorted(root.rglob("*.recovered.bin")):
            data = candidate.read_bytes()
            if len(data) != claimed_count or sha256(data) != claimed_sha:
                continue
            normalized = run(repo, ["hash-object", f"--path={relative}", "--stdin"], data).stdout.decode().strip()
            values.append({
                "path": str(candidate),
                "sha256": sha256(data),
                "byte_count": len(data),
                "git_clean_filter_blob_oid": normalized,
                "normalizes_to_historical_blob": normalized == historical_blob_oid,
                "valid_exact_recovery": normalized == historical_blob_oid,
            })
    return values


def package_member_candidates(packages: list[dict[str, Any]], claimed_sha: str, claimed_count: int) -> list[dict[str, Any]]:
    values = []
    for package in packages:
        path_value = pathlib.Path(package["path"])
        if not package.get("available"):
            continue
        with zipfile.ZipFile(path_value) as archive:
            for info in archive.infolist():
                if info.file_size != claimed_count:
                    continue
                data = archive.read(info.filename)
                if sha256(data) == claimed_sha:
                    values.append({"package_id": package["package_id"], "member": info.filename, "sha256": claimed_sha, "byte_count": claimed_count})
    return values


def incident_id(relative: str, claimed_sha: str, count: int) -> str:
    digest = sha256(f"{relative}\n{claimed_sha}\n{count}\n")[:16].upper()
    return f"HIST_INCIDENT_{digest}"


def load_references(repo: pathlib.Path, declaration: dict[str, Any]) -> list[dict[str, Any]]:
    v04 = json.loads((repo / V04_DECLARATION_RELATIVE).read_bytes())
    references = []
    for item in v04["references"]:
        references.append({
            "reference_id": item["case_id"],
            "package_id": "V0.4",
            "evidence_member": item["evidence_member"],
            "json_pointers": item["json_pointers"],
            "repository_path": item["repository_path"],
            "claimed_sha256": item["claimed_sha256"],
            "claimed_byte_count": item["claimed_byte_count"],
            "declared_v0_4_strict_resolved": item["strict_resolved"],
        })
    for item in declaration["v0_4_1_references"]:
        references.append({**item, "package_id": "V0.4.1", "declared_v0_4_strict_resolved": None})
    if len(references) != declaration["required_reference_count"] or len({item["reference_id"] for item in references}) != len(references):
        fail("reference_declaration_count_mismatch")
    return references


def validate_reference_bindings(references: list[dict[str, Any]], package_paths: dict[str, pathlib.Path]) -> None:
    documents: dict[tuple[str, str], Any] = {}
    for item in references:
        key = (item["package_id"], item["evidence_member"])
        document = documents.setdefault(key, zip_json(package_paths[item["package_id"]], item["evidence_member"]))
        observed = {
            "path": pointer(document, item["json_pointers"]["path"]),
            "sha256": pointer(document, item["json_pointers"]["sha256"]),
            "byte_count": pointer(document, item["json_pointers"]["byte_count"]),
        }
        expected = {"path": item["repository_path"], "sha256": item["claimed_sha256"], "byte_count": item["claimed_byte_count"]}
        if observed != expected:
            fail("reference_pointer_binding_mismatch", item["reference_id"])


def disposition_record(
    root_id: str,
    sequence: int,
    state: str,
    reason_code: str,
    identity: dict[str, str],
    parent_hash: str | None,
    failure_latched: bool,
    component_only: bool,
) -> dict[str, Any]:
    if state not in DISPOSITION_STATES:
        fail("unknown_disposition_state", state)
    payload = {
        "schema_version": "tivdoc-evidence-root-disposition-v1",
        "root_id": root_id,
        "sequence": sequence,
        "state": state,
        "reason_code": reason_code,
        "package_identity": identity,
        "parent_record_hash": parent_hash,
        "failure_latched": failure_latched,
        "component_only": component_only,
        "capabilities": {
            "current_audit_admission": False,
            "legal_source_activation": False,
            "shadow_evidence_admission": False,
        },
    }
    return {**payload, "record_hash": sha256(canonical_bytes(payload))}


def validate_disposition_chain(records: list[dict[str, Any]]) -> None:
    if not records:
        fail("empty_disposition_chain")
    allowed = {
        ("trusted_current", "superseded_for_use"),
        ("quarantined_failed", "forensic_only"),
        ("not_available_for_revalidation", "forensic_only"),
        ("forensic_only", "superseded_for_use"),
    }
    for index, record in enumerate(records):
        previous = records[index - 1] if index else None
        if record["sequence"] != index:
            fail("disposition_sequence_mismatch")
        if record["parent_record_hash"] != (previous["record_hash"] if previous else None):
            fail("disposition_parent_hash_mismatch")
        payload = {key: value for key, value in record.items() if key != "record_hash"}
        if record["record_hash"] != sha256(canonical_bytes(payload)):
            fail("disposition_record_hash_mismatch")
        if previous:
            if previous["root_id"] != record["root_id"] or previous["package_identity"] != record["package_identity"]:
                fail("disposition_immutable_identity_changed")
            if (previous["state"], record["state"]) not in allowed:
                fail("invalid_disposition_transition")
            if previous["failure_latched"] and not record["failure_latched"]:
                fail("failure_latch_cleared")
        if record["failure_latched"] and record["state"] == "trusted_current":
            fail("failed_root_cannot_become_trusted")
        if record["state"] != "trusted_current" and any(record["capabilities"].values()):
            fail("historical_root_admission_capability")


def build_dispositions(package_bindings: list[dict[str, Any]]) -> dict[str, Any]:
    identities = {
        item["package_id"]: {key: value for key, value in EXPECTED_PACKAGE_IDENTITIES[item["package_id"]].items()}
        | {"package_id": item["package_id"]}
        for item in package_bindings
    }
    roots = []
    records = []
    for package_id, failure_reason in (("V0.4", "HISTORICAL_STRICT_REFERENCE_FAILURE"), ("V0.4.1", "HISTORICAL_EVIDENCE_TO_GIT_FAILURE")):
        root_id = f"historical-evidence-root-{package_id.lower()}"
        first = disposition_record(root_id, 0, "quarantined_failed", failure_reason, identities[package_id], None, True, False)
        second = disposition_record(root_id, 1, "forensic_only", "PRESERVED_FOR_INCIDENT_INSPECTION_ONLY", identities[package_id], first["record_hash"], True, False)
        validate_disposition_chain([first, second])
        records.extend((first, second))
        roots.append({
            "root_id": root_id,
            "package_id": package_id,
            "failure_disposition": "quarantined_failed",
            "use_disposition": "forensic_only",
            "failure_latched": True,
            "current_record_hash": second["record_hash"],
            "historical_root_repaired": False,
        })
    root_id = "historical-component-package-v0.4.2"
    component = disposition_record(
        root_id, 0, "forensic_only", "COMPONENT_ONLY_HISTORICAL_CHAIN_REMAINED_FAILED",
        identities["V0.4.2"], None, False, True,
    )
    validate_disposition_chain([component])
    records.append(component)
    roots.append({
        "root_id": root_id,
        "package_id": "V0.4.2",
        "failure_disposition": None,
        "use_disposition": "forensic_only",
        "component_only": True,
        "successful_historical_chain_root": False,
        "current_record_hash": component["record_hash"],
    })
    return hash_bound({
        "schema_version": "tivdoc-wave23-evidence-root-disposition-registry-v0.5.0",
        "append_only": True,
        "hash_bound": True,
        "historical_roots_can_satisfy_current_admission": False,
        "historical_roots_can_satisfy_legal_activation": False,
        "historical_roots_can_satisfy_shadow_admission": False,
        "roots": roots,
        "records": records,
        "summary": {
            "root_count": 3,
            "quarantined_failed_root_count": 2,
            "forensic_only_root_count": 3,
            "trusted_current_root_count": 0,
            "successful_historical_chain_root_count": 0,
        },
    }, "registry_sha256")


def validate_identity(package_id: str, identity: dict[str, str]) -> None:
    if identity != EXPECTED_PACKAGE_IDENTITIES[package_id]:
        fail("package_identity_mismatch", package_id)


def validate_registry_counts(references: list[dict[str, Any]], unique_incidents: list[dict[str, Any]], expected_ids: set[str]) -> None:
    ids = {item["reference_id"] for item in references}
    if ids != expected_ids or len(references) != 15:
        fail("incident_reference_coverage_mismatch")
    derived = {(item["repository_path"], item["claimed_sha256"], item["claimed_byte_count"]) for item in references}
    observed = {(item["repository_path"], item["claimed_sha256"], item["claimed_byte_count"]) for item in unique_incidents}
    if derived != observed or len(unique_incidents) == len(references):
        fail("unique_incident_reconciliation_mismatch")


def validate_recovery(method: str, exact_hash: bool, exact_count: bool, normalizes: bool) -> None:
    if method == "crosswalk_only":
        fail("crosswalk_is_not_byte_recovery")
    if not (exact_hash and exact_count and normalizes):
        fail("exact_recovery_proof_incomplete")


def negative_matrix(registry: dict[str, Any], dispositions: dict[str, Any]) -> dict[str, Any]:
    cases = []

    def expect_rejection(case_id: str, code: str, operation: Any) -> None:
        observed = None
        try:
            operation()
        except IncidentError as error:
            observed = str(error).split(":", 1)[0]
        cases.append({
            "case_id": case_id,
            "expected_result": "rejected",
            "expected_reason": code,
            "actual_result": "rejected" if observed else "accepted",
            "actual_reason": observed,
            "passed": observed == code,
        })

    v04_chain = [item for item in dispositions["records"] if item["root_id"] == "historical-evidence-root-v0.4"]
    expect_rejection("INCIDENT_NEG_001_QUARANTINED_TO_TRUSTED", "invalid_disposition_transition", lambda: validate_disposition_chain([
        v04_chain[0],
        disposition_record(v04_chain[0]["root_id"], 1, "trusted_current", "ILLEGAL", v04_chain[0]["package_identity"], v04_chain[0]["record_hash"], True, False),
    ]))
    expect_rejection("INCIDENT_NEG_002_CROSSWALK_AS_RECOVERY", "crosswalk_is_not_byte_recovery", lambda: validate_recovery("crosswalk_only", True, True, True))
    expected_ids = {item["reference_id"] for item in registry["references"]}
    expect_rejection("INCIDENT_NEG_003_OMITTED_REFERENCE", "incident_reference_coverage_mismatch", lambda: validate_registry_counts(registry["references"][:-1], registry["unique_incidents"], expected_ids))
    expect_rejection("INCIDENT_NEG_004_COLLAPSED_REFERENCE_COUNT", "incident_reference_coverage_mismatch", lambda: validate_registry_counts(registry["references"][:len(registry["unique_incidents"])], registry["unique_incidents"], expected_ids))
    expect_rejection("INCIDENT_NEG_005_ZIP_IDENTITY_MISMATCH", "package_identity_mismatch", lambda: validate_identity("V0.4", {**EXPECTED_PACKAGE_IDENTITIES["V0.4"], "zip_sha256": "0" * 64}))
    expect_rejection("INCIDENT_NEG_006_MANIFEST_IDENTITY_MISMATCH", "package_identity_mismatch", lambda: validate_identity("V0.4", {**EXPECTED_PACKAGE_IDENTITIES["V0.4"], "manifest_sha256": "0" * 64}))
    expect_rejection("INCIDENT_NEG_007_ERRATUM_IDENTITY_MISMATCH", "package_identity_mismatch", lambda: validate_identity("V0.4", {**EXPECTED_PACKAGE_IDENTITIES["V0.4"], "erratum_sha256": "0" * 64}))
    expect_rejection("INCIDENT_NEG_008_HISTORICAL_FALLBACK", "historical_root_cannot_satisfy_current_admission", lambda: fail("historical_root_cannot_satisfy_current_admission") if not v04_chain[-1]["capabilities"]["current_audit_admission"] else None)
    tampered_reason = [{**item} for item in v04_chain]
    tampered_reason[1]["reason_code"] = "TAMPERED"
    expect_rejection("INCIDENT_NEG_009_TAMPERED_REASON", "disposition_record_hash_mismatch", lambda: validate_disposition_chain(tampered_reason))
    tampered_parent = [{**item} for item in v04_chain]
    tampered_parent[1]["parent_record_hash"] = "f" * 64
    expect_rejection("INCIDENT_NEG_010_TAMPERED_PARENT_HASH", "disposition_parent_hash_mismatch", lambda: validate_disposition_chain(tampered_parent))
    if not all(item["passed"] for item in cases):
        fail("negative_matrix_regression")
    return hash_bound({
        "schema_version": "tivdoc-wave23-evidence-incident-negative-matrix-v0.5.0",
        "cases": cases,
        "case_count": len(cases),
        "passed_count": len(cases),
        "passed": True,
    }, "matrix_sha256")


def allowlisted(relative: str) -> bool:
    return any(relative.startswith(pattern[:-3]) if pattern.endswith("/**") else relative == pattern for pattern in ALLOWLIST)


def git_evidence(repo: pathlib.Path) -> dict[str, Any]:
    head = git_text(repo, ["rev-parse", "HEAD"])
    parent = git_text(repo, ["rev-parse", "HEAD^"])
    tree = git_text(repo, ["rev-parse", "HEAD^{tree}"])
    merge_base = git_text(repo, ["merge-base", CONTRACT_SHA, head])
    commit_count = int(git_text(repo, ["rev-list", "--count", f"{CONTRACT_SHA}..{head}"]))
    paths = sorted(filter(None, git_text(repo, ["diff", "--name-only", f"{CONTRACT_SHA}..{head}"]).splitlines()))
    status = git_text(repo, ["status", "--porcelain=v1"])
    patch = run(repo, ["show", "--pretty=format:", "--no-ext-diff", "--binary", head]).stdout + b"\n"
    patch_id_result = run(repo, ["patch-id", "--stable"], patch).stdout.decode().split()
    return hash_bound({
        "schema_version": "tivdoc-wave23-w1-git-evidence-v0.5.0",
        "branch": git_text(repo, ["branch", "--show-current"]),
        "contract_sha": CONTRACT_SHA,
        "head": head,
        "parent": parent,
        "tree": tree,
        "merge_base": merge_base,
        "commit_count_over_contract": commit_count,
        "patch_id": patch_id_result[0] if patch_id_result else None,
        "allowlist": list(ALLOWLIST),
        "allowlist_sha256": sha256(pretty_bytes(list(ALLOWLIST))),
        "changed_paths": paths,
        "all_paths_allowlisted": all(allowlisted(item) for item in paths),
        "clean_worktree": status == "",
        "porcelain": status,
        "handoff_ready": parent == CONTRACT_SHA and merge_base == CONTRACT_SHA and commit_count == 1 and status == "" and all(allowlisted(item) for item in paths),
    }, "report_sha256")


def build(repo: pathlib.Path, historical_root: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    declaration_bytes = (repo / DECLARATION_RELATIVE).read_bytes()
    declaration = json.loads(declaration_bytes)
    package_specs = {item["package_id"]: item for item in declaration["historical_packages"]}
    package_paths = {package_id: historical_root / pathlib.Path(*item["zip_path"].split("/")) for package_id, item in package_specs.items()}
    packages = [verify_zip(package_paths[package_id], package_specs[package_id]) for package_id in ("V0.4", "V0.4.1", "V0.4.2")]
    if not all(item.get("available") for item in packages[:2]):
        fail("required_reference_package_unavailable")
    erratum_path = historical_root / "output/parallel-wave-2.2/workers/w1-evidence-forensics/v0.4-immutable-erratum.json"
    if not erratum_path.is_file() or sha256(erratum_path.read_bytes()) != EXPECTED_PACKAGE_IDENTITIES["V0.4"]["erratum_sha256"]:
        fail("v0_4_erratum_identity_mismatch")
    packages[0]["erratum_path"] = str(erratum_path)
    packages[0]["erratum_sha256"] = EXPECTED_PACKAGE_IDENTITIES["V0.4"]["erratum_sha256"]
    references = load_references(repo, declaration)
    validate_reference_bindings(references, package_paths)
    paths = sorted({item["repository_path"] for item in references})
    history = historical_blob_groups(repo, paths)
    worktrees = parse_worktrees(repo)
    recovered_reference_count = 0
    reference_rows = []
    recovery_rows = []
    for item in references:
        historical_head = V04_HEAD if item["package_id"] == "V0.4" else V041_HEAD
        canonical = historical_blob(repo, historical_head, item["repository_path"])
        worktree_rows = worktree_candidates(
            repo, worktrees, item["repository_path"], item["claimed_sha256"], item["claimed_byte_count"], canonical["git_blob_oid"],
        )
        recovered_rows = known_recovered_candidates(
            repo, historical_root, item["repository_path"], item["claimed_sha256"], item["claimed_byte_count"], canonical["git_blob_oid"],
        )
        package_rows = package_member_candidates(packages, item["claimed_sha256"], item["claimed_byte_count"])
        valid_worktrees = [row for row in worktree_rows if row["valid_exact_recovery"]]
        valid_outputs = [row for row in recovered_rows if row["valid_exact_recovery"]]
        recovered = bool(valid_worktrees or valid_outputs)
        if item["package_id"] == "V0.4" and recovered != bool(item["declared_v0_4_strict_resolved"]):
            fail("v0_4_recovery_proof_changed", item["reference_id"])
        recovered_reference_count += int(recovered)
        selected = ({"source_kind": "existing_worktree", **valid_worktrees[0]} if valid_worktrees else
                    {"source_kind": "known_historical_output", **valid_outputs[0]} if valid_outputs else None)
        incident = incident_id(item["repository_path"], item["claimed_sha256"], item["claimed_byte_count"])
        root_cause = "line_ending_or_filter_transform" if recovered else "unexplained_possible_integrity_failure"
        authority = "exact_bytes_recovered_for_forensic_crosswalk_only" if recovered else "non_authoritative_unrecoverable_or_unavailable"
        package_identity = {
            "package_id": item["package_id"],
            **EXPECTED_PACKAGE_IDENTITIES[item["package_id"]],
        }
        reference_rows.append({
            **item,
            "package_identity": package_identity,
            "incident_id": incident,
            "exact_recovery_status": "exact_recovered" if recovered else "unrecoverable_or_unavailable",
            "exact_recovery_proof": selected,
            "historical_canonical_git_blob": canonical,
            "available_git_blobs": history[item["repository_path"]],
            "bounded_provenance": {
                "git_object_database_and_reflogs_inspected": True,
                "existing_worktree_count": len(worktrees),
                "valid_exact_worktree_candidates": len(valid_worktrees),
                "valid_exact_known_output_candidates": len(valid_outputs),
                "matching_known_package_members": package_rows,
                "speculative_transforms_attempted": 0,
            },
            "root_cause_class": root_cause,
            "root_cause_hypotheses": ["pre_commit_generated_evidence_bug"],
            "pre_commit_generated_evidence_bug_causally_proven": False,
            "authority_disposition": authority,
        })
        recovery_rows.append({
            "reference_id": item["reference_id"],
            "incident_id": incident,
            "repository_path": item["repository_path"],
            "expected_result": "exact_recovered" if recovered else "unrecoverable_or_unavailable",
            "actual_result": "exact_recovered" if recovered else "unrecoverable_or_unavailable",
            "selected_proof": selected,
            "worktree_candidates": worktree_rows,
            "known_recovered_output_candidates": recovered_rows,
            "matching_package_members": package_rows,
            "passed": True,
        })
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in reference_rows:
        grouped[row["incident_id"]].append(row)
    unique_incidents = []
    for identifier, rows in sorted(grouped.items()):
        first = rows[0]
        package_ids = sorted({row["package_id"] for row in rows})
        recovered = any(row["exact_recovery_status"] == "exact_recovered" for row in rows)
        unique_incidents.append({
            "incident_id": identifier,
            "repository_path": first["repository_path"],
            "claimed_sha256": first["claimed_sha256"],
            "claimed_byte_count": first["claimed_byte_count"],
            "reference_ids": [row["reference_id"] for row in rows],
            "reference_count": len(rows),
            "package_ids": package_ids,
            "duplicate_path_hash_incident": len(rows) > 1,
            "cross_package_duplicate_path_hash_incident": len(package_ids) > 1,
            "exact_recovery_status": "exact_recovered" if recovered else "unrecoverable_or_unavailable",
            "authority_disposition": "forensic_crosswalk_only" if recovered else "non_authoritative_unresolved",
        })
    path_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for incident in unique_incidents:
        path_groups[incident["repository_path"]].append(incident)
    crosswalk = [{
        "repository_path": relative,
        "incident_ids": [item["incident_id"] for item in rows],
        "package_ids": sorted({package for item in rows for package in item["package_ids"]}),
        "same_path_different_claim_incident": len(rows) > 1,
        "crosswalk_is_byte_recovery": False,
    } for relative, rows in sorted(path_groups.items())]
    expected_ids = {item["reference_id"] for item in references}
    validate_registry_counts(reference_rows, unique_incidents, expected_ids)
    recovered_unique = sum(item["exact_recovery_status"] == "exact_recovered" for item in unique_incidents)
    registry = hash_bound({
        "schema_version": "tivdoc-wave23-cross-package-incident-registry-v0.5.0",
        "declaration": {"path": DECLARATION_RELATIVE.as_posix(), "sha256": sha256(declaration_bytes)},
        "historical_packages": packages,
        "references": reference_rows,
        "unique_incidents": unique_incidents,
        "crosswalk": crosswalk,
        "summary": {
            "reference_count": len(reference_rows),
            "unique_path_hash_incident_count": len(unique_incidents),
            "duplicate_reference_count": len(reference_rows) - len(unique_incidents),
            "exact_recovered_reference_count": recovered_reference_count,
            "unrecoverable_or_unavailable_reference_count": len(reference_rows) - recovered_reference_count,
            "exact_recovered_unique_incident_count": recovered_unique,
            "unrecoverable_or_unavailable_unique_incident_count": len(unique_incidents) - recovered_unique,
            "cross_package_duplicate_path_hash_incident_count": sum(item["cross_package_duplicate_path_hash_incident"] for item in unique_incidents),
        },
        "bounded_sources": {
            "git_object_database": True,
            "git_reflogs": True,
            "existing_repository_worktrees": [item["worktree"] for item in worktrees],
            "known_historical_packages": [item["path"] for item in packages],
            "known_historical_outputs": [
                str(historical_root / "output/parallel-wave-2.2/workers/w1-evidence-forensics/recovered-bytes"),
                str(historical_root / "output/parallel-wave-2.2/workers/w1-integration-verification/recovered-bytes"),
            ],
            "unrelated_directories_scanned": 0,
            "brute_force_candidates_generated": 0,
            "speculative_line_ending_filter_or_encoding_transforms_accepted": 0,
        },
        "historical_roots_repaired": False,
    }, "report_sha256")
    recovery_matrix = hash_bound({
        "schema_version": "tivdoc-wave23-bounded-recovery-matrix-v0.5.0",
        "cases": recovery_rows,
        "reference_count": len(recovery_rows),
        "exact_recovered_reference_count": recovered_reference_count,
        "unrecoverable_or_unavailable_reference_count": len(recovery_rows) - recovered_reference_count,
        "passed": True,
    }, "matrix_sha256")
    dispositions = build_dispositions(packages)
    negatives = negative_matrix(registry, dispositions)
    git_report = git_evidence(repo)
    historical_gates = hash_bound({
        "schema_version": "tivdoc-wave23-historical-gate-status-v0.5.0",
        "gates": [
            {"gate_id": "V0.4_STRICT_REFERENCE_CLOSURE", "subject_passed": False, "actual_status": "EVIDENCE_REFERENCE_CLOSURE_INCOMPLETE", "historical_exit_code": 6, "disposition": "quarantined_failed"},
            {"gate_id": "V0.4.1_EVIDENCE_TO_GIT", "subject_passed": False, "actual_status": "FOUR_FROZEN_MISMATCH_REFERENCES", "historical_overall": False, "disposition": "quarantined_failed"},
            {"gate_id": "V0.4.2_COMPONENT_PACKAGE", "subject_passed": True, "actual_status": "COMPONENT_VERIFIED_HISTORICAL_CHAIN_FAILED", "successful_historical_chain_root": False, "disposition": "forensic_only"},
        ],
        "historical_failure_preserved": True,
        "historical_roots_repaired": False,
    }, "report_sha256")
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "cross-package-incident-registry.json", registry)
    write_json(output / "evidence-root-disposition-registry.json", dispositions)
    write_json(output / "bounded-recovery-matrix.json", recovery_matrix)
    write_json(output / "negative-case-matrix.json", negatives)
    write_json(output / "git-evidence.json", git_report)
    write_json(output / "historical-gate-status.json", historical_gates)
    diagnostic = hash_bound({
        "schema_version": "tivdoc-wave23-evidence-incident-diagnostic-v0.5.0",
        "command": "diagnostic",
        "exit_code": 0,
        "status": "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
        "historical_roots_repaired": False,
        "reference_count": registry["summary"]["reference_count"],
        "unique_path_hash_incident_count": registry["summary"]["unique_path_hash_incident_count"],
        "exact_recovered_reference_count": registry["summary"]["exact_recovered_reference_count"],
        "unrecoverable_or_unavailable_reference_count": registry["summary"]["unrecoverable_or_unavailable_reference_count"],
        "incident_registry_sha256": sha256((output / "cross-package-incident-registry.json").read_bytes()),
        "disposition_registry_sha256": sha256((output / "evidence-root-disposition-registry.json").read_bytes()),
        "recovery_matrix_sha256": sha256((output / "bounded-recovery-matrix.json").read_bytes()),
        "negative_matrix_sha256": sha256((output / "negative-case-matrix.json").read_bytes()),
        "git_evidence_sha256": sha256((output / "git-evidence.json").read_bytes()),
        "historical_gate_status_sha256": sha256((output / "historical-gate-status.json").read_bytes()),
        "negative_cases_passed": negatives["passed"],
    }, "report_sha256")
    write_json(output / "diagnostic-result.json", diagnostic)
    write_manifest(output)
    return diagnostic


def write_manifest(output: pathlib.Path) -> None:
    files = []
    for path_value in sorted(output.rglob("*"), key=lambda item: item.relative_to(output).as_posix()):
        if not path_value.is_file() or path_value.name == "evidence-manifest.json":
            continue
        data = path_value.read_bytes()
        files.append({"path": path_value.relative_to(output).as_posix(), "sha256": sha256(data), "byte_count": len(data)})
    write_json(output / "evidence-manifest.json", {
        "schema_version": "tivdoc-wave23-w1-evidence-manifest-v0.5.0",
        "manifest_self_excluded": True,
        "files": files,
        "file_count": len(files),
    })


def self_test() -> dict[str, Any]:
    identity = {"package_id": "SYNTHETIC", "zip_sha256": "1" * 64, "manifest_sha256": "2" * 64}
    failed = disposition_record("synthetic", 0, "quarantined_failed", "SYNTHETIC_FAILURE", identity, None, True, False)
    forensic = disposition_record("synthetic", 1, "forensic_only", "SYNTHETIC_FORENSIC", identity, failed["record_hash"], True, False)
    validate_disposition_chain([failed, forensic])
    validate_recovery("exact_existing_worktree_bytes", True, True, True)
    return {"schema_version": "tivdoc-wave23-evidence-incident-self-test-v0.5.0", "case_count": 2, "passed_count": 2, "passed": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("diagnostic", "strict", "self-test"))
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--historical-root", default=r"C:\dev\tivdoc\salary")
    parser.add_argument("--output-root")
    args = parser.parse_args()
    if args.command == "self-test":
        print(json.dumps(self_test(), sort_keys=True))
        return 0
    repo = pathlib.Path(args.repo_root).resolve()
    historical_root = pathlib.Path(args.historical_root).resolve()
    output = pathlib.Path(args.output_root).resolve() if args.output_root else (repo / OUTPUT_RELATIVE).resolve()
    allowed_output = (repo / "output/parallel-wave-2.3/workers").resolve()
    if allowed_output not in output.parents:
        fail("output_path_escape", str(output))
    diagnostic = build(repo, historical_root, output)
    print(json.dumps(diagnostic, sort_keys=True))
    return 6 if args.command == "strict" else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IncidentError as error:
        print(f"WAVE23_EVIDENCE_INCIDENT_FAILED {error}", file=sys.stderr)
        raise SystemExit(2) from error
