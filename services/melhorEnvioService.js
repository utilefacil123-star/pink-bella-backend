const axios = require('axios');
const db = require('../database');
const fs = require('fs');
const path = require('path');
const comprasService = require('../services/comprasService');
const melhorEnvioAuth = require('../services/melhorEnvioAuth');

const MELHOR_ENVIO_URL = process.env.MELHOR_ENVIO_URL;
const CEP_ORIGEM_LOJA = process.env.CEP_ORIGEM_LOJA;
const SEU_EMAIL_MELHOR_ENVIO = process.env.SEU_EMAIL_MELHOR_ENVIO;

// Medidas mínimas exigidas pelo Melhor Envio (em cm para altura/largura/comprimento, kg para peso)
const MEDIDAS_MINIMAS = {
    height: 2,
    width: 11,
    length: 16,
    weight: 0.1 // Peso mínimo em KG
};

/**
 * Calcula o frete usando a API do Melhor Envio, aplicando a lógica de dimensões personalizada da PinkBella.
 * @param {string} cepDestino - CEP de destino.
 * @param {number} quantidadeTotalItens - Quantidade total de unidades de produtos na compra.
 * @returns {Promise<Array>} - Retorna um array de opções de frete.
 * @param {Array<Object>} orders
 */
async function calcularFrete(cepDestino, quantidadeTotalItens) {
    if (!CEP_ORIGEM_LOJA || !SEU_EMAIL_MELHOR_ENVIO) {
        throw new Error('CEP de origem da loja ou e-mail do Melhor Envio não configurados no .env');
    }
    if (typeof quantidadeTotalItens !== 'number' || quantidadeTotalItens <= 0) {
        throw new Error('A quantidade total de itens é obrigatória e deve ser um número positivo para calcular o frete.');
    }
    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();

    // --- Lógica para agregar peso e dimensões dos produtos com base na quantidadeTotalItens ---
    let pesoCalculado = 0;
    if (quantidadeTotalItens === 1) {
        pesoCalculado = 500; // 500g para o primeiro item
    } else if (quantidadeTotalItens > 1) {
        pesoCalculado = 500 + (250 * (quantidadeTotalItens - 1)); // 500g + 250g para cada item extra
    }

    let alturaCalculada = 0;
    if (quantidadeTotalItens === 1) {
        alturaCalculada = 8; // 8cm para o primeiro item
    } else if (quantidadeTotalItens > 1) {
        alturaCalculada = 8 + (2 * (quantidadeTotalItens - 1)); // 8cm + 2cm para cada item extra
    }

    // Largura e Comprimento são fixos em 25cm
    const larguraFixa = 25;
    const comprimentoFixo = 25;

    // Garante que as dimensões e peso respeitem os mínimos exigidos pelo Melhor Envio
    // E converte peso para KG (dividindo por 1000)
    const pacoteFinal = {
        height: Math.max(alturaCalculada, MEDIDAS_MINIMAS.height),
        width: Math.max(larguraFixa, MEDIDAS_MINIMAS.width),
        length: Math.max(comprimentoFixo, MEDIDAS_MINIMAS.length),
        weight: Math.max(pesoCalculado / 1000, MEDIDAS_MINIMAS.weight) // Peso em KG
    };
    // --- Fim da lógica de agregação ---

    const dadosFrete = {
        from: { postal_code: CEP_ORIGEM_LOJA },
        to: { postal_code: cepDestino },
        volumes: [pacoteFinal], // Envia o pacote final calculado
        options: {
            receipt: false,
            own_hand: false
        }
    };

    try {
        const response = await axios.post(`${MELHOR_ENVIO_URL}/me/shipment/calculate`, dadosFrete, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
                'User-Agent': `PinkBellaBackend (${SEU_EMAIL_MELHOR_ENVIO})`
            }
        });

        const opcoesValidas = response.data
            .filter(service => !service.error)
            .map(service => ({
                ...service,
                pacote_utilizado: pacoteFinal // Adiciona os detalhes do pacote usado para o cálculo
            }));

        if (opcoesValidas.length === 0) {
            console.error('Melhor Envio: Nenhuma opção de frete válida encontrada para o trecho/dimensões.');
            throw new Error('Nenhuma opção de frete disponível para o trecho ou dimensões informadas.');
        }

        return opcoesValidas;

    } catch (error) {
        console.error('Erro ao chamar a API do Melhor Envio:', error.message);
        if (error.response) {
            console.error('Detalhes do erro Melhor Envio:', error.response.data);
            // Tenta pegar uma mensagem de erro mais específica do Melhor Envio, se houver
            const melhorEnvioErrorMsg = error.response.data.message || (error.response.data.errors && Object.values(error.response.data.errors).flat().join(', '));
            throw new Error(`Erro na integração com Melhor Envio: ${melhorEnvioErrorMsg || JSON.stringify(error.response.data)}`);
        }
        throw new Error('Erro desconhecido ao calcular frete com Melhor Envio.');
    }
}

