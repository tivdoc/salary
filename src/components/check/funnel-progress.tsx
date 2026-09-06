"use client";

// Site S4 (2.1). One progress indicator for the whole funnel.
//
// There were two. The header showed four stages — questions, documents,
// payment, received — and the questionnaire drew its own bar underneath showing
// question N of nine. A person on the first screen saw "stage 1 of 4" above
// "question 3 of 9" and had to work out that these were the same journey
// measured twice; the two bars also moved at different rates, so one always
// looked wrong.
//
// Now there is one. The header owns it, the questionnaire reports where it is,
// and the bar fills across the whole funnel: the questions occupy the first
// stage's width, and progress inside them moves the bar inside that stage
// rather than beside it.
//
// The source is the same `step_number` the funnel's own analytics event
// carries, so what the customer sees and what the funnel measures cannot drift.
//
// Accessibility, from S4's own list: this is a `progressbar` with an
// `aria-valuetext`, because "3" read aloud on its own means nothing; and it
// carries NO `aria-live` — the bar animates on every step, and a live region on
// an animating element interrupts a screen reader continuously. The step change
// is announced by moving focus to the new heading instead, which is what a
// person actually needs to hear.

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type FunnelStage = Readonly<{ path: string; label: string }>;

export const FUNNEL_STAGES: readonly FunnelStage[] = Object.freeze([
  Object.freeze({ path: "/check", label: "כמה פרטים" }),
  Object.freeze({ path: "/check/upload", label: "מסמכים" }),
  Object.freeze({ path: "/check/payment", label: "תשלום" }),
  Object.freeze({ path: "/check/received", label: "התקבל" }),
]);

type Substep = Readonly<{ index: number; count: number }> | null;

type ProgressValue = Readonly<{
  substep: Substep;
  /** Called by the screen that has steps of its own; null clears it. */
  reportSubstep: (next: Substep) => void;
}>;

const FunnelProgressContext = createContext<ProgressValue>({ substep: null, reportSubstep: () => undefined });

export function FunnelProgressProvider({ children }: { children: React.ReactNode }) {
  const [substep, setSubstep] = useState<Substep>(null);
  const reportSubstep = useCallback((next: Substep) => {
    setSubstep((current) => {
      if (current === next) return current;
      if (current && next && current.index === next.index && current.count === next.count) return current;
      return next;
    });
  }, []);
  const value = useMemo(() => ({ substep, reportSubstep }), [substep, reportSubstep]);
  return <FunnelProgressContext.Provider value={value}>{children}</FunnelProgressContext.Provider>;
}

export function useFunnelProgress(): ProgressValue {
  return useContext(FunnelProgressContext);
}

/**
 * How far along the whole funnel we are, in [0, 1].
 *
 * A stage with no sub-steps counts as complete once it is the current one —
 * the person is standing on it and there is nothing smaller to measure. A stage
 * that reports sub-steps fills proportionally inside its own share, so the bar
 * never jumps backwards when the questionnaire hands over to the upload screen.
 */
export function funnelFraction(stageIndex: number, substep: Substep, stageCount = FUNNEL_STAGES.length): number {
  const clamped = Math.min(Math.max(stageIndex, 0), stageCount - 1);
  const share = 1 / stageCount;
  if (!substep || substep.count <= 0) return (clamped + 1) * share;
  const within = Math.min(Math.max(substep.index, 0), substep.count) / substep.count;
  return clamped * share + within * share;
}

/** What a screen reader is told instead of a bare number. */
export function funnelValueText(stageIndex: number, substep: Substep, stages: readonly FunnelStage[] = FUNNEL_STAGES): string {
  const stage = stages[Math.min(Math.max(stageIndex, 0), stages.length - 1)]!;
  const base = `שלב ${stageIndex + 1} מתוך ${stages.length}: ${stage.label}`;
  return substep && substep.count > 0 ? `${base}, שאלה ${substep.index} מתוך ${substep.count}` : base;
}
