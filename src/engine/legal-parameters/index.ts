export {
  appendIndependentHumanVerification,
  assessParameterInvalidation,
  createNumericParameterDraft,
  invalidateNumericParameterDraft,
  makeActivationEligible,
  parameterInvalidationReasons,
} from "./state-machine.ts";
export type {
  CurrentParameterBinding,
  ParameterInvalidationReason,
  VerificationEvidenceBinding,
} from "./state-machine.ts";
