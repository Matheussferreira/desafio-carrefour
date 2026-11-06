# Ciclo completo dos testes de integração, para PowerShell:
#   1. sobe a infra isolada (postgres:5433, rabbitmq:5673, redis:6380)
#   2. roda os testes de integração dos dois serviços
#   3. derruba a infra, passe ou falhe
#
# Uso: .\test-integration.ps1
# Requer Docker Desktop (Compose v2) e Node 24 ou superior.

$raiz = $PSScriptRoot
$compose = Join-Path $raiz 'docker-compose.integration.yml'
$falhou = $false

try {
    Write-Host '-> Subindo infra isolada (postgres:5433, rabbitmq:5673, redis:6380)...'
    docker compose -f $compose up -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao subir a infra de integração' }

    $env:RABBITMQ_URL = 'amqp://rabbit:rabbit@localhost:5673'
    $env:REDIS_URL = 'redis://localhost:6380'

    $servicos = @(
        @{ nome = 'lancamentos'; banco = 'lancamentos_db' },
        @{ nome = 'consolidado'; banco = 'consolidado_db' }
    )

    foreach ($s in $servicos) {
        Write-Host ''
        Write-Host "=== Integração: $($s.nome) ==="
        $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/$($s.banco)"
        Push-Location (Join-Path $raiz "services\$($s.nome)")
        try {
            if (-not (Test-Path 'node_modules')) { npm ci --no-audit --no-fund }
            npm run test:integration
            if ($LASTEXITCODE -ne 0) { $falhou = $true }
        }
        finally { Pop-Location }
    }
}
finally {
    Write-Host ''
    Write-Host '-> Derrubando infra de integração...'
    docker compose -f $compose down -v 2>$null | Out-Null
}

if ($falhou) { Write-Host 'Testes de integração FALHARAM'; exit 1 }
Write-Host 'Testes de integração concluídos com sucesso'
exit 0
