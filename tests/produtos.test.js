jest.mock('../database', () => ({
  query: jest.fn(),
  run:   jest.fn(),
  get:   jest.fn(),
  all:   jest.fn(),
  pool:  { end: jest.fn() },
}));

jest.mock('../utils/supabaseStorage', () => ({
  uploadImagem: jest.fn().mockResolvedValue('http://mock.test/vestido.jpg'),
  deletarImagem: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const app = require('../app');
const db  = require('../database');

// Helpers para simular db.run com callback (usado em POST/PUT/DELETE)
function mockRun({ lastID = null, changes = 1, err = null } = {}) {
  db.run.mockImplementationOnce((_sql, _params, callback) => {
    if (typeof _params === 'function') { _params.call({ lastID, changes }, err); return; }
    if (typeof callback === 'function') callback.call({ lastID, changes }, err);
  });
}

beforeEach(() => jest.resetAllMocks());

// ─── GET /produtos ────────────────────────────────────────────────────────────

describe('GET /produtos', () => {
  it('retorna array vazio quando não há produtos', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/produtos');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retorna produtos com campo categorias', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 1, nome: 'Vestido Floral', preco: 99.90, estoque: 10, ativo: 1, categorias: [{ id: 1, nome: 'Vestido' }] },
        { id: 2, nome: 'Blusa Básica',  preco: 49.90, estoque: 5,  ativo: 1, categorias: [] },
      ],
    });

    const res = await request(app).get('/produtos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].nome).toBe('Vestido Floral');
    expect(Array.isArray(res.body[0].categorias)).toBe(true);
    expect(res.body[0].categorias[0].nome).toBe('Vestido');
  });

  it('retorna 500 em erro de banco', async () => {
    db.query.mockRejectedValueOnce(new Error('falha no banco'));

    const res = await request(app).get('/produtos');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ─── GET /produtos/:id ────────────────────────────────────────────────────────

describe('GET /produtos/:id', () => {
  it('retorna o produto pelo id com categorias', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 5, nome: 'Calça Jeans', preco: 129.90, estoque: 8, ativo: 1,
        categorias: [{ id: 2, nome: 'Calça' }],
      }],
    });

    const res = await request(app).get('/produtos/5');
    expect(res.status).toBe(200);
    expect(res.body.nome).toBe('Calça Jeans');
    expect(res.body.categorias).toHaveLength(1);
  });

  it('retorna 404 para produto inexistente', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/produtos/99999');
    expect(res.status).toBe(404);
  });
});

// ─── POST /produtos ───────────────────────────────────────────────────────────

describe('POST /produtos', () => {
  it('cadastra produto sem imagem', async () => {
    mockRun({ lastID: 42 });

    const res = await request(app)
      .post('/produtos')
      .field('nome', 'Saia Floral')
      .field('preco', '79.90')
      .field('estoque', '15');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('productId', 42);
  });

  it('retorna 400 se nome estiver ausente', async () => {
    const res = await request(app)
      .post('/produtos')
      .field('preco', '50')
      .field('estoque', '10');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('retorna 400 se preco estiver ausente', async () => {
    const res = await request(app)
      .post('/produtos')
      .field('nome', 'Camiseta')
      .field('estoque', '10');

    expect(res.status).toBe(400);
  });

  it('retorna 400 se estoque estiver ausente', async () => {
    const res = await request(app)
      .post('/produtos')
      .field('nome', 'Regata')
      .field('preco', '39.90');

    expect(res.status).toBe(400);
  });
});

// ─── PUT /produtos/:id ────────────────────────────────────────────────────────

describe('PUT /produtos/:id', () => {
  it('atualiza campos do produto', async () => {
    mockRun({ changes: 1 });

    const res = await request(app)
      .put('/produtos/1')
      .field('nome', 'Regata Premium')
      .field('preco', '59.90')
      .field('estoque', '25');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/atualizado/i);
  });

  it('retorna 404 para id inexistente', async () => {
    mockRun({ changes: 0 }); // nenhuma linha afetada

    const res = await request(app)
      .put('/produtos/99999')
      .field('nome', 'X')
      .field('preco', '10')
      .field('estoque', '1');

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /produtos/:id ─────────────────────────────────────────────────────

describe('DELETE /produtos/:id', () => {
  it('faz soft delete (marca ativo = 0)', async () => {
    mockRun({ changes: 1 });

    const res = await request(app).delete('/produtos/1');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/removido/i);
    // verifica que o SQL usa soft delete (UPDATE, não DELETE)
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('ativo = 0'),
      expect.any(Array),
      expect.any(Function)
    );
  });

  it('retorna 404 para id inexistente', async () => {
    mockRun({ changes: 0 });

    const res = await request(app).delete('/produtos/99999');
    expect(res.status).toBe(404);
  });
});
