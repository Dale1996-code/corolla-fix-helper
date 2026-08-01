param(
  [string]$PdfFolder = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverEnvPath = Join-Path $repoRoot "server\.env"
$exampleEnvPath = Join-Path $repoRoot ".env.example"

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path $Path)) {
    return ""
  }

  $line = Get-Content -Path $Path |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -Last 1

  if (-not $line) {
    return ""
  }

  return $line -replace "^$([regex]::Escape($Name))=", ""
}

function Set-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Value
  )

  $safeValue = ($Value -replace "(`r|`n)", "").Trim()
  $lines = @()

  if (Test-Path $Path) {
    $lines = @(Get-Content -Path $Path)
  }

  $found = $false
  $updatedLines = @(foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($Name))=") {
      $found = $true
      "$Name=$safeValue"
    } else {
      $line
    }
  })

  if (-not $found) {
    $updatedLines += "$Name=$safeValue"
  }

  Set-Content -Path $Path -Value $updatedLines -Encoding utf8
}

function Run-Step {
  param(
    [string]$Title,
    [scriptblock]$Command
  )

  Write-Host ""
  Write-Host "== $Title =="
  & $Command

  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE."
  }
}

Set-Location $repoRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 24 before running this script."
}

if (-not (Test-Path $serverEnvPath)) {
  Copy-Item -Path $exampleEnvPath -Destination $serverEnvPath
  Write-Host "Created local settings file: server\.env"
}

$openAiKey = Get-EnvValue -Path $serverEnvPath -Name "OPENAI_API_KEY"

if ([string]::IsNullOrWhiteSpace($openAiKey)) {
  Write-Host "Paste your OpenAI API key. It will be saved only in server\.env, which Git ignores."
  $secureKey = Read-Host "OpenAI API key" -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

  try {
    $openAiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }

  if ([string]::IsNullOrWhiteSpace($openAiKey)) {
    throw "OPENAI_API_KEY is required for embedding and Ask answers."
  }

  Set-EnvValue -Path $serverEnvPath -Name "OPENAI_API_KEY" -Value $openAiKey
}

Set-EnvValue -Path $serverEnvPath -Name "OPENAI_ANSWER_MODEL" -Value "gpt-5.5-2026-04-23"
Set-EnvValue -Path $serverEnvPath -Name "OPENAI_EMBEDDING_MODEL" -Value "text-embedding-3-small"
Set-EnvValue -Path $serverEnvPath -Name "OPENAI_EMBEDDING_DIMENSIONS" -Value "512"

Run-Step "Installing packages" { npm run install:all }

if ([string]::IsNullOrWhiteSpace($PdfFolder)) {
  $PdfFolder = Read-Host "PDF folder to import, or press Enter to skip"
}

if (-not [string]::IsNullOrWhiteSpace($PdfFolder)) {
  if (-not (Test-Path $PdfFolder)) {
    throw "PDF folder was not found: $PdfFolder"
  }

  Run-Step "Importing PDF folder" { npm run import -- $PdfFolder }
} else {
  Write-Host "Skipping import because no PDF folder was provided."
}

Run-Step "Embedding document chunks" { npm run embed:backfill }
Run-Step "Building frontend" { npm run build }

Write-Host ""
Write-Host "Starting Corolla Fix Helper at http://localhost:4000"
Write-Host "Leave this PowerShell window open while using the app."
npm start
