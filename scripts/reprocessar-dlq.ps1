<#
.SYNOPSIS
  Devolve as mensagens da DLQ do consolidado à fila principal.
.DESCRIPTION
  Usa a API de gerenciamento do RabbitMQ (porta 15672) por meio de scripts\reprocessar-dlq.js, que precisa só do Node 20.
  Reentregar é seguro porque o consumidor é idempotente. Mensagem inválida volta para a DLQ; corrija a causa antes.
.EXAMPLE
  .\scripts\reprocessar-dlq.ps1 -Simular
  .\scripts\reprocessar-dlq.ps1
  .\scripts\reprocessar-dlq.ps1 -Limite 10
#>
param(
    [int]$Limite = 0,
    [switch]$Simular,
    [string]$Url = 'http://localhost:15672',
    [string]$Usuario = 'rabbit',
    [string]$Senha = 'rabbit'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 20 ou superior é necessário para este script.'
    exit 2
}

$argumentos = @((Join-Path $PSScriptRoot 'reprocessar-dlq.js'), '--url', $Url, '--usuario', $Usuario, '--senha', $Senha)
if ($Limite -gt 0) { $argumentos += @('--limite', "$Limite") }
if ($Simular) { $argumentos += '--simular' }

& node @argumentos
exit $LASTEXITCODE
