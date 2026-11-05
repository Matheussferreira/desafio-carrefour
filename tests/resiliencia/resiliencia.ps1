# Teste de resiliência contra a stack em execução (docker compose up -d --wait).
#
# Cenário A: consolidado parado. Os lançamentos continuam aceitos (201) e, quando o consolidado
#            volta, o saldo converge sozinho.
# Cenário B: RabbitMQ parado. Os lançamentos continuam aceitos, o outbox acumula pendentes e,
#            quando o broker volta, o relay drena e o saldo converge.
#
# A saída vai para a tela e para docs/evidencias/resiliencia-ps1-<data>.txt.
# Sai com código diferente de zero se qualquer verificação falhar.
#
# Uso: .\tests\resiliencia\resiliencia.ps1 [-Quantidade 30] [-Cliente erp-loja-2]
param(
    [int]$Quantidade = 30,
    [string]$Cliente = 'erp-loja-2',
    [int]$TimeoutSegundos = 120,
    [string]$LancamentosUrl = 'http://localhost:3001',
    [string]$ConsolidadoUrl = 'http://localhost:3002'
)

$ErrorActionPreference = 'Stop'
$raiz = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $raiz

$pastaEvidencias = Join-Path $raiz 'docs\evidencias'
New-Item -ItemType Directory -Force $pastaEvidencias | Out-Null
$arquivo = Join-Path $pastaEvidencias ("resiliencia-ps1-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$falhas = 0

docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker não está disponível. Inicie o Docker Desktop e suba a stack com docker compose up -d --wait.'; exit 2 }

function Log([string]$texto) {
    Write-Host $texto
    Add-Content -Path $arquivo -Value $texto -Encoding utf8
}

function Verificar([bool]$condicao, [string]$descricao) {
    if ($condicao) { Log "  [OK]    $descricao" }
    else { Log "  [FALHA] $descricao"; $script:falhas++ }
}

function ObterToken { & "$raiz\scripts\obter-token.ps1" -Cliente $Cliente }

function Pendentes {
    $n = docker compose exec -T postgres psql -U postgres -d lancamentos_db -tAc "SELECT count(*) FROM outbox WHERE status = 'pendente'"
    [int]($n | Select-Object -First 1).Trim()
}

function FilaConsolidado {
    $r = Invoke-RestMethod -Uri 'http://localhost:15672/api/queues/%2F/consolidado.lancamentos' `
        -Headers @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('rabbit:rabbit')) }
    [int]$r.messages
}

function Lancar([string]$data, [string]$rodada) {
    $auth = @{ Authorization = "Bearer $(ObterToken)" }
    $criados = 0
    for ($i = 1; $i -le $Quantidade; $i++) {
        $corpo = '{"valor":"10.00","tipo":"credito","data":"' + $data + '","descricao":"resiliencia"}'
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$LancamentosUrl/lancamentos" `
                -Headers ($auth + @{ 'X-Idempotency-Key' = "res-$rodada-$i" }) -ContentType 'application/json' -Body $corpo
            if ($r.StatusCode -eq 201) { $criados++ }
        } catch { }
    }
    $criados
}

# Espera o saldo do dia chegar ao esperado. Devolve os segundos gastos, ou -1 se estourar o prazo.
function EsperarSaldo([string]$data, [decimal]$esperado) {
    $auth = @{ Authorization = "Bearer $(ObterToken)" }
    $inicio = Get-Date
    while (((Get-Date) - $inicio).TotalSeconds -lt $TimeoutSegundos) {
        try {
            $c = Invoke-RestMethod -Uri "$ConsolidadoUrl/consolidado/$data" -Headers $auth
            if ([decimal]$c.totalCreditos -eq $esperado) { return [math]::Round(((Get-Date) - $inicio).TotalSeconds, 1) }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    -1
}

function EsperarOutboxVazio {
    $inicio = Get-Date
    while (((Get-Date) - $inicio).TotalSeconds -lt $TimeoutSegundos) {
        if ((Pendentes) -eq 0) { return [math]::Round(((Get-Date) - $inicio).TotalSeconds, 1) }
        Start-Sleep -Milliseconds 500
    }
    -1
}

$rodada = [guid]::NewGuid().ToString('N').Substring(0, 8)
$esperado = [decimal]($Quantidade * 10)

Log "Teste de resiliência, rodada $rodada, $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Log "Quantidade por cenário: $Quantidade lançamentos de 10.00 (cliente $Cliente)"
Log ''

# Estado inicial: tudo no ar
docker compose up -d --wait consolidado lancamentos lancamentos-relay rabbitmq | Out-Null
$null = EsperarOutboxVazio

# --- Cenário A: consolidado parado -------------------------------------------------------------
$dataA = (Get-Date '2040-01-01').AddDays((Get-Random -Maximum 3000)).ToString('yyyy-MM-dd')
Log "=== Cenário A: consolidado parado (data $dataA) ==="
docker compose stop consolidado | Out-Null
Log '  consolidado parado'
$criados = Lancar $dataA "$rodada-a"
Verificar ($criados -eq $Quantidade) "lançamentos aceitos com o consolidado fora do ar: $criados de $Quantidade (esperado 201 em todos)"
# A API de gerenciamento atualiza as estatísticas de fila a cada ~5 s; espera até aparecer
$fila = 0
for ($k = 0; $k -lt 20 -and $fila -lt 1; $k++) { Start-Sleep -Seconds 1; $fila = FilaConsolidado }
Log "  mensagens aguardando na fila do consolidado: $fila"
Verificar ($fila -ge 1) 'a fila retém os eventos enquanto o consolidado está fora'
docker compose start consolidado | Out-Null
$t = EsperarSaldo $dataA $esperado
Verificar ($t -ge 0) "saldo convergiu para $esperado depois que o consolidado voltou (em $t s)"
Log ''

# --- Cenário B: RabbitMQ parado ----------------------------------------------------------------
$dataB = (Get-Date '2045-01-01').AddDays((Get-Random -Maximum 3000)).ToString('yyyy-MM-dd')
Log "=== Cenário B: RabbitMQ parado (data $dataB) ==="
docker compose stop rabbitmq | Out-Null
Log '  rabbitmq parado'
$criados = Lancar $dataB "$rodada-b"
Verificar ($criados -eq $Quantidade) "lançamentos aceitos com o broker fora do ar: $criados de $Quantidade (esperado 201 em todos)"
Start-Sleep -Seconds 3
$pend = Pendentes
Log "  eventos pendentes no outbox: $pend"
Verificar ($pend -ge $Quantidade) 'o outbox acumulou os eventos que não puderam ser publicados'
$pronto = try { (Invoke-WebRequest -UseBasicParsing "$LancamentosUrl/ready").StatusCode } catch { [int]$_.Exception.Response.StatusCode }
Verificar ($pronto -eq 200) "API de lançamentos segue pronta (/ready = $pronto)"
docker compose start rabbitmq | Out-Null
$tDreno = EsperarOutboxVazio
Verificar ($tDreno -ge 0) "outbox drenou depois que o broker voltou (em $tDreno s)"
$t = EsperarSaldo $dataB $esperado
Verificar ($t -ge 0) "saldo convergiu para $esperado (em $t s)"
Log ''

if ($falhas -gt 0) { Log "RESULTADO: $falhas verificação(ões) falharam"; exit 1 }
Log 'RESULTADO: todas as verificações passaram'
Log "Saída salva em $arquivo"
exit 0
