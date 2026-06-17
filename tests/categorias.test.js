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

// ─── GET /categorias ──────────────────────────────────────────────────────────

describe('GET /categorias', () => {
  it('retorna lista de categorias ordenada por nome', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 1, nome: 'Blusa' },
        { id: 2, nome: 'Vestido' },
      ],
    });

    const res = await request(app).get('/categorias');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].nome).toBe('Blusa');
    expect(res.body[1].nome).toBe('Vestido');
  });

  it('retorna array vazio quando não há categorias', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/categorias');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retorna 500 em erro de banco', async () => {
    db.query.mockRejectedValueOnce(new Error('falha no banco'));

    const res = await request(app).get('/categorias');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ─── POST /categorias ─────────────────────────────────────────────────────────

describe('POST /categorias', () => {
  it('cria nova categoria', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, nome: 'Macacão' }],
    });

    const res = await request(app)
      .post('/categorias')
      .send({ nome: 'Macacão' });

    expect(res.status).toBe(201);
    expect(res.body.nome).toBe('Macacão');
    expect(res.body.id).toBe(7);
  });

  it('remove espaços extras do nome antes de salvar', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 8, nome: 'Calça' }],
    });

    const res = await request(app)
      .post('/categorias')
      .send({ nome: '  Calça  ' });

    expect(res.status).toBe(201);
    // verifica que a query foi chamada com nome sem espaços
    expect(db.query).toHaveBeenCalledWith(
      expect.any(String),
      ['Calça']
    );
  });

  it('retorna 400 se nome estiver vazio', async () => {
    const res = await request(app)
      .post('/categorias')
      .send({ nome: '' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('retorna 400 se nome for apenas espaços', async () => {
    const res = await request(app)
      .post('/categorias')
      .send({ nome: '   ' });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('retorna 400 se nome for omitido', async () => {
    const res = await request(app)
      .post('/categorias')
      .send({});

    expect(res.status).toBe(400);
  });

  it('retorna 400 em categoria duplicada (unique constraint)', async () => {
    const err = new Error('duplicate key value'); err.code = '23505';
    db.query.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/categorias')
      .send({ nome: 'Vestido' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/já existe/i);
  });

  it('retorna 500 em outro erro de banco', async () => {
    db.query.mockRejectedValueOnce(new Error('conexão recusada'));

    const res = await request(app)
      .post('/categorias')
      .send({ nome: 'NovaCategoria' });

    expect(res.status).toBe(500);
  });
});
