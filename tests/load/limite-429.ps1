Set-Location (Join-Path $PSScriptRoot '..\..')

# Sobe o consolidado com RATE_LIMIT_MAX=300, roda a rajada e devolve o serviço ao limite de produção.
# Sem ErrorActionPreference Stop: o docker escreve progresso no stderr e o PowerShell 5.1 trataria isso como erro.
$saida = 1
docker compose -f docker-compose.yml -f docker-compose.ratelimit.yml up -d --build --wait consolidado
if ($LASTEXITCODE -eq 0) {
    docker compose -f docker-compose.yml -f docker-compose.ratelimit.yml --profile loadtest run --rm k6 run /scripts/limite-429.js
    $saida = $LASTEXITCODE
}
docker compose up -d --wait consolidado
Write-Host "Código de saída do k6: $saida"
exit $saida
