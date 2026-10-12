// The caller's address, for the audit trail and the per-address rate limits.
//
// Both hosts sit behind a proxy, so the socket address is the proxy's and
// x-forwarded-for's first entry is the original client. It is
// attacker-supplied, so it is recorded as a claim about the request and only
// ever used to slow one down.
//
// Azure App Service's front end writes that entry with the client's port
// ("203.0.113.7:57779", "[2001:db8::1]:57779"); Vercel writes the bare
// address. The port is dropped: Postgres's inet refuses it, which failed every
// audit row that carried one, and a port that changes on every connection
// would make each request a new address to the rate limits. Anything that is
// still not an address is no address.
import { isIP } from 'node:net';

export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  return addressOnly(forwarded.split(',')[0] ?? '');
}

export function addressOnly(raw: string): string | null {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  return isIP(value) ? value : null;
}
