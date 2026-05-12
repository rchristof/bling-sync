# bling-sync

Backend Express para sincronizar dados do Bling no Postgres e expor os dados ao Metabase.

## Servicos

- `postgres`: banco principal dos dados sincronizados e banco interno do Metabase.
- `bling-sync`: API HTTP, OAuth, webhooks, worker e jobs de sync.
- `metabase`: BI em `http://localhost:3001`.

## Subir

```bash
cp .env.example .env
docker compose up -d --build
```

Configure no Bling o redirect URI:

```text
http://localhost:3002/auth/callback
```

Autorize o aplicativo em:

```text
http://localhost:3002/auth
```

## Deploy em VM

Na VM, use Docker Compose e mantenha os segredos apenas no `.env` da propria VM.

```bash
git clone https://github.com/rchristof/bling-test.git /opt/bling-sync
cd /opt/bling-sync
cp .env.example .env
```

Edite o `.env` antes de subir:

```text
BLING_CLIENT_ID=...
BLING_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://seu-dominio
BLING_REDIRECT_URI=https://seu-dominio/auth/callback
POSTGRES_PASSWORD=uma_senha_forte
POSTGRES_BIND=127.0.0.1
BLING_SYNC_BIND=127.0.0.1
METABASE_BIND=127.0.0.1
BACKFILL_START_DATE=
```

No desenho recomendado, Docker publica tudo apenas em `127.0.0.1` e o Caddy
decide o que fica acessivel. Para expor o Metabase, o OAuth e o webhook do
backend no mesmo dominio:

```caddyfile
seu-dominio {
  @bling_oauth path /auth /auth/callback
  handle @bling_oauth {
    reverse_proxy 127.0.0.1:3002
  }

  @bling_webhook {
    method POST
    path /webhooks/bling
  }
  handle @bling_webhook {
    reverse_proxy 127.0.0.1:3002
  }

  handle {
    reverse_proxy 127.0.0.1:3001
  }
}
```

Se preferir dominios separados:

```caddyfile
metabase.seu-dominio {
  reverse_proxy 127.0.0.1:3001
}

bling.seu-dominio {
  @bling_oauth path /auth /auth/callback
  handle @bling_oauth {
    reverse_proxy 127.0.0.1:3002
  }

  @bling_webhook {
    method POST
    path /webhooks/bling
  }
  handle @bling_webhook {
    reverse_proxy 127.0.0.1:3002
  }

  respond 404
}
```

Com Cloudflare Tunnel, aponte o tunnel para o Caddy. Nao precisa abrir as portas
Docker publicamente. Se quiser acessar o Metabase sem Caddy, use tunel SSH:

```bash
ssh -L 3001:localhost:3001 usuario@IP_DA_VM
```

Suba e valide:

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3002/health
curl http://localhost:3002/ready
curl http://localhost:3002/auth/status
```

Depois, cadastre no Bling:

```text
Redirect URI: https://seu-dominio/auth/callback
Webhook:      https://seu-dominio/webhooks/bling
```

Abra `/auth` uma vez para concluir o OAuth. Apos o callback, o token fica salvo
em Postgres e o backfill inicial comeca automaticamente. Se `BACKFILL_START_DATE`
estiver vazio, esse backfill inicial sera completo.

## Healthchecks

```bash
curl http://localhost:3002/health
curl http://localhost:3002/ready
docker compose ps
```

## Webhook

No deploy restrito, exponha somente `POST /webhooks/bling` pelo Caddy.

Configure o webhook do Bling apontando para:

```text
POST http://SEU_HOST/webhooks/bling
```

A autenticacao eh feita pelo proprio Bling: cada requisicao traz o header `X-Bling-Signature-256: sha256=<HMAC-SHA256(payload, BLING_CLIENT_SECRET)>` e o backend valida antes de aceitar. Eventos com assinatura invalida sao rejeitados com 401 e um log `webhook signature invalid`.

Eventos validos entram em `bling_webhook_events` com status `pending`. O worker pega em batches (`WORKER_BATCH_SIZE`, padrao 25) a cada `WORKER_INTERVAL_MS` (padrao 10s) e atualiza as tabelas normalizadas. Falhas sao logadas e marcadas `failed`; apos `WEBHOOK_MAX_ATTEMPTS` tentativas (padrao 10) o evento fica permanentemente em `failed` e gera log com level `error` na ultima tentativa.

Recursos suportados: `order.*`, `product.*`, `invoice.*` (NF-e). Eventos `consumer_invoice` (NFC-e), `stock`, `virtual_stock` e `product_supplier` sao registrados mas ignorados — sempre com log `unsupported`.

### Como testar

Voce nao precisa esperar um evento real do Bling para verificar o endpoint. Tres abordagens:

**1. Disparar evento real no Bling**

A rota `/webhooks/bling` precisa estar publicamente acessivel (ou exposta via tunel — `ngrok http 3002`, `cloudflared tunnel`, etc). Cadastre o webhook no Bling, edite/crie um pedido ou produto e veja o evento chegar nos logs e em `bling_webhook_events`.

**2. Simular um POST com assinatura valida (curl)**

Util para testes locais. Substitua `SECRET` pelo seu `BLING_CLIENT_SECRET`:

```bash
PAYLOAD='{"eventId":"test-1","event":"product.updated","date":"2026-05-06T12:00:00Z","companyId":"123","version":"1","data":{"id":999}}'
SECRET='seu_client_secret_aqui'
SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)"

