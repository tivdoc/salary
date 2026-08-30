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
import zipfile
from collections import defaultdict
from typing import Any, Iterable


V04_ZIP = pathlib.Path(r"C:\dev\tivdoc\salary\output\parallel-wave-2\review-package-v0.4.zip")
V041_ZIP = pathlib.Path(r"C:\dev\tivdoc\salary\output\parallel-wave-2.1\review-package-v0.4.1.zip")
V04_ZIP_SHA256 = "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c"
V04_MANIFEST_SHA256 = "9fa62f6848c5bef1e4bfae1654b5e0673bf61589c6ca985d1578a44d95c7c5bf"
V041_ZIP_SHA256 = "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2"
V041_MANIFEST_SHA256 = "f4a4ea363abdaf15a2a3cdbba925937360a08d14d704bc3fe6060b2264fcf16b"
V04_HEAD = "5ce3eba6ab816cd6a20e101c913f7f1177c7598a"
WAVE22_CONTRACT_SHA = "acdf75383125fb67187de58dd331577eefb106bb"
WAVE22_REQUIRED_BASE = "48be587d5a394e37656e20a1276b4cebb85c60bb"
ALLOWLIST = (
    "src/engine/wave22/evidence-forensics/**",
    "scripts/wave22-evidence-forensics/**",
    "docs/wave22-evidence-forensics-v0.4.2.md",
)
ROOT_CAUSE_CLASSES = {
    "historical_worktree_bytes_recovered",
    "pre_commit_generated_evidence_bug",
    "post_worker_orchestrator_mutation",
    "line_ending_or_filter_transform",
    "stale_inventory_reference",
    "unexplained_possible_integrity_failure",
}
CASE_ID = re.compile(r"^FORENSIC_REF_[0-9]{3}$")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA64 = re.compile(r"^[0-9a-f]{64}$")


class ForensicError(ValueError):
    pass


def fail(code: str, detail: str = "") -> None:
    raise ForensicError(f"{code}:{detail}" if detail else code)


