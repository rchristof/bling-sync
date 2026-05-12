import type { Pool, PoolClient } from 'pg';
import { pool } from './db';

type DbClient = Pool | PoolClient;

function blankToNull(value: unknown): string | null {
  return value === undefined || value === '' ? null : value as string;
}

function toNumber(value: unknown): number | null {
  const normalized = blankToNull(value);
  if (normalized === null) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function toId(value: unknown): number | null {
  const id = toNumber(value);
  return id && id > 0 ? id : null;
}

function toDate(value: unknown): string | null {
  const normalized = blankToNull(value);
  if (!normalized) return null;

  const match = String(normalized).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);

  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return date;
}

function toJson(value: unknown): string {
  return JSON.stringify(value || {});
}

export async function upsertLoja(loja: any, client: DbClient = pool): Promise<void> {
  if (!loja?.id) return;
  await client.query(
    `INSERT INTO lojas (id, nome, situacao, raw, synced_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       nome      = EXCLUDED.nome,
       situacao  = EXCLUDED.situacao,
       raw       = EXCLUDED.raw,
       synced_at = NOW()`,
    [
      loja.id,
      blankToNull(loja.nome),
      blankToNull(loja.situacao?.valor || loja.situacao),
      toJson(loja),
    ]
  );
}

export async function upsertContato(contato: any, client: DbClient = pool): Promise<void> {
  if (!contato?.id) return;

  await client.query(
    `INSERT INTO contatos (id, nome, tipo_pessoa, numero_documento, email, telefone, raw, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       nome             = EXCLUDED.nome,
       tipo_pessoa      = EXCLUDED.tipo_pessoa,
       numero_documento = EXCLUDED.numero_documento,
       email            = EXCLUDED.email,
       telefone         = EXCLUDED.telefone,
       raw              = EXCLUDED.raw,
       synced_at        = NOW()`,
    [
      contato.id,
      blankToNull(contato.nome),
      blankToNull(contato.tipoPessoa || contato.tipo),
      blankToNull(contato.numeroDocumento),
      blankToNull(contato.email),
      blankToNull(contato.telefone || contato.celular),
      toJson(contato),
    ]
  );
}

export async function upsertProduto(produto: any, client: DbClient = pool): Promise<void> {
  if (!produto?.id) return;

  await client.query(
    `INSERT INTO produtos (
       id, nome, codigo, preco, preco_custo, estoque_saldo, tipo, situacao, formato,
       unidade, marca, categoria_id, fornecedor_id, fornecedor_nome, gtin, ncm,
       imagem_url, raw, synced_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (id) DO UPDATE SET
       nome            = EXCLUDED.nome,
       codigo          = EXCLUDED.codigo,
       preco           = EXCLUDED.preco,
       preco_custo     = COALESCE(EXCLUDED.preco_custo, produtos.preco_custo),
       estoque_saldo   = COALESCE(EXCLUDED.estoque_saldo, produtos.estoque_saldo),
       tipo            = EXCLUDED.tipo,
       situacao        = EXCLUDED.situacao,
       formato         = EXCLUDED.formato,
       unidade         = COALESCE(EXCLUDED.unidade, produtos.unidade),
       marca           = COALESCE(EXCLUDED.marca, produtos.marca),
       categoria_id    = COALESCE(EXCLUDED.categoria_id, produtos.categoria_id),
       fornecedor_id   = COALESCE(EXCLUDED.fornecedor_id, produtos.fornecedor_id),
       fornecedor_nome = COALESCE(EXCLUDED.fornecedor_nome, produtos.fornecedor_nome),
       gtin            = COALESCE(EXCLUDED.gtin, produtos.gtin),
       ncm             = COALESCE(EXCLUDED.ncm, produtos.ncm),
       imagem_url      = COALESCE(EXCLUDED.imagem_url, produtos.imagem_url),
       raw             = EXCLUDED.raw,
       synced_at       = NOW(),
       deleted_at      = NULL`,
    [
      produto.id,
      blankToNull(produto.nome),
      blankToNull(produto.codigo),
      toNumber(produto.preco),
      toNumber(produto.precoCusto || produto.fornecedor?.precoCusto),
      toNumber(produto.estoque?.saldoVirtualTotal),
      blankToNull(produto.tipo),
      blankToNull(produto.situacao),
      blankToNull(produto.formato),
      blankToNull(produto.unidade),
      blankToNull(produto.marca),
      toId(produto.categoria?.id),
      toId(produto.fornecedor?.id),
      blankToNull(produto.fornecedor?.contato?.nome),
      blankToNull(produto.gtin),
      blankToNull(produto.tributacao?.ncm),
      produto.imagemURL || produto.midia?.imagens?.internas?.[0]?.link || null,
      toJson(produto),
    ]
  );
}

