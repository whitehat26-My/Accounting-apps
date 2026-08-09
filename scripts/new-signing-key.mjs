/**
 * Generate the keypair that makes printed documents verify themselves.
 *
 *   node scripts/new-signing-key.mjs
 *
 * Prints two lines for `.env.prod`. They are halves of ONE key and must be
 * generated together — a verify page holding a public key that does not match
 * the signer calls every genuine document a forgery, which is the most
 * alarming possible way to fail.
 *
 * ---------------------------------------------------------------------------
 * KEEP THE PRIVATE HALF, AND UNDERSTAND WHAT ROTATING IT COSTS.
 *
 * Every document already printed was signed by THIS key. Replace it and every
 * receipt, invoice and warranty card in every customer's drawer stops
 * verifying — the paper is unchanged and the checker no longer recognises it.
 * There is no re-print step and no migration that can reach paper.
 *
 * So: generate once, back it up with the database, and rotate only if it
 * leaks. If it does leak, rotating is right and the cost above is the price of
 * having leaked it — somebody else can otherwise sign documents in this
 * business's name, which is worse than old receipts failing a check.
 * ---------------------------------------------------------------------------
 */

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
  'base64',
);

// Raw uncompressed point, 65 bytes — the form a browser imports with
// `importKey('raw', …)`, so the verify page needs no ASN.1 parser.
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let publicKey = '';
for (let i = 0; i < raw.length; i += 3) {
  const a = raw[i];
  const b = raw[i + 1];
  const c = raw[i + 2];
  publicKey += alphabet[a >> 2];
  publicKey += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
  if (b === undefined) break;
  publicKey += alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
  if (c === undefined) break;
  publicKey += alphabet[c & 0x3f];
}

console.log(`
# Signs printed documents so their QR codes verify with the server switched
# off. Back this up with the database; rotating it stops every document ALREADY
# PRINTED from verifying. See scripts/new-signing-key.mjs.
DOCUMENT_SIGNING_KEY=${pkcs8}

# The matching public half, compiled into the verify page at build time.
# Not a secret — it is published on purpose, so anyone can check a document.
NEXT_PUBLIC_VERIFY_KEY=${publicKey}
`);
