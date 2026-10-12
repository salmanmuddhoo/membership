// The client's address, for the audit trail and the rate limits.
//
// The app sits behind a proxy (Vercel's, or Azure App Service's front end),
// so the socket address is the proxy's; x-forwarded-for's first entry is the
// original client. It is attacker-supplied, so it is recorded as a claim
// about the request and never used to grant anything.
//
// Azure's front end writes the client's port onto it — "196.20.185.85:10007"
// — which Postgres refuses as an inet (audit_event.ip_address), so the
// sign-in audit row was lost, and which made every request look like a new
// client to a rate limit keyed on the address. The port is dropped here, and
// anything that is not an IP address comes back as null.

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(value: string): boolean {
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    // The URL parser validates an IPv6 literal in any runtime.
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * An address as Postgres's inet will take it, or null: the port dropped from
 * "a.b.c.d:port" and "[v6]:port", the brackets from "[v6]".
 */
export function normaliseAddress(
  raw: string | null | undefined
): string | null {
  let value = (raw ?? '').trim();
  if (!value || value.length > 64) return null;
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    value = bracketed[1];
  } else {
    const v4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (v4WithPort) value = v4WithPort[1];
  }
  if (IPV4.test(value) || isIpv6(value)) return value;
  return null;
}

export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  return normaliseAddress(forwarded.split(',')[0]);
}
