require('dotenv').config();

const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./utils/swaggerConfig');
const autenticar = require('./middleware/auth');
const authRoutes = require('./routes/authRoutes');
const melhorEnvioOAuthRoutes = require('./routes/melhorEnvioOAuthRoutes');
const produtosRoutes = require('./routes/produtosRoutes');
const clientesRoutes = require('./routes/clientesRoutes');
const comprasRoutes = require('./routes/comprasRoutes');
const freteRoutes = require('./routes/freteRoutes');
const addressRoutes = require('./routes/addressRoutes');
const melhorEnvioRoutes = require('./routes/melhorEnvioRoutes');
const categoriasRoutes = require('./routes/categoriasRoutes');
const { initTokenTable } = require('./services/melhorEnvioAuth');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
    res.send('Backend Pink Bella funcionando!');
});

// Inicializa a tabela de tokens Melhor Envio
initTokenTable();

// Rotas públicas — sem autenticação
app.use('/auth', authRoutes);
app.use('/melhor-envio', melhorEnvioOAuthRoutes); // /auth e /callback públicos

// Middleware de autenticação aplicado a todas as rotas de negócio
app.use(autenticar);

app.use('/produtos', produtosRoutes);
app.use('/clientes', clientesRoutes);
app.use('/compras', comprasRoutes);
app.use('/frete', freteRoutes);
app.use('/endereco', addressRoutes);
app.use('/melhor-envio', melhorEnvioRoutes);
app.use('/categorias', categoriasRoutes);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

module.exports = app;
