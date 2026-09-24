<#
.SYNOPSIS
Creates an isolated local caption runtime without changing Windows or PATH.
.DESCRIPTION
Run from PowerShell with Python 3.10+ installed. By default this installs
faster-whisper and explicitly downloads Systran's multilingual small model.
Use -Model tiny for a smaller test model, -SkipModelDownload to install only
the Python dependency, or -CheckOnly to inspect an existing setup offline.
Choose the printed Python executable and model folder in the desktop app.
.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/setup-transcription.ps1
.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/setup-transcription.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
    [string]$PythonExecutable = 'python',
    [string]$EnvironmentDirectory,
    [ValidateSet('tiny', 'base', 'small')]
    [string]$Model = 'small',
    [string]$ModelDirectory,
    [switch]$SkipModelDownload,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($EnvironmentDirectory)) {
    $candidateProject = Split-Path -Parent $PSScriptRoot
    if ((Test-Path -LiteralPath (Join-Path $candidateProject 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $candidateProject 'src-tauri'))) {
        $EnvironmentDirectory = Join-Path $candidateProject '.venv-captions'
    } else {
        # An installed app may live under Program Files; speech data belongs to the user.
        $localData = [Environment]::GetFolderPath('LocalApplicationData')
        if ([string]::IsNullOrWhiteSpace($localData)) { throw 'Local application data is unavailable. Pass -EnvironmentDirectory explicitly.' }
        $EnvironmentDirectory = Join-Path $localData 'com.aireelstudio.app\speech-runtime'
    }
}
$environmentPath = [System.IO.Path]::GetFullPath($EnvironmentDirectory)
$environmentPython = Join-Path $environmentPath 'Scripts\python.exe'
if ([string]::IsNullOrWhiteSpace($ModelDirectory)) {
    $ModelDirectory = Join-Path $environmentPath "models\faster-whisper-$Model"
}
$modelPath = [System.IO.Path]::GetFullPath($ModelDirectory)
$modelFiles = @('model.bin', 'config.json', 'tokenizer.json')

function Test-LocalModel {
    foreach ($file in $modelFiles) {
        $path = Join-Path $modelPath $file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $path).Length -eq 0) { return $false }
    }
    return $true
}

function Test-LocalProvider {
    if (-not (Test-Path -LiteralPath $environmentPython -PathType Leaf)) { return $false }
    # Match the application's isolated interpreter: --user packages do not count.
    $probe = @'
import importlib.util
import sys
if importlib.util.find_spec('faster_whisper') is None:
    print('faster-whisper is not installed in this virtual environment.')
    sys.exit(1)
try:
    import faster_whisper
    from importlib.metadata import version
    print('faster-whisper ' + version('faster-whisper'))
except Exception as error:
    print('faster-whisper could not load: ' + str(error))
    sys.exit(1)
'@
    & $environmentPython -I -c $probe | Out-Host
    return ($LASTEXITCODE -eq 0)
}

if ($CheckOnly) {
    $providerReady = Test-LocalProvider
    $modelReady = Test-LocalModel
    Write-Host "Python executable: $environmentPython"
    Write-Host "Local model folder: $modelPath"
    Write-Host "Python provider ready: $providerReady"
    Write-Host "Required model files present: $modelReady"
    Write-Host 'This checks dependencies only; use the desktop app to verify a real speech clip.'
    Write-Host 'FFmpeg must be detected or configured separately in the desktop app.'
    if (-not ($providerReady -and $modelReady)) { exit 1 }
    exit 0
}

if (-not (Test-Path -LiteralPath $environmentPython -PathType Leaf)) {
    if (Test-Path -LiteralPath $environmentPath) {
        $existing = @(Get-ChildItem -LiteralPath $environmentPath -Force)
        if ($existing.Count -gt 0) {
            throw "Refusing to replace an incomplete or unrelated folder: $environmentPath. Choose a new -EnvironmentDirectory."
        }
    }
    $pythonCommand = Get-Command -Name $PythonExecutable -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $pythonCommand) {
        throw 'Python was not found. Install Python 3.10+ or pass -PythonExecutable with its full path.'
    }
    & $pythonCommand.Source -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required for this setup helper.' }
    & $pythonCommand.Source -m venv $environmentPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the caption virtual environment.' }
} elseif (-not (Test-Path -LiteralPath (Join-Path $environmentPath 'pyvenv.cfg') -PathType Leaf)) {
    throw "This is not a virtual environment: $environmentPath. Choose a new -EnvironmentDirectory."
}

Write-Host "Installing caption dependencies into $environmentPath"
& $environmentPython -m pip install --disable-pip-version-check 'faster-whisper==1.2.1'
if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation failed. Check the preceding pip error and network access, then rerun this script.'
}
if (-not (Test-LocalProvider)) { throw 'The installed caption provider could not load.' }

if (-not $SkipModelDownload -and -not (Test-LocalModel)) {
    $repository = "Systran/faster-whisper-$Model"
    Write-Host "Downloading the multilingual model from $repository to $modelPath"
    $download = @'
import sys
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id=sys.argv[1],
    local_dir=sys.argv[2],
    allow_patterns=['model.bin', 'config.json', 'tokenizer.json',
                    'preprocessor_config.json', 'vocabulary.*'],
)
'@
    & $environmentPython -I -c $download $repository $modelPath
    if ($LASTEXITCODE -ne 0) {
        throw 'Model download failed. Rerun to resume it, or select an existing local CTranslate2 model in the app.'
    }
    if (-not (Test-LocalModel)) { throw 'The downloaded model is missing required nonempty files.' }
} elseif (-not $SkipModelDownload) {
    Write-Host 'Required model files already exist; keeping the selected local model.'
}

Write-Host ''
Write-Host 'Select these values in the desktop caption panel:'
Write-Host "Python executable: $environmentPython"
Write-Host "Local model folder: $modelPath"
if ($SkipModelDownload -and -not (Test-LocalModel)) {
    Write-Host 'No complete model is present at that location. Choose your existing model folder in the app.'
}
Write-Host 'FFmpeg must also be detected or configured in the desktop app.'
Write-Host 'Caption generation runs locally and does not download models.'