curl -i -X POST http://localhost:3002/webhooks/bling \
  -H "Content-Type: application/json" \
  -H "X-Bling-Signature-256: $SIG" \
  --data "$PAYLOAD"
```

Esperado: `202 Accepted`. Sem o header (ou com assinatura errada): `401 Unauthorized`.

**3. Verificar a fila e o reprocessamento**

```bash
docker compose exec postgres psql -U bling -d blingdb -c \
  "SELECT id, event_name, status, attempts, error FROM bling_webhook_events ORDER BY received_at DESC LIMIT 20;"
```

Para reprocessar um evento manualmente, basta resetar:

```sql
UPDATE bling_webhook_events SET status = 'pending', attempts = 0, error = NULL, locked_at = NULL WHERE id = <ID>;
```

O worker pegara no proximo ciclo.

## Backfill inicial

Depois que o OAuth for concluido em `/auth`, o callback salva o token e dispara o backfill inicial automaticamente em segundo plano. Se `BACKFILL_START_DATE` estiver vazio, o backfill inicial eh completo; se estiver preenchido, usa essa data como ponto de partida. Se o servico subir antes de existir token, ele apenas aguarda a autorizacao. O job eh idempotente por data de partida: o estado fica registrado em `sync_state.entity = 'initial_backfill'` e so pula a execucao se ja estiver marcado como `completed` para o mesmo valor de `BACKFILL_START_DATE`. Cada entidade tambem tem checkpoint em `sync_state`: listagens retomam da ultima pagina concluida; entidades que buscam detalhe por ID tambem salvam a pagina atual e o proximo item pendente, entao uma interrupcao por rate limit ou queda retoma dentro da propria pagina.

Se quiser disparar manualmente (por exemplo para uma janela diferente):

```bash
docker compose run --rm bling-sync npm run backfill -- --desde=2026-01-01
docker compose run --rm bling-sync npm run backfill -- --entities=produtos,pedidos
docker compose run --rm bling-sync npm run reconcile
```

## Jobs

Rodar migracao/schema:

```bash
docker compose run --rm bling-sync npm run migrate
```

Teste local, rodando o Node direto na sua maquina:

```bash
docker compose up -d postgres
npm run build
npm run migrate
npm run sync -- --entities=produtos,pedidos --desde=2026-05-01
```

Quando voce roda os scripts `npm run ...` direto no host, o backend usa `localhost` como host padrao do Postgres. Dentro do Docker Compose, o `docker-compose.yml` injeta `postgres` como host do banco.

## Tabelas

- `bling_webhook_events`
- `sync_state`
- `pedidos`
- `itens_pedido`
- `produtos`
- `contatos`
- `notas_fiscais`
- `contas_receber`
- `contas_pagar`

Tambem existe `bling_oauth_tokens` para persistir access/refresh tokens do OAuth.

## Metabase

O Metabase usa o banco `metabase` para seus metadados internos. Para analisar os dados do Bling, adicione outro banco no Metabase:

```text
Tipo: PostgreSQL
Host: postgres
Porta: 5432
Banco: blingdb
Usuario: bling
Senha: blingpass
SSL: desligado
```
