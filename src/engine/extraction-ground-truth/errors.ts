export class GroundTruthError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "GroundTruthError";
    this.code = code;
  }
}

export function requireGroundTruth(condition: unknown, code: string): asserts condition {
  if (!condition) throw new GroundTruthError(code);
}
