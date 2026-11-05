# Popula o sistema com lançamentos de exemplo, pela API (nunca direto no banco).
# Opcional. Pode rodar mais de uma vez no mesmo dia: as chaves de idempotência evitam duplicar.
#
# Uso: .\scripts\seed-demo.ps1
param(
    [string]$LancamentosUrl = 'http://localhost:3001',
    [string]$ConsolidadoUrl = 'http://localhost:3002',
    [string]$Comerciante = 'padrao'
)

$ErrorActionPreference = 'Stop'

$login = Invoke-RestMethod -Method Post -Uri "$LancamentosUrl/auth/login" `
    -ContentType 'application/json' -Body (@{ comerciante = $Comerciante } | ConvertTo-Json -Compress)
$auth = @{ Authorization = "Bearer $($login.token)" }

$hoje = (Get-Date).ToString('yyyy-MM-dd')
$ontem = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')

$itens = @(
    @{ n = '001'; valor = '1500.00'; tipo = 'credito'; descricao = 'Venda produto A'; data = $ontem },
    @{ n = '002'; valor = '200.50'; tipo = 'debito'; descricao = 'Compra de insumos'; data = $ontem },
    @{ n = '003'; valor = '3200.00'; tipo = 'credito'; descricao = 'Venda produto B'; data = $hoje },
    @{ n = '004'; valor = '450.75'; tipo = 'debito'; descricao = 'Aluguel do ponto'; data = $hoje }
)

foreach ($i in $itens) {
    $corpo = @{ valor = $i.valor; tipo = $i.tipo; descricao = $i.descricao; data = $i.data } | ConvertTo-Json -Compress
    $headers = $auth + @{ 'X-Idempotency-Key' = "seed-demo-$($i.data)-$($i.n)" }
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$LancamentosUrl/lancamentos" `
        -Headers $headers -ContentType 'application/json' -Body $corpo
    $situacao = if ($resp.StatusCode -eq 201) { 'criado' } else { 'ja existia' }
    Write-Host ("{0} {1,-7} {2,10}  {3}" -f $i.data, $i.tipo, $i.valor, $situacao)
}

Write-Host ''
Write-Host 'Aguardando o consolidado processar os eventos...'
Start-Sleep -Seconds 4

foreach ($dia in @($ontem, $hoje)) {
    $c = Invoke-RestMethod -Uri "$ConsolidadoUrl/consolidado/$dia" -Headers $auth
    Write-Host ("{0}  creditos={1}  debitos={2}  resultado={3}  acumulado={4}" -f $c.data, $c.totalCreditos, $c.totalDebitos, $c.resultadoDia, $c.saldoAcumulado)
}
