#Requires -Version 7.4
<#
Exercises only the launcher's owned-client helper. No WSL command, Zebra node,
distro or service is started or stopped. Run with: pwsh -File test/launcher.test.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
$tokens = $null
$parseErrors = $null
$launcher = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $repo 'scripts/run-regtest.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Launcher did not parse' }
foreach ($name in @('Invoke-OwnedClient', 'Invoke-Wsl')) {
    $definition = $launcher.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $false)
    if ($null -eq $definition) { throw "Missing production helper: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-Control([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}
function Get-Timeout([scriptblock] $Action) {
    try { $unexpected = & $Action } catch {
        if ($_.Exception -is [TimeoutException]) { return $_.Exception }
        throw
    }
    throw "Expected a timeout; received $($unexpected | ConvertTo-Json -Compress)"
}

$pwsh = (Get-Process -Id $PID).Path
$node = (Get-Command node -CommandType Application).Source
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('shieldcheck-launcher-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$fixture = Join-Path $scratch 'client fixture.ps1'
$hangPid = Join-Path $scratch 'hang.pid'
$pipePid = Join-Path $scratch 'pipe.pid'
$wrapperPid = Join-Path $scratch 'wrapper.pid'
$unrelated = [Diagnostics.Process]::new()
$unrelatedStarted = $false
$pipeChild = $null
$passed = [Collections.Generic.List[string]]::new()
try {
    @'
param([string] $Mode, [string] $Value)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
switch ($Mode) {
    'success' { [Console]::Out.Write($Value); [Console]::Error.Write('stderr-control') }
    'nonzero' { [Console]::Out.Write('stdout-control'); [Console]::Error.Write('failure-control'); exit 7 }
    'bulk' { [Console]::Out.Write('x' * 131072); [Console]::Error.Write('y' * 131072) }
    'hang' { [IO.File]::WriteAllText($Value, [string]$PID); Start-Sleep -Seconds 30 }
    default { throw 'Unknown fixture mode' }
}
'@ | Set-Content -LiteralPath $fixture -Encoding utf8NoBOM
    $prefix = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $fixture)
    $marker = 'space "quote" $literal; & café'
    $success = Invoke-OwnedClient -FilePath $pwsh -Arguments ($prefix + @('success', $marker)) -TimeoutSeconds 5
    Assert-Control ($success.ExitCode -eq 0 -and $success.Stdout -ceq $marker -and $success.Stderr -ceq 'stderr-control') 'Output or argument preservation failed'
    $passed.Add('success preserves argument boundaries and both output streams')

    $nonzero = Invoke-OwnedClient -FilePath $pwsh -Arguments ($prefix + @('nonzero', '')) -TimeoutSeconds 5
    Assert-Control ($nonzero.ExitCode -eq 7 -and $nonzero.Stdout -ceq 'stdout-control' -and $nonzero.Stderr -ceq 'failure-control') 'Nonzero exit capture failed'
    $passed.Add('nonzero exit captures status and both output streams')

    $bulk = Invoke-OwnedClient -FilePath $pwsh -Arguments ($prefix + @('bulk', '')) -TimeoutSeconds 5
    Assert-Control ($bulk.ExitCode -eq 0 -and $bulk.Stdout.Length -eq 131072 -and $bulk.Stderr.Length -eq 131072) 'Concurrent pipe capture was truncated or deadlocked'
    $passed.Add('both output pipes drain concurrently beyond pipe-buffer capacity')

    # Keep a distinct owned control alive throughout the timeout. The helper
    # must never terminate it while stopping its own client.
    $unrelated.StartInfo.FileName = $node
    $unrelated.StartInfo.UseShellExecute = $false
    $unrelated.StartInfo.CreateNoWindow = $true
    $unrelated.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    foreach ($argument in @('-e', 'setTimeout(() => {}, 30000)')) { $unrelated.StartInfo.ArgumentList.Add($argument) }
    $unrelatedStarted = $unrelated.Start()
    Assert-Control $unrelatedStarted 'Unrelated control did not start'
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    $timeout = Get-Timeout { Invoke-OwnedClient -FilePath $pwsh -Arguments ($prefix + @('hang', $hangPid)) -TimeoutSeconds 1 }
    Assert-Control ($elapsed.Elapsed.TotalSeconds -lt 7) 'Hanging client exceeded timeout plus bounded cleanup'
    Assert-Control ((Get-Content -Raw -LiteralPath $hangPid) -ceq [string]$timeout.Data['OwnedClientProcessId']) 'Timeout ownership record does not match the client'
    Assert-Control ($timeout.Data['OwnedClientStopped'] -eq $true) 'Exact owned client termination was not verified'
    Assert-Control (-not $unrelated.HasExited) 'Timeout terminated an unrelated process'
    $passed.Add('hanging client times out and only the exact owned client is stopped')

    # Deliberately detach this short-lived control so Windows does not end it
    # when its parent exits. It retains the pipes beyond the client's lifetime.
    $pipeProgram = @'
const fs=require('node:fs'); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',"process.stdout.write('holding'); setTimeout(() => {}, 4000)"],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true,detached:true}); fs.writeFileSync(process.argv[1],String(c.pid)); c.unref();
'@
    $elapsed.Restart()
    $pipeTimeout = Get-Timeout { Invoke-OwnedClient -FilePath $node -Arguments @('-e', $pipeProgram, $pipePid) -TimeoutSeconds 1 }
    Assert-Control ($elapsed.Elapsed.TotalSeconds -lt 7 -and $pipeTimeout.Message.Contains('output')) 'Inherited output pipe did not obey the original deadline'
    $pipeChild = [Diagnostics.Process]::GetProcessById([int](Get-Content -Raw -LiteralPath $pipePid))
    Assert-Control (-not $pipeChild.HasExited -and -not $unrelated.HasExited) 'A timeout stopped a descendant or unrelated process'
    $passed.Add('inherited output pipes time out without stopping descendants')

    # Route the WSL wrapper to a real local hanging client. This tests retained
    # uncertainty evidence without invoking WSL or making claims about Linux.
    $script:realOwnedClient = (Get-Item Function:/Invoke-OwnedClient).ScriptBlock
    $script:wrapperArguments = $prefix + @('hang', $wrapperPid)
    $script:wrapperFilePath = $pwsh
    function Invoke-OwnedClient {
        param([string] $FilePath, [string[]] $Arguments, [int] $TimeoutSeconds)
        & $script:realOwnedClient -FilePath $script:wrapperFilePath -Arguments $script:wrapperArguments -TimeoutSeconds $TimeoutSeconds
    }
    function Get-Command {
        param([string] $Name, [string] $CommandType)
        Assert-Control ($Name -ceq 'wsl.exe' -and $CommandType -ceq 'Application') 'Unexpected wrapper executable lookup'
        return [pscustomobject]@{ Source = $script:wrapperFilePath }
    }
    $script:Distribution = 'control-only'
    $script:wslOperationsUnverified = @()
    $wrapperTimeout = Get-Timeout { Invoke-Wsl -Arguments @('ownership-control') -TimeoutSeconds 1 }
    Assert-Control ($script:wslOperationsUnverified.Count -eq 1) 'WSL timeout uncertainty was not retained'
    $record = $script:wslOperationsUnverified[0]
    Assert-Control ($record.clientProcessId -eq $wrapperTimeout.Data['OwnedClientProcessId'] -and
        $record.clientStopped -eq $true -and $record.linuxCompletionVerified -eq $false -and
        $record.operation -ceq 'ownership-control') 'Windows client termination was treated as Linux command completion'
    Assert-Control (-not $unrelated.HasExited) 'Wrapper timeout terminated an unrelated process'
    $passed.Add('WSL wrapper retains owned-client evidence and unverified Linux completion')

    Assert-Control ($pipeChild.WaitForExit(6000)) 'Pipe control did not exit on its own deadline'
    [ordered]@{ status = 'passed'; count = $passed.Count; checks = @($passed) } | ConvertTo-Json
} catch {
    throw "Launcher helper controls failed after $($passed.Count) checks: $($_.Exception.Message)"
} finally {
    if ($null -ne $pipeChild) { $pipeChild.Dispose() }
    if ($unrelatedStarted -and -not $unrelated.HasExited) {
        $unrelated.Kill($false)
        if (-not $unrelated.WaitForExit(5000)) { throw 'Owned test control did not stop' }
    }
    $unrelated.Dispose()
    foreach ($path in @($fixture, $hangPid, $pipePid, $wrapperPid)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    }
    Remove-Item -LiteralPath $scratch
}
