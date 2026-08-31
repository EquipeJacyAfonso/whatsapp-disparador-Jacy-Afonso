const rateLimit = require('express-rate-limit');

// Rate limit para o login: no máximo 5 tentativas por IP a cada 15 minutos.
// skipSuccessfulRequests: true — logins bem-sucedidos (2xx) não contam para
// o limite, então só penaliza tentativas erradas repetidas (brute-force).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,    // devolve RateLimit-* headers
  legacyHeaders: false,     // desativa X-RateLimit-* (deprecated)
  skipSuccessfulRequests: true,
  message: { ok: false, error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
  // Importante: se o app roda atrás de proxy reverso (nginx, Docker com
  // proxy na frente, etc.), é necessário configurar em server.js:
  //   app.set('trust proxy', 1)
  // Caso contrário, todas as requisições podem ser contadas sob o mesmo IP
  // (o do proxy), causando bloqueio incorreto de todos os usuários.
});

module.exports = { loginLimiter };
