import path from "node:path";
import { GroundTruthError, requireGroundTruth } from "./errors.ts";

export const SYNTHETIC_ALLOWED_ROOT = "X:\\__synthetic_ground_truth_allowed__";
export const SYNTHETIC_PROHIBITED_SENTINEL = "X:\\__synthetic_prohibited_sentinel__\\never-open.bin";

export type SyntheticFixtureOpener<T> = (verifiedPath: string) => T;

function insideSyntheticRoot(candidate: string) {
  const root = path.win32.resolve(SYNTHETIC_ALLOWED_ROOT);
  const resolved = path.win32.resolve(candidate);
  return resolved.startsWith(`${root}\\`) && resolved !== root;
}

export function openVerifiedSyntheticFixture<T>(input: {
  source_kind: "synthetic_fixture" | "prohibited_sentinel";
  path: string;
  opener: SyntheticFixtureOpener<T>;
}): T {
  if (input.source_kind !== "synthetic_fixture" || input.path === SYNTHETIC_PROHIBITED_SENTINEL) {
    throw new GroundTruthError("ground_truth_prohibited_path_denied_before_io");
  }
  requireGroundTruth(insideSyntheticRoot(input.path), "ground_truth_path_outside_synthetic_root");
  return input.opener(path.win32.resolve(input.path));
}
