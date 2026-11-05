# Teste de resiliência contra a stack em execução (docker compose up -d --wait).
#
# Cenário A: consolidado parado. Os lançamentos continuam aceitos (201) e, quando o consolidado
#            volta, o saldo converge sozinho.
# Cenário B: RabbitMQ parado. Os lançamentos continuam aceitos, o outbox acumula pendentes e,
#            quando o broker volta, o relay drena e o saldo converge.
# Cenário C: Redis parado. O consolidado segue pronto (/ready 200) e o GET vem do banco (200); os eventos
#            continuam sendo aplicados. Mede por quanto tempo um cache antigo ainda pode ser servido na volta.
# Cenário D: banco do consolidado fora por 30 s (só ele, o de lançamentos segue no ar). Lançamentos continuam
#            aceitos, as mensagens ficam retidas na fila principal, nada vai para a DLQ e o saldo converge na volta.
# Cenário E: reprocessar a DLQ com scripts/reprocessar-dlq: o evento válido volta à fila e é aplicado; a
#            mensagem quebrada é recusada de novo e volta para a DLQ.
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

function CabecalhoRabbit { @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('rabbit:rabbit')) } }

function ApiRabbit([string]$metodo, [string]$caminho, $corpo) {
    $parametros = @{ Method = $metodo; Uri = "http://localhost:15672/api$caminho"; Headers = (CabecalhoRabbit); UseBasicParsing = $true }
    if ($null -ne $corpo) {
        $parametros.Body = [Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Depth 6 -Compress))
        $parametros.ContentType = 'application/json'
    }
    Invoke-RestMethod @parametros
}

# Estatísticas de uma fila (a API de gerenciamento as atualiza a cada ~5 s)
function InfoFila([string]$nome) { ApiRabbit 'GET' "/queues/%2F/$nome" $null }

