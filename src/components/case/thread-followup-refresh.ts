// A route refresh can return before the worker opens its follow-up requests.
// Keep the budget outside the timer so a new server payload cannot renew it.
export const THREAD_FOLLOWUP_REFRESH_INTERVAL_MS = 10_000;
export const THREAD_FOLLOWUP_REFRESH_LIMIT = 12;
export const THREAD_FOLLOWUP_REFRESH_WINDOW_MS = 120_000;

export function createThreadFollowupRefreshBudget(now: number) {
  return { expiresAt: now + THREAD_FOLLOWUP_REFRESH_WINDOW_MS, remaining: THREAD_FOLLOWUP_REFRESH_LIMIT };
}

export function startThreadFollowupRefresh({ budget, refresh, isVisible, onFinished }: {
  budget: ReturnType<typeof createThreadFollowupRefreshBudget>;
  refresh: () => void;
  isVisible: () => boolean;
  onFinished: () => void;
}) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if (cancelled) return;
    if (budget.remaining === 0 || Date.now() >= budget.expiresAt) {
      onFinished();
      return;
    }
    timer = setTimeout(tick, Math.min(THREAD_FOLLOWUP_REFRESH_INTERVAL_MS, budget.expiresAt - Date.now()));
  }
  function tick() {
    if (cancelled) return;
    if (Date.now() <= budget.expiresAt && budget.remaining > 0 && isVisible()) {
      budget.remaining -= 1;
      refresh();
    }
    schedule();
  }
  // Finish asynchronously even when a refreshed payload reuses an expired budget.
  timer = setTimeout(schedule, 0);
  return () => { cancelled = true; clearTimeout(timer); };
}
