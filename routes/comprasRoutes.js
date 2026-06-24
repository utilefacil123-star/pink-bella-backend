    const express = require('express');
    const router = express.Router();
    const db = require('../database');
    const { calcularFrete } = require('../services/melhorEnvioService'); // Para calcular o frete
    const melhorEnvioService = require('../services/melhorEnvioService');
    const { getFormattedCompraDetails,
            getCompraDetalhadaComHistorico
     } = require('../utils/formatadores')
    const comprasService = require('../services/comprasService'); // Certifique-se de importar

  
router.get('/', async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const filtros = {
            status: req.query.status || 'Todos',
            search: req.query.search || '',
        };
        const resultado = await comprasService.getAllComprasFormatted(page, limit, filtros);
        res.json(resultado);
    } catch (error) {
        console.error('Erro ao buscar todas as compras:', error.message);
        res.status(500).json({ error: 'Erro ao buscar a lista de compras.' });
    }
});

    router.post('/', async (req, res) => {
        const { cliente_id, endereco_entrega_id, itens, frete_selecionado } = req.body;

        // --- 1. Validação dos Dados de Entrada ---
        if (!cliente_id || !itens || !Array.isArray(itens) || itens.length === 0) {
            return res.status(400).json({ error: 'ID do cliente e uma lista de itens são obrigatórios.' });
        }

        for (const item of itens) {
            if (typeof item.produto_id !== 'number' || typeof item.quantidade !== 'number' || item.quantidade <= 0) {
                return res.status(400).json({ error: 'Cada item deve ter produto_id e uma quantidade válida.' });
            }
        }

        let cliente;
        let enderecoEntrega;
        let quantidadeTotalDeItens = 0;
        let produtosCompradosDetalhes = [];
        let pacoteFinalCalculado = null; // Para armazenar o pacote final retornado do cálculo do frete

        try {
            // --- 2. Buscar Informações do Cliente ---
            cliente = await new Promise((resolve, reject) => {
                db.get('SELECT id, endereco_principal_id FROM clientes WHERE id = ?', [cliente_id], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });

            if (!cliente) {
                return res.status(404).json({ error: 'Cliente não encontrado.' });
            }

            // --- 3. Determinar e Buscar Detalhes do Endereço de Entrega ---
            let idDoEnderecoParaEntrega = endereco_entrega_id;

            if (!idDoEnderecoParaEntrega) {
                if (!cliente.endereco_principal_id) {
                    return res.status(400).json({ error: 'Nenhum endereço de entrega fornecido e o cliente não possui um endereço principal cadastrado.' });
                }
                idDoEnderecoParaEntrega = cliente.endereco_principal_id;
            }

            enderecoEntrega = await new Promise((resolve, reject) => {
                db.get('SELECT id, cep, logradouro, numero, bairro, cidade, estado, complemento FROM enderecos WHERE id = ? AND cliente_id = ?', // Adicionei complemento
                    [idDoEnderecoParaEntrega, cliente_id],
                    (err, row) => {
                        if (err) return reject(err);
                        resolve(row);
                    });
            });

            if (!enderecoEntrega) {
                return res.status(404).json({ error: `Endereço de entrega (ID ${idDoEnderecoParaEntrega}) não encontrado ou não pertence a este cliente.` });
            }

            // --- 4. Buscar Detalhes dos Produtos e Verificar Estoque ---
            const produtosPromises = itens.map(item => {
                return new Promise((resolve, reject) => {
                    db.get('SELECT id, nome, preco, estoque FROM produtos WHERE id = ?', [item.produto_id], async (err, row) => {
                        if (err) return reject(err);
                        if (!row) return reject(new Error(`Produto com ID ${item.produto_id} não encontrado.`));

                        // Verificação de estoque: usa variação se informada, senão usa estoque do produto
                        if (item.variacao_id) {
                            try {
                                const varResult = await db.query(
                                    'SELECT id, estoque FROM produto_variacoes WHERE id = $1 AND produto_id = $2 AND ativo = TRUE',
                                    [item.variacao_id, item.produto_id]
                                );
                                const variacao = varResult.rows[0];
                                if (!variacao) return reject(new Error(`Variação não encontrada para o produto: ${row.nome}.`));
                                if (variacao.estoque < item.quantidade) {
                                    return reject(new Error(`Estoque insuficiente na variação selecionada de "${row.nome}". Disponível: ${variacao.estoque}, Solicitado: ${item.quantidade}.`));
                                }
                            } catch (e) { return reject(e); }
                        } else {
                            if (row.estoque < item.quantidade) {
                                return reject(new Error(`Estoque insuficiente para o produto: ${row.nome}. Disponível: ${row.estoque}, Solicitado: ${item.quantidade}.`));
                            }
                        }

                        quantidadeTotalDeItens += item.quantidade;
                        resolve({ ...row, quantidade_comprada: item.quantidade, variacao_id: item.variacao_id || null });
                    });
                });
            });

            produtosCompradosDetalhes = await Promise.all(produtosPromises);

            // --- 5. Selecionar Frete ---
            let freteEscolhido;
            let pacoteFinalParaDb;

            if (frete_selecionado) {
                // Frete pré-selecionado pelo usuário na tela
                const pesoG = 500 + 250 * Math.max(quantidadeTotalDeItens - 1, 0);
                const alturaC = 8 + 2 * Math.max(quantidadeTotalDeItens - 1, 0);
                freteEscolhido = {
                    price: frete_selecionado.preco_frete,
                    company: { name: frete_selecionado.nome_transportadora },
                    name: frete_selecionado.servico,
                    delivery_time: frete_selecionado.prazo_dias_uteis,
                    id: frete_selecionado.id_servico,
                };
                pacoteFinalParaDb = {
                    weight: Math.max(pesoG / 1000, 0.1),
                    height: Math.max(alturaC, 2),
                    width: 25,
                    length: 25,
                };
            } else {
                // Auto-seleciona o frete mais barato
                const opcoesFrete = await calcularFrete(enderecoEntrega.cep, quantidadeTotalDeItens);

                if (!opcoesFrete || opcoesFrete.length === 0) {
                    return res.status(400).json({ error: 'Não foi possível calcular o frete para este destino com os produtos selecionados.' });
                }

                freteEscolhido = opcoesFrete.sort((a, b) => a.price - b.price)[0];
                pacoteFinalParaDb = freteEscolhido.pacote_utilizado;
                if (!pacoteFinalParaDb) {
                    return res.status(500).json({ error: 'Erro interno ao processar detalhes do frete.' });
                }
            }

            // Calculando o valor total dos produtos
            let valorTotalProdutos = produtosCompradosDetalhes.reduce((acc, prod) => acc + (prod.preco * prod.quantidade_comprada), 0);
            let valorTotalCompra = valorTotalProdutos + parseFloat(freteEscolhido.price);

            // --- 6. Iniciar uma Transação no DB (Salvar Compra, Itens, Baixa Estoque) ---
            // db.serialize não é estritamente necessário aqui se todas as operações usam await Promise,
            // mas pode ser mantido para garantir a ordem sequencial de outras operações no futuro.
            // O importante é o BEGIN TRANSACTION e o COMMIT/ROLLBACK.
            db.run('BEGIN TRANSACTION;', async function(err) {
                if (err) {
                    console.error('Erro ao iniciar transação de compra:', err.message);
                    return res.status(500).json({ error: 'Erro interno ao iniciar a transação de compra.' });
                }

                try {
                    // --- 7. Salvar a compra na tabela 'compras' ---
                    const resultCompra = await new Promise((resolve, reject) => {
                        db.run(
                            `INSERT INTO compras (
                                cliente_id,
                                endereco_entrega_id,
                                valor_total,
                                valor_produtos,
                                status_compra,
                                valor_frete,
                                transportadora,
                                servico_frete,
                                prazo_frete_dias,
                                melhor_envio_service_id,
                                peso_pacote,
                                altura_pacote,
                                largura_pacote,
                                comprimento_pacote
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                cliente_id,
                                enderecoEntrega.id,
                                valorTotalCompra,
                                valorTotalProdutos,
                                'Pendente',
                                parseFloat(freteEscolhido.price),
                                freteEscolhido.company.name,
                                freteEscolhido.name,
                                parseInt(freteEscolhido.delivery_time),
                                freteEscolhido.id, 
                                pacoteFinalParaDb.weight,
                                pacoteFinalParaDb.height,
                                pacoteFinalParaDb.width,
                                pacoteFinalParaDb.length
                            ],
                            function(err) {
                                if (err) return reject(err);
                                resolve(this.lastID);
                            }
                        );
                    });

                    const compraId = resultCompra;
                    if (!compraId) {
                        throw new Error('Não foi possível obter o ID da compra inserida.');
                    }

                    // --- 8. Salvar cada item na tabela 'itens_compra' e Dar baixa no estoque ---
                    for (const item of produtosCompradosDetalhes) {
                        await new Promise((resolve, reject) => {
                            db.run(
                                `INSERT INTO itens_compra (compra_id, produto_id, variacao_id, quantidade, preco_unitario_no_momento_da_compra)
                                VALUES (?, ?, ?, ?, ?)`,
                                [compraId, item.id, item.variacao_id || null, item.quantidade_comprada, item.preco],
                                function(err) {
                                    if (err) return reject(err);
                                    resolve();
                                }
                            );
                        });

                        if (item.variacao_id) {
                            // Baixa no estoque da variação e sincroniza produto
                            await db.query(
                                'UPDATE produto_variacoes SET estoque = estoque - $1 WHERE id = $2',
                                [item.quantidade_comprada, item.variacao_id]
                            );
                            await db.query(
                                `UPDATE produtos SET estoque = (
                                   SELECT COALESCE(SUM(estoque), 0)
                                   FROM produto_variacoes WHERE produto_id = $1 AND ativo = TRUE
                                 ) WHERE id = $1`,
                                [item.id]
                            );
                        } else {
                            await new Promise((resolve, reject) => {
                                db.run(
                                    `UPDATE produtos SET estoque = estoque - ? WHERE id = ?`,
                                    [item.quantidade_comprada, item.id],
                                    function(err) {
                                        if (err) return reject(err);
                                        if (this.changes === 0) return reject(new Error(`Falha ao dar baixa no estoque do produto ID ${item.id}.`));
                                        resolve();
                                    }
                                );
                            });
                        }
                    }

                    // --- 9. Finalizar a transação (COMMIT) ---
                    db.run('COMMIT;', async function(err) {
                        if (err) {
                            console.error('Erro ao fazer commit da compra:', err.message);
                            return res.status(500).json({ error: 'Erro interno ao finalizar a compra.' });
                        }

                        // --- NOVO BLOCO: Buscar e formatar os detalhes completos da compra recém-criada ---
                        try {
                            const compraFormatadaParaRetorno = await getFormattedCompraDetails(db, compraId);

                            if (!compraFormatadaParaRetorno) {
                                console.error('Erro: Compra recém-criada não encontrada ao tentar formatar detalhes.');
                                return res.status(500).json({ error: 'Compra registrada, mas não foi possível recuperar seus detalhes.' });
                            }

                            res.status(201).json(compraFormatadaParaRetorno);

                        } catch (error) {
                            console.error('Erro ao buscar detalhes da compra após o registro:', error.message);
                            res.status(500).json({ error: `Compra registrada, mas houve um erro ao buscar seus detalhes: ${error.message}` });
                        }
                    });

                } catch (innerError) {
                    console.error('Erro durante a transação da compra:', innerError.message);
                    db.run('ROLLBACK;', function(rollbackErr) {
                        if (rollbackErr) {
                            console.error('Erro ao fazer rollback da compra:', rollbackErr.message);
                        }
                        res.status(500).json({ error: `Erro ao registrar a compra: ${innerError.message}. Transação revertida.` });
                    });
                }
            });

        } catch (error) {
            console.error('Erro no processamento inicial da compra:', error.message);
            res.status(500).json({ error: error.message || 'Erro ao processar a compra.' });
        }
    });

    router.get('/:id', async (req, res) => {
        const { id } = req.params;

        try {
            const compraFormatada = await getFormattedCompraDetails(db, id);

            const historico = await getCompraDetalhadaComHistorico(db, id)

            if (!compraFormatada) {
                return res.status(404).json({ error: 'Compra não encontrada.' });
            }

            res.json(historico);

        } catch (error) {
            console.error(`Erro ao buscar detalhes da compra ${id}:`, error.message);
            res.status(500).json({ error: 'Erro ao buscar detalhes da compra.' });
        }
    });

    router.put('/:id/status', async (req, res) => {
        const compraId = req.params.id;
        const { status } = req.body;

        try {
            //const pedidoAtualizado = await updateOrderStatus(compraId, status); verificarStatusCompra
            const pedidoAtualizado = await melhorEnvioService.verificarStatusCompra(compraId, status);
            res.json(pedidoAtualizado);

        } catch (error) {
            console.error('Erro ao atualizar status da compra:', error.message);
            res.status(500).json({ error: error.message || 'Erro interno do servidor ao atualizar o status.' });
        }
    });

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const novosDados = req.body;

  try {
    const resultado = await comprasService.editarCompra(id, novosDados);
    res.json(resultado);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ error: 'Erro ao editar compra.' });
  }
});
    

// GET /:id/cotar-frete — recalcula todas as opções de frete para uma compra existente
router.get('/:id/cotar-frete', async (req, res) => {
  const { id } = req.params;
  try {
    // Busca CEP do endereço de entrega e total de itens
    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT e.cep, (SELECT SUM(ic.quantidade) FROM itens_compra ic WHERE ic.compra_id = c.id) AS total_itens
         FROM compras c
         JOIN enderecos e ON e.id = c.endereco_entrega_id
         WHERE c.id = ?`,
        [id],
        (err, r) => { if (err) return reject(err); resolve(r); }
      );
    });

    if (!row) return res.status(404).json({ error: 'Compra não encontrada.' });

    const cep = (row.cep || '').replace(/\D/g, '');
    const totalItens = parseInt(row.total_itens) || 1;

    const opcoesBrutas = await calcularFrete(cep, totalItens);
    const opcoes = opcoesBrutas
      .filter(o => o.price !== null && o.error === undefined)
      .map(o => ({
        id_servico: o.id,
        nome_transportadora: o.company.name,
        logo_transportadora: o.company.picture || null,
        servico: o.name,
        preco_frete: parseFloat(o.price),
        prazo_dias_uteis: parseInt(o.delivery_time),
      }))
      .sort((a, b) => a.preco_frete - b.preco_frete);

    res.json({ opcoes_frete: opcoes, cep_destino: cep, total_itens: totalItens });
  } catch (error) {
    console.error(`Erro ao cotar frete para compra ${id}:`, error.message);
    res.status(500).json({ error: error.message || 'Erro ao calcular frete.' });
  }
});

// PUT /:id/frete — atualiza o frete selecionado (Pendente, Pago ou Pagar Etiqueta)
// Para "Pagar Etiqueta": reseta para "Pago" e limpa a entrada velha do carrinho ME
router.put('/:id/frete', async (req, res) => {
  const { id } = req.params;
  const { id_servico, nome_transportadora, servico, preco_frete, prazo_dias_uteis } = req.body;

  if (!id_servico || !preco_frete) {
    return res.status(400).json({ error: 'Informe id_servico e preco_frete.' });
  }

  try {
    const compra = await new Promise((resolve, reject) => {
      db.get('SELECT status_compra, valor_produtos FROM compras WHERE id = ?', [id],
        (err, r) => { if (err) return reject(err); resolve(r); });
    });

    if (!compra) return res.status(404).json({ error: 'Compra não encontrada.' });

    const statusPermitidos = ['Pendente', 'Pago', 'Pagar Etiqueta'];
    if (!statusPermitidos.includes(compra.status_compra)) {
      return res.status(400).json({ error: `Não é possível alterar o frete de uma compra com status "${compra.status_compra}".` });
    }

    const novoTotal = parseFloat(compra.valor_produtos) + parseFloat(preco_frete);
    // Se estava em "Pagar Etiqueta" (já no carrinho ME), volta para "Pago" para re-adicionar depois
    const novoStatus = compra.status_compra === 'Pagar Etiqueta' ? 'Pago' : compra.status_compra;

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE compras
         SET valor_frete = ?, transportadora = ?, servico_frete = ?,
             prazo_frete_dias = ?, melhor_envio_service_id = ?, valor_total = ?,
             status_compra = ?
         WHERE id = ?`,
        [preco_frete, nome_transportadora, servico, prazo_dias_uteis, id_servico, novoTotal, novoStatus, id],
        function(err) { if (err) return reject(err); resolve(); }
      );
    });

    // Se havia entrada no carrinho ME (estava em "Pagar Etiqueta"), limpa automaticamente
    let carrinhoLimpo = null;
    if (compra.status_compra === 'Pagar Etiqueta') {
      try {
        carrinhoLimpo = await melhorEnvioService.limparCarrinhoObsoleto();
      } catch (e) {
        console.warn(`Aviso: não foi possível limpar carrinho ME após troca de frete: ${e.message}`);
      }
    }

    res.json({
      message: 'Frete atualizado com sucesso.',
      novo_total: novoTotal,
      status_compra: novoStatus,
      aviso: novoStatus === 'Pago'
        ? 'Entrada antiga removida do carrinho Melhor Envio. Clique em "Adicionar ao Carrinho" para reinserir com o novo serviço.'
        : null,
      carrinho_limpo: carrinhoLimpo,
    });
  } catch (error) {
    console.error(`Erro ao atualizar frete da compra ${id}:`, error.message);
    res.status(500).json({ error: error.message || 'Erro ao atualizar frete.' });
  }
});

    module.exports = router;