CREATE TABLE IF NOT EXISTS bling_oauth_tokens (
  id            TEXT PRIMARY KEY,
  access_token  TEXT,
  refresh_token TEXT,
  token_type    TEXT,
  scope         TEXT,
  expires_in    INTEGER,
  expires_at    TIMESTAMPTZ,
  raw           JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bling_webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT,
  event_name    TEXT,
  resource      TEXT,
  action        TEXT,
  company_id    TEXT,
  event_date    TIMESTAMPTZ,
  payload       JSONB NOT NULL,
  headers       JSONB,
  raw_body      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at     TIMESTAMPTZ,
  processed_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS bling_webhook_events_event_id_uq
  ON bling_webhook_events (event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bling_webhook_events_status_idx
  ON bling_webhook_events (status, received_at);

CREATE TABLE IF NOT EXISTS sync_state (
  entity         TEXT PRIMARY KEY,
  cursor_value   TEXT,
  last_synced_at TIMESTAMPTZ,
  metadata       JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contatos (
  id               BIGINT PRIMARY KEY,
  nome             TEXT,
  tipo_pessoa      TEXT,
  numero_documento TEXT,
  email            TEXT,
  telefone         TEXT,
  raw              JSONB,
  synced_at        TIMESTAMPTZ DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS produtos (
  id              BIGINT PRIMARY KEY,
  nome            TEXT,
  codigo          TEXT,
  preco           NUMERIC(15,4),
  preco_custo     NUMERIC(15,4),
  estoque_saldo   NUMERIC(15,4),
  tipo            TEXT,
  situacao        TEXT,
  formato         TEXT,
  unidade         TEXT,
  marca           TEXT,
  categoria_id    BIGINT,
  fornecedor_id   BIGINT,
  fornecedor_nome TEXT,
  gtin            TEXT,
  ncm             TEXT,
  imagem_url      TEXT,
  raw             JSONB,
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS produtos_codigo_idx ON produtos (codigo);
CREATE INDEX IF NOT EXISTS produtos_categoria_idx ON produtos (categoria_id);

CREATE TABLE IF NOT EXISTS pedidos (
  id                         BIGINT PRIMARY KEY,
  numero                     TEXT,
  numero_loja                TEXT,
  data                       DATE,
  data_saida                 DATE,
  data_prevista              DATE,
  total_produtos             NUMERIC(15,4),
  total                      NUMERIC(15,4),
  contato_id                 BIGINT REFERENCES contatos(id),
  situacao_id                BIGINT,
  situacao_valor             TEXT,
  loja_id                    BIGINT,
  loja_unidade_negocio_id    BIGINT,
  nota_fiscal_id             BIGINT,
  vendedor_id                BIGINT,
  intermediador_nome_usuario TEXT,
  raw                        JSONB,
  synced_at                  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pedidos_data_idx ON pedidos (data);
CREATE INDEX IF NOT EXISTS pedidos_contato_idx ON pedidos (contato_id);
CREATE INDEX IF NOT EXISTS pedidos_loja_idx ON pedidos (loja_id);
CREATE INDEX IF NOT EXISTS pedidos_situacao_idx ON pedidos (situacao_id);

CREATE TABLE IF NOT EXISTS itens_pedido (
  id             BIGINT PRIMARY KEY,
  pedido_id      BIGINT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  item_index     INTEGER NOT NULL,
  produto_id     BIGINT,
  codigo         TEXT,
  descricao      TEXT,
  unidade        TEXT,
  quantidade     NUMERIC(15,4),
  valor_unitario NUMERIC(15,4),
  valor_total    NUMERIC(15,4),
  desconto       NUMERIC(15,4),
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (pedido_id, item_index)
);

CREATE INDEX IF NOT EXISTS itens_pedido_produto_idx ON itens_pedido (produto_id);

CREATE TABLE IF NOT EXISTS estoque_movimentos (
  id              BIGSERIAL PRIMARY KEY,
  bling_id        BIGINT,
  produto_id      BIGINT,
  data_movimento  TIMESTAMPTZ,
  tipo            TEXT,
  quantidade      NUMERIC(15,4),
  saldo           NUMERIC(15,4),
  raw             JSONB,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS estoque_movimentos_bling_id_uq
  ON estoque_movimentos (bling_id)
  WHERE bling_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS estoque_movimentos_produto_idx ON estoque_movimentos (produto_id);
CREATE INDEX IF NOT EXISTS estoque_movimentos_data_idx ON estoque_movimentos (data_movimento);

CREATE TABLE IF NOT EXISTS notas_fiscais (
  id         BIGINT PRIMARY KEY,
  numero     TEXT,
  serie      TEXT,
  data       DATE,
  valor      NUMERIC(15,4),
  contato_id BIGINT REFERENCES contatos(id),
  situacao   TEXT,
  raw        JSONB,
  synced_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notas_fiscais_data_idx ON notas_fiscais (data);

CREATE TABLE IF NOT EXISTS contas_receber (
  id            BIGINT PRIMARY KEY,
  contato_id    BIGINT REFERENCES contatos(id),
  data_emissao  DATE,
  data_vencimento DATE,
  data_pagamento DATE,
  valor         NUMERIC(15,4),
  saldo         NUMERIC(15,4),
  situacao      TEXT,
  raw           JSONB,
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS contas_receber_vencimento_idx ON contas_receber (data_vencimento);
CREATE INDEX IF NOT EXISTS contas_receber_situacao_idx ON contas_receber (situacao);

CREATE TABLE IF NOT EXISTS contas_pagar (
  id            BIGINT PRIMARY KEY,
  contato_id    BIGINT REFERENCES contatos(id),
  data_emissao  DATE,
  data_vencimento DATE,
  data_pagamento DATE,
  valor         NUMERIC(15,4),
  saldo         NUMERIC(15,4),
  situacao      TEXT,
  raw           JSONB,
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS contas_pagar_vencimento_idx ON contas_pagar (data_vencimento);
CREATE INDEX IF NOT EXISTS contas_pagar_situacao_idx ON contas_pagar (situacao);
