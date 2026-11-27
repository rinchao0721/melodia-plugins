# 把 download-bridge 目录打成 .melodiaplugin（zip），只用 PowerShell 自带命令，无需 Python / Add-Type。
# 用法：
#   .\build.ps1
#   .\build.ps1 -ExtraHosts your.host,api.example.com
param(
    [string[]] $ExtraHosts = @()
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$manifestPath = Join-Path $root 'plugin.json'
$manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$jsonText = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8)

if ($ExtraHosts.Count -gt 0) {
    $hosts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($h in $manifest.network.hosts) { $hosts.Add([string]$h) }
    foreach ($h in $ExtraHosts) {
        $name = ([string]$h).Trim().ToLowerInvariant()
        if ($name -and -not $hosts.Contains($name)) { $hosts.Add($name) }
    }
    $manifest.network.hosts = $hosts.ToArray()
    $jsonText = $manifest | ConvertTo-Json -Depth 20
    "追加域名: " + ($hosts -join ', ')
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ('xhdb-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
[IO.File]::WriteAllText((Join-Path $stage 'plugin.json'), $jsonText, (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $stage 'main.js'), [IO.File]::ReadAllText((Join-Path $root 'main.js'), [Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding($false)))

$output = Join-Path $root 'download-bridge.melodiaplugin'
$zipTemp = Join-Path ([IO.Path]::GetTempPath()) ('xhdb-' + [guid]::NewGuid().ToString('N') + '.zip')
if ([IO.File]::Exists($zipTemp)) { [IO.File]::Delete($zipTemp) }
Compress-Archive -Path (Join-Path $stage 'plugin.json'), (Join-Path $stage 'main.js') -DestinationPath $zipTemp -CompressionLevel Optimal
if ([IO.File]::Exists($output)) { [IO.File]::Delete($output) }
[IO.File]::Move($zipTemp, $output)

$verify = Join-Path ([IO.Path]::GetTempPath()) ('xhdb-verify-' + [guid]::NewGuid().ToString('N'))
$verifyZip = $verify + '.zip'
[IO.File]::Copy($output, $verifyZip, $true)
Expand-Archive -Path $verifyZip -DestinationPath $verify -Force
"包内文件:"
foreach ($f in (Get-ChildItem -LiteralPath $verify -File)) { "  " + $f.Name + "  " + $f.Length + " bytes" }
$packed = [IO.File]::ReadAllText((Join-Path $verify 'plugin.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
"版本: " + $packed.version + "  apiVersion: " + $packed.apiVersion + "  下载源: " + ($packed.contributes.downloadSources.id -join ',')
"域名: " + ($packed.network.hosts -join ', ')
$file = Get-Item -LiteralPath $output
"产物: " + $file.FullName
"大小: " + $file.Length + " bytes"
"sha256: " + (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.Directory]::Delete($stage, $true)
[IO.Directory]::Delete($verify, $true)
if ([IO.File]::Exists($verifyZip)) { [IO.File]::Delete($verifyZip) }
