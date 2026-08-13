param(
    [string]$LogPath = '',
    [switch]$Watch
)

$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path $PSScriptRoot -Parent

function Get-TrainingProcs {
    @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
        $_.CommandLine -match 'train\.py' -and $_.CommandLine -match '--config'
    })
}

function Show-Status {
    if ($LogPath) {
        $stderrLog = $LogPath
    } else {
        # 查找训练日志：优先匹配正在运行的进程的 --config 参数；否则取最新修改的
        $runningConfig = $null
        $allProcs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
            $_.CommandLine -match 'train\.py' -and $_.CommandLine -match '--config\s+(\S+\.json)'
        })
        if ($allProcs.Count -gt 0 -and $allProcs[0].CommandLine -match '--config\s+(\S+\.json)') {
            $configName = [IO.Path]::GetFileNameWithoutExtension($Matches[1])
            $runningConfig = $configName
        }
        $candidates = @(Get-ChildItem -Path (Join-Path $repo 'data\sr_train') -Filter '_train_*.stderr.log' -File -ErrorAction SilentlyContinue)
        if ($runningConfig -and $candidates) {
            $matched = $candidates | Where-Object { $_.Name -match $runningConfig } | Select-Object -First 1
            $stderrLog = if ($matched) { $matched.FullName } else { ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
        } else {
            $stderrLog = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        }
    }

    Write-Host '=== AIcut SR training status ==='
    Write-Host ("Time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Host ("Log file: " + $stderrLog)

    if (Test-Path $stderrLog) {
        $lines = Get-Content -Tail 300 -Encoding UTF8 $stderrLog
        $lastIter = $lines | Select-String -Pattern '\[train\] iter=\d+/\d+' | Select-Object -Last 1
        $lastVal = $lines | Select-String -Pattern '\[train\] iter=\d+ val ' | Select-Object -Last 1
        if ($lastIter) {
            Write-Host ("Last iteration: " + $lastIter.Line.Trim())
        } else {
            Write-Host 'Last iteration: no iteration line yet'
        }
        if ($lastVal) {
            Write-Host ("Last val: " + $lastVal.Line.Trim())
        }

        $issues = $lines | Select-String -Pattern 'WARN|NaN|Traceback|RuntimeError|AssertionError|UserWarning' | Select-Object -Last 5
        if ($issues) {
            Write-Host 'Recent warnings/errors:'
            $issues | ForEach-Object { Write-Host ('  ' + $_.Line.Trim()) }
        } else {
            Write-Host 'Recent warnings/errors: none'
        }
    } else {
        Write-Host 'Last iteration: training log not found'
        Write-Host 'Recent warnings/errors: n/a'
    }

    $procs = Get-TrainingProcs
    if ($procs.Count -gt 0) {
        $pids = ($procs | ForEach-Object { $_.ProcessId }) -join ', '
        Write-Host ("Training process: RUNNING (PID " + $pids + ")")
    } else {
        Write-Host 'Training process: NOT RUNNING'
    }

    $logBase = [IO.Path]::GetFileNameWithoutExtension([IO.Path]::GetFileNameWithoutExtension($stderrLog))
    $ckptDir = Join-Path $repo ("python\sr\checkpoints\" + ($logBase -replace '^_train_', ''))
    $ckpts = @(Get-ChildItem -Path $ckptDir -Filter 'model_g_*.pth' -ErrorAction SilentlyContinue)
    if ($ckpts.Count -gt 0) {
        $newest = $ckpts | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        Write-Host ("Checkpoints: " + $ckpts.Count + ", newest " + $newest.Name)
    } else {
        Write-Host 'Checkpoints: none yet'
    }

    $gpu = nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader 2>$null
    if ($gpu) {
        Write-Host ('GPU: ' + ($gpu -join '; '))
    } else {
        Write-Host 'GPU: nvidia-smi unavailable'
    }
}

$procs = Get-TrainingProcs
if ($Watch -or $procs.Count -gt 0) {
    Write-Host 'Watching training status every 2 seconds. Press Ctrl+C to exit.'
    while ($true) {
        Clear-Host
        Show-Status
        Start-Sleep -Seconds 2
        $procs = Get-TrainingProcs
        if (-not $Watch -and $procs.Count -eq 0) {
            Write-Host ''
            Write-Host 'Training process ended. Press Ctrl+C to close.'
            break
        }
    }
} else {
    Show-Status
}
