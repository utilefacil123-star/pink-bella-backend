const express = require('express');
const router = express.Router();
const db = require('../database');

// GET /categorias
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM categorias ORDER BY nome');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar categorias:', err.message);
    res.status(500).json({ error: 'Erro ao listar categorias.' });
  }
});

// POST /categorias
router.post('/', async (req, res) => {
  const { nome } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });

  try {
    const result = await db.query(
      'INSERT INTO categorias (nome) VALUES ($1) RETURNING *',
      [nome.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Categoria já existe.' });
    console.error('Erro ao criar categoria:', err.message);
    res.status(500).json({ error: 'Erro ao criar categoria.' });
  }
});

module.exports = router;
