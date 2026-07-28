[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$OutputDirectory = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) {
    $Version = [IO.File]::ReadAllText((Join-Path $root 'VERSION')).Trim()
}
if ($Version -notmatch '^v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$') {
    throw "版本格式无效: $Version"
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $root 'dist'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null

function Assert-FxapOutputChild {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullOutput = $output.TrimEnd('\')
    if (-not $fullPath.StartsWith($fullOutput + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作输出目录之外的路径: $fullPath"
    }
    return $fullPath
}

function Remove-FxapBuildArtifact {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = Assert-FxapOutputChild -Path $Path
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function Copy-FxapRequiredFile {
    param([Parameter(Mandatory)][string]$RelativePath)

    $source = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Release 缺少源文件: $RelativePath"
    }
    $destination = Join-Path $stage $RelativePath
    $parent = Split-Path -Parent $destination
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$packageName = "fxap-only-$Version"
$stage = Join-Path $output $packageName
$asset = Join-Path $output "$packageName-windows.zip"
$checksum = "$asset.sha256"

foreach ($path in @($stage, $asset, $checksum)) {
    Remove-FxapBuildArtifact -Path $path
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$releaseFiles = @(
    'index.js',
    'package.json',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    '.env.example',
    'VERSION',
    'component-manifest.json',
    'src\cloudflare-grants.js',
    'src\grants-api.js',
    'src\constants.js',
    'src\crypto.js',
    'src\decryptor.js',
    'src\discover.js',
    'src\java-decompiler.js',
    'src\keymaster.js',
    'tools\unluac54.jar',
    'tools\unluac54.jar.sha256'
)
foreach ($relative in $releaseFiles) {
    Copy-FxapRequiredFile -RelativePath $relative
}

$manifestPath = Join-Path $stage 'component-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.version = $Version
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 8),
    (New-Object Text.UTF8Encoding($false))
)

$packagePath = Join-Path $stage 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$package.version = $Version.Substring(1)
[IO.File]::WriteAllText(
    $packagePath,
    ($package | ConvertTo-Json -Depth 8),
    (New-Object Text.UTF8Encoding($false))
)
$versionPath = Join-Path $stage 'VERSION'
[IO.File]::WriteAllText(
    $versionPath,
    $Version + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
)

if ([string]$manifest.releaseAssetPattern -ne 'fxap-only-*-windows.zip' -or
    [string]$manifest.releaseChecksumAssetPattern -ne 'fxap-only-*-windows.zip.sha256') {
    throw '组件清单的 Release 附件规则与 CK 免费工具箱不一致。'
}

$apiHealthUri = [Uri]$null
if (-not [Uri]::TryCreate([string]$manifest.apiHealthUrl, [UriKind]::Absolute, [ref]$apiHealthUri) -or
    $apiHealthUri.Scheme -ne [Uri]::UriSchemeHttps) {
    throw '组件清单的 apiHealthUrl 必须是绝对 HTTPS 地址。'
}

foreach ($relative in @($manifest.requiredFiles)) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage ([string]$relative)) -PathType Leaf)) {
        throw "组件清单缺少打包文件: $relative"
    }
}

$jarPath = Join-Path $stage 'tools\unluac54.jar'
$jarChecksumPath = Join-Path $stage 'tools\unluac54.jar.sha256'
$jarChecksumText = [IO.File]::ReadAllText($jarChecksumPath)
$jarChecksumMatch = [regex]::Match($jarChecksumText, '(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])')
if (-not $jarChecksumMatch.Success) {
    throw 'unluac54.jar.sha256 没有有效的 SHA-256。'
}
$actualJarHash = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualJarHash -ne $jarChecksumMatch.Value.ToLowerInvariant()) {
    throw "unluac54.jar 校验失败。期望: $($jarChecksumMatch.Value)，实际: $actualJarHash"
}

$forbiddenFiles = @('.env', 'node.exe', 'java.exe')
foreach ($file in @(Get-ChildItem -LiteralPath $stage -Recurse -File)) {
    if ($file.Name -in $forbiddenFiles) {
        throw "Release 不应包含文件: $($file.FullName)"
    }
}
foreach ($directoryName in @('.git', 'node_modules', 'test', 'coverage')) {
    if (@(Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force | Where-Object Name -eq $directoryName).Count -gt 0) {
        throw "Release 不应包含目录: $directoryName"
    }
}
$exampleEnvironment = [IO.File]::ReadAllText((Join-Path $stage '.env.example')).Replace([string][char]13, '').Trim()
$expectedEnvironment = @(
    '# Optional overrides. The release works without creating a .env file.',
    '# CK_KEYMASTER_GRANTS_API_URL=https://www.fengshao.icu',
    '# CK_KEYMASTER_GRANTS_API_TOKEN=replace-with-an-alternate-bearer-token',
    '# CK_CLIENT_KEY_API_URL=https://grantsclk.ckcloud.de5.net'
) -join [string][char]10
if ($exampleEnvironment -ne $expectedEnvironment) {
    throw '.env.example 必须只保留可选的 API 覆盖配置和 Token 占位值。'
}

Compress-Archive -LiteralPath $stage -DestinationPath $asset -CompressionLevel Optimal
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($asset)
try {
    $roots = @($archive.Entries | ForEach-Object {
        $_.FullName.Replace('\', '/').Split('/')[0]
    } | Where-Object { $_ } | Select-Object -Unique)
    if ($roots.Count -ne 1 -or $roots[0] -ne $packageName) {
        throw "Release ZIP 必须只有一个顶层目录 $packageName，实际: $($roots -join ', ')"
    }
} finally {
    $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumLine = "$hash  $([IO.Path]::GetFileName($asset))" + [Environment]::NewLine
[IO.File]::WriteAllText(
    $checksum,
    $checksumLine,
    (New-Object Text.UTF8Encoding($false))
)

[pscustomobject]@{
    version = $Version
    package = $stage
    asset = $asset
    checksum = $checksum
    sha256 = $hash
    files = @(Get-ChildItem -LiteralPath $stage -Recurse -File).Count
} | ConvertTo-Json -Compress
