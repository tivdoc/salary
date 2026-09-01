param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($null -eq $signature.SignerCertificate) {
  throw "POSTGRES_INSTALLER_SIGNER_CERTIFICATE_MISSING"
}

[ordered]@{
  schema_version = "tivdoc-postgresql-installer-authenticode-v0.10.0"
  status = $signature.Status.ToString()
  subject = $signature.SignerCertificate.Subject
  issuer = $signature.SignerCertificate.Issuer
  thumbprint = $signature.SignerCertificate.Thumbprint
} | ConvertTo-Json -Compress
