# Confere no Prometheus se cada painel do dashboard tem dado. Uso: .\scripts\verificar-dashboard.ps1 [-Minutos 30]
param([int]$Minutos = 30)
node (Join-Path $PSScriptRoot 'verificar-dashboard.js') $Minutos
exit $LASTEXITCODE
