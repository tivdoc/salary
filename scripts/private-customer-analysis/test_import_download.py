"""Synthetic, offline safety regressions for the private source importer."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo


sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "private_import_download", Path(__file__).with_name("import-download.py")
)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class ImportDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tivdoc-private-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.snapshot = self.root / "snapshot.json"
        self.archive = self.root / "download.zip"
        self.output = self.root / "source"
        self.data = {"a.pdf": b"synthetic first source", "b.pdf": b"synthetic second source"}
        self.case = {
            "id": "synthetic-case-one", "is_qa": False,
            "payments": [{"status": "verified"}],
            "documents": [
                {"id": f"synthetic-document-{name}", "case_id": "synthetic-case-one",
                 "storage_path": f"synthetic-case-one/{name}", "filename": name,
                 "mime_type": "application/pdf", "size": len(data)}
                for name, data in self.data.items()
            ],
        }
        self.source = {"sourceProject": "synthetic-private-project", "cases": [self.case]}
        self.write_snapshot()
        self.write_archive()

    def write_snapshot(self):
        self.snapshot.write_text(json.dumps(self.source), encoding="utf-8")

    def write_archive(self, entries=None):
        with ZipFile(self.archive, "w") as archive:
            for name, data in (entries if entries is not None else self.data.items()):
                archive.writestr(name, data)

    def run_import(self, work_id="CASE-01", output=None):
        with patch.object(sys, "argv", [
            "import-download.py", "--snapshot", str(self.snapshot), "--work-id", work_id,
            "--archive", str(self.archive), "--output", str(output or self.output),
        ]), contextlib.redirect_stdout(io.StringIO()) as captured:
            IMPORTER.main()
        return json.loads(captured.getvalue())

    def rejected(self, code, work_id="CASE-01", output=None):
        with self.assertRaisesRegex(ValueError, f"^{code}$"):
            self.run_import(work_id, output)

    def test_zero_work_id_cannot_select_last_case(self):
        self.rejected("INVALID_WORK_ID", "CASE-00")
        self.assertFalse(self.output.exists())

    def test_existing_receipt_cannot_rebind_source_case(self):
        self.run_import()
        path = self.output / "download-receipt.private.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt["source_case_id"] = "synthetic-foreign-case"
        path.write_text(json.dumps(receipt), encoding="utf-8")
        original = path.read_bytes()
        self.rejected("PRIVATE_RECEIPT_BINDING_MISMATCH")
        self.assertEqual(path.read_bytes(), original)

    def test_later_file_mismatch_leaves_no_earlier_file_or_receipt(self):
        self.output.mkdir()
        (self.output / "b.pdf").write_bytes(b"different synthetic bytes")
        self.rejected("PRIVATE_SNAPSHOT_IMMUTABLE")
        self.assertEqual(sorted(p.name for p in self.output.iterdir()), ["b.pdf"])

    def test_valid_import_and_retry_preserve_original_receipt_bytes(self):
        self.assertEqual(self.run_import(), {"work_id": "CASE-01", "files_imported": 2, "source_mutations": 0})
        path = self.output / "download-receipt.private.json"
        original = path.read_bytes()
        receipt = json.loads(original)
        self.assertEqual(receipt["archive_sha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertEqual(receipt["download_method"], "authenticated_owner_storage_dashboard_zip")
        self.assertEqual(receipt["source_case_id"], self.case["id"])
        self.run_import()
        self.assertEqual(path.read_bytes(), original)
        for record in receipt["documents"]:
            data = self.data[record["private_filename"]]
            self.assertEqual((self.output / record["private_filename"]).read_bytes(), data)
            self.assertEqual(record["observed_sha256"], hashlib.sha256(data).hexdigest())
            self.assertIsNone(record["historical_version_id"])

    def test_noncanonical_or_negative_ids_are_refused(self):
        for work_id in ("CASE-0", "CASE-1", "CASE-001", "CASE--1", "CASE-+1", "CASE-０１", "case-01", "CASE-01 "):
            with self.subTest(work_id=work_id):
                self.rejected("INVALID_WORK_ID", work_id)
        self.assertFalse(self.output.exists())

    def test_out_of_bounds_is_refused(self):
        self.rejected("WORK_ID_OUT_OF_BOUNDS", "CASE-02")
        self.assertFalse(self.output.exists())

    def test_canonical_three_digit_index_selects_correct_case(self):
        source = {"sourceProject": "synthetic", "cases": [
            {"id": f"synthetic-{index}", "is_qa": False, "payments": [{"status": "verified"}]}
            for index in range(1, 101)
        ]}
        self.assertEqual(IMPORTER.select_case(source, "CASE-100")["id"], "synthetic-100")

    def test_foreign_document_case_refused_before_writes(self):
        self.case["documents"][1]["case_id"] = "synthetic-foreign-case"
        self.write_snapshot()
        self.rejected("SOURCE_DOCUMENT_CASE_MISMATCH")
        self.assertFalse(self.output.exists())

    def test_foreign_verified_payment_is_not_paid_scope(self):
        self.case["payments"][0]["case_id"] = "synthetic-foreign-case"
        self.write_snapshot()
        self.rejected("PAID_CASE_SCOPE_REQUIRED")

    def test_ambiguous_source_case_id_refused(self):
        self.source["cases"].append(dict(self.case))
        self.write_snapshot()
        self.rejected("INVALID_SOURCE_CASE_BINDING")

    def test_receipt_file_and_container_bindings_are_all_checked(self):
        self.run_import()
        path = self.output / "download-receipt.private.json"
        original = path.read_bytes()
        mutations = [
            lambda row: row.update(work_id="CASE-02"),
            lambda row: row.update(source_project="synthetic-foreign-project"),
            lambda row: row.update(source_is_qa=True),
            lambda row: row.update(archive_sha256="0" * 64),
            lambda row: row.update(source_mutations=False),
            lambda row: row["documents"][0].update(observed_sha256="0" * 64),
            lambda row: row["documents"][0].update(observed_size=1),
            lambda row: row["documents"][0].update(private_filename="foreign.pdf"),
            lambda row: row["documents"][0]["source_document"].update(storage_path="foreign/a.pdf"),
            lambda row: row["documents"][0].update(historical_version_id=1),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                receipt = json.loads(original)
                mutate(receipt)
                path.write_text(json.dumps(receipt), encoding="utf-8")
                tampered = path.read_bytes()
                self.rejected("PRIVATE_RECEIPT_BINDING_MISMATCH")
                self.assertEqual(path.read_bytes(), tampered)

    def test_receipt_with_missing_file_is_not_silently_repaired(self):
        self.run_import()
        (self.output / "a.pdf").unlink()
        self.rejected("PRIVATE_RECEIPT_FILE_MISSING")
        self.assertFalse((self.output / "a.pdf").exists())

    def test_matching_interrupted_files_without_receipt_can_resume(self):
        self.output.mkdir()
        (self.output / "b.pdf").write_bytes(self.data["b.pdf"])
        self.run_import()
        self.assertEqual((self.output / "a.pdf").read_bytes(), self.data["a.pdf"])
        self.assertTrue((self.output / "download-receipt.private.json").is_file())

    def test_unrelated_output_files_refuse_mixing_cases(self):
        self.output.mkdir()
        (self.output / "foreign.pdf").write_bytes(b"synthetic foreign bytes")
        self.rejected("PRIVATE_OUTPUT_UNEXPECTED_FILE")
        self.assertEqual([entry.name for entry in self.output.iterdir()], ["foreign.pdf"])

    def test_source_document_ids_and_windows_filename_aliases_are_unique(self):
        original = json.loads(json.dumps(self.case["documents"]))
        for change in (
            {"id": original[0]["id"]}, {"storage_path": "synthetic-case-one/A.PDF"},
        ):
            with self.subTest(change=change):
                self.case["documents"] = json.loads(json.dumps(original))
                self.case["documents"][1].update(change)
                self.write_snapshot()
                self.rejected("AMBIGUOUS_SOURCE_FILENAMES")

    def test_unsafe_source_names_refused(self):
        for name in ("../a.pdf", "a.pdf:stream", "NUL.pdf", "a.pdf.", "a.pdf ", "download-receipt.private.json", "a\\b.pdf"):
            with self.subTest(name=name):
                self.case["documents"][0]["storage_path"] = f"synthetic-case-one/{name}"
                self.write_snapshot()
                self.rejected("UNSAFE_SOURCE_FILENAME")

    def test_zip_duplicate_missing_nested_extra_and_directory_entries_refused(self):
        cases = [
            [("a.pdf", self.data["a.pdf"]), ("a.pdf", self.data["a.pdf"])],
            [("a.pdf", self.data["a.pdf"])],
            [("a.pdf", self.data["a.pdf"]), ("nested/b.pdf", self.data["b.pdf"])],
            [*self.data.items(), ("extra.pdf", b"synthetic")],
            [*self.data.items(), ("folder/", b"")],
            [("../a.pdf", self.data["a.pdf"]), ("b.pdf", self.data["b.pdf"])],
        ]
        for index, entries in enumerate(cases):
            with self.subTest(index=index), contextlib.redirect_stderr(io.StringIO()):
                self.write_archive(entries)
                self.rejected("DOWNLOAD_CASE_FILE_SET_MISMATCH")
                self.assertFalse(self.output.exists())

    def test_zip_symlink_refused(self):
        entry = ZipInfo("a.pdf")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.write_archive([(entry, self.data["a.pdf"]), ("b.pdf", self.data["b.pdf"])])
        self.rejected("UNSAFE_DOWNLOAD_ENTRY")

    def test_declared_size_mismatch_and_over_limit_refused_before_writes(self):
        for size in (len(self.data["a.pdf"]) + 1, 0, -1, True, IMPORTER.MAX_FILE_BYTES + 1):
            with self.subTest(size=size):
                self.case["documents"][0]["size"] = size
                self.write_snapshot()
                self.rejected("DOWNLOAD_SIZE_MISMATCH")
        self.assertFalse(self.output.exists())

    def test_combined_size_and_container_size_are_bounded(self):
        with patch.object(IMPORTER, "MAX_TOTAL_BYTES", 2):
            self.rejected("DOWNLOAD_TOTAL_SIZE_LIMIT")
        with patch.object(IMPORTER, "MAX_ARCHIVE_BYTES", 2):
            self.rejected("DOWNLOAD_ARCHIVE_SIZE_LIMIT")
        self.assertFalse(self.output.exists())

    def test_other_git_repository_and_linked_worktree_are_refused(self):
        for kind in ("directory", "file"):
            with self.subTest(kind=kind):
                repository = self.root / kind
                repository.mkdir()
                marker = repository / ".git"
                if kind == "directory":
                    marker.mkdir()
                else:
                    marker.write_text("gitdir: synthetic", encoding="utf-8")
                self.rejected("CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY", output=repository / "private")
                self.assertFalse((repository / "private").exists())

    def test_ancestor_git_requires_both_explicit_exclusion_and_no_tracked_files(self):
        repository = self.root / "synthetic-git"
        repository.mkdir()
        subprocess.run(["git", "init", "--quiet", str(repository)], check=True, capture_output=True)
        private = repository / "private"
        private.mkdir()
        ignored = repository / ".git" / "info" / "exclude"
        ignored.write_text("/private/\n", encoding="utf-8")
        self.assertEqual(IMPORTER.outside_repository(str(private)), private.resolve())
        tracked = private / "synthetic.txt"
        tracked.write_text("synthetic only", encoding="utf-8")
        subprocess.run(["git", "-C", str(repository), "add", "--force", "private/synthetic.txt"], check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, "CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY"):
            IMPORTER.outside_repository(str(private))
        with self.assertRaisesRegex(ValueError, "CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY"):
            IMPORTER.outside_repository(str(repository / "not-ignored"))

    def test_known_application_repo_never_allowed_even_if_ignored(self):
        repository = Path(IMPORTER.__file__).resolve().parents[2]
        with self.assertRaisesRegex(ValueError, "CUSTOMER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY"):
            IMPORTER.outside_repository(str(repository / "output" / "synthetic-unused.pdf"))

    def test_relative_path_leaving_application_repo_resolves_before_scope_check(self):
        relative = os.path.relpath(self.snapshot, Path.cwd())
        self.assertIn("..", Path(relative).parts)
        self.assertEqual(IMPORTER.outside_repository(relative), self.snapshot.resolve())

    def test_symlink_guard_also_has_portable_policy_regression(self):
        original = Path.is_symlink
        blocked = self.output / "b.pdf"
        self.output.mkdir()
        with patch.object(Path, "is_symlink", lambda path: path == blocked or original(path)):
            self.rejected("CUSTOMER_ARTIFACT_SYMLINK_FORBIDDEN")
        self.assertFalse((self.output / "a.pdf").exists())

    def symlink(self, link, target, directory=False):
        try:
            os.symlink(target, link, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"OS does not permit synthetic symlinks: {type(error).__name__}")

    def test_output_symlink_and_file_symlink_refused(self):
        actual = self.root / "actual"
        actual.mkdir()
        link = self.root / "linked"
        self.symlink(link, actual, directory=True)
        self.rejected("CUSTOMER_ARTIFACT_SYMLINK_FORBIDDEN", output=link)
        self.output.mkdir()
        outside = self.root / "unchanged.pdf"
        outside.write_bytes(self.data["b.pdf"])
        self.symlink(self.output / "b.pdf", outside)
        self.rejected("CUSTOMER_ARTIFACT_SYMLINK_FORBIDDEN")
        self.assertFalse((self.output / "a.pdf").exists())
        self.assertEqual(outside.read_bytes(), self.data["b.pdf"])

    def test_input_symlink_refused(self):
        original = self.archive
        self.archive = self.root / "linked.zip"
        self.symlink(self.archive, original)
        self.rejected("CUSTOMER_ARTIFACT_SYMLINK_FORBIDDEN")

    def configure_single_raw(self):
        self.case["documents"] = self.case["documents"][:1]
        raw = b"%PDF-1.7\nSynthetic fixture; not a customer PDF.\n%%EOF\n"
        self.case["documents"][0]["size"] = len(raw)
        self.write_snapshot()
        self.archive = self.root / "a.pdf"
        self.archive.write_bytes(raw)
        return raw

    def test_single_raw_pdf_has_truthful_method_and_idempotent_receipt(self):
        raw = self.configure_single_raw()
        self.run_import()
        path = self.output / "download-receipt.private.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(receipt["download_method"], "authenticated_owner_storage_dashboard_single_file")
        self.assertEqual(receipt["archive_sha256"], hashlib.sha256(raw).hexdigest())
        original = path.read_bytes()
        self.run_import()
        self.assertEqual(path.read_bytes(), original)

    def test_raw_file_requires_exact_single_document_name_size_and_signature(self):
        self.configure_single_raw()
        self.archive.write_bytes(b"wrong signature".ljust(self.case["documents"][0]["size"], b"x"))
        self.rejected("DOWNLOAD_SIGNATURE_MISMATCH")
        self.configure_single_raw()
        self.case["documents"][0]["mime_type"] = "image/png"
        self.write_snapshot()
        self.rejected("DOWNLOAD_SIGNATURE_MISMATCH")
        self.case["documents"][0]["mime_type"] = "application/pdf"
        self.case["documents"][0]["size"] += 1
        self.write_snapshot()
        self.rejected("DOWNLOAD_SIZE_MISMATCH")
        self.configure_single_raw()
        renamed = self.root / "renamed.pdf"
        self.archive.rename(renamed)
        self.archive = renamed
        self.rejected("DOWNLOAD_CASE_FILE_SET_MISMATCH")
        self.assertFalse(self.output.exists())

    def test_raw_file_cannot_stand_in_for_two_documents(self):
        self.archive = self.root / "a.pdf"
        self.archive.write_bytes(b"%PDF-1.7\nSynthetic")
        self.rejected("DOWNLOAD_CASE_FILE_SET_MISMATCH")


if __name__ == "__main__":
    unittest.main()
