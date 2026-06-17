// Mocks declarados antes de qualquer require (jest.mock é hoisted)
jest.mock('../database', () => ({
  query: jest.fn(),
  run:   jest.fn(),
  get:   jest.fn(),
  all:   jest.fn(),
  pool:  { end: jest.fn() },
}));

jest.mock('../utils/supabaseStorage', () => ({
  uploadImagem: jest.fn().mockResolvedValue('http://mock.test/img.jpg'),
  deletarImagem: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const app = require('../app');
const db  = require('../database');

beforeEach(() => jest.resetAllMocks());

// ─── GET /produtos/:id/variacoes ─────────────────────────────────────────────

describe('GET /produtos/:id/variacoes', () => {
  it('retorna lista de variações ativas e inativas', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 1, produto_id: 10, tamanho: 'M', cor: 'Rosa', sku: 'vestido-rosa-m', estoque: 5, ativo: true },
        { id: 2, produto_id: 10, tamanho: 'G', cor: 'Rosa', sku: 'vestido-rosa-g', estoque: 0, ativo: false },
      ],
    });

    const res = await request(app).get('/produtos/10/variacoes');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].tamanho).toBe('M');
    expect(res.body[1].ativo).toBe(false);
  });

  it('retorna array vazio quando não há variações', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/produtos/99/variacoes');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retorna 500 em erro de banco', async () => {
    db.query.mockRejectedValueOnce(new Error('falha no banco'));

    const res = await request(app).get('/produtos/10/variacoes');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ─── POST /produtos/:id/variacoes ────────────────────────────────────────────

describe('POST /produtos/:id/variacoes', () => {
  it('cria variação e gera SKU automaticamente', async () => {
    // 1) buscar nome do produto
    db.query.mockResolvedValueOnce({ rows: [{ nome: 'Vestido Floral' }] });
    // 2) INSERT variação
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 1, produto_id: 10, tamanho: 'M', cor: 'Rosa',
        sku: 'vestido-floral-rosa-m', estoque: 5, ativo: true,
      }],
    });
    // 3) sync estoque produto
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/produtos/10/variacoes')
      .send({ tamanho: 'M', cor: 'Rosa', estoque: 5 });

    expect(res.status).toBe(201);
    expect(res.body.sku).toBe('vestido-floral-rosa-m');
    expect(res.body.tamanho).toBe('M');
  });

  it('cria variação sem cor (tamanho único)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ nome: 'Camiseta' }] });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 2, produto_id: 10, tamanho: 'Único', cor: null, sku: 'camiseta-unico-unico', estoque: 10, ativo: true }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/produtos/10/variacoes')
      .send({ tamanho: 'Único', estoque: 10 });

    expect(res.status).toBe(201);
    expect(res.body.cor).toBeNull();
  });

  it('retorna 400 se tamanho não for informado', async () => {
    const res = await request(app)
      .post('/produtos/10/variacoes')
      .send({ cor: 'Rosa', estoque: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tamanho/i);
  });

  it('retorna 404 se produto não existir', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // produto não encontrado

    const res = await request(app)
      .post('/produtos/9999/variacoes')
      .send({ tamanho: 'P' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/produto/i);
  });

  it('retorna 400 em conflito de SKU (unique constraint)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ nome: 'Blusa' }] });
    const err = new Error('duplicate key'); err.code = '23505';
    db.query.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/produtos/10/variacoes')
      .send({ tamanho: 'M', cor: 'Azul' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tamanho\/cor/i);
  });
});

// ─── PUT /produtos/:id/variacoes/:varId ──────────────────────────────────────

describe('PUT /produtos/:id/variacoes/:varId', () => {
  it('atualiza estoque da variação', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, produto_id: 10, tamanho: 'M', cor: 'Rosa', estoque: 20, ativo: true }],
    });
    db.query.mockResolvedValueOnce({ rows: [] }); // sync estoque

    const res = await request(app)
      .put('/produtos/10/variacoes/1')
      .send({ estoque: 20 });

    expect(res.status).toBe(200);
    expect(res.body.estoque).toBe(20);
  });

  it('atualiza múltiplos campos de uma vez', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, produto_id: 10, tamanho: 'GG', cor: 'Preto', estoque: 3, preco_variacao: 89.90, ativo: true }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/produtos/10/variacoes/1')
      .send({ tamanho: 'GG', cor: 'Preto', estoque: 3, preco_variacao: 89.90 });

    expect(res.status).toBe(200);
    expect(res.body.tamanho).toBe('GG');
  });

  it('desativa variação via ativo=false', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, produto_id: 10, tamanho: 'P', ativo: false }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/produtos/10/variacoes/1')
      .send({ ativo: false });

    expect(res.status).toBe(200);
    expect(res.body.ativo).toBe(false);
  });

  it('retorna 400 se nenhum campo for enviado', async () => {
    const res = await request(app)
      .put('/produtos/10/variacoes/1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nenhum campo/i);
  });

  it('retorna 404 se variação não existir', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // update retornou 0 linhas
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/produtos/10/variacoes/9999')
      .send({ estoque: 5 });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /produtos/:id/variacoes/:varId ───────────────────────────────────

describe('DELETE /produtos/:id/variacoes/:varId', () => {
  it('desativa variação (soft delete)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // update ativo=FALSE
    db.query.mockResolvedValueOnce({ rows: [] });           // sync estoque

    const res = await request(app).delete('/produtos/10/variacoes/1');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/desativada/i);
  });

  it('retorna 404 se variação não existir', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // nenhuma linha atualizada

    const res = await request(app).delete('/produtos/10/variacoes/9999');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('retorna 500 em erro de banco', async () => {
    db.query.mockRejectedValueOnce(new Error('erro no banco'));

    const res = await request(app).delete('/produtos/10/variacoes/1');
    expect(res.status).toBe(500);
  });
});

// ─── PUT /produtos/:id/categorias ────────────────────────────────────────────

describe('PUT /produtos/:id/categorias', () => {
  it('salva categorias do produto (substitui todas)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // DELETE
    db.query.mockResolvedValueOnce({ rows: [] }); // INSERT cat 1
    db.query.mockResolvedValueOnce({ rows: [] }); // INSERT cat 2

    const res = await request(app)
      .put('/produtos/10/categorias')
      .send({ categorias: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/atualizadas/i);
    // Deve ter chamado query 3 vezes: 1 DELETE + 2 INSERTs
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('remove todas as categorias ao enviar array vazio', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // somente DELETE

    const res = await request(app)
      .put('/produtos/10/categorias')
      .send({ categorias: [] });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
