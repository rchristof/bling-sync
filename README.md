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
http://localhost:3002/callback
```

Autorize o aplicativo em:

```text
http://localhost:3002/auth
```

## Healthchecks

```bash
curl http://localhost:3002/health
curl http://localhost:3002/ready
docker compose ps
```

## Webhook

Configure o webhook do Bling para:

```text
POST http://SEU_HOST/webhooks/bling
```

Eventos crus entram em `bling_webhook_events`. O worker processa eventos pendentes e atualiza as tabelas normalizadas.

## Jobs

Rodar migracao/schema:

```bash
docker compose run --rm bling-sync node server.js migrate
```

Teste local, rodando o Node direto na sua maquina:

```bash
docker compose up -d postgres
npm run migrate
npm run sync -- --entities=produtos,pedidos --desde=2026-05-01
```

Quando voce roda `node server.js` direto no host, o backend usa `localhost` como host padrao do Postgres. Dentro do Docker Compose, o `docker-compose.yml` injeta `postgres` como host do banco.

Backfill inicial:

```bash
docker compose run --rm bling-sync node server.js backfill --desde=2026-01-01
```

Backfill escolhendo entidades:

```bash
docker compose run --rm bling-sync node server.js backfill --entities=produtos,pedidos,contatos
```

Reconciliacao manual:

```bash
docker compose run --rm bling-sync node server.js reconcile
```

## Tabelas

- `bling_webhook_events`
- `sync_state`
- `pedidos`
- `itens_pedido`
- `produtos`
- `contatos`
- `estoque_movimentos`
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
