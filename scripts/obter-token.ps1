# Obtém um token de acesso no Keycloak (OAuth2 client credentials) e o imprime.
# Os clientes abaixo existem no realm de desenvolvimento (keycloak/realm-caixa.json).
# O comerciante e os escopos estão amarrados ao cliente pelo realm; quem pede o token não escolhe.
#
# Uso: $TOKEN = .\scripts\obter-token.ps1 -Cliente erp-loja-1
param(
    [string]$Cliente = 'erp-loja-1',
    [string]$Segredo,
    [string]$KeycloakUrl = 'http://localhost:8080'
)

$ErrorActionPreference = 'Stop'

$segredosDeDesenvolvimento = @{
    'erp-loja-1' = 'dev-segredo-erp-loja-1'
    'erp-loja-2' = 'dev-segredo-erp-loja-2'
    'bi-loja-1'  = 'dev-segredo-bi-loja-1'
    'contabil-loja-1' = 'dev-segredo-contabil-loja-1'
}
if (-not $Segredo) { $Segredo = $segredosDeDesenvolvimento[$Cliente] }
if (-not $Segredo) { throw "Informe -Segredo para o cliente '$Cliente'." }

$resposta = Invoke-RestMethod -Method Post -Uri "$KeycloakUrl/realms/caixa/protocol/openid-connect/token" `
    -Body @{ grant_type = 'client_credentials'; client_id = $Cliente; client_secret = $Segredo }
$resposta.access_token
