param(
 [Parameter(Mandatory=$true)][ValidatePattern('^Tivdoc-DEV-[A-Za-z0-9-]+$')][string]$TaskName,
 [Parameter(Mandatory=$true)][string]$Launcher,
 [switch]$Resume
)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$privateRoot=[IO.Path]::GetFullPath((Join-Path $repo '../release-work'))
$Launcher=[IO.Path]::GetFullPath($Launcher)
if(!$Launcher.StartsWith($privateRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($Launcher) -notmatch '^dev-launch-([a-f0-9-]{36})\.ps1$'){throw 'DEV_BACKGROUND_SCOPE'}
$epoch=$Matches[1]
if(!$TaskName.EndsWith($epoch)){throw 'DEV_BACKGROUND_TASK_SCOPE'}
$controlPath=Join-Path $privateRoot ('dev-supervisor-'+$epoch+'.private.json')
$control=Get-Content -LiteralPath $controlPath -Raw|ConvertFrom-Json
if($control.control_id -ne $epoch -or $control.schema_version -ne 'managed-dev-supervisor-v1'){throw 'DEV_BACKGROUND_CONTROL_SCOPE'}
$task=Get-ScheduledTask -TaskName $TaskName
$legacyArgs='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$Launcher+'"'
$guiArgs='//B //NoLogo "'+$Launcher+'.vbs"'
if($task.Actions.Count -ne 1 -or !(($task.Actions[0].Execute -eq 'powershell.exe' -and $task.Actions[0].Arguments -eq $legacyArgs) -or ($task.Actions[0].Execute -eq (Join-Path $env:SystemRoot 'System32/wscript.exe') -and $task.Actions[0].Arguments -eq $guiArgs))){throw 'DEV_BACKGROUND_UNEXPECTED_TASK_ACTION'}
$receiptDir=Join-Path $privateRoot 'background-task-repairs'
New-Item -ItemType Directory -Path $receiptDir -Force|Out-Null
$receiptBase=Join-Path $receiptDir ($epoch+'-'+[guid]::NewGuid())
Export-ScheduledTask -TaskName $TaskName|Set-Content -LiteralPath ($receiptBase+'.before.xml')
# Disable future starts only. Never stop a running job to repair presentation.
Disable-ScheduledTask -TaskName $TaskName|Out-Null
if((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'){throw 'DEV_BACKGROUND_WAIT_FOR_ACTIVE_TASK'}
$live=Get-CimInstance Win32_Process|Where-Object {$_.Name -in @('node.exe','powershell.exe','wscript.exe') -and $_.CommandLine -and ($_.CommandLine.Contains($controlPath) -or $_.CommandLine.Contains($Launcher))}
if($live){throw 'DEV_BACKGROUND_ACTIVE_PROCESS'}
$archivedLock=$null
$output=[IO.Path]::GetFullPath($control.output_directory)
$expectedOutput=[IO.Path]::GetFullPath((Join-Path $control.working_directory ('output/release-completion/dev-operations-'+$epoch+'/supervisor')))
if($output -ne $expectedOutput -or [IO.Path]::GetFullPath((Join-Path $control.working_directory '../release-work')) -ne $privateRoot){throw 'DEV_BACKGROUND_OUTPUT_SCOPE'}
$lock=Join-Path $output 'supervisor.lock'
if(Test-Path -LiteralPath $lock){
 $lockBytes=[IO.File]::ReadAllBytes($lock);$prior=[Text.Encoding]::UTF8.GetString($lockBytes)|ConvertFrom-Json
 if($prior.control_id -ne $epoch -or $prior.nonce -notmatch '^[a-f0-9-]{36}$' -or $prior.pid -lt 1){throw 'DEV_BACKGROUND_LOCK_SCOPE'}
 foreach($processId in @($prior.pid,$prior.child_pid)|Where-Object {$_}){if(Get-Process -Id $processId -ErrorAction SilentlyContinue){throw 'DEV_BACKGROUND_LOCK_PROCESS_EXISTS'}}
 if([Convert]::ToBase64String([IO.File]::ReadAllBytes($lock)) -ne [Convert]::ToBase64String($lockBytes)){throw 'DEV_BACKGROUND_LOCK_CHANGED'}
 $archivedLock=Join-Path $output ('supervisor.orphan-'+$prior.nonce+'.json')
 # Both resolved paths are exact children of the verified supervisor directory.
 Move-Item -LiteralPath $lock -Destination $archivedLock -ErrorAction Stop
}
$gui=& node (Join-Path $PSScriptRoot 'windows-background-launcher.mjs') $Launcher
if($LASTEXITCODE -ne 0 -or $gui -ne $Launcher+'.vbs'){throw 'DEV_BACKGROUND_RENDER_FAILED'}
$action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/wscript.exe') -Argument $guiArgs
Set-ScheduledTask -TaskName $TaskName -Action $action|Out-Null
$after=Get-ScheduledTask -TaskName $TaskName
if($after.Settings.MultipleInstances -ne 'IgnoreNew' -or $after.Settings.RestartCount -ne 0){throw 'DEV_BACKGROUND_UNEXPECTED_RESTART_POLICY'}
if($Resume){
 if(!$control.enabled -or [datetimeoffset]$control.expires_at -le [datetimeoffset]::UtcNow){throw 'DEV_BACKGROUND_CONTROL_NOT_ACTIVE'}
 Enable-ScheduledTask -TaskName $TaskName|Out-Null
}
@{at=[datetimeoffset]::UtcNow.ToString('o');task=$TaskName;launcher=$Launcher;archived_orphan_lock=$archivedLock;resumed=[bool]$Resume;authority_changed=$false;budget_changed=$false;processes_terminated=0}|ConvertTo-Json|Set-Content -LiteralPath ($receiptBase+'.json')
@{state='repaired';task=$TaskName;resumed=[bool]$Resume;orphanLockArchived=[bool]$archivedLock;receipt=$receiptBase+'.json'}|ConvertTo-Json -Compress
