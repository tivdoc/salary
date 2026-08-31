param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [Parameter(Mandatory = $true)]
  [string]$Prefix
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).Path
$prefixParent = (Resolve-Path -LiteralPath (Split-Path -Parent $Prefix) -ErrorAction Stop).Path
$resolvedPrefix = [IO.Path]::GetFullPath((Join-Path $prefixParent (Split-Path -Leaf $Prefix)))
$parentWithSeparator = $prefixParent.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedPrefix.StartsWith($parentWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
  throw "POSTGRES_EXTRACT_PREFIX_ESCAPE"
}
if (Test-Path -LiteralPath $resolvedPrefix) {
  throw "POSTGRES_EXTRACT_PREFIX_ALREADY_EXISTS"
}

$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $entryCount = $zip.Entries.Count
  if ($entryCount -lt 1 -or $entryCount -gt 30000) {
    throw "POSTGRES_ARCHIVE_ENTRY_COUNT_INVALID"
  }

  $validated = [Collections.Generic.List[object]]::new()
  [long]$uncompressedBytes = 0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($name) -or -not $name.StartsWith('pgsql/', [StringComparison]::Ordinal)) {
      throw "POSTGRES_ARCHIVE_ROOT_INVALID"
    }
    $relative = $name.Substring(6)
    if ($relative.Length -eq 0) {
      continue
    }
    $segments = $relative.Split('/')
    if ($segments | Where-Object { $_ -eq '..' -or $_ -eq '.' }) {
      throw "POSTGRES_ARCHIVE_PATH_ESCAPE"
    }
    $target = [IO.Path]::GetFullPath((Join-Path $resolvedPrefix ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
    $prefixWithSeparator = $resolvedPrefix.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefixWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
      throw "POSTGRES_ARCHIVE_PATH_ESCAPE"
    }
    $attributes = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$entry.ExternalAttributes), 0)
    $unixType = ($attributes -shr 16) -band 0xF000
    if ($unixType -eq 0xA000) {
      throw "POSTGRES_ARCHIVE_LINK_ENTRY_REJECTED"
    }
    $uncompressedBytes += [long]$entry.Length
    if ($uncompressedBytes -gt 1500000000) {
      throw "POSTGRES_ARCHIVE_UNCOMPRESSED_SIZE_LIMIT"
    }
    $validated.Add([pscustomobject]@{
      Entry = $entry
      Target = $target
      Directory = $name.EndsWith('/', [StringComparison]::Ordinal)
    })
  }

  [IO.Directory]::CreateDirectory($resolvedPrefix) | Out-Null
  [int]$fileCount = 0
  foreach ($item in $validated) {
    if ($item.Directory) {
      [IO.Directory]::CreateDirectory($item.Target) | Out-Null
      continue
    }
    $targetParent = [IO.Path]::GetDirectoryName($item.Target)
    [IO.Directory]::CreateDirectory($targetParent) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($item.Entry, $item.Target, $false)
    $fileCount += 1
  }

  [ordered]@{
    schema_version = "tivdoc-postgresql-official-archive-extract-v0.9.1"
    archive_root = "pgsql"
    archive_entries = $entryCount
    extracted_files = $fileCount
    uncompressed_bytes = $uncompressedBytes
    path_escape_entries = 0
    link_entries = 0
    status = "PASS"
  } | ConvertTo-Json -Compress
}
finally {
  $zip.Dispose()
}
