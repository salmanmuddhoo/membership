// A signed, expiring link to a receipt (S-1602). The member has no sign-in
// here until Phase 4, so the link itself is the credential: a compact token
// naming one transaction, signed with the member-facing secret, good for a
// while and then not. It opens /receipts/shared/{token}, which renders the
// sheet and nothing else.
import { SignJWT, jwtVerify } from 'jose';
import { getAppOrigin, getReceiptLinkSecret } from '../config';

const PURPOSE = 'receipt';
// Long enough to find the message again after a fortnight away, short
// enough that a forwarded message does not open a receipt for ever.
export const LINK_DAYS = 30;

function key(): Uint8Array | null {
  const secret = getReceiptLinkSecret();
  return secret ? new TextEncoder().encode(secret) : null;
}

// A membership fee receipt (a payment row, not a transaction) is signed for
// its own purpose, so neither kind of token can be read as the other.
const FEE_PURPOSE = 'fee-receipt';

export async function signReceiptToken(
  transactionId: string,
  purpose: string = PURPOSE
): Promise<string | null> {
  const k = key();
  if (!k) return null;
  return new SignJWT({ purpose })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(transactionId)
    .setIssuedAt()
    .setExpirationTime(`${LINK_DAYS}d`)
    .sign(k);
}

// The transaction the token names, or null for anything else: expired,
// tampered, signed for another purpose, or signed with another secret.
export async function verifyReceiptToken(
  token: string,
  purpose: string = PURPOSE
): Promise<string | null> {
  const k = key();
  if (!k || !token) return null;
  try {
    const { payload } = await jwtVerify(token, k, { algorithms: ['HS256'] });
    if (payload.purpose !== purpose || typeof payload.sub !== 'string') {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}

// The payment a fee receipt's token names, or null.
export async function verifyFeeReceiptToken(
  token: string
): Promise<string | null> {
  return verifyReceiptToken(token, FEE_PURPOSE);
}

// The full addresses, or null when the origin or the secret is not known:
// the page, and the same token with the receipt as a file on the end —
// what a WhatsApp document or an email attachment is fetched from at send
// time (S-1602's Should half). One token for both, so the message and its
// attachment expire together.
export async function receiptLinks(
  transactionId: string
): Promise<{ page: string; pdf: string } | null> {
  const origin = getAppOrigin();
  const token = await signReceiptToken(transactionId);
  if (!origin || !token) return null;
  const page = `${origin}/receipts/shared/${token}`;
  return { page, pdf: `${page}.pdf` };
}

export async function receiptLink(
  transactionId: string
): Promise<string | null> {
  return (await receiptLinks(transactionId))?.page ?? null;
}

// Where a membership fee receipt's PDF is fetched from at send time: the same
// route as a transaction's, under a token signed for the fee receipt.
export async function feeReceiptPdfLink(
  paymentId: string
): Promise<string | null> {
  const origin = getAppOrigin();
  const token = await signReceiptToken(paymentId, FEE_PURPOSE);
  if (!origin || !token) return null;
  return `${origin}/receipts/shared/${token}.pdf`;
}