# Código HTTP sem lançar exceção em 4xx e 5xx
function CodigoHttp([string]$url) {
    try { (Invoke-WebRequest -UseBasicParsing $url).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
}

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
docker compose up -d --wait consolidado lancamentos lancamentos-relay rabbitmq redis | Out-Null
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
# O cronômetro da drenagem começa quando o broker está saudável: a subida do RabbitMQ em si
# (dezenas de segundos) não depende desta solução e é registrada à parte.
$subida = [Diagnostics.Stopwatch]::StartNew()
docker compose up -d --wait rabbitmq | Out-Null
Log ("  rabbitmq saudável depois de {0} s" -f [math]::Round($subida.Elapsed.TotalSeconds, 1))
$tDreno = EsperarOutboxVazio
Verificar (($tDreno -ge 0) -and ($tDreno -lt 15)) "outbox drenou em menos de 15 s depois que o broker voltou (em $tDreno s)"
$t = EsperarSaldo $dataB $esperado
Verificar ($t -ge 0) "saldo convergiu para $esperado (em $t s)"
Log ''

# --- Cenário C: Redis parado -------------------------------------------------------------------
$dataC = (Get-Date '2050-01-01').AddDays((Get-Random -Maximum 3000)).ToString('yyyy-MM-dd')
Log "=== Cenário C: Redis parado (data $dataC) ==="
$criados = Lancar $dataC "$rodada-c1"
Verificar ($criados -eq $Quantidade) "lançamentos aceitos com tudo no ar: $criados de $Quantidade"
$t = EsperarSaldo $dataC $esperado
Verificar ($t -ge 0) "saldo convergiu para $esperado com o Redis no ar (em $t s)"
$auth = @{ Authorization = "Bearer $(ObterToken)" }
$null = Invoke-RestMethod -Uri "$ConsolidadoUrl/consolidado/$dataC" -Headers $auth   # aquece o cache
docker compose stop redis | Out-Null
Log '  redis parado'
$pronto = CodigoHttp "$ConsolidadoUrl/ready"
Verificar ($pronto -eq 200) "consolidado segue pronto sem o Redis (/ready = $pronto)"
$cronometro = [Diagnostics.Stopwatch]::StartNew()
$dia = Invoke-RestMethod -Uri "$ConsolidadoUrl/consolidado/$dataC" -Headers $auth
$ms = $cronometro.ElapsedMilliseconds
Verificar ($dia.source -eq 'database' -and [decimal]$dia.totalCreditos -eq $esperado) "GET devolve 200 vindo do banco (source = $($dia.source), total = $($dia.totalCreditos))"
Verificar ($ms -lt 3000) "o GET sem Redis não fica esperando a reconexão ($ms ms)"
$criados = Lancar $dataC "$rodada-c2"
Verificar ($criados -eq $Quantidade) "lançamentos aceitos com o Redis fora do ar: $criados de $Quantidade"
$t = EsperarSaldo $dataC ($esperado * 2)
Verificar ($t -ge 0) "o consumidor aplicou os eventos novos sem o Redis e o GET mostra $($esperado * 2) (em $t s)"
docker compose up -d --wait redis | Out-Null
Log '  redis de volta'
# Os eventos aplicados com o Redis fora não avançaram a versão do cache; a reconexão sobe a época
# do cache, então uma entrada antiga que sobreviveu à parada não pode mais ser servida.
$t = EsperarSaldo $dataC ($esperado * 2)
Log "  defasagem do cache depois da volta do Redis: $t s (limite: 5 s)"
Verificar (($t -ge 0) -and ($t -lt 5)) 'depois da volta do Redis o GET mostra o saldo correto em menos de 5 s'
Log ''

# --- Cenário D: banco do consolidado fora por 30 s ---------------------------------------------
$dataD = (Get-Date '2055-01-01').AddDays((Get-Random -Maximum 3000)).ToString('yyyy-MM-dd')
Log "=== Cenário D: banco do consolidado fora por 30 s (data $dataD) ==="
$dlqAntes = (InfoFila 'consolidado.lancamentos.dlq').messages
$inicioFalha = Get-Date
docker compose exec -T postgres psql -U postgres -d postgres -c 'ALTER DATABASE consolidado_db ALLOW_CONNECTIONS false' | Out-Null
docker compose exec -T postgres psql -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'consolidado_db'" | Out-Null
Log '  consolidado_db bloqueado (lancamentos_db segue no ar)'
try {
    $criados = Lancar $dataD "$rodada-d"
    Verificar ($criados -eq $Quantidade) "lançamentos aceitos com o banco do consolidado fora: $criados de $Quantidade"
    Verificar ((CodigoHttp "$LancamentosUrl/ready") -eq 200) 'API de lançamentos segue pronta'
    Verificar ((CodigoHttp "$ConsolidadoUrl/ready") -eq 503) 'o consolidado sai de prontidão enquanto o banco dele está fora'
    $restante = 30 - ((Get-Date) - $inicioFalha).TotalSeconds
    if ($restante -gt 0) { Start-Sleep -Seconds ([math]::Ceiling($restante)) }
    Start-Sleep -Seconds 6   # estatísticas de fila do RabbitMQ atualizam a cada ~5 s
    $info = InfoFila 'consolidado.lancamentos'
    Log "  na fila principal depois de 30 s de queda: $($info.messages) mensagem(ns) ($($info.messages_unacknowledged) retida(s) pelo consumidor)"
    Verificar ($info.messages -ge 1) 'as mensagens ficam retidas na fila principal, não são descartadas'
    Verificar ((InfoFila 'consolidado.lancamentos.dlq').messages -eq $dlqAntes) 'nada foi para a DLQ durante os 30 s de queda'
}
finally {
    docker compose exec -T postgres psql -U postgres -d postgres -c 'ALTER DATABASE consolidado_db ALLOW_CONNECTIONS true' | Out-Null
    Log '  consolidado_db liberado'
}
$t = EsperarSaldo $dataD $esperado
Verificar ($t -ge 0) "saldo convergiu para $esperado depois que o banco voltou (em $t s)"
Start-Sleep -Seconds 6
Verificar ((InfoFila 'consolidado.lancamentos.dlq').messages -eq $dlqAntes) 'a DLQ continua sem mensagens novas'
$metricas = (Invoke-WebRequest -UseBasicParsing "$ConsolidadoUrl/metrics").Content
$transitorios = if ($metricas -match 'consolidado_consumer_transient_errors_total (\d+)') { [int]$Matches[1] } else { 0 }
Verificar ($transitorios -ge 1) "a métrica consolidado_consumer_transient_errors_total registrou a espera ($transitorios)"
Log ''

# --- Cenário E: reprocessar a DLQ ---------------------------------------------------------------
$dataE = (Get-Date '2060-01-01').AddDays((Get-Random -Maximum 3000)).ToString('yyyy-MM-dd')
Log "=== Cenário E: reprocessar a DLQ com scripts\reprocessar-dlq.ps1 (data $dataE) ==="
$partes = (ObterToken).Split('.')[1].Replace('-', '+').Replace('_', '/')
switch ($partes.Length % 4) { 2 { $partes += '==' } 3 { $partes += '=' } }
$comerciante = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($partes)) | ConvertFrom-Json).comerciante_id
$null = ApiRabbit 'DELETE' '/queues/%2F/consolidado.lancamentos.dlq/contents' $null
$evento = [ordered]@{
    eventoId = [guid]::NewGuid().ToString(); schemaVersion = '1.1'; tipo = 'LancamentoRegistrado'
    comercianteId = $comerciante; correlationId = "res-$rodada-dlq"
    createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    data = [ordered]@{ lancamentoId = [guid]::NewGuid().ToString(); valor = '7.00'; tipo = 'credito'; descricao = $null; data = $dataE }
} | ConvertTo-Json -Depth 5 -Compress
foreach ($payload in @($evento, '{"quebrado":')) {
    $null = ApiRabbit 'POST' '/exchanges/%2F/amq.default/publish' @{
        properties = @{ delivery_mode = 2; headers = @{ 'x-first-death-reason' = 'rejected' } }
        routing_key = 'consolidado.lancamentos.dlq'; payload = $payload; payload_encoding = 'string'
    }
}
$fim = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $fim -and (InfoFila 'consolidado.lancamentos.dlq').messages_ready -lt 2) { Start-Sleep -Seconds 1 }
Verificar ((InfoFila 'consolidado.lancamentos.dlq').messages_ready -eq 2) 'a DLQ recebeu 1 evento válido e 1 mensagem quebrada'
$saida = & "$raiz\scripts\reprocessar-dlq.ps1" 2>&1
$saida | ForEach-Object { Log "  $_" }
Verificar ($LASTEXITCODE -eq 0) 'reprocessar-dlq.ps1 terminou sem erro'
$t = EsperarSaldo $dataE 7
Verificar ($t -ge 0) "o evento válido voltou à fila principal e foi aplicado (saldo 7.00, em $t s)"
$fim = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $fim -and (InfoFila 'consolidado.lancamentos.dlq').messages -ne 1) { Start-Sleep -Seconds 1 }
Verificar ((InfoFila 'consolidado.lancamentos.dlq').messages -eq 1) 'a mensagem quebrada foi recusada de novo e voltou para a DLQ (reentregar não conserta dado inválido)'
$null = ApiRabbit 'DELETE' '/queues/%2F/consolidado.lancamentos.dlq/contents' $null
Log ''

if ($falhas -gt 0) { Log "RESULTADO: $falhas verificação(ões) falharam"; exit 1 }
Log 'RESULTADO: todas as verificações passaram'
Log "Saída salva em $arquivo"
exit 0
