import {createHash} from 'node:crypto';

export const RECEIPT_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}/,
];

export const receiptSha256 = value => createHash('sha256').update(value).digest('hex');

export function assertSafeReceipt(value) {
  const body = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (RECEIPT_SECRET_PATTERNS.some(pattern => pattern.test(body))) {
    throw new Error('Contact source receipt contains a credential-like value');
  }
}
