import crypto from 'crypto';

const REDEEM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type RedeemCodeMode = 'universal' | 'bound';

export function normalizeRedeemCode(input: string) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function randomRedeemCodeChars(length: number) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += REDEEM_CODE_ALPHABET[bytes[index] % REDEEM_CODE_ALPHABET.length];
  }
  return out;
}

export function generateRedeemCode() {
  const raw = randomRedeemCodeChars(12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function getRedeemCodeHash(inputCode: string) {
  const normalized = normalizeRedeemCode(inputCode);
  const salt = process.env.REDEEM_CODE_SALT || process.env.JWT_SECRET || 'redeem-code-default-salt';
  return crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
}

export function buildRedeemCodePreview(plainCode: string) {
  const normalized = normalizeRedeemCode(plainCode);
  const start = normalized.slice(0, 4);
  const end = normalized.slice(-4);
  return `${start}-****-${end}`;
}
