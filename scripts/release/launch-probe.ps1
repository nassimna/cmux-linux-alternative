param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Executable,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ApplicationArguments
)

$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-workspace-launch-probe-{0}" -f [guid]::NewGuid())
$log = Join-Path $scratch 'application.log'
$errorLog = Join-Path $scratch 'application-error.log'
$process = $null
$passed = $false

function Get-DescendantProcesses([int]$RootProcessId) {
  $processes = @(Get-CimInstance Win32_Process)
  $descendantIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$descendantIds.Add($RootProcessId)
  for ($pass = 0; $pass -lt $processes.Count; $pass += 1) {
    foreach ($candidate in $processes) {
      if ($descendantIds.Contains([int]$candidate.ParentProcessId)) {
        [void]$descendantIds.Add([int]$candidate.ProcessId)
      }
    }
  }
  return @($processes | Where-Object { $descendantIds.Contains([int]$_.ProcessId) })
}

try {
  New-Item -ItemType Directory -Path $scratch | Out-Null
  foreach ($directory in @('profile', 'appdata', 'local-appdata', 'temp')) {
    New-Item -ItemType Directory -Path (Join-Path $scratch $directory) | Out-Null
  }
  $env:USERPROFILE = Join-Path $scratch 'profile'
  $env:APPDATA = Join-Path $scratch 'appdata'
  $env:LOCALAPPDATA = Join-Path $scratch 'local-appdata'
  $env:TEMP = Join-Path $scratch 'temp'
  $env:TMP = $env:TEMP

  $arguments = @('--disable-gpu') + @($ApplicationArguments)
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError $errorLog

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($process.HasExited) {
      throw "Packaged application exited before readiness with code $($process.ExitCode)."
    }
    $tree = @(Get-DescendantProcesses -RootProcessId $process.Id)
    $service = $tree | Where-Object {
      $_.CommandLine -match 'resources[\\/]bin[\\/]agent-workspace-service\.exe(?:\s|"|$)'
    } | Select-Object -First 1
    $renderer = $tree | Where-Object { $_.CommandLine -match '(?:^|\s)--type=renderer(?:\s|$)' } |
      Select-Object -First 1
    if ($null -ne $service -and $null -ne $renderer) {
      $passed = $true
      Write-Output "packaged launch ready: main=$($process.Id) service=$($service.ProcessId) renderer=$($renderer.ProcessId)"
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $passed) {
    throw 'Timed out waiting for service and renderer readiness.'
  }
}
finally {
  if ($null -ne $process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
  }
  if (-not $passed) {
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
