#Requires -Version 7.4
<#
Creates one isolated, disposable Zebra node; runs the native checkout benchmark;
stops only processes whose executable and unique runtime arguments match.
#>
[CmdletBinding()]
param(
    [string] $Distribution = 'Ubuntu-24.04',
    [string] $ZebraArchive,
    [string] $ReportDirectory,
    [ValidateRange(0, 65535)][int] $RpcPort = 0,
    [switch] $NoBuild
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
$version = '6.4.2'
$archiveName = "zebrad-$version-x86_64-unknown-linux-gnu.tar.gz"
$archiveSha256 = '505cab2c616dac1a5bc1c414716206a775f38f41ca6f70a60729df40c29e7b8b'
$genesis = '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327'
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$runtime = Join-Path $repo ".local/runs/$runId"
$nodeProcess = $null
$benchmarkProcess = $null
$linuxNode = $null
$linuxConfig = $null
$benchmarkExit = $null
$clock = [Diagnostics.Stopwatch]::StartNew()

function Invoke-Wsl([string[]] $Arguments) {
    $answer = & wsl.exe -d $Distribution -- @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL operation failed: $($Arguments[0])" }
    return $answer
}
function ConvertTo-LinuxPath([string] $Path) {
    return (Invoke-Wsl @('wslpath', '-a', $Path.Replace('\', '/'))).Trim()
}
function Quote-Shell([string] $Value) {
    return "'" + $Value.Replace("'", "'" + '"' + "'" + '"' + "'") + "'"
}
function Invoke-Rpc([string] $Method, [object[]] $Parameters = @()) {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method Post `
        -ContentType 'application/json' -Body (@{jsonrpc='2.0';id=1;method=$Method;params=$Parameters} | ConvertTo-Json -Compress) `
        -NoProxy -MaximumRedirection 0 -TimeoutSec 2
    if ($response.PSObject.Properties['error'] -and $null -ne $response.error) { throw 'Node RPC failed' }
    if (-not $response.PSObject.Properties['result']) { throw 'Node RPC result missing' }
    return $response.result
}
function Assert-OwnedNode([string] $ProcessId) {
    if ($ProcessId -notmatch '^[1-9][0-9]{0,9}$' -or [long]$ProcessId -le 1) { throw 'Invalid owned node PID' }
    $command = (Invoke-Wsl @('cat', "/proc/$ProcessId/cmdline")) -join "`n"
    $arguments = $command.Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
    if ($arguments.Count -ne 4 -or $arguments[0] -cne $linuxNode -or $arguments[1] -cne '-c' -or
        $arguments[2] -cne $linuxConfig -or $arguments[3] -cne 'start') {
        throw 'Node ownership mismatch; refused to stop process'
    }
}
function Stop-OwnedNode {
    if ($null -eq $nodeProcess) { return }
    $nodeProcess.Refresh()
    if ($nodeProcess.HasExited) { return }
    $pidPath = Join-Path $runtime 'node.pid'
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { throw 'Owned node PID record missing; inspect runtime' }
    $nodeId = (Get-Content -Raw -LiteralPath $pidPath).Trim()
    Assert-OwnedNode $nodeId
    Invoke-Wsl @('kill', '-TERM', $nodeId) | Out-Null
    if (-not $nodeProcess.WaitForExit(30000)) { throw 'Owned node did not stop within 30 seconds' }
}
function Stop-OwnedBenchmark {
    if ($null -eq $benchmarkProcess) { return }
    $benchmarkProcess.Refresh()
    if ($benchmarkProcess.HasExited) { return }
    $observed = Get-CimInstance Win32_Process -Filter "ProcessId=$($benchmarkProcess.Id)"
    if ($null -eq $observed -or $observed.ExecutablePath -ine $nodeExe -or
        -not $observed.CommandLine.Contains($cliPath) -or -not $observed.CommandLine.Contains($ReportDirectory) -or
        [math]::Abs(($observed.CreationDate.ToUniversalTime() - $benchmarkProcess.StartTime.ToUniversalTime()).TotalMilliseconds) -gt 1) {
        throw 'Benchmark ownership mismatch; refused to stop process tree'
    }
    & taskkill.exe /PID $benchmarkProcess.Id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Owned benchmark process tree did not stop' }
}

try {
    if (-not $IsWindows) { throw 'This launcher requires Windows, PowerShell 7.4+ and WSL' }
    if ($RpcPort -gt 0 -and $RpcPort -lt 1024) { throw 'Use a non-privileged RPC port or zero for automatic allocation' }
    $nodeExe = (Get-Command node -CommandType Application).Source
    $cliPath = Join-Path $repo 'src/cli.mjs'
    $nativeExe = Join-Path $repo 'native/target/release/shieldcheck-native.exe'
    if (-not $NoBuild) {
        & cargo build --release --locked --manifest-path (Join-Path $repo 'native/Cargo.toml')
        if ($LASTEXITCODE -ne 0) { throw 'Native release build failed' }
    }
    if (-not (Test-Path -LiteralPath $nativeExe -PathType Leaf)) { throw 'Native release executable missing; run without -NoBuild' }
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'Benchmark CLI missing' }
    if (-not $ReportDirectory) { $ReportDirectory = Join-Path $repo "reports/$runId" }
    $ReportDirectory = [IO.Path]::GetFullPath($ReportDirectory)
    if (Test-Path -LiteralPath $ReportDirectory) { throw 'Report directory must not already exist' }
    if ($ReportDirectory.Contains('"')) { throw 'Invalid report directory' }
    $portReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $RpcPort)
    $portReservation.Server.ExclusiveAddressUse = $true
    try { $portReservation.Start(); $RpcPort = $portReservation.LocalEndpoint.Port } finally { $portReservation.Stop() }
    New-Item -ItemType Directory -Path $runtime | Out-Null
    $toolsDirectory = Join-Path $repo ".local/tools/zebra-$version"
    [IO.Directory]::CreateDirectory($toolsDirectory) | Out-Null
    if (-not $ZebraArchive) {
        $ZebraArchive = Join-Path $toolsDirectory $archiveName
        if (-not (Test-Path -LiteralPath $ZebraArchive)) {
            $download = Join-Path $runtime 'node.download'
            Invoke-WebRequest -Uri "https://github.com/ZcashFoundation/zebra/releases/download/v$version/$archiveName" `
                -OutFile $download -ConnectionTimeoutSeconds 30 -OperationTimeoutSeconds 120
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -cne $archiveSha256) { throw 'Node archive checksum mismatch' }
            [IO.File]::Move($download, $ZebraArchive, $false)
        }
    }
    $ZebraArchive = [IO.Path]::GetFullPath($ZebraArchive)
    if ((Get-FileHash -LiteralPath $ZebraArchive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $archiveSha256) { throw 'Node archive checksum mismatch' }
    Invoke-Wsl @('tar', '-xzf', (ConvertTo-LinuxPath $ZebraArchive), '-C', (ConvertTo-LinuxPath $toolsDirectory)) | Out-Null
    $linuxNode = (ConvertTo-LinuxPath (Join-Path $toolsDirectory 'zebrad'))
    if ((Invoke-Wsl @($linuxNode, '--version')).Trim() -cne "zebrad $version") { throw 'Node version mismatch' }
    $linuxRuntime = ConvertTo-LinuxPath $runtime
    $linuxConfig = "$linuxRuntime/zebrad.toml"
    # Escape TOML strings separately from shell arguments.
    $tomlRuntime = $linuxRuntime.Replace('\', '\\').Replace('"', '\"')
    @"
[network]
network = "Regtest"
listen_addr = "127.0.0.1:0"
initial_mainnet_peers = []
initial_testnet_peers = []
cache_dir = false

[network.testnet_parameters.activation_heights]
"NU6.3" = 1

[state]
ephemeral = true
cache_dir = "$tomlRuntime/state"
delete_old_database = false

[rpc]
listen_addr = "127.0.0.1:$RpcPort"
enable_cookie_auth = false
cookie_dir = "$tomlRuntime/cookie"
"@ | Set-Content -LiteralPath (Join-Path $runtime 'zebrad.toml') -Encoding utf8NoBOM
    $launch = "#!/bin/sh`nset -eu`necho `$`$ > $(Quote-Shell "$linuxRuntime/node.pid")`nexec $(Quote-Shell $linuxNode) -c $(Quote-Shell $linuxConfig) start`n"
    [IO.File]::WriteAllText((Join-Path $runtime 'start-node.sh'), $launch, [Text.UTF8Encoding]::new($false))
    $nodeProcess = Start-Process -FilePath wsl.exe -WindowStyle Hidden -PassThru `
        -ArgumentList @('-d', $Distribution, '--', 'sh', "`"$linuxRuntime/start-node.sh`"") `
        -RedirectStandardOutput (Join-Path $runtime 'node.stdout.log') -RedirectStandardError (Join-Path $runtime 'node.stderr.log')
    $readyBy = [DateTime]::UtcNow.AddSeconds(90)
    $ready = $false
    do {
        $nodeProcess.Refresh()
        if ($nodeProcess.HasExited) { throw 'Owned node exited before readiness; inspect runtime logs' }
        if ([DateTime]::UtcNow -ge $readyBy) { throw 'Owned node readiness timed out' }
        try {
            if (Select-String -LiteralPath (Join-Path $runtime 'node.stdout.log') -SimpleMatch "Opened RPC endpoint at 127.0.0.1:$RpcPort" -Quiet) {
                Assert-OwnedNode ((Get-Content -Raw -LiteralPath (Join-Path $runtime 'node.pid')).Trim())
                $info = Invoke-Rpc 'getblockchaininfo'
                if ($info.blocks -eq 0 -and $info.consensus.nextblock -ceq '37a5165b' -and
                    (Invoke-Rpc 'getblockhash' @(0)) -ceq $genesis -and @(Invoke-Rpc 'getpeerinfo').Count -eq 0) { $ready = $true }
            }
        } catch { }
        if (-not $ready) { Start-Sleep -Milliseconds 200 }
    } while (-not $ready)
    $owner = [ordered]@{run=$runId;rpcPort=$RpcPort;nodeVersion=$version;nodeProcess=$nodeProcess.Id;runtime=$runtime;reportDirectory=$ReportDirectory}
    $owner | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'owner.json') -Encoding utf8NoBOM
    $benchmarkProcess = Start-Process -FilePath $nodeExe -WindowStyle Hidden -PassThru `
        -ArgumentList @("`"$cliPath`"", '--native', "`"$nativeExe`"", '--rpc-port', "$RpcPort", '--out', "`"$ReportDirectory`"") `
        -RedirectStandardOutput (Join-Path $runtime 'benchmark.stdout.log') -RedirectStandardError (Join-Path $runtime 'benchmark.stderr.log')
    if (-not $benchmarkProcess.WaitForExit(900000)) { throw 'Benchmark exceeded 15-minute limit' }
    $benchmarkExit = $benchmarkProcess.ExitCode
    if ($benchmarkExit -ne 0) { throw "Benchmark did not complete successfully (exit $benchmarkExit); inspect its redacted report and private runtime logs" }
    # Save only public chain facts from this disposable run, never the payment
    # disclosure or invoice. The node is ephemeral and is about to shut down.
    $completedReport = Get-Content -Raw -LiteralPath (Join-Path $ReportDirectory 'report.json') | ConvertFrom-Json
    $finalTip = Invoke-Rpc 'getblockchaininfo'
    if ($completedReport.status -cne 'completed' -or $completedReport.native.status -cne 'verified' -or
        $finalTip.blocks -ne $completedReport.native.blockHeight) { throw 'Report and final node checkpoint disagree' }
    $finalHash = Invoke-Rpc 'getblockhash' @($finalTip.blocks)
    $finalBlock = Invoke-Rpc 'getblock' @($finalHash, 1)
    if ($finalBlock.hash -cne $finalHash -or $finalBlock.height -ne $finalTip.blocks -or @($finalBlock.tx).Count -ne 2) {
        throw 'Unexpected final benchmark block'
    }
    [ordered]@{
        schema='shieldcheck-chain-evidence/v1'; network='regtest'; nodeVersion=$version
        genesis=(Invoke-Rpc 'getblockhash' @(0)); branchId=$finalTip.consensus.chaintip
        blockHeight=$finalBlock.height; blockHash=$finalHash; transactionIds=@($finalBlock.tx)
        nativeSha256=(Get-FileHash -LiteralPath $nativeExe -Algorithm SHA256).Hash.ToLowerInvariant()
        reportSha256=(Get-FileHash -LiteralPath (Join-Path $ReportDirectory 'report.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runtime 'chain-evidence.json') -Encoding utf8NoBOM
} finally {
    # Always try both cleanup operations; a failure must be visible.
    $cleanupErrors = @()
    try { Stop-OwnedBenchmark } catch { $cleanupErrors += $_.Exception.Message }
    try { Stop-OwnedNode } catch { $cleanupErrors += $_.Exception.Message }
    if (Test-Path -LiteralPath $runtime -PathType Container) {
        [ordered]@{run=$runId;benchmarkExit=$benchmarkExit;elapsedSeconds=[math]::Round($clock.Elapsed.TotalSeconds,2);cleanupComplete=($cleanupErrors.Count -eq 0)} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'lifecycle.json') -Encoding utf8NoBOM
    }
    if ($cleanupErrors.Count -gt 0) { throw ($cleanupErrors -join '; ') }
}
Write-Output "ShieldCheck benchmark complete: $ReportDirectory"
