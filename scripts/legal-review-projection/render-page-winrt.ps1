# L6-7 / D1. Render one page of a PDF to PNG with the Windows built-in PDF
# rasteriser (Windows.Data.Pdf, WinRT). Nothing is installed: this is what the
# operating system ships. Used for typeset PDFs, which have no scan stream to
# decode; scanned pages render from their own CCITT stream instead.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File render-page-winrt.ps1 <pdf> <png> [scale]
#
# The page is rendered at scale × 72 dpi (default 3, i.e. 216 dpi).
param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$Png,
  [double]$Scale = 3
)
$ErrorActionPreference = "Stop"
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }
function AwaitAction($WinRtTask) { $netTask = $asTaskAction.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null }

$pdfPath = (Resolve-Path $Pdf).Path
$pngDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($Png))
$pngName = Split-Path -Leaf $Png
if (-not (Test-Path $pngDir)) { New-Item -ItemType Directory -Force $pngDir | Out-Null }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$page = $doc.GetPage(0)
$opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$opts.DestinationWidth = [uint32][math]::Round($page.Size.Width * $Scale)
$opts.DestinationHeight = [uint32][math]::Round($page.Size.Height * $Scale)
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync((Resolve-Path $pngDir).Path)) ([Windows.Storage.StorageFolder])
$out = Await ($folder.CreateFileAsync($pngName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$stream = Await ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
AwaitAction ($page.RenderToStreamAsync($stream, $opts))
$stream.Dispose(); $page.Dispose()
Write-Output ("{0}x{1}" -f $opts.DestinationWidth, $opts.DestinationHeight)
