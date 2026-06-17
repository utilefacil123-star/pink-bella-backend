const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../database');
const { uploadImagem, deletarImagem } = require('../utils/supabaseStorage');
const variacoesRoutes = require('./variacoesRoutes');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Sub-router de variações montado antes das rotas /:id para evitar conflito
router.use('/:id/variacoes', variacoesRoutes);

// GET /produtos — lista com categorias
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*,
        COALESCE(
          json_agg(json_build_object('id', c.id, 'nome', c.nome))
          FILTER (WHERE c.id IS NOT NULL),
          '[]'::json
        ) AS categorias
      FROM produtos p
      LEFT JOIN produto_categorias pc ON pc.produto_id = p.id
      LEFT JOIN categorias c ON c.id = pc.categoria_id
      WHERE p.ativo = 1
      GROUP BY p.id
      ORDER BY p.nome
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar produtos:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar produtos.' });
  }
});

// GET /produtos/:id — detalhe com categorias e variações ativas
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const prodResult = await db.query(`
      SELECT p.*,
        COALESCE(
          json_agg(json_build_object('id', c.id, 'nome', c.nome))
          FILTER (WHERE c.id IS NOT NULL),
          '[]'::json
        ) AS categorias
      FROM produtos p
      LEFT JOIN produto_categorias pc ON pc.produto_id = p.id
      LEFT JOIN categorias c ON c.id = pc.categoria_id
      WHERE p.id = $1 AND p.ativo = 1
      GROUP BY p.id
    `, [id]);

    if (!prodResult.rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });

    res.json(prodResult.rows[0]);
  } catch (err) {
    console.error('Erro ao buscar produto:', err.message);
    res.status(500).json({ error: 'Erro interno ao buscar o produto.' });
  }
});

// POST /produtos
router.post('/', upload.single('imagemProduto'), async (req, res) => {
  const { nome, preco, peso, altura, largura, comprimento, estoque } = req.body;

  if (!nome || !preco || !estoque) {
    return res.status(400).json({ error: 'Nome, preço e estoque são campos obrigatórios.' });
  }

  let imagem = null;
  if (req.file) {
    try {
      const ext = path.extname(req.file.originalname) || '.jpg';
      const nomeArquivo = `produto-${Date.now()}${ext}`;
      imagem = await uploadImagem(req.file.buffer, req.file.mimetype, nomeArquivo);
    } catch (err) {
      console.error('Erro no upload da imagem:', err.message);
      return res.status(500).json({ error: 'Erro ao fazer upload da imagem.' });
    }
  }

  db.run(
    `INSERT INTO produtos (nome, preco, peso, altura, largura, comprimento, estoque, imagem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [nome, preco, peso, altura, largura, comprimento, estoque, imagem],
    function (err) {
      if (err) {
        console.error('Erro ao cadastrar produto:', err.message);
        return res.status(500).json({ error: 'Erro interno ao cadastrar o produto.' });
      }
      res.status(201).json({ message: 'Produto cadastrado com sucesso!', productId: this.lastID, imagemPath: imagem });
    }
  );
});

// PUT /produtos/:id/categorias — substitui todas as categorias do produto
router.put('/:id/categorias', async (req, res) => {
  const { id } = req.params;
  const { categorias } = req.body; // array de IDs

  try {
    await db.query('DELETE FROM produto_categorias WHERE produto_id = $1', [id]);

    if (Array.isArray(categorias) && categorias.length > 0) {
      for (const catId of categorias) {
        await db.query(
          'INSERT INTO produto_categorias (produto_id, categoria_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, catId]
        );
      }
    }

    res.json({ message: 'Categorias atualizadas.' });
  } catch (err) {
    console.error('Erro ao atualizar categorias:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar categorias.' });
  }
});

// PUT /produtos/:id
router.put('/:id', upload.single('imagemProduto'), async (req, res) => {
  const { id } = req.params;
  const { nome, preco, peso, altura, largura, comprimento, estoque } = req.body;

  if (!nome || !preco || !estoque) {
    return res.status(400).json({ error: 'Nome, preço e estoque são campos obrigatórios para atualização.' });
  }

  let imagem = req.body.imagem || null;
  if (req.file) {
    try {
      if (imagem && imagem.includes('supabase')) await deletarImagem(imagem);
      const ext = path.extname(req.file.originalname) || '.jpg';
      const nomeArquivo = `produto-${Date.now()}${ext}`;
      imagem = await uploadImagem(req.file.buffer, req.file.mimetype, nomeArquivo);
    } catch (err) {
      console.error('Erro no upload da imagem:', err.message);
      return res.status(500).json({ error: 'Erro ao fazer upload da imagem.' });
    }
  }

  db.run(
    `UPDATE produtos SET nome = ?, preco = ?, peso = ?, altura = ?, largura = ?, comprimento = ?, estoque = ?, imagem = ?
     WHERE id = ?`,
    [nome, preco, peso, altura, largura, comprimento, estoque, imagem, id],
    function (err) {
      if (err) {
        console.error('Erro ao atualizar produto:', err.message);
        return res.status(500).json({ error: 'Erro interno ao atualizar o produto.' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Produto não encontrado ou nenhum dado alterado.' });
      }
      res.json({ message: 'Produto atualizado com sucesso!' });
    }
  );
});

// DELETE /produtos/:id (soft delete)
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  db.run(`UPDATE produtos SET ativo = 0 WHERE id = ? AND ativo = 1`, [id], function (err) {
    if (err) {
      console.error('Erro ao desativar produto:', err.message);
      return res.status(500).json({ error: 'Erro interno ao desativar o produto.' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ message: 'Produto removido com sucesso!' });
  });
});

module.exports = router;