export async function upsertPedido(pedido: any, client: DbClient = pool): Promise<void> {
  if (!pedido?.id) return;

  await upsertContato(pedido.contato, client);

  await client.query(
    `INSERT INTO pedidos (
       id, numero, numero_loja, data, data_saida, data_prevista, total_produtos, total,
       contato_id, situacao_id, situacao_valor, loja_id, loja_unidade_negocio_id,
       nota_fiscal_id, vendedor_id, intermediador_nome_usuario, raw, synced_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
     ON CONFLICT (id) DO UPDATE SET
       numero                     = EXCLUDED.numero,
       numero_loja                = EXCLUDED.numero_loja,
       data                       = EXCLUDED.data,
       data_saida                 = EXCLUDED.data_saida,
       data_prevista              = EXCLUDED.data_prevista,
       total_produtos             = EXCLUDED.total_produtos,
       total                      = EXCLUDED.total,
       contato_id                 = EXCLUDED.contato_id,
       situacao_id                = EXCLUDED.situacao_id,
       situacao_valor             = EXCLUDED.situacao_valor,
       loja_id                    = EXCLUDED.loja_id,
       loja_unidade_negocio_id    = EXCLUDED.loja_unidade_negocio_id,
       nota_fiscal_id             = COALESCE(EXCLUDED.nota_fiscal_id, pedidos.nota_fiscal_id),
       vendedor_id                = COALESCE(EXCLUDED.vendedor_id, pedidos.vendedor_id),
       intermediador_nome_usuario = COALESCE(EXCLUDED.intermediador_nome_usuario, pedidos.intermediador_nome_usuario),
       raw                        = EXCLUDED.raw,
       synced_at                  = NOW(),
       deleted_at                 = NULL`,
    [
      pedido.id,
      blankToNull(pedido.numero),
      blankToNull(pedido.numeroLoja),
      toDate(pedido.data),
      toDate(pedido.dataSaida),
      toDate(pedido.dataPrevista),
      toNumber(pedido.totalProdutos),
      toNumber(pedido.total),
      toId(pedido.contato?.id),
      toId(pedido.situacao?.id),
      blankToNull(pedido.situacao?.valor),
      toId(pedido.loja?.id),
      toId(pedido.loja?.unidadeNegocio?.id),
      toId(pedido.notaFiscal?.id),
      toId(pedido.vendedor?.id),
      blankToNull(pedido.intermediador?.nomeUsuario),
      toJson(pedido),
    ]
  );

  if (Array.isArray(pedido.itens)) {
    await client.query('DELETE FROM itens_pedido WHERE pedido_id = $1', [pedido.id]);

    for (const [index, item] of pedido.itens.entries()) {
      await client.query(
        `INSERT INTO itens_pedido (
           id, pedido_id, item_index, produto_id, codigo, descricao, unidade,
           quantidade, valor_unitario, valor_total, desconto, raw, synced_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (id) DO UPDATE SET
           pedido_id      = EXCLUDED.pedido_id,
           item_index     = EXCLUDED.item_index,
           produto_id     = EXCLUDED.produto_id,
           codigo         = EXCLUDED.codigo,
           descricao      = EXCLUDED.descricao,
           unidade        = EXCLUDED.unidade,
           quantidade     = EXCLUDED.quantidade,
           valor_unitario = EXCLUDED.valor_unitario,
           valor_total    = EXCLUDED.valor_total,
           desconto       = EXCLUDED.desconto,
           raw            = EXCLUDED.raw,
           synced_at      = NOW()`,
        [
          item.id,
          pedido.id,
          index,
          toId(item.produto?.id),
          blankToNull(item.codigo),
          blankToNull(item.descricao),
          blankToNull(item.unidade),
          toNumber(item.quantidade),
          toNumber(item.valor),
          toNumber(item.quantidade) !== null && toNumber(item.valor) !== null
            ? toNumber(item.quantidade)! * toNumber(item.valor)!
            : null,
          toNumber(item.desconto),
          toJson(item),
        ]
      );
    }
  }
}

export async function upsertNotaFiscal(nota: any, client: DbClient = pool): Promise<void> {
  if (!nota?.id) return;
  await upsertContato(nota.contato, client);

  await client.query(
    `INSERT INTO notas_fiscais (id, numero, serie, data, valor, contato_id, situacao, raw, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       numero = EXCLUDED.numero, serie = EXCLUDED.serie, data = EXCLUDED.data,
       valor = EXCLUDED.valor, contato_id = EXCLUDED.contato_id, situacao = EXCLUDED.situacao,
       raw = EXCLUDED.raw, synced_at = NOW(), deleted_at = NULL`,
    [
      nota.id,
      blankToNull(nota.numero),
      blankToNull(nota.serie),
      toDate(nota.dataEmissao || nota.dataOperacao || nota.data),
      toNumber(nota.valorNota || nota.total || nota.valor),
      toId(nota.contato?.id),
      blankToNull(nota.situacao?.valor || nota.situacao?.id || nota.situacao),
      toJson(nota),
    ]
  );
}

export async function upsertConta(table: 'contas_receber' | 'contas_pagar', conta: any, client: DbClient = pool): Promise<void> {
  if (!conta?.id) return;
  await upsertContato(conta.contato, client);

  await client.query(
    `INSERT INTO ${table} (
       id, contato_id, data_emissao, data_vencimento, valor, saldo, situacao, raw, synced_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       contato_id = EXCLUDED.contato_id, data_emissao = EXCLUDED.data_emissao,
       data_vencimento = EXCLUDED.data_vencimento,
       valor = EXCLUDED.valor, saldo = EXCLUDED.saldo, situacao = EXCLUDED.situacao,
       raw = EXCLUDED.raw, synced_at = NOW(), deleted_at = NULL`,
    [
      conta.id,
      toId(conta.contato?.id),
      toDate(conta.dataEmissao || conta.data),
      toDate(conta.dataVencimento || conta.vencimento),
      toNumber(conta.valor),
      toNumber(conta.saldo),
      blankToNull(conta.situacao?.valor || conta.situacao?.id || conta.situacao),
      toJson(conta),
    ]
  );
}

export async function syncState(entity: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    `INSERT INTO sync_state (entity, last_synced_at, metadata, updated_at)
     VALUES ($1, NOW(), $2, NOW())
     ON CONFLICT (entity) DO UPDATE SET
       last_synced_at = NOW(),
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [entity, toJson(metadata)]
  );
}
