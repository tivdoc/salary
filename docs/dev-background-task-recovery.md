# Windows DEV background execution

Use the ordinary lifecycle commands for new epochs. The task action now starts
`wscript.exe //B //NoLogo` and a UTF-16 GUI wrapper, which starts PowerShell with
window style zero and waits for it. Direct Task Scheduler → PowerShell created
visible Windows Terminal windows before PowerShell processed `-WindowStyle Hidden`.
`Hidden` on a scheduled task alone is not a window-creation control.

The wrapper returns the original exit code. It appends start/end/exit fields to
the private `<launcher>.launch.log`; the supervisor keeps its sanitized JSON
receipts, output hashes, worker exit codes and monotonic tick counter. No secrets
or raw provider output are added to these logs. `IgnoreNew`, no automatic failure
restart, source/job locks, authority, spend ledger and expiry remain unchanged.

For an existing epoch, from the repository root in PowerShell:

```powershell
& scripts/product-workers/repair-windows-background-task.ps1 `
  -TaskName 'Tivdoc-DEV-QA-<exact-existing-epoch>' `
  -Launcher '<absolute-private-root>\dev-launch-<exact-existing-epoch>.ps1' `
  -Resume
```

The repair verifies the existing action, epoch and private paths; exports the
original task XML; disables only future starts; and refuses to interrupt an active
task or process. If an active task remains, let it finish, then repeat the command.
An orphan supervisor lock is archived only with scheduling disabled and both
recorded PIDs absent. A live or reused PID refuses repair. The provider ledger's
locks are never touched. An unchanged repair can be repeated without renewing any
authority, extending expiry or resetting counters. Without `-Resume` it leaves
the schedule disabled; with it, only an already enabled, unexpired control resumes.

Inspect `Get-ScheduledTaskInfo`, private launch logs and two successive supervisor
receipts after repair. Exit zero verifies a successful scheduler tick, not a new
financial report. Source-deficient cases can remain awaiting input. A blocked
repair leaves the task disabled and retains its XML; it does not silently restart.
Production and unrelated scheduled tasks are outside this utility's scope.
