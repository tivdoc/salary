# L8-1 / D2: refuse before imports, argument parsing, or private file access.
import os as _tivdoc_os, sys as _tivdoc_sys
if (_tivdoc_os.environ.get("NODE_ENV", "").strip().lower() == "production"
        or _tivdoc_os.environ.get("VERCEL_ENV", "").strip().lower() in ("production", "preview")):
    _tivdoc_sys.stderr.write("PRODUCTION_ENVIRONMENT_REFUSED\n")
    _tivdoc_sys.exit(2)

"""Import only a selected paid case's dashboard download into a private snapshot.

No network, database mutation, fabricated historical version or customer delivery.
"""
import argparse
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, is_zipfile


RECEIPT_NAME = "download-receipt.private.json"
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + 1024 * 1024
MAX_FILES = 100


def nonempty_string(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def require_private_git_exclusion(repository, target):
    """A home-directory Git repo requires explicit local exclusion, never tracking.

    The application repository remains forbidden even when its ignore rules match.
    No Git index/configuration is changed by this read-only check.
    """
    relative = target.relative_to(repository).as_posix()
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    command = ["git", "--literal-pathspecs", "-C", str(repository)]
    try:
        discovered = subprocess.run(
            [*command, "rev-parse", "--show-toplevel"],
            capture_output=True, timeout=10, check=False, env=environment,
        )
        if (discovered.returncode != 0 or not discovered.stdout.strip()
                or Path(os.fsdecode(discovered.stdout).strip()).resolve() != repository.resolve()):
            raise ValueError("CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY")
        tracked = subprocess.run(
            [*command, "ls-files", "-z", "--", relative],
            capture_output=True, timeout=10, check=False, env=environment,
        )
        ignored = subprocess.run(
            ["git", "-C", str(repository), "check-ignore", "--quiet", "--", relative],
            capture_output=True, timeout=10, check=False, env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("CUSTOMER_ARTIFACT_GIT_PRIVACY_UNVERIFIED") from error
    if tracked.returncode != 0 or tracked.stdout or ignored.returncode != 0:
        raise ValueError("CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY")


def outside_repository(value: str) -> Path:
    # Inspect the lexical path before resolve: otherwise an output/file symlink
    # could hide its location in Git or redirect a later write.
    raw = Path(value).absolute()
    for component in (raw, *raw.parents):
        if component.is_symlink() or (
            hasattr(component, "is_junction") and component.is_junction()
        ):
            raise ValueError("CUSTOMER_ARTIFACT_SYMLINK_FORBIDDEN")
    # Path.absolute retains '..'. Collapse it only after checking the traversed
    # components, so a legitimate ../release-work sibling is not inside salary.
    lexical = Path(os.path.abspath(value))
    repository = Path(__file__).resolve().parents[2]
    checked_git_roots = set()
    for location in dict.fromkeys((lexical, lexical.resolve())):
        if location == repository or repository in location.parents:
            raise ValueError("CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY")
        for component in (location, *location.parents):
            if component.is_symlink() or (
                hasattr(component, "is_junction") and component.is_junction()
            ):
                raise ValueError("CUSTOMER_ARTIFACT_SYMLINK_FORBIDDEN")
            # A .git file also marks a linked Git worktree; check other repos.
            if (component / ".git").exists() and component not in checked_git_roots:
                require_private_git_exclusion(component, location)
                checked_git_roots.add(component)
    return lexical.resolve()


def safe_filename(name: str) -> str:
    if (not nonempty_string(name) or name in (".", "..") or len(name) > 255
            or re.search(r'[\\/<>:"|?*\x00-\x1f\x7f]', name)
            or name.endswith((".", " "))
            or name.casefold() == RECEIPT_NAME.casefold()
            or re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", name, re.I)):
        raise ValueError("UNSAFE_SOURCE_FILENAME")
    return unicodedata.normalize("NFC", name).casefold()


def select_case(snapshot, work_id):
    if not re.fullmatch(r"CASE-[0-9]{2,9}", work_id):
        raise ValueError("INVALID_WORK_ID")
    index = int(work_id[5:])
    if index < 1 or work_id != f"CASE-{index:02d}":
        raise ValueError("INVALID_WORK_ID")
    if (not isinstance(snapshot, dict) or not nonempty_string(snapshot.get("sourceProject"))
            or not isinstance(snapshot.get("cases"), list)):
        raise ValueError("INVALID_SOURCE_SNAPSHOT")
    cases = snapshot["cases"]
    if index > len(cases):
        raise ValueError("WORK_ID_OUT_OF_BOUNDS")
    case = cases[index - 1]
    if (not isinstance(case, dict) or not nonempty_string(case.get("id"))
            or not isinstance(case.get("is_qa"), bool)
            or sum(isinstance(row, dict) and row.get("id") == case["id"] for row in cases) != 1):
        raise ValueError("INVALID_SOURCE_CASE_BINDING")
    payments = case.get("payments")
    if (not isinstance(payments, list) or not any(
        isinstance(payment, dict) and payment.get("status") == "verified"
        and payment.get("case_id", case["id"]) == case["id"] for payment in payments
    )):
        raise ValueError("PAID_CASE_SCOPE_REQUIRED")
    return case


def expected_documents(case):
    documents = case.get("documents")
    if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_FILES:
        raise ValueError("AMBIGUOUS_SOURCE_FILENAMES")
    expected, folded_names, identifiers, paths = {}, set(), set(), set()
    total = 0
    for document in documents:
        if (not isinstance(document, dict) or document.get("case_id") != case["id"]
                or not nonempty_string(document.get("id"))):
            raise ValueError("SOURCE_DOCUMENT_CASE_MISMATCH")
        path = document.get("storage_path")
        if (not nonempty_string(path) or path.startswith("/") or "\\" in path
                or any(part in ("", ".", "..") for part in path.split("/"))):
            raise ValueError("UNSAFE_SOURCE_FILENAME")
        name = path.rsplit("/", 1)[-1]
        folded = safe_filename(name)
        if (folded in folded_names or document["id"] in identifiers or path in paths):
            raise ValueError("AMBIGUOUS_SOURCE_FILENAMES")
        size = document.get("size")
        if type(size) is not int or not 0 < size <= MAX_FILE_BYTES:
            raise ValueError("DOWNLOAD_SIZE_MISMATCH")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise ValueError("DOWNLOAD_TOTAL_SIZE_LIMIT")
        expected[name] = document
        folded_names.add(folded)
        identifiers.add(document["id"])
        paths.add(path)
    return expected


def read_archive(archive_file, expected):
    if not archive_file.is_file() or archive_file.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("DOWNLOAD_ARCHIVE_SIZE_LIMIT")
    # Hash and unzip the same bounded bytes, not two independently opened versions.
    with archive_file.open("rb") as stream:
        raw = stream.read(MAX_ARCHIVE_BYTES + 1)
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise ValueError("DOWNLOAD_ARCHIVE_SIZE_LIMIT")
    digest = hashlib.sha256(raw).hexdigest()
    if not is_zipfile(io.BytesIO(raw)):
        if len(expected) != 1 or archive_file.name not in expected:
            raise ValueError("DOWNLOAD_CASE_FILE_SET_MISMATCH")
        document = expected[archive_file.name]
        if len(raw) != document["size"]:
            raise ValueError("DOWNLOAD_SIZE_MISMATCH")
        extension = archive_file.suffix.casefold()
        signature_matches = {
            (".pdf", "application/pdf"): raw.startswith(b"%PDF-"),
            (".png", "image/png"): raw.startswith(b"\x89PNG\r\n\x1a\n"),
            (".jpg", "image/jpeg"): raw.startswith(b"\xff\xd8\xff"),
            (".jpeg", "image/jpeg"): raw.startswith(b"\xff\xd8\xff"),
            (".webp", "image/webp"): raw.startswith(b"RIFF") and raw[8:12] == b"WEBP",
        }
        if not signature_matches.get((extension, document.get("mime_type")), False):
            raise ValueError("DOWNLOAD_SIGNATURE_MISMATCH")
        return ([(archive_file.name, raw, document)], digest,
                "authenticated_owner_storage_dashboard_single_file")
    prepared = []
    with ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if len(entries) != len(expected) or {entry.filename for entry in entries} != set(expected):
            raise ValueError("DOWNLOAD_CASE_FILE_SET_MISMATCH")
        for entry in entries:
            safe_filename(entry.filename)
            file_type = stat.S_IFMT(entry.external_attr >> 16)
            if (entry.is_dir() or entry.orig_filename != entry.filename
                    or file_type not in (0, stat.S_IFREG) or entry.flag_bits & 1
                    or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED)):
                raise ValueError("UNSAFE_DOWNLOAD_ENTRY")
            document = expected[entry.filename]
            if entry.file_size != document["size"]:
                raise ValueError("DOWNLOAD_SIZE_MISMATCH")
            with archive.open(entry) as stream:
                data = stream.read(document["size"] + 1)
            if len(data) != document["size"]:
                raise ValueError("DOWNLOAD_SIZE_MISMATCH")
            prepared.append((entry.filename, data, document))
    return prepared, digest, "authenticated_owner_storage_dashboard_zip"


def preflight_output(output, prepared, receipt):
    if output.exists() and not output.is_dir():
        raise ValueError("PRIVATE_OUTPUT_MUST_BE_DIRECTORY")
    if output.exists():
        expected_names = {name for name, _, _ in prepared} | {RECEIPT_NAME}
        if any(entry.name not in expected_names for entry in output.iterdir()):
            raise ValueError("PRIVATE_OUTPUT_UNEXPECTED_FILE")
    receipt_path = outside_repository(str(output / RECEIPT_NAME))
    if receipt_path.exists():
        try:
            old = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
            timestamp = datetime.fromisoformat(old["observed_at"])
            if timestamp.tzinfo is None:
                raise ValueError("timezone required")
            # Preserve the original observation time and exact v1 receipt bytes.
            comparable = {**old, "observed_at": receipt["observed_at"]}
            if json.dumps(comparable, sort_keys=True) != json.dumps(receipt, sort_keys=True):
                raise ValueError("binding mismatch")
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ValueError("PRIVATE_RECEIPT_BINDING_MISMATCH") from error
    for name, data, _ in prepared:
        target = outside_repository(str(output / name))
        if target.exists():
            if not target.is_file() or target.stat().st_size != len(data) or target.read_bytes() != data:
                raise ValueError("PRIVATE_SNAPSHOT_IMMUTABLE")
        elif receipt_path.exists():
            raise ValueError("PRIVATE_RECEIPT_FILE_MISSING")
    return receipt_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    snapshot_file = outside_repository(args.snapshot)
    archive_file = outside_repository(args.archive)
    output = outside_repository(args.output)
    snapshot = json.loads(snapshot_file.read_text(encoding="utf-8-sig"))
    case = select_case(snapshot, args.work_id)
    prepared, archive_sha256, download_method = read_archive(archive_file, expected_documents(case))
    records = []
    for name, data, document in prepared:
        records.append({"source_document": document, "private_filename": name,
                        "observed_sha256": hashlib.sha256(data).hexdigest(),
                        "observed_size": len(data), "historical_version_id": None})
    receipt = {"schema_version": "private-source-download-v1", "work_id": args.work_id,
               "source_case_id": case["id"], "source_project": snapshot["sourceProject"],
               "source_is_qa": case["is_qa"], "observed_at": datetime.now(timezone.utc).isoformat(),
               "download_method": download_method,
               "archive_sha256": archive_sha256,
               "snapshot_semantics": "Observed bytes, not a claim of immutable historical source version",
               "source_mutations": 0, "documents": records}
    # All known source/receipt/file mismatches fail before mkdir or any byte write.
    receipt_path = preflight_output(output, prepared, receipt)
    output.mkdir(parents=True, exist_ok=True)
    outside_repository(str(output))
    preflight_output(output, prepared, receipt)
    for name, data, _ in prepared:
        target = output / name
        if not target.exists():
            with target.open("xb") as stream:
                stream.write(data)
    if not receipt_path.exists():
        with receipt_path.open("x", encoding="utf-8") as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps({"work_id": args.work_id, "files_imported": len(records), "source_mutations": 0}))


if __name__ == "__main__":
    main()
