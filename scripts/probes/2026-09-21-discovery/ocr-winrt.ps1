# Probe: OCR nativo do Windows (Windows.Media.Ocr) sobre screenshot da tela —
# peça de percepção do port Windows do typesafe-computer-use (equivalente ao Apple Vision).
# Roda no host Windows a partir do WSL (interop). Saída: linhas OCR + tempo.
$ErrorActionPreference = "Stop"
$total = [System.Diagnostics.Stopwatch]::StartNew()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# helper await p/ IAsyncOperation WinRT a partir do PowerShell
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) {
  $m = $asTaskGeneric.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# 1) screenshot da tela primária
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$png = "$env:TEMP\voicecast-ocr-probe.png"
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"captura: $($sw.ElapsedMilliseconds)ms ($($bounds.Width)x$($bounds.Height)) -> $png"

# 2) OCR via WinRT
$sw.Restart()
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw "OcrEngine indisponível (sem language pack OCR?)" }
$result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
"ocr: $($sw.ElapsedMilliseconds)ms · lang=$($engine.RecognizerLanguage.LanguageTag) · linhas=$($result.Lines.Count)"
"--- primeiras 12 linhas ---"
$result.Lines | Select-Object -First 12 | ForEach-Object { $_.Text }
"total: $($total.ElapsedMilliseconds)ms"
