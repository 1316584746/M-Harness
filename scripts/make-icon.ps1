# 生成应用图标 build/icon.png（256x256）。图形与 desktop/renderer/src/components/Logo.tsx 一致。
# 用法：powershell -File scripts/make-icon.ps1；再运行 node scripts/make-ico.mjs 生成 build/icon.ico
Add-Type -AssemblyName System.Drawing
$S = 256
$bmp = New-Object System.Drawing.Bitmap($S, $S)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

$k = $S / 24.0
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#2b2e3a'))
$g.FillEllipse($bg, 0, 0, $S - 1, $S - 1)

$teal = [System.Drawing.ColorTranslator]::FromHtml('#86b9bf')
$pen = New-Object System.Drawing.Pen($teal, [single](0.8 * $k))
$rx = 7.6 * $k
$ry = 3.0 * $k
foreach ($deg in 30, 90, 150) {
  $g.ResetTransform()
  $g.TranslateTransform($S / 2.0, $S / 2.0)
  $g.RotateTransform($deg)
  $g.DrawEllipse($pen, [single](-$rx), [single](-$ry), [single](2 * $rx), [single](2 * $ry))
}
$g.ResetTransform()
$dot = New-Object System.Drawing.SolidBrush($teal)
$r = 1.1 * $k
$g.FillEllipse($dot, [single]($S / 2.0 - $r), [single]($S / 2.0 - $r), [single](2 * $r), [single](2 * $r))

New-Item -ItemType Directory -Force -Path "$PSScriptRoot/../build" | Out-Null
$out = [System.IO.Path]::GetFullPath("$PSScriptRoot/../build/icon.png")
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved $out"
