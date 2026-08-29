# Controlled Import Security and Test-Only E2E V0.3.1

This module keeps four claims separate:

1. `self-test` proves only that deterministic validation tooling executes.
2. ordinary `verify` on an empty ledger reports `NO_IMPORTS_TO_VERIFY`; it does not prove an import.
3. `verify --strict-required-instance --require-request-id <id>` fails with exit code 4 until that exact request has a committed, verified instance.
4. corpus acquisition readiness remains a separate gate and is never satisfied by a tooling test.

## Controlled transaction

An import binds the receipt to the request ID, source ID, exact HTTPS landing/artifact/final URLs, official allowlisted host, expected PDF media type, expected document title, filename, and—when known—artifact hash. The incoming file must be a case-exact, single-link regular file under the request inbox. Absolute paths, traversal, UNC/device/ADS names, trailing-dot/space names, symlinks, junctions/reparse points, hardlinks, and case collisions are rejected.

The importer opens the incoming file once, verifies its identity before and after reading, writes a private transaction copy, hashes and validates that copy, and publishes those same bytes. Artifact and event files are atomically linked from fully written temporary files. The root ledger record is written last and is the only commit marker consumed by verification or selection. A crash may leave an orphan artifact or event; recovery inspection reports it, but it is unreachable from selection until a valid root ledger commit exists.

PDF validation is bounded by byte, page, object, and declared-stream limits and rejects MIME/magic mismatch, HTML, missing EOF/xref, encryption, corrupt object structure, executables/polyglots, actions/scripts, embedded content, and external references. Import intentionally does not parse or index legal text: every imported record remains `parse_state=not_attempted`, `needs_review`, `inactive`, and unusable for rules. Parser process isolation, timeout, and memory limits remain a post-import parser responsibility; this import layer exposes that as an explicit residual gap instead of pretending a parser ran.

Receipts and reportable metadata are scanned for authorization/cookie/session/token material, local user paths, email addresses, credential-bearing query strings, and EXIF/GPS keys. Screenshots are not import inputs. Quarantined observations are outside the committed ledger and cannot reach parser, index, retrieval, or promotion through this module.

## Test-only public-artifact instance

`test-acquisition-instance` accepts an absolute local path to a copy of an already acquired public official artifact plus its expected SHA-256 and exact official URLs. It performs a complete request → synthetic receipt → private copy → same-byte hash/validation → immutable publish → append-only ledger → strict verify flow in a temporary directory, then deletes the instance. Its receipt is required to say:

`TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT`

The instance uses `system_test` and `synthetic_test_copy_existing_public_official_artifact`; it is never described or stored as a real owner import and cannot activate a source.

## Residual risks

- The ledger is local filesystem evidence, not durable replicated audit storage.
- Directory fsync semantics and power-loss durability differ across filesystems; atomic visibility is tested, durable persistence is not claimed.
- Windows reparse checks are fail-closed for visible symlink/junction paths, but privileged kernel-level races cannot be eliminated by portable Node filesystem APIs.
- PDF structural screening is not a substitute for a sandboxed full parser. The parser remains disabled during import and must later run in an isolated process with explicit timeout/memory limits.
- A human must validate instrument identity, provenance, legal effect, scope, and applicability. No import result is reviewed or active.

## Integration wiring required

The orchestrator should add package scripts for `self-test`, `test-acquisition-instance`, and `instance-readiness`. It must also wire `classifyLegalChangeDetections` into the central source-diff report so the three minimum-wage byte changes are emitted as `unreviewed_byte_change` and the two retained 505-byte challenge observations as `rejected_challenge_observation`; the central diff generator must stop labeling those byte changes `presentation_or_transport_only` without semantic and human review.
