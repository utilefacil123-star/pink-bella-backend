// routes/melhorEnvioRoutes.js
const express = require('express');
const router = express.Router();
const melhorEnvioService = require('../services/melhorEnvioService');


router.post('/adicionar-ao-carrinho', async (req, res) => {
  const { purchaseIds } = req.body;

  if (!purchaseIds || !Array.isArray(purchaseIds) || purchaseIds.length === 0) {
    return res.status(400).json({ error: "É necessário fornecer IDs de compra válidos." });
  }

  const results = []; // Para armazenar as respostas de cada envio
  const errors = []; // Para armazenar erros específicos de cada envio

  for (const purchaseId of purchaseIds) {
    try {
      const result = await melhorEnvioService.adicionarEnviosAoCarrinho(purchaseId);
      results.push({ purchaseId, status: 'success', data: result });
    } catch (error) {
      console.error(`Erro ao adicionar compra ${purchaseId} ao carrinho:`, error.message);
      let errorDetails = error.message;
      if (error.response && error.response.data) {
        errorDetails = error.response.data;
        console.error("Detalhes do erro da API Melhor Envio para compra", purchaseId, ":", errorDetails);
      }
      errors.push({ purchaseId, status: 'error', message: error.message, details: errorDetails });
    }
  }

  // Responde ao cliente com os resultados de todos os processamentos
  if (errors.length > 0) {
    return res.status(207).json({ // 207 Multi-Status para indicar sucesso parcial
      message: "Algumas compras foram adicionadas ao carrinho, outras tiveram erros.",
      successful: results,
      failed: errors
    });
  } else {
    return res.status(200).json({
      message: "Todas as compras foram adicionadas ao carrinho com sucesso.",
      data: results
    });
  }
});

router.get('/valorfrete', async(req, res) => {
  try {
    const valor = await melhorEnvioService.getTotalValorCarrinho();
    return res.json({total : valor.total});
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao consultar o valor do carrinho' });
  }
})

router.get('/saldo', async (req, res) => {
  try {
    const saldo = await melhorEnvioService.getBalance();
    res.json(saldo);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao consultar saldo no Melhor Envio' });
  }
});

router.post('/pix', async (req, res) => {
  const { valor } = req.body;
  if (!valor || valor <= 0) {
    return res.status(400).json({ error: 'Informe um valor válido para gerar o código PIX.' });
  }

  try {
    const pix = await melhorEnvioService.gerarCodigoPix(valor);
    res.json(pix);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar código PIX' });
  }
});

router.get('/pix-valor-carrinho', async (req, res) => {
  try {
    const pixData = await melhorEnvioService.gerarPixComValorDoCarrinho();
    res.json(pixData);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro interno ao gerar PIX' });
  }
});

router.get('/saldo-carrinho', async (req, res) => {
    try {
    const saldo = await melhorEnvioService.getBalance();
    const valor = await melhorEnvioService.getTotalValorCarrinho();
    res.json({
      saldo : saldo.balance,
      Frete : valor.total
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro busca valores' });
  }
});

router.get('/comprar-etiquetas', async (req, res) => {
  try {
    
    const resultado = await melhorEnvioService.comprarEtiquetas();
    res.json(resultado);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/etiqueta/gerar', async (req, res) => {
  try {
    const labelIds = req.body.labelIds;
    const resultado = await melhorEnvioService.gerarEtiqueta(labelIds);
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao gerar etiqueta:', error.message);
    res.status(500).json({ error: 'Erro ao gerar etiqueta.' });
  }
});

router.post('/imprimir-etiquetas-pdf', async (req, res) => {
  try {
    const orderIds = req.body.orderIds;

    if (!Array.isArray(orderIds)) {
      return res.status(400).json({ error: 'orderIds deve ser um array de IDs de ordens' });
    }

    const pdfBuffers = await melhorEnvioService.imprimirEtiquetasPDF(orderIds);

    res.setHeader('Content-Disposition', 'attachment; filename=etiquetas.pdf');
    res.setHeader('Content-Type', 'application/pdf');

    // Se você quiser retornar um único PDF com todas as etiquetas
    // const mergedPdf = await mergePdfs(pdfBuffers);
    // res.send(mergedPdf);

    // Se você quiser retornar os PDFs separados
    res.json({ pdfBuffers });
  } catch (error) {
    console.error('Erro ao imprimir etiquetas:', error.message);
    res.status(500).json({ error: 'Erro ao imprimir etiquetas.' });
  }
});

router.post('/imprimir-etiquetas', async (req, res) => {
  const { orders, mode } = req.body;
  try {
    const result = await melhorEnvioService.imprimirEtiquetas(orders, mode);
    res.json(result);
  } catch (error) {
    console.error('Erro ao gerar link de impressão:', error.message);
    res.status(500).json({ error: 'Erro ao gerar link de impressão.' });
  }
});


router.get('/etiquetas', async (req, res) => {
  try {
    const etiquetas = await melhorEnvioService.listarEtiquetas();
    res.json(etiquetas);
  } catch (error) {
    console.error('Erro ao listar etiquetas:', error.message);
    res.status(500).json({ error: 'Erro ao listar etiquetas.' });
  }
});

router.post('/rastrear-envios', async (req, res) => {
  try {
    const orders = req.body.orders;
    const resultado = await melhorEnvioService.rastrearEnvios(orders);
    res.json(resultado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao rastrear envios' });
  }
});

router.get('/rastreios/atualizar', async (req, res) => {
  try {
    const resultado = await melhorEnvioService.atualizarStatusComprasMelhorEnvio();
    res.json({ resultado });
  } catch (error) {
    console.error('Erro ao atualizar rastreios:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar rastreios.' });
  }
});

// Lista todos os itens do carrinho ME com detalhes (diagnóstico)
router.get('/carrinho-itens', async (req, res) => {
  try {
    const itens = await melhorEnvioService.listarItensCarrinho();
    const total = itens.reduce((s, i) => s + i.price, 0);
    res.json({ total, quantidade: itens.length, itens });
  } catch (error) {
    console.error('Erro ao listar itens do carrinho:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Remove do carrinho ME os itens de pedidos que não estão em "Pagar Etiqueta"
router.delete('/carrinho-limpar-obsoletos', async (req, res) => {
  try {
    const resultado = await melhorEnvioService.limparCarrinhoObsoleto();
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao limpar carrinho obsoleto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;