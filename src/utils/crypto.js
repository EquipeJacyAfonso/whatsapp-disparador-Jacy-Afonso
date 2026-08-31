const crypto = require('crypto');

// Chave de 32 bytes (64 caracteres hex), vinda de fora do banco — nunca commitar.
// Gerar uma vez com:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// e definir ENCRYPTION_KEY=<resultado> no .env.
const RAW_KEY = process.env.ENCRYPTION_KEY;

if (!RAW_KEY || RAW_KEY.length !== 64) {
  throw new Error(
    'ENCRYPTION_KEY ausente ou inválida no .env. ' +
    'Gere uma com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
    'e defina ENCRYPTION_KEY=<resultado> (64 caracteres hex).'
  );
}

const KEY = Buffer.from(RAW_KEY, 'hex');
const ALGO = 'aes-256-gcm';

/**
 * Criptografa um texto em claro.
 * Retorna string no formato "iv_hex:authtag_hex:ciphertext_hex",
 * pronta para salvar numa coluna TEXT.
 */
function encrypt(texto) {
  if (texto === null || texto === undefined) return null;
  const iv = crypto.randomBytes(12); // 96 bits — recomendado para GCM
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Descriptografa uma string gerada por encrypt().
 */
function decrypt(payload) {
  if (!payload) return null;
  const partes = String(payload).split(':');
  if (partes.length !== 3) {
    throw new Error('Payload criptografado em formato inválido');
  }
  const [ivHex, tagHex, dataHex] = partes;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Verifica se um valor já está no formato criptografado por este módulo.
 * Usado por migrações para evitar re-criptografar (idempotência).
 */
function jaCriptografado(valor) {
  return typeof valor === 'string' &&
    valor.split(':').length === 3 &&
    /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(valor);
}

module.exports = { encrypt, decrypt, jaCriptografado };
