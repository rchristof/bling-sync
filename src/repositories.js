const { pool } = require('./db');
const { dateOrNull, idOrNull, json, numberOrNull, valueOrNull } = require('./utils');

async function upsertContato(contato, client = pool) {
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
      valueOrNull(contato.nome),
      valueOrNull(contato.tipoPessoa || contato.tipo),
      valueOrNull(contato.numeroDocumento),
      valueOrNull(contato.email),
      valueOrNull(contato.telefone || contato.celular),
      json(contato),
    ]
  );
}

async function upsertProduto(produto, client = pool) {
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
      valueOrNull(produto.nome),
      valueOrNull(produto.codigo),
      numberOrNull(produto.preco),
      numberOrNull(produto.precoCusto || produto.fornecedor?.precoCusto),
      numberOrNull(produto.estoque?.saldoVirtualTotal),
      valueOrNull(produto.tipo),
      valueOrNull(produto.situacao),
      valueOrNull(produto.formato),
      valueOrNull(produto.unidade),
      valueOrNull(produto.marca),
      idOrNull(produto.categoria?.id),
      idOrNull(produto.fornecedor?.id),
      valueOrNull(produto.fornecedor?.contato?.nome),
      valueOrNull(produto.gtin),
      valueOrNull(produto.tributacao?.ncm),
      produto.imagemURL || produto.midia?.imagens?.internas?.[0]?.link || null,
      json(produto),
    ]
  );
}

async function upsertPedido(pedido, client = pool) {
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
      valueOrNull(pedido.numero),
      valueOrNull(pedido.numeroLoja),
      dateOrNull(pedido.data),
      dateOrNull(pedido.dataSaida),
      dateOrNull(pedido.dataPrevista),
      numberOrNull(pedido.totalProdutos),
      numberOrNull(pedido.total),
      idOrNull(pedido.contato?.id),
      idOrNull(pedido.situacao?.id),
      valueOrNull(pedido.situacao?.valor),
      idOrNull(pedido.loja?.id),
      idOrNull(pedido.loja?.unidadeNegocio?.id),
      idOrNull(pedido.notaFiscal?.id),
      idOrNull(pedido.vendedor?.id),
      valueOrNull(pedido.intermediador?.nomeUsuario),
      json(pedido),
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
          idOrNull(item.produto?.id),
          valueOrNull(item.codigo),
          valueOrNull(item.descricao),
          valueOrNull(item.unidade),
          numberOrNull(item.quantidade),
          numberOrNull(item.valor),
          numberOrNull(item.quantidade) !== null && numberOrNull(item.valor) !== null
            ? numberOrNull(item.quantidade) * numberOrNull(item.valor)
            : null,
          numberOrNull(item.desconto),
          json(item),
        ]
      );
    }
  }
}

async function upsertNotaFiscal(nota, client = pool) {
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
      valueOrNull(nota.numero),
      valueOrNull(nota.serie),
      dateOrNull(nota.dataEmissao || nota.dataOperacao || nota.data),
      numberOrNull(nota.valorNota || nota.total || nota.valor),
      idOrNull(nota.contato?.id),
      valueOrNull(nota.situacao?.valor || nota.situacao?.id || nota.situacao),
      json(nota),
    ]
  );
}

async function upsertConta(table, conta, client = pool) {
  if (!conta?.id) return;
  await upsertContato(conta.contato, client);

  await client.query(
    `INSERT INTO ${table} (
       id, contato_id, data_emissao, data_vencimento, data_pagamento, valor, saldo, situacao, raw, synced_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO UPDATE SET
       contato_id = EXCLUDED.contato_id, data_emissao = EXCLUDED.data_emissao,
       data_vencimento = EXCLUDED.data_vencimento, data_pagamento = EXCLUDED.data_pagamento,
       valor = EXCLUDED.valor, saldo = EXCLUDED.saldo, situacao = EXCLUDED.situacao,
       raw = EXCLUDED.raw, synced_at = NOW(), deleted_at = NULL`,
    [
      conta.id,
      idOrNull(conta.contato?.id),
      dateOrNull(conta.dataEmissao || conta.data),
      dateOrNull(conta.dataVencimento || conta.vencimento),
      dateOrNull(conta.dataPagamento || conta.pagamento),
      numberOrNull(conta.valor),
      numberOrNull(conta.saldo),
      valueOrNull(conta.situacao?.valor || conta.situacao?.id || conta.situacao),
      json(conta),
    ]
  );
}

async function upsertEstoqueMovimento(item, client = pool) {
  await client.query(
    `INSERT INTO estoque_movimentos (bling_id, produto_id, data_movimento, tipo, quantidade, saldo, raw, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (bling_id) WHERE bling_id IS NOT NULL DO UPDATE SET
       produto_id = EXCLUDED.produto_id, data_movimento = EXCLUDED.data_movimento,
       tipo = EXCLUDED.tipo, quantidade = EXCLUDED.quantidade, saldo = EXCLUDED.saldo,
       raw = EXCLUDED.raw, synced_at = NOW()`,
    [
      idOrNull(item.id),
      idOrNull(item.produto?.id || item.produtoId),
      valueOrNull(item.data || item.dataMovimento),
      valueOrNull(item.tipo || item.operacao),
      numberOrNull(item.quantidade),
      numberOrNull(item.saldo),
      json(item.raw || item),
    ]
  );
}

async function syncState(entity, metadata = {}) {
  await pool.query(
    `INSERT INTO sync_state (entity, last_synced_at, metadata, updated_at)
     VALUES ($1, NOW(), $2, NOW())
     ON CONFLICT (entity) DO UPDATE SET
       last_synced_at = NOW(),
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [entity, json(metadata)]
  );
}

module.exports = {
  upsertContato,
  upsertProduto,
  upsertPedido,
  upsertNotaFiscal,
  upsertConta,
  upsertEstoqueMovimento,
  syncState,
};
