# 用 Windows 内置 OCR 识别图片文字（zh-Hans），输出 JSON（含每行坐标）
# 用法: powershell -File ocr2.ps1 <图片路径>
param([Parameter(Mandatory=$true)][string]$Path)

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language "zh-Hans-CN"
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$rows = @()
foreach ($line in $result.Lines) {
    $words = @()
    $minX = 1e9; $minY = 1e9; $maxX = 0; $maxY = 0
    foreach ($wd in $line.Words) {
        $r = $wd.BoundingRect
        $words += $wd.Text
        if ($r.X -lt $minX) { $minX = $r.X }
        if ($r.Y -lt $minY) { $minY = $r.Y }
        if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    $rows += [pscustomobject]@{
        text = ($words -join "")
        x = [int]$minX
        y = [int]$minY
        w = [int]($maxX - $minX)
        h = [int]($maxY - $minY)
    }
}

$json = $rows | ConvertTo-Json -Compress
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $json
