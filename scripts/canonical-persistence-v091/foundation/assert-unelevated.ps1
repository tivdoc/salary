$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

[ordered]@{
  schema_version = "tivdoc-windows-token-elevation-v0.9.1"
  elevated = $elevated
  status = if ($elevated) { "REJECTED" } else { "PASS" }
} | ConvertTo-Json -Compress