async function adicionarEnviosAoCarrinho(purchaseId) {
  if (!purchaseId) {
    throw new Error("É necessário fornecer um ID de compra válido.");
  }

  try {
    // Busca dados da compra, cliente, endereço e loja
    const purchaseDetailsQuery = `
      SELECT
        c.id AS compra_id,
        c.valor_produtos AS insurance_value,
        c.melhor_envio_service_id AS service_id,
        c.peso_pacote AS package_weight,
        c.altura_pacote AS package_height,
        c.largura_pacote AS package_width,
        c.comprimento_pacote AS package_length,
        c.codigo_etiqueta AS codigo_etiqueta_existente,
        c.valor_frete AS valor_frete_existente,
        c.codigo_envio AS codigo_envio_existente,
        cli.nome AS destinatario_name,
        cli.telefone AS destinatario_phone,
        cli.email AS destinatario_email,
        cli.cpf AS destinatario_document,
        en.logradouro AS destinatario_address,
        en.complemento AS destinatario_complement,
        en.numero AS destinatario_number,
        en.bairro AS destinatario_district,
        en.cidade AS destinatario_city,
        en.estado AS destinatario_state_abbr,
        en.cep AS destinatario_postal_code,
        'BR' AS destinatario_country_id
      FROM compras c
      JOIN clientes cli ON cli.id = c.cliente_id
      JOIN enderecos en ON en.id = c.endereco_entrega_id
      WHERE c.id = ?
    `;

    const purchase = await new Promise((resolve, reject) => {
      db.get(purchaseDetailsQuery, [purchaseId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!purchase) {
      throw new Error(`Compra ${purchaseId} não encontrada no banco de dados.`);
    }

    // Se já foi adicionada ao carrinho Melhor Envio, retorna sem duplicar
    if (purchase.codigo_etiqueta_existente) {
      console.log(`Compra ${purchaseId} já no carrinho ME (${purchase.codigo_etiqueta_existente}). Pulando.`);
      return {
        id: purchase.codigo_etiqueta_existente,
        price: purchase.valor_frete_existente,
        protocol: purchase.codigo_envio_existente
      };
    }

    // Valida campos obrigatórios antes de chamar a API do Melhor Envio
    if (!purchase.service_id) {
      throw new Error(`Compra ${purchaseId} não tem serviço de frete selecionado (melhor_envio_service_id é nulo).`);
    }
    if (!purchase.destinatario_postal_code) {
      throw new Error(`Compra ${purchaseId} não tem CEP de destino.`);
    }

    // Busca produtos da compra
    const productsInPurchaseQuery = `
      SELECT
        p.nome AS product_name,
        ic.quantidade AS quantity,
        ic.preco_unitario_no_momento_da_compra AS unitary_value,
        p.peso AS item_weight,
        p.altura AS item_height,
        p.largura AS item_width,
        p.comprimento AS item_length
      FROM itens_compra ic
      JOIN produtos p ON p.id = ic.produto_id
      WHERE ic.compra_id = ?
    `;

    const productsInPurchase = await new Promise((resolve, reject) => {
      db.all(productsInPurchaseQuery, [purchaseId], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    let totalWeight = purchase.package_weight || 0;
    let packageHeight = purchase.package_height || 0;
    let packageWidth = purchase.package_width || 0;
    let packageLength = purchase.package_length || 0;

    const loja = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM configuracoes_loja LIMIT 1', [], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!loja) {
      throw new Error('Configurações da loja não encontradas. Cadastre os dados em Configurações.');
    }

    const productsForMelhorEnvio = productsInPurchase.map(item => {
      if (!purchase.package_weight) {
        totalWeight += (item.item_weight || 0) * item.quantity;
        packageHeight = Math.max(packageHeight, (item.item_height || 0));
        packageWidth = Math.max(packageWidth, (item.item_width || 0));
        packageLength = Math.max(packageLength, (item.item_length || 0));
      }

      return {
        name: item.product_name,
        quantity: String(item.quantity),
        unitary_value: String(item.unitary_value)
      };
    });

    // Monta o objeto de envio (único), e envia como array
    const orderMelhorEnvio = {
      from: {
        name: loja.nome,
        phone: loja.telefone,
        email: loja.email,
        document: loja.documento,
        address: loja.logradouro,
        state_register: loja.estado_sigla,
        number: loja.numero,
        district: loja.bairro,
        city: loja.cidade,
        country_id: loja.pais_id || 'BR',
        postal_code: loja.cep,
        state_abbr: loja.estado_sigla,
        complement: loja.complemento || ''
      },
      to: {
        name: purchase.destinatario_name,
        phone: "+55" + String(purchase.destinatario_phone || '').replace(/\D/g, ''),
        email: purchase.destinatario_email || '',
        document: (purchase.destinatario_document || '').replace(/\D/g, ''),
        address: purchase.destinatario_address || '',
        complement: purchase.destinatario_complement || '',
        number: String(purchase.destinatario_number || 'S/N'),
        district: purchase.destinatario_district || '',
        city: purchase.destinatario_city || '',
        country_id: "BR",
        postal_code: (purchase.destinatario_postal_code || '').replace(/\D/g, ''),
        state_abbr: purchase.destinatario_state_abbr || ''
      },
      service: purchase.service_id,
      volumes: [
        {
          height: packageHeight,
          width: packageWidth,
          length: packageLength,
          weight: totalWeight
        }
      ],
      options: {
        insurance_value: purchase.insurance_value,
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: true,
        platform: "Pink Bella",
        tags: [
          {
            tag: `PinkBella-Compra-${purchase.compra_id}`,
            url: `https://sua-plataforma.com/pedidos/${purchase.compra_id}`
          }
        ],
        invoice: { key: null }
      },
      products: productsForMelhorEnvio
    };

    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
    const response = await axios.post(`${MELHOR_ENVIO_URL}/me/cart`, orderMelhorEnvio, {
      headers: {
        'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    const price = response.data.price; // valor do frete (string ou number)
    const codigo_envio = response.data.protocol;
    const codigo_etiqueta = response.data.id

    await new Promise((resolve, reject) => { 
  db.run(
    'UPDATE compras SET valor_frete = ?, codigo_envio = ?, codigo_etiqueta =? WHERE id = ?',
    [parseFloat(price), codigo_envio, codigo_etiqueta, purchaseId],
    function (err) {
      if (err) return reject(err);
      resolve();
    }
  );
});

    return response.data;

  } catch (error) {
    console.error("Erro ao adicionar envios ao carrinho:", error);
    if (error.response) {
      console.error("Erro da API Melhor Envio:", error.response.data);
      throw new Error(`Erro da API Melhor Envio para compra ${purchaseId}: ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Erro interno ao processar compra ${purchaseId}: ${error.message}`);
  }
}

async function verificarStatusCompra(compraId, status) {
  try {
    const compra = await new Promise((resolve, reject) => {
      db.get('SELECT status_compra FROM compras WHERE id = ?', [compraId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!compra) {
      throw new Error('Compra não encontrada.');
    }

    // Bloqueia apenas status que não têm ação útil ao repetir
    const statusIdempotentes = ['Cancelado', 'Entregue', 'Postado', 'Processado'];
    if (compra.status_compra === status && statusIdempotentes.includes(status)) {
      return { status_compra: compra.status_compra, aviso: 'Compra já está com este status.' };
    }

    let novoStatus = null;

    switch (status) {
      case 'Pago':
        // Atualiza para "Pago" no banco primeiro — garante que o status muda mesmo se o carrinho falhar
        await comprasService.atualizarStatusCompra(compraId, 'Pago');
        try {
          await adicionarEnviosAoCarrinho(compraId);
          await comprasService.atualizarStatusCompra(compraId, 'Pagar Etiqueta');
          novoStatus = 'Pagar Etiqueta';
        } catch (cartErr) {
          // Carrinho falhou — status fica em "Pago" para o usuário tentar novamente
          console.error(`Erro ao adicionar compra ${compraId} ao carrinho ME:`, cartErr.message);
          return { status_compra: 'Pago', aviso: `Status atualizado para Pago, mas falhou ao adicionar ao carrinho Melhor Envio: ${cartErr.message}` };
        }
        break;

      case 'Pagar Etiqueta':
        // Tentativa manual de (re)adicionar ao carrinho e marcar como aguardando
        try {
          await adicionarEnviosAoCarrinho(compraId);
        } catch (cartErr) {
          console.error(`Erro ao adicionar compra ${compraId} ao carrinho ME:`, cartErr.message);
          throw cartErr;
        }
        await comprasService.atualizarStatusCompra(compraId, 'Aguardando Etiqueta');
        novoStatus = 'Aguardando Etiqueta';
        break;

      case 'Aguardando Etiqueta':
        await comprasService.atualizarStatusCompra(compraId, 'Aguardando Etiqueta');
        novoStatus = 'Aguardando Etiqueta';
        break;

      case 'Cancelado':
      case 'Cancelada':
      case 'canceled':
        await comprasService.atualizarStatusCompra(compraId, 'Cancelado');
        novoStatus = 'Cancelado';
        break;

      // Eventos do webhook Melhor Envio
      case 'paid':
        await comprasService.atualizarStatusCompra(compraId, 'Pago');
        novoStatus = 'Pago';
        break;
      case 'pending':
        await comprasService.atualizarStatusCompra(compraId, 'Pagar Etiqueta');
        novoStatus = 'Pagar Etiqueta';
        break;
      case 'released':
      case 'generated':
        await comprasService.atualizarStatusCompra(compraId, 'Etiqueta PDF Gerada');
        novoStatus = 'Etiqueta PDF Gerada';
        break;
      case 'posted':
        await comprasService.atualizarStatusCompra(compraId, 'Postado');
        novoStatus = 'Postado';
        break;
      case 'received':
        await comprasService.atualizarStatusCompra(compraId, 'Processado');
        novoStatus = 'Processado';
        break;
      case 'delivered':
        await comprasService.atualizarStatusCompra(compraId, 'Entregue');
        novoStatus = 'Entregue';
        break;

      default:
        // Status interno direto (ex: "Postado", "Processado" vindos do frontend)
        await comprasService.atualizarStatusCompra(compraId, status);
        novoStatus = status;
        break;
    }

    return { status_compra: novoStatus };

  } catch (error) {
    console.error('Erro ao verificar status da compra:', error.message);
    throw error;
  }
}

async function getTotalValorCarrinho() {
  try {
    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
    const response = await axios.get(`${MELHOR_ENVIO_URL}/me/cart`, {
      headers: {
        'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    const etiquetas = response.data.data;


    // Garante que é um array
    if (!Array.isArray(etiquetas)) {
      throw new Error('Resposta do carrinho não é um array');
    }

    // Soma os valores de todas as etiquetas no carrinho
    /*const total = etiquetas.reduce((acc, etiqueta) => {
      return acc + parseFloat(etiqueta.price || 0);
    }, 0);*/

    const resultado = etiquetas.reduce((acc, etiqueta) => {
      acc.total += parseFloat(etiqueta.price || 0);
      acc.ids.push(etiqueta.id);
      return acc;
    }, { total: 0, ids: [] });

    return resultado;

  } catch (error) {
    console.error('Erro ao consultar o carrinho:', error.message);
    throw error;
  }
}

async function getBalance() {
  try {
    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
    const response = await axios.get(`${MELHOR_ENVIO_URL}/me/balance`, {
      headers: {
        'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error("Erro ao consultar saldo no Melhor Envio:", error.message);
    if (error.response) {
      console.error("Detalhes do erro da API Melhor Envio (saldo):", error.response.data);
    }
    throw error;
  }
}

async function gerarCodigoPix(valorReais) {
  try {
    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
    const payload = {
      value: valorReais.toFixed(2),          // valor como string, ex: "10.50"
      gateway: 'yapay-transparente',          // gateway correto
      slug: 'pix'                            // tipo de pagamento
      // Você pode adicionar outros campos opcionais, ex: redirect_url, finger_print, company_name, cnpj
    };

    const response = await axios.post(`${MELHOR_ENVIO_URL}/me/balance`, payload, {
      headers: {
        'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `${SEU_EMAIL_MELHOR_ENVIO}`  // altere para sua app e contato
      }
    });

    return response.data;

  } catch (error) {
    console.error('Erro ao gerar código PIX:', error.message);
    if (error.response) {
      console.error('Detalhes do erro da API Melhor Envio (PIX):', error.response.data);
    }
    throw error;
  }
}

async function gerarPixComValorDoCarrinho() {
    try {
        const { total } = await getTotalValorCarrinho();

        if (!total || total <= 0) {
            throw new Error('Carrinho vazio ou valor inválido para gerar PIX.');
        }

        // Chama a função que faz a requisição para o Melhor Envio (adicionarCredito)
        // Certifique-se de que 'adicionarCredito' está retornando 'response.data' corretamente
        const pixResponse = await gerarCodigoPix(total); 

        let codigoPixCopiaECola = '';
        let urlQrCodeImagem = '';
        let detalhesInternosPix = null; // Para guardar o JSON parseado de 'payment.response'

        // A estrutura da resposta é mais "plana" do que eu esperava para os campos principais:
        // 'digitable' e 'redirect' estão no nível superior.
        if (pixResponse) {
            codigoPixCopiaECola = pixResponse.digitable || '';
            urlQrCodeImagem = pixResponse.redirect || ''; // A URL da imagem do QR Code

            // O campo 'response' dentro de 'payment' é uma string JSON que precisa ser parseada.
            if (pixResponse.payment && typeof pixResponse.payment.response === 'string') {
                try {
                    // Tenta fazer o parse da string JSON aninhada
                    const parsedInternalResponse = JSON.parse(pixResponse.payment.response);
                    detalhesInternosPix = parsedInternalResponse; // Armazena para debug ou uso futuro
                    
                    // Você pode opcionalmente verificar aqui se os caminhos internos batem com os externos
                    // console.log('Parsed internal qrcode_original_path:', parsedInternalResponse.data_response?.transaction?.payment?.qrcode_original_path);
                    // console.log('Parsed internal qrcode_path:', parsedInternalResponse.data_response?.transaction?.payment?.qrcode_path);

                } catch (e) {
                    console.error('Erro ao fazer parse da string JSON interna (pixResponse.payment.response):', e);
                }
            }


        } else {
            console.error('Resposta da API de PIX vazia ou inválida:', pixResponse);
            throw new Error('Não foi possível obter uma resposta válida da API de PIX.');
        }

        const token = detalhesInternosPix?.data_response?.transaction?.token_transaction;

        return {
            valor: total.toFixed(2),
            codigoParaCopiar: codigoPixCopiaECola,
            urlQrCodeImagem: urlQrCodeImagem,
            transactionToken: token
            // Opcional: Incluir os detalhes internos se precisar deles no frontend
            //detalhesApiCompletos: detalhesInternosPix 
        };

    } catch (error) {
        console.error('Erro ao gerar código PIX com valor do carrinho:', error.message);
        throw error;
    }
}

async function comprarEtiquetas(listaDeIds) {
  try {
    const carrinho = await getTotalValorCarrinho()
    const labelIds = carrinho.ids

    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
  const response = await axios.post(
      `${MELHOR_ENVIO_URL}/me/shipment/checkout`,
      {
        orders: labelIds
      },
      {
        headers: {
          'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'PinkBella'//USER_AGENT
        }
      }
    );

    await comprasService.atualizarStatusPorCodigoEtiqueta(labelIds, 'Aguardando Etiqueta');

    return response.data;
  } catch (error) {
    console.error('Erro ao comprar etiquetas:', error.response?.data || error.message);
    throw new Error('Erro ao realizar o checkout das etiquetas.');
  }
}

async function gerarEtiqueta(labelIds) {
    if (!Array.isArray(labelIds) || labelIds.length === 0) {
        throw new Error('Você deve fornecer pelo menos um ID de etiqueta.');
    }

    try {
        const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
        const response = await axios.post(
            `${MELHOR_ENVIO_URL}/me/shipment/generate`,
            { orders: labelIds },
            {
                headers: {
                    Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'PinkBella'//USER_AGENT
                }
            }
        );

        await comprasService.atualizarStatusPorCodigoEtiqueta(labelIds, 'Etiqueta PDF Gerada');

        return response.data;

    } catch (error) {
        console.error('Erro ao gerar etiqueta:', error.response?.data || error.message);
        throw new Error(error.response?.data?.message || 'Erro ao gerar a etiqueta no Melhor Envio.');
    }
}

async function imprimirEtiquetasPDF(orderIds) {
  try {
    if (!Array.isArray(orderIds)) {
      throw new Error('orderIds deve ser um array de IDs de ordens');
    }

    const pdfBuffers = [];

    for (const orderId of orderIds) {
      const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
      const response = await axios.get(
        `${MELHOR_ENVIO_URL}/me/imprimir/pdf/${orderId}`,
        {
          headers: {
            Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
            'User-Agent': `Nome da Aplicação (email@example.com)`,
          },
        }
      );

      const pdfResponse = await axios.get(response.data, {
        responseType: 'arraybuffer',
      });

      const pdfBuffer = Buffer.from(pdfResponse.data, 'binary');
      pdfBuffers.push(pdfBuffer);

      // Chamar o método salvarPdf
      await salvarPdf(orderId, pdfBuffer);
    }

    return pdfBuffers;
  } catch (error) {
    console.error('Erro ao imprimir etiquetas:', error.message);
    throw new Error('Erro ao imprimir etiquetas.');
  }
}

async function salvarPdf(orderId, pdfBuffer) {
  const pasta = path.join(__dirname, 'pdfs');
  if (!fs.existsSync(pasta)) {
    fs.mkdirSync(pasta);
  }
  const arquivo = path.join(pasta, `${orderId}.pdf`);
  fs.writeFileSync(arquivo, pdfBuffer);
}

async function imprimirEtiquetas(orders, mode = 'private') {
  try {
    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
    const response = await axios.post(
      `${MELHOR_ENVIO_URL}/me/shipment/print`,
      {
        orders,
        mode,
      },
      {
        headers: {
          Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
        },
      }
    );
    
    orders.forEach(compraId => {
      salvarUrlMelhorEnvio(compraId, response.data.url);
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao gerar link de impressão:', error.response?.data || error.message);
    throw new Error('Erro ao gerar link de impressão.');
  }
}

async function salvarUrlMelhorEnvio(compraId, url) {
  try {
    const compra = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM compras WHERE codigo_etiqueta = ?',
        [compraId],
        function(err, row) {
          if (err) return reject(err);
          resolve(row);
        }
      );
    });

    if (!compra) {
      throw new Error('Compra não encontrada');
    }

    const result = await new Promise((resolve, reject) => {
      db.run(
        'UPDATE compras SET url_melhor_envio = ? WHERE codigo_etiqueta = ?',
        [url, compraId],
        function(err) {
          if (err) return reject(err);
          resolve(this.changes);
        }
      );
    });

    return { message: 'URL salva com sucesso!' };
  } catch (error) {
    console.error('Erro ao salvar URL do Melhor Envio:', error.message);
    throw error;
  }
}

//Listar de etique ainda não esta funcionando
async function listarEtiquetas(status = '', page = 1, limit = 10) {
    try {
      const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
      const response = await axios.get(`${MELHOR_ENVIO_URL}/me/orders`, {
        headers: {
          Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'PinkBellaStore/1.0'
        },
        params: {
          //status, // Ex: 'paid', 'pending', 'shipped', etc.
          page,
          limit
        }
      });

      return response.data;
    } catch (error) {
      console.error('Erro ao listar etiquetas:', error?.response?.data || error.message);
      throw error;
    }
  }


const rastrearEnvios = async (orders) => {
  const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
  const headers = {
    Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
    'User-Agent': `Nome da Aplicação (email@example.com)`,
    'Content-Type': 'application/json',
  };

  const body = {
    orders: orders,
  };

  try {
    const response = await axios.post(`${MELHOR_ENVIO_URL}/me/shipment/tracking`, body, { headers });
    return response.data;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

async function atualizarCodigoRastreio(compraId, codigoRastreioBruto) {
  try {
    // Busca o código atual e a transportadora
    const dadosCompra = await new Promise((resolve, reject) => {
      db.get('SELECT codigo_rastreio, transportadora FROM compras WHERE id = ?', [compraId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!dadosCompra) throw new Error('Compra não encontrada.');

    if (dadosCompra.codigo_rastreio) {
      return;
    }

    const transportadora = (dadosCompra.transportadora || 'correios').toLowerCase().replace(/\s/g, '');
    const urlRastreio = `https://app.melhorrastreio.com.br/app/${transportadora}/${codigoRastreioBruto}`;

    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE compras SET codigo_rastreio = ? WHERE id = ?',
        [urlRastreio, compraId],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  } catch (error) {
    console.error(`Erro ao atualizar código de rastreio da compra ${compraId}:`, error.message);
    throw error;
  }
}

async function atualizarStatusComprasMelhorEnvio() {
  try {
    const compras = await comprasService.buscarComprasComEtiquetaPendente();

    if (compras.length === 0) {
      return;
    }

    const labelIds = compras.map((c) => c.codigo_etiqueta);
    const dadosRastreamento = await rastrearEnvios(labelIds); // Passo 3: já existe

    for (const [labelId, dados] of Object.entries(dadosRastreamento)) {
      const statusMelhorEnvio = dados.status;
      const codigoRastreio = dados.tracking || dados.melhorenvio_tracking;

      const compra = compras.find((c) => c.codigo_etiqueta === labelId);
      if (!compra) continue;

      // Atualiza o código de rastreio se disponível
      if (codigoRastreio) {
        
        await atualizarCodigoRastreio(compra.id, codigoRastreio);
      }

      // Atualiza o status usando o método que já trata os casos
      await verificarStatusCompra(compra.id, statusMelhorEnvio);
    }

  } catch (error) {
    console.error('Erro ao atualizar status das compras:', error.message);
  }
}

// Lista todos os itens do carrinho ME com seus detalhes e compra associada
async function listarItensCarrinho() {
  const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
  const response = await axios.get(`${MELHOR_ENVIO_URL}/me/cart`, {
    headers: { 'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`, 'Accept': 'application/json' }
  });
  const etiquetas = response.data.data || [];

  const itens = etiquetas.map(e => {
    // Extrai o ID da compra da tag "PinkBella-Compra-{id}"
    const tag = (e.options?.tags || []).find(t => t.tag && t.tag.startsWith('PinkBella-Compra-'));
    const compraId = tag ? parseInt(tag.tag.replace('PinkBella-Compra-', ''), 10) : null;
    return {
      id: e.id,
      price: parseFloat(e.price || 0),
      service: e.service?.name || null,
      compraId
    };
  });

  return itens;
}

// Remove do carrinho ME os itens que não pertencem a compras ativas (status "Pagar Etiqueta")
async function limparCarrinhoObsoleto() {
  const itens = await listarItensCarrinho();
  if (itens.length === 0) return { removidos: [], mantidos: [], totalAntes: 0, totalDepois: 0 };

  const totalAntes = itens.reduce((s, i) => s + i.price, 0);

  // Consulta o status de cada compra referenciada
  const idsUnicos = [...new Set(itens.map(i => i.compraId).filter(Boolean))];
  const statusPorCompra = {};
  for (const id of idsUnicos) {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT status_compra FROM compras WHERE id = ?', [id], (err, r) => {
        if (err) return reject(err);
        resolve(r);
      });
    });
    statusPorCompra[id] = row ? row.status_compra : null;
  }

  const idsParaRemover = [];
  const removidos = [];
  const mantidos = [];

  for (const item of itens) {
    const status = statusPorCompra[item.compraId];
    // Mantém apenas compras em "Pagar Etiqueta" — todo o resto é obsoleto
    if (status === 'Pagar Etiqueta') {
      mantidos.push(item);
    } else {
      idsParaRemover.push(item.id);
      removidos.push({ ...item, statusCompra: status || 'não encontrada' });
    }
  }

  if (idsParaRemover.length > 0) {
    const MELHOR_ENVIO_TOKEN = await melhorEnvioAuth.getValidToken();
    await axios.delete(`${MELHOR_ENVIO_URL}/me/cart`, {
      headers: {
        'Authorization': `Bearer ${MELHOR_ENVIO_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: { orders: idsParaRemover }
    });
  }

  const totalDepois = mantidos.reduce((s, i) => s + i.price, 0);
  return { removidos, mantidos, totalAntes, totalDepois };
}

module.exports = {
    calcularFrete,
    adicionarEnviosAoCarrinho,
    getTotalValorCarrinho,
    listarItensCarrinho,
    limparCarrinhoObsoleto,
    getBalance,
    gerarCodigoPix,
    gerarPixComValorDoCarrinho,
    comprarEtiquetas,
    gerarEtiqueta,
    imprimirEtiquetas,
    imprimirEtiquetasPDF,
    listarEtiquetas,
    rastrearEnvios,
    verificarStatusCompra,
    atualizarStatusComprasMelhorEnvio
};