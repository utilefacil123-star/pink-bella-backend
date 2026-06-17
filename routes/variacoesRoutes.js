const express = require('express');
const router = express.Router({ mergeParams: true }); // herda :id do produtosRoutes
const db = require('../database');

function gerarSku(nomeProduto, cor, tamanho) {
  const slug = (str) =>
    String(str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const corSlug = cor ? slug(cor) : 'unico';
  return `${slug(nomeProduto)}-${corSlug}-${slug(tamanho)}`;
}

async function atualizarEstoqueProduto(produtoId) {
  await db.query(
    `UPDATE produtos
     SET estoque = (
       SELECT COALESCE(SUM(estoque), 0)
       FROM produto_variacoes
       WHERE produto_id = $1 AND ativo = TRUE
     )
     WHERE id = $1`,
    [produtoId]
  );
}

// GET /produtos/:id/variacoes
router.get('/', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM produto_variacoes
       WHERE produto_id = $1
       ORDER BY ativo DESC, tamanho, cor NULLS LAST`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar variações:', err.message);
    res.status(500).json({ error: 'Erro ao listar variações.' });
  }
});

// POST /produtos/:id/variacoes
router.post('/', async (req, res) => {
  const { id } = req.params;
  const { tamanho, cor, estoque = 0, preco_variacao, imagem_url, sku: skuManual } = req.body;

  if (!tamanho) return res.status(400).json({ error: 'Tamanho é obrigatório.' });

  try {
    const prod = await db.query('SELECT nome FROM produtos WHERE id = $1', [id]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });

    const sku = skuManual || gerarSku(prod.rows[0].nome, cor, tamanho);

    const result = await db.query(
      `INSERT INTO produto_variacoes
         (produto_id, tamanho, cor, sku, estoque, preco_variacao, imagem_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, tamanho, cor || null, sku, estoque, preco_variacao || null, imagem_url || null]
    );

    await atualizarEstoqueProduto(id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe uma variação com esse tamanho/cor para este produto.' });
    }
    console.error('Erro ao criar variação:', err.message);
    res.status(500).json({ error: 'Erro ao criar variação.' });
  }
});

// PUT /produtos/:id/variacoes/:varId
router.put('/:varId', async (req, res) => {
  const { id, varId } = req.params;
  const { tamanho, cor, estoque, preco_variacao, imagem_url, ativo } = req.body;

  const campos = [];
  const valores = [];
  let idx = 1;

  if (tamanho     !== undefined) { campos.push(`tamanho = $${idx++}`);       valores.push(tamanho); }
  if (cor         !== undefined) { campos.push(`cor = $${idx++}`);            valores.push(cor || null); }
  if (estoque     !== undefined) { campos.push(`estoque = $${idx++}`);        valores.push(estoque); }
  if (preco_variacao !== undefined) { campos.push(`preco_variacao = $${idx++}`); valores.push(preco_variacao || null); }
  if (imagem_url  !== undefined) { campos.push(`imagem_url = $${idx++}`);    valores.push(imagem_url || null); }
  if (ativo       !== undefined) { campos.push(`ativo = $${idx++}`);          valores.push(ativo); }

  if (!campos.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

  valores.push(varId, id);

  try {
    const result = await db.query(
      `UPDATE produto_variacoes
       SET ${campos.join(', ')}
       WHERE id = $${idx++} AND produto_id = $${idx++}
       RETURNING *`,
      valores
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Variação não encontrada.' });

    await atualizarEstoqueProduto(id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar variação:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar variação.' });
  }
});

// DELETE /produtos/:id/variacoes/:varId (soft delete)
router.delete('/:varId', async (req, res) => {
  const { id, varId } = req.params;
  try {
    const result = await db.query(
      `UPDATE produto_variacoes SET ativo = FALSE
       WHERE id = $1 AND produto_id = $2
       RETURNING id`,
      [varId, id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Variação não encontrada.' });

    await atualizarEstoqueProduto(id);
    res.json({ message: 'Variação desativada com sucesso.' });
  } catch (err) {
    console.error('Erro ao desativar variação:', err.message);
    res.status(500).json({ error: 'Erro ao desativar variação.' });
  }
});

module.exports = router;
