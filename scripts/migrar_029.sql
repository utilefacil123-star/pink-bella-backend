-- #029 — Variações, Categorias, Preferências
-- Executar no Supabase SQL Editor (em ordem)

-- 1. Tabela de variações
CREATE TABLE IF NOT EXISTS produto_variacoes (
  id               SERIAL PRIMARY KEY,
  produto_id       INTEGER NOT NULL REFERENCES produtos(id),
  tamanho          TEXT    NOT NULL,
  cor              TEXT,
  sku              TEXT    UNIQUE,
  preco_variacao   NUMERIC(10,2),
  imagem_url       TEXT,
  estoque          INTEGER NOT NULL DEFAULT 0,
  external_ids     JSONB   NOT NULL DEFAULT '{}',
  ativo            BOOLEAN NOT NULL DEFAULT TRUE
);

-- 2. Categorias
CREATE TABLE IF NOT EXISTS categorias (
  id                  SERIAL PRIMARY KEY,
  nome                TEXT NOT NULL UNIQUE,
  tiktok_category_id  TEXT,
  shopee_category_id  TEXT,
  meli_category_id    TEXT
);

-- 3. Produto × Categoria (N:N)
CREATE TABLE IF NOT EXISTS produto_categorias (
  produto_id   INTEGER NOT NULL REFERENCES produtos(id),
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  PRIMARY KEY (produto_id, categoria_id)
);

-- 4. Preferências do cliente
CREATE TABLE IF NOT EXISTS cliente_preferencias (
  cliente_id  INTEGER PRIMARY KEY REFERENCES clientes(id),
  tamanhos    TEXT[],
  categorias  TEXT[]
);

-- 5. Novos campos em tabelas existentes
ALTER TABLE itens_compra
  ADD COLUMN IF NOT EXISTS variacao_id INTEGER REFERENCES produto_variacoes(id);

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS external_ids JSONB NOT NULL DEFAULT '{}';

-- 6. Categorias padrão da loja
INSERT INTO categorias (nome) VALUES
  ('Vestido'), ('Conjunto'), ('Macacão'), ('Blusa'), ('Calça'), ('Plus Size')
ON CONFLICT (nome) DO NOTHING;

-- 7. Migração: variação "Único" para produtos existentes (preserva estoque atual)
INSERT INTO produto_variacoes (produto_id, tamanho, cor, sku, estoque)
SELECT
  id,
  'Único',
  NULL,
  'produto-' || id::text || '-unico',
  COALESCE(estoque, 0)
FROM produtos
WHERE id NOT IN (SELECT DISTINCT produto_id FROM produto_variacoes);
