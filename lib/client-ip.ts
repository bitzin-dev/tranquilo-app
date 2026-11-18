// The one place a request's client IP is derived, for every rate limiter.
// CloudFront-Viewer-Address is set by CloudFront itself; the last
// X-Forwarded-For hop is the one the nearest proxy appended. The first hop is
// viewer-controlled and MUST NOT be trusted.

type HeaderValue = string | string[] | undefined;

interface RequestWithClientIp {
  headers?: Record<string, HeaderValue>;
  socket?: { remoteAddress?: string | null } | null;
}

function headerValue(value: HeaderValue): string {
  return String(Array.isArray(value) ? value[0] : (value ?? "")).trim();
}

function stripPort(address: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) return bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  if (ipv4WithPort) return ipv4WithPort[1];
  return address;
}

function normalize(address: string): string | null {
  const bare = stripPort(address.trim());
  if (!bare) return null;
  return bare
    .replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1")
    .toLowerCase();
}

export function clientIp(
  req: RequestWithClientIp | null | undefined,
): string | null {
  const viewer = normalize(
    headerValue(req?.headers?.["cloudfront-viewer-address"]),
  );
  if (viewer) return viewer;

  const forwarded = req?.headers?.["x-forwarded-for"];
  const hops = (
    Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")
  )
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const lastHop = hops.length ? normalize(hops[hops.length - 1]) : null;
  if (lastHop) return lastHop;

  const socketAddress = req?.socket?.remoteAddress;
  return socketAddress ? normalize(socketAddress) : null;
}
