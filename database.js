require('dotenv').config();
const { Pool, types } = require('pg');

// PostgreSQL retorna NUMERIC e INT8 como string por padrão — converter para number
types.setTypeParser(1700, (val) => val === null ? null : parseFloat(val)); // NUMERIC / DECIMAL
types.setTypeParser(20,   (val) => val === null ? null : parseInt(val, 10)); // INT8 / BIGINT

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase.co') ? { rejectUnauthorized: false } : false,
});

pool.connect((err) => {
  if (err) {
    console.error('Erro ao conectar ao PostgreSQL:', err.message);
  } else {
    console.log('Conectado ao banco de dados PostgreSQL (Supabase).');
  }
});

// Converte placeholders SQLite (?) para PostgreSQL ($1, $2...)
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Camada de compatibilidade com a API de callbacks do sqlite3
const db = {
  // Busca uma linha
  get(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    pool.query(convertPlaceholders(sql), params || [])
      .then(result => callback(null, result.rows[0] || null))
      .catch(err => callback(err));
  },

  // Busca múltiplas linhas
  all(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    pool.query(convertPlaceholders(sql), params || [])
      .then(result => callback(null, result.rows))
      .catch(err => callback(err));
  },

  // Executa INSERT/UPDATE/DELETE
  // Para INSERT, adiciona RETURNING id automaticamente para capturar lastID
  run(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }

    let pgSql = convertPlaceholders(sql.trim());

    const isInsert = pgSql.trimStart().toUpperCase().startsWith('INSERT');
    if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
      pgSql += ' RETURNING id';
    }

    pool.query(pgSql, params || [])
      .then(result => {
        if (typeof callback === 'function') {
          const ctx = {
            lastID: result.rows?.[0]?.id ?? null,
            changes: result.rowCount ?? 0,
          };
          callback.call(ctx, null);
        }
      })
      .catch(err => {
        if (typeof callback === 'function') callback(err);
      });
  },

  // Executa múltiplas operações em sequência (no-op no PG — já é async)
  serialize(fn) {
    if (typeof fn === 'function') fn();
  },

  // Acesso direto ao pool para código novo
  query(sql, params) {
    return pool.query(convertPlaceholders(sql), params || []);
  },

  pool,
};

module.exports = db;
