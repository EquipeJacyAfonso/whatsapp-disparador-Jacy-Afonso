const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const config = require('./config');
const crypto = require('crypto');

// Busca ou gera a chave JWT — armazenada no banco para persistir entre restarts
async function getJwtSecret() {
  let secret = await config.get('jwt_secret', '');
  if (!secret) {
    secret = crypto.randomBytes(64).toString('hex');
    await config.set('jwt_secret', secret);
    console.log('[AUTH] Chave JWT gerada e salva.');
  }
  return secret;
}

// Gera um token válido por 8 horas
async function gerarToken(usuario) {
  const secret = await getJwtSecret();
  return jwt.sign(
    { id: usuario.id, email: usuario.email, nome: usuario.nome },
    secret,
    { expiresIn: '8h' }
  );
}

// Verifica token e retorna payload
async function verificarToken(token) {
  const secret = await getJwtSecret();
  return jwt.verify(token, secret);
}

// Login — retorna token ou null
async function login(email, senha) {
  const result = await pool.query(
    'SELECT * FROM usuarios WHERE email = $1 AND ativo = true',
    [email.toLowerCase().trim()]
  );
  if (!result.rows.length) return null;

  const usuario = result.rows[0];
  const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
  if (!senhaOk) return null;

  // Registra último acesso
  await pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [usuario.id]);

  const token = await gerarToken(usuario);
  return { token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } };
}

// Altera senha
async function alterarSenha(userId, senhaAtual, novaSenha) {
  const result = await pool.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
  if (!result.rows.length) throw new Error('Usuário não encontrado');

  const senhaOk = await bcrypt.compare(senhaAtual, result.rows[0].senha_hash);
  if (!senhaOk) throw new Error('Senha atual incorreta');

  if (novaSenha.length < 6) throw new Error('Nova senha deve ter ao menos 6 caracteres');

  const hash = await bcrypt.hash(novaSenha, 12);
  await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, userId]);
}

// Middleware Express — bloqueia rotas sem token válido
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'Não autenticado' });
    }
    const token = authHeader.split(' ')[1];
    const payload = await verificarToken(token);
    req.usuario = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token inválido ou expirado. Faça login novamente.' });
  }
}

module.exports = { login, gerarToken, verificarToken, requireAuth, alterarSenha };