def sha256(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def stable(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: stable(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [stable(item) for item in value]
    return value


def stable_bytes(value: Any) -> bytes:
    return (json.dumps(stable(value), ensure_ascii=False, indent=2) + "\n").encode()


def write_json(path_value: pathlib.Path, value: Any) -> None:
    path_value.parent.mkdir(parents=True, exist_ok=True)
    path_value.write_bytes(stable_bytes(value))


def run(repo: pathlib.Path, args: Iterable[str], input_bytes: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(["git", *args], cwd=repo, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if check and result.returncode != 0:
        fail("git_command_failed", f"{' '.join(args)}:{result.stderr.decode(errors='replace').strip()}")
    return result


def git_text(repo: pathlib.Path, args: Iterable[str], input_bytes: bytes | None = None) -> str:
    return run(repo, args, input_bytes).stdout.decode(errors="strict").strip()


def verify_zip(path_value: pathlib.Path, zip_hash: str, manifest_hash: str, members: int, entries: int) -> dict[str, Any]:
    data = path_value.read_bytes()
    if sha256(data) != zip_hash:
        fail("historical_package_hash_mismatch", str(path_value))
    with zipfile.ZipFile(path_value) as archive:
        infos = archive.infolist()
        names = [item.filename for item in infos]
        if len(names) != len(set(names)) or len(names) != members:
            fail("historical_package_member_count_or_duplicate", str(path_value))
        manifest_data = archive.read("package-manifest.json")
        if sha256(manifest_data) != manifest_hash:
            fail("historical_package_manifest_hash_mismatch", str(path_value))
        manifest = json.loads(manifest_data)
        files = manifest.get("files")
        if manifest.get("manifest_self_excluded_to_avoid_recursive_hash") is not True or not isinstance(files, list) or len(files) != entries:
            fail("historical_package_manifest_shape_mismatch", str(path_value))
        expected = {item["path"]: item for item in files}
        if set(expected) != set(names) - {"package-manifest.json"}:
            fail("historical_package_manifest_membership_mismatch", str(path_value))
        for name, item in expected.items():
            member = archive.read(name)
            if len(member) != item["byte_count"] or sha256(member) != item["sha256"]:
                fail("historical_package_member_hash_mismatch", name)
    return {"path": str(path_value), "zip_sha256": zip_hash, "manifest_sha256": manifest_hash, "member_count": members, "manifest_entry_count": entries, "unchanged_and_structurally_verified": True}


def pointer(document: Any, value: str) -> Any:
    current = document
    for raw in value.split("/")[1:]:
        token = raw.replace("~1", "/").replace("~0", "~")
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current


def zip_json(path_value: pathlib.Path, member: str) -> Any:
    with zipfile.ZipFile(path_value) as archive:
        return json.loads(archive.read(member))


def blob(repo: pathlib.Path, revision: str, relative: str) -> tuple[str, str, bytes, str]:
    blob_id = git_text(repo, ["rev-parse", f"{revision}:{relative}"])
    data = run(repo, ["cat-file", "blob", blob_id]).stdout
    tree_line = git_text(repo, ["ls-tree", revision, "--", relative])
    mode = tree_line.split()[0]
    return blob_id, sha256(data), data, mode


def newline_candidates(data: bytes) -> tuple[bytes, bytes]:
    lf = data.replace(b"\r\n", b"\n")
    return lf, lf.replace(b"\n", b"\r\n")


def parse_worktrees(repo: pathlib.Path) -> list[dict[str, str | None]]:
    blocks = git_text(repo, ["worktree", "list", "--porcelain"]).split("\n\n")
    output = []
    for block in blocks:
        values: dict[str, str | None] = {"worktree": None, "HEAD": None, "branch": None}
        for line in block.splitlines():
            if " " in line:
                key, value = line.split(" ", 1)
                if key in values:
                    values[key] = value
        if values["worktree"]:
            output.append(values)
    return sorted(output, key=lambda item: str(item["worktree"]).lower())


def worktree_candidates(repo: pathlib.Path, relative: str, claimed_sha: str, claimed_bytes: int, canonical_blob_id: str) -> list[dict[str, Any]]:
    output = []
    for item in parse_worktrees(repo):
        root = pathlib.Path(str(item["worktree"]))
        candidate = root / pathlib.Path(*relative.split("/"))
        if not candidate.is_file():
            continue
        data = candidate.read_bytes()
        normalized_id = git_text(root, ["hash-object", f"--path={relative}", "--stdin"], data)
        path_status = run(root, ["status", "--porcelain=v1", "--", relative], check=False).stdout.decode(errors="replace").strip()
        output.append({
            "worktree": str(root),
            "head": item["HEAD"],
            "branch": item["branch"],
            "path_status": path_status,
            "byte_count": len(data),
            "sha256": sha256(data),
            "filesystem_type": "regular_file" if stat.S_ISREG(candidate.stat().st_mode) else "other",
            "filesystem_mode": oct(candidate.stat().st_mode & 0o777),
            "git_clean_filter_blob_id": normalized_id,
            "normalizes_to_v0_4_canonical_blob": normalized_id == canonical_blob_id,
            "exact_claim_match": len(data) == claimed_bytes and sha256(data) == claimed_sha,
            "valid_recovery_candidate": len(data) == claimed_bytes and sha256(data) == claimed_sha and normalized_id == canonical_blob_id,
        })
    return output


def historical_blob_groups(repo: pathlib.Path, paths: list[str]) -> dict[str, list[dict[str, Any]]]:
    commits = git_text(repo, ["rev-list", "--all", "--reverse"]).splitlines()
    groups: dict[str, dict[str, list[str]]] = {path_value: defaultdict(list) for path_value in paths}
    for commit in commits:
        result = run(repo, ["ls-tree", commit, "--", *paths]).stdout.decode()
        for line in result.splitlines():
            metadata, relative = line.split("\t", 1)
            _, object_type, blob_id = metadata.split()
            if object_type == "blob":
                groups[relative][blob_id].append(commit)
    output: dict[str, list[dict[str, Any]]] = {}
    for relative in paths:
        records = []
        for blob_id, blob_commits in groups[relative].items():
            data = run(repo, ["cat-file", "blob", blob_id]).stdout
            records.append({
                "blob_id": blob_id,
                "sha256": sha256(data),
                "byte_count": len(data),
                "first_commit_observed": blob_commits[0],
                "commit_count": len(blob_commits),
                "commits": blob_commits,
            })
        output[relative] = sorted(records, key=lambda item: (item["first_commit_observed"], item["blob_id"]))
    return output


def attributes_and_config(repo: pathlib.Path, relative: str) -> dict[str, Any]:
    attrs = {}
    raw = run(repo, ["check-attr", "-a", "--", relative]).stdout.decode(errors="replace")
    for line in raw.splitlines():
        parts = line.split(": ", 2)
        if len(parts) == 3:
            attrs[parts[1]] = parts[2]
    config_result = run(repo, ["config", "--show-origin", "--get-regexp", r"^(core\.(autocrlf|eol|attributesfile)|filter\..*|encoding\..*)$"], check=False)
    config = config_result.stdout.decode(errors="replace").splitlines()
    return {
        "git_attributes": attrs,
        "working_tree_encoding": attrs.get("working-tree-encoding", "unspecified"),
        "eol": attrs.get("eol", "unspecified"),
        "filter": attrs.get("filter", "unspecified"),
        "relevant_git_config_with_origin": config,
        "core_autocrlf": git_text(repo, ["config", "--get", "core.autocrlf"]) if run(repo, ["config", "--get", "core.autocrlf"], check=False).returncode == 0 else "unset",
    }


def patch_id(repo: pathlib.Path, commit: str) -> str:
    patch = run(repo, ["show", "--pretty=format:", "--no-ext-diff", "--binary", commit]).stdout
    result = run(repo, ["patch-id", "--stable"], patch + b"\n").stdout.decode().split()
    return result[0] if result else "0" * 40


def commit_record(repo: pathlib.Path, commit: str) -> dict[str, Any]:
    fields = git_text(repo, ["show", "-s", "--format=%H%n%P%n%T%n%s", commit]).splitlines()
    changed = []
    raw = git_text(repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames=100%", commit])
    for line in raw.splitlines():
        status_value, *names = line.split("\t")
        changed.append({"status": status_value, "paths": names})
    stats = []
    raw_stats = git_text(repo, ["show", "--numstat", "--format=", "--no-renames", commit])
    for line in raw_stats.splitlines():
        added, deleted, relative = line.split("\t")
        stats.append({"path": relative, "added": None if added == "-" else int(added), "deleted": None if deleted == "-" else int(deleted)})
    return {
        "sha": fields[0],
        "parents": fields[1].split() if fields[1] else [],
        "tree": fields[2],
        "subject": fields[3],
        "patch_id": patch_id(repo, commit),
        "changed_files": changed,
        "diff_stat": {
            "files": stats,
            "file_count": len(stats),
            "added_lines": sum(item["added"] or 0 for item in stats),
            "deleted_lines": sum(item["deleted"] or 0 for item in stats),
        },
    }


def allowlisted(relative: str) -> bool:
    return any(relative.startswith(item[:-3]) if item.endswith("/**") else relative == item for item in ALLOWLIST)


def complete_git_evidence(repo: pathlib.Path, v04: pathlib.Path, v041: pathlib.Path) -> dict[str, Any]:
    head = git_text(repo, ["rev-parse", "HEAD"])
    branch = git_text(repo, ["branch", "--show-current"])
    merge_base = git_text(repo, ["merge-base", WAVE22_CONTRACT_SHA, head])
    count = int(git_text(repo, ["rev-list", "--count", f"{WAVE22_CONTRACT_SHA}..{head}"]))
    status_value = git_text(repo, ["status", "--porcelain=v1"])
    paths = sorted(filter(None, git_text(repo, ["diff", "--name-only", f"{WAVE22_CONTRACT_SHA}..{head}"]).splitlines()))
    checks = []
    for relative in paths:
        data = (repo / pathlib.Path(*relative.split("/"))).read_bytes()
        checks.append({"path": relative, "allowlisted": allowlisted(relative), "sha256": sha256(data), "byte_count": len(data)})
    with zipfile.ZipFile(v04) as archive:
        wave2_audit_bytes = archive.read("git/wave2-git-audit.json")
        wave2_audit = json.loads(wave2_audit_bytes)
    with zipfile.ZipFile(v041) as archive:
        wave21_proof_bytes = archive.read("git/wave21-git-proof.json")
        wave21_proof = json.loads(wave21_proof_bytes)
    current = {
        "branch": branch,
        "worktree": str(repo),
        "expected_base": WAVE22_CONTRACT_SHA,
        "merge_base": merge_base,
        "commit_count_over_base": count,
        "clean_handoff": status_value == "",
        "porcelain": status_value,
        "allowlist": list(ALLOWLIST),
        "allowlist_sha256": sha256(stable_bytes(list(ALLOWLIST))),
        "changed_paths": checks,
        "all_paths_allowlisted": all(item["allowlisted"] for item in checks),
        "worker_commit": commit_record(repo, head),
    }
    return {
        "schema_version": "tivdoc-wave22-w1-complete-git-evidence-v0.4.2",
        "required_base": WAVE22_REQUIRED_BASE,
        "contract_commit": commit_record(repo, WAVE22_CONTRACT_SHA),
        "current_worker": current,
        "historical_v0_4_git_audit_sha256": sha256(wave2_audit_bytes),
        "historical_v0_4_git_audit": wave2_audit,
        "historical_v0_4_1_git_proof_sha256": sha256(wave21_proof_bytes),
        "historical_v0_4_1_git_proof": wave21_proof,
        "handoff_ready": branch == "codex/wave22-w1-evidence-forensics" and merge_base == WAVE22_CONTRACT_SHA and count == 1 and status_value == "" and all(item["allowlisted"] for item in checks),
    }


def report_hash(value: dict[str, Any], field: str) -> dict[str, Any]:
    without = {key: item for key, item in value.items() if key != field}
    return {**without, field: sha256(stable_bytes(without))}


def build_diagnostic(repo: pathlib.Path, output: pathlib.Path, declaration_path: pathlib.Path, v04: pathlib.Path, v041: pathlib.Path) -> dict[str, Any]:
    v04_binding = verify_zip(v04, V04_ZIP_SHA256, V04_MANIFEST_SHA256, 115, 114)
    v041_binding = verify_zip(v041, V041_ZIP_SHA256, V041_MANIFEST_SHA256, 82, 81)
    declaration_bytes = declaration_path.read_bytes()
    declaration = json.loads(declaration_bytes)
    refs = declaration.get("references")
    if not isinstance(refs, list) or len(refs) != 11:
        fail("erratum_reference_count_mismatch")
    if len({item["case_id"] for item in refs}) != 11 or any(not CASE_ID.fullmatch(item["case_id"]) for item in refs):
        fail("erratum_case_ids_invalid")
    if any(not set(item["root_cause_classes"]).issubset(ROOT_CAUSE_CLASSES) for item in refs):
        fail("erratum_root_cause_class_invalid")
    paths = sorted({item["repository_path"] for item in refs})
    history = historical_blob_groups(repo, paths)
    output.mkdir(parents=True, exist_ok=True)
    recovered_root = output / "recovered-bytes"
    if recovered_root.exists():
        shutil.rmtree(recovered_root)

    package_documents: dict[str, Any] = {}
    forensic_records = []
    compact_erratum = []
    for declared in refs:
        member = declared["evidence_member"]
        document = package_documents.setdefault(member, zip_json(v04, member))
        observed_path = pointer(document, declared["json_pointers"]["path"])
        observed_sha = pointer(document, declared["json_pointers"]["sha256"])
        observed_count = pointer(document, declared["json_pointers"]["byte_count"])
        if observed_path != declared["repository_path"] or observed_sha != declared["claimed_sha256"] or observed_count != declared["claimed_byte_count"]:
            fail("erratum_pointer_binding_mismatch", declared["case_id"])
        relative = declared["repository_path"]
        canonical_id, canonical_sha, canonical_data, canonical_mode = blob(repo, V04_HEAD, relative)
        current_id, current_sha, current_data, current_mode = blob(repo, "HEAD", relative)
        if canonical_sha != declared["v0_4_canonical_git_blob_sha256"] or len(canonical_data) != declared["v0_4_canonical_git_blob_byte_count"]:
            fail("erratum_canonical_binding_mismatch", declared["case_id"])
        attrs = attributes_and_config(repo, relative)
        lf, crlf = newline_candidates(canonical_data)
        filtered = run(repo, ["cat-file", "--filters", f"--path={relative}", f"{V04_HEAD}:{relative}"]).stdout
        candidate_records = [
            {"candidate_id": "v0_4_git_blob", "sha256": canonical_sha, "byte_count": len(canonical_data), "justification": "canonical Git object", "predeclared": True},
            {"candidate_id": "lf_normalized", "sha256": sha256(lf), "byte_count": len(lf), "justification": "comparison only; not accepted without matching declared eol configuration", "predeclared": True},
            {"candidate_id": "crlf_checkout", "sha256": sha256(crlf), "byte_count": len(crlf), "justification": f"core.autocrlf={attrs['core_autocrlf']}", "predeclared": True},
            {"candidate_id": "git_cat_file_filters", "sha256": sha256(filtered), "byte_count": len(filtered), "justification": "Git-configured filter output for V0.4 path", "predeclared": True},
            {"candidate_id": "working_tree_encoding", "sha256": None, "byte_count": None, "justification": f"working-tree-encoding={attrs['working_tree_encoding']}; no transform manufactured", "predeclared": True},
        ]
        for candidate in candidate_records:
            candidate["matches_claim"] = candidate["sha256"] == observed_sha and candidate["byte_count"] == observed_count
        worktrees = worktree_candidates(repo, relative, observed_sha, observed_count, canonical_id)
        valid_recoveries = [item for item in worktrees if item["valid_recovery_candidate"]]
        recovery = None
        if valid_recoveries:
            source = sorted(valid_recoveries, key=lambda item: item["worktree"].lower())[0]
            source_bytes = (pathlib.Path(source["worktree"]) / pathlib.Path(*relative.split("/"))).read_bytes()
            recovery_path = recovered_root / declared["case_id"] / pathlib.Path(*relative.split("/")).with_suffix(pathlib.Path(relative).suffix + ".recovered.bin")
            recovery_path.parent.mkdir(parents=True, exist_ok=True)
            recovery_path.write_bytes(source_bytes)
            recovery = {
                "evidence_path": recovery_path.relative_to(output).as_posix(),
                "sha256": sha256(source_bytes),
                "byte_count": len(source_bytes),
                "source_worktree": source["worktree"],
                "source_worktree_head": source["head"],
                "source_worktree_branch": source["branch"],
                "source_path_status": source["path_status"],
                "git_clean_filter_blob_id": source["git_clean_filter_blob_id"],
                "normalizes_to_v0_4_canonical_blob": True,
            }
        resolved = recovery is not None or any(item["matches_claim"] and item["candidate_id"] in {"v0_4_git_blob", "git_cat_file_filters"} for item in candidate_records)
        resolution_status = "recovered_exact_historical_worktree_bytes" if recovery else "resolved_by_predeclared_repository_transform" if resolved else "unresolved_exact_bytes_unavailable"
        authority = "authoritative_via_recovered_bytes_and_erratum" if recovery else "authoritative_via_canonical_repository_bytes" if resolved else "non_authoritative_unresolved"
        if resolution_status != declared["expected_resolution_status"] or resolved != declared["strict_resolved"] or authority != declared["claim_authority"]:
            fail("erratum_expected_resolution_drift", declared["case_id"])
        canonical_groups = [item for item in history[relative] if item["blob_id"] == canonical_id]
        forensic = {
            **declared,
            "observed_pointer_values": {"path": observed_path, "sha256": observed_sha, "byte_count": observed_count},
            "v0_4_canonical_git": {"commit": V04_HEAD, "blob_id": canonical_id, "sha256": canonical_sha, "byte_count": len(canonical_data), "file_mode": canonical_mode},
            "current_git": {"commit": git_text(repo, ["rev-parse", "HEAD"]), "blob_id": current_id, "sha256": current_sha, "byte_count": len(current_data), "file_mode": current_mode},
            "historical_git_blob_groups": history[relative],
            "historical_commit_count_containing_path": sum(item["commit_count"] for item in history[relative]),
            "candidate_bytes": candidate_records,
            "worktree_candidates": worktrees,
            "git_attributes_and_config": attrs,
            "first_point": {
                "claimed_hash_first_observed_in": f"review-package-v0.4.zip!/{member}#{declared['json_pointers']['sha256']}",
                "canonical_blob_first_commit_observed": canonical_groups[0]["first_commit_observed"] if canonical_groups else None,
                "exact_recovery_locations": [item["worktree"] for item in valid_recoveries],
                "claim_present_in_any_git_blob": any(item["sha256"] == observed_sha and item["byte_count"] == observed_count for item in history[relative]),
            },
            "recovery": recovery,
            "resolution_status": resolution_status,
            "claim_authority": authority,
            "strict_resolved": resolved,
        }
        forensic_records.append(forensic)
        compact_erratum.append({
            "case_id": declared["case_id"],
            "original_reference": {"evidence_member": member, "json_pointers": declared["json_pointers"], "repository_path": relative, "claimed_sha256": observed_sha, "claimed_byte_count": observed_count},
            "canonical_v0_4_bytes": forensic["v0_4_canonical_git"],
            "recovered_bytes": recovery,
            "root_cause_classes": declared["root_cause_classes"],
            "explanation": "The V0.4 inventory generator hashed checked-out worktree bytes with readFile(path) rather than immutable Git blob bytes. Exact bytes are authoritative only where a preserved registered worktree still provides the claimed hash and clean-filters to the V0.4 blob; otherwise the original claim remains non-authoritative and unresolved.",
            "resolution_status": resolution_status,
            "claim_authority": authority,
            "strict_resolved": resolved,
        })

    resolved_count = sum(item["strict_resolved"] for item in forensic_records)
    unresolved_count = len(forensic_records) - resolved_count
    overall = unresolved_count == 0
    generator_blob_id, generator_sha, generator_bytes, _ = blob(repo, V04_HEAD, "scripts/parallel-wave2-review-package.mts")
    generator_text = generator_bytes.decode()
    relevant_lines = [
        {"line": index, "text": text.strip()}
        for index, text in enumerate(generator_text.splitlines(), start=1)
        if "readFile(target)" in text or "target_sha256" in text or "target_byte_count" in text
    ]
    package_bindings = {"v0_4": v04_binding, "v0_4_1": v041_binding}
    forensic_report = report_hash({
        "schema_version": "tivdoc-historical-byte-forensics-v0.4.2",
        "package_bindings": package_bindings,
        "repository_context": {
            "repo_root": str(repo),
            "observed_head": git_text(repo, ["rev-parse", "HEAD"]),
            "v0_4_head": V04_HEAD,
            "erratum_declaration_path": declaration_path.relative_to(repo).as_posix(),
            "erratum_declaration_sha256": sha256(declaration_bytes),
            "inventory_generator": {"path": "scripts/parallel-wave2-review-package.mts", "blob_id": generator_blob_id, "sha256": generator_sha, "relevant_lines": relevant_lines},
        },
        "references": forensic_records,
        "summary": {"reference_count": 11, "unique_path_count": len(paths), "strict_resolved_count": resolved_count, "unresolved_count": unresolved_count, "recovered_reference_count": sum(item["recovery"] is not None for item in forensic_records)},
        "overall": overall,
    }, "report_sha256")
    write_json(output / "historical-byte-forensics.json", forensic_report)

    erratum = report_hash({
        "schema_version": "tivdoc-v0.4-immutable-erratum-crosswalk-v0.4.2",
        "append_only": True,
        "historical_package_mutated": False,
        "original_package": v04_binding,
        "declaration": {"path": declaration_path.relative_to(repo).as_posix(), "sha256": sha256(declaration_bytes)},
        "policy": declaration["policy"],
        "references": compact_erratum,
        "summary": forensic_report["summary"],
        "overall": overall,
    }, "erratum_sha256")
    write_json(output / "v0.4-immutable-erratum.json", erratum)

    git_evidence = report_hash(complete_git_evidence(repo, v04, v041), "report_sha256")
    write_json(output / "complete-git-evidence.json", git_evidence)
    diagnostic = report_hash({
        "schema_version": "tivdoc-wave22-evidence-diagnostic-v0.4.2",
        "command": "diagnostic",
        "exit_code": 0,
        "status": "EVIDENCE_REFERENCE_CLOSURE_COMPLETE" if overall else "EVIDENCE_REFERENCE_CLOSURE_INCOMPLETE",
        "overall": overall,
        "reference_count": 11,
        "resolved_count": resolved_count,
        "unresolved_count": unresolved_count,
        "forensics_sha256": sha256((output / "historical-byte-forensics.json").read_bytes()),
        "erratum_sha256": sha256((output / "v0.4-immutable-erratum.json").read_bytes()),
        "git_evidence_sha256": sha256((output / "complete-git-evidence.json").read_bytes()),
        "historical_packages_unchanged": True,
    }, "report_sha256")
    write_json(output / "diagnostic-result.json", diagnostic)
    strict = strict_result(diagnostic)
    write_json(output / "strict-result.json", strict)
    write_manifest(output)
    return diagnostic


def strict_result(diagnostic: dict[str, Any]) -> dict[str, Any]:
    overall = diagnostic.get("overall") is True
    return report_hash({
        "schema_version": "tivdoc-wave22-evidence-strict-gate-v0.4.2",
        "command": "strict",
        "diagnostic_overall": overall,
        "status": "EVIDENCE_REFERENCE_CLOSURE_COMPLETE" if overall else "EVIDENCE_REFERENCE_CLOSURE_INCOMPLETE",
        "exit_code": 0 if overall else 6,
        "passed": overall,
        "false_overall_forces_nonzero": not overall,
        "diagnostic_report_sha256": diagnostic.get("report_sha256"),
    }, "report_sha256")


def write_manifest(output: pathlib.Path) -> None:
    files = []
    for item in sorted(output.rglob("*"), key=lambda value: value.relative_to(output).as_posix()):
        if not item.is_file() or item.name == "evidence-manifest.json":
            continue
        data = item.read_bytes()
        files.append({"path": item.relative_to(output).as_posix(), "byte_count": len(data), "sha256": sha256(data)})
    manifest = {
        "schema_version": "tivdoc-wave22-w1-evidence-manifest-v0.4.2",
        "manifest_self_excluded": True,
        "files": files,
        "file_count": len(files),
    }
    write_json(output / "evidence-manifest.json", manifest)


def self_test() -> dict[str, Any]:
    false_diagnostic = {"overall": False, "report_sha256": "1" * 64}
    true_diagnostic = {"overall": True, "report_sha256": "2" * 64}
    false_result = strict_result(false_diagnostic)
    true_result = strict_result(true_diagnostic)
    if false_result["exit_code"] != 6 or false_result["passed"] or true_result["exit_code"] != 0 or not true_result["passed"]:
        fail("strict_false_overall_regression")
    return {"schema_version": "tivdoc-wave22-evidence-strict-regression-v0.4.2", "cases": [{"case_id": "STRICT_FALSE_OVERALL", "expected_exit_code": 6, "observed_exit_code": false_result["exit_code"], "passed": True}, {"case_id": "STRICT_TRUE_OVERALL", "expected_exit_code": 0, "observed_exit_code": true_result["exit_code"], "passed": True}], "passed": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("diagnostic", "strict", "self-test"))
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output-root", default="output/parallel-wave-2.2/workers/w1-evidence-forensics")
    parser.add_argument("--v0-4-zip", default=str(V04_ZIP))
    parser.add_argument("--v0-4-1-zip", default=str(V041_ZIP))
    parser.add_argument("--report")
    args = parser.parse_args()
    if args.command == "self-test":
        print(json.dumps(self_test(), sort_keys=True))
        return 0
    repo = pathlib.Path(args.repo_root).resolve()
    output = pathlib.Path(args.output_root)
    if not output.is_absolute():
        output = (repo / output).resolve()
    allowed = (repo / "output" / "parallel-wave-2.2" / "workers").resolve()
    if allowed not in output.parents:
        fail("output_path_escape", str(output))
    declaration = repo / "src" / "engine" / "wave22" / "evidence-forensics" / "v0.4-erratum.v0.4.2.json"
    if args.command == "diagnostic":
        diagnostic = build_diagnostic(repo, output, declaration, pathlib.Path(args.v0_4_zip).resolve(), pathlib.Path(args.v0_4_1_zip).resolve())
        print(json.dumps(diagnostic, sort_keys=True))
        return 0
    report_path = pathlib.Path(args.report).resolve() if args.report else output / "diagnostic-result.json"
    diagnostic = json.loads(report_path.read_bytes())
    strict = strict_result(diagnostic)
    write_json(output / "strict-result.json", strict)
    write_manifest(output)
    print(json.dumps(strict, sort_keys=True))
    return int(strict["exit_code"])


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ForensicError as error:
        print(f"WAVE22_EVIDENCE_FORENSICS_FAILED {error}", file=sys.stderr)
        raise SystemExit(2) from error
