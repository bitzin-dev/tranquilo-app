import { describe, expect, it } from "vitest";
import { clientIp } from "../lib/client-ip.ts";

describe("clientIp", () => {
  it("prefers CloudFront-Viewer-Address over a spoofed x-forwarded-for", () => {
    expect(
      clientIp({
        headers: {
          "cloudfront-viewer-address": "198.51.100.4:41234",
          "x-forwarded-for": "1.2.3.4, 198.51.100.4",
        },
      }),
    ).toBe("198.51.100.4");
  });

  it("strips the bracketed port from an IPv6 viewer address", () => {
    expect(
      clientIp({
        headers: { "cloudfront-viewer-address": "[2001:db8::1]:41234" },
      }),
    ).toBe("2001:db8::1");
  });

  it("uses the last x-forwarded-for hop, not the viewer-controlled first", () => {
    expect(
      clientIp({
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.7" },
      }),
    ).toBe("203.0.113.7");
  });

  it("gives a spoofed first hop no influence on the result", () => {
    const a = clientIp({
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" },
    });
    const b = clientIp({
      headers: { "x-forwarded-for": "8.8.8.8, 203.0.113.7" },
    });
    expect(a).toBe(b);
  });

  it("trims whitespace and ignores empty hops", () => {
    expect(
      clientIp({ headers: { "x-forwarded-for": "1.2.3.4,  203.0.113.7 , " } }),
    ).toBe("203.0.113.7");
  });

  it("handles a header array", () => {
    expect(
      clientIp({ headers: { "x-forwarded-for": ["1.2.3.4", "203.0.113.7"] } }),
    ).toBe("203.0.113.7");
  });

  it("handles an IPv6 last hop and a bracketed one with a port", () => {
    expect(
      clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 2001:DB8::7" } }),
    ).toBe("2001:db8::7");
    expect(
      clientIp({ headers: { "x-forwarded-for": "[2001:db8::7]:5000" } }),
    ).toBe("2001:db8::7");
  });

  it("strips the port from an IPv4 address", () => {
    expect(
      clientIp({ headers: { "cloudfront-viewer-address": "203.0.113.7:99" } }),
    ).toBe("203.0.113.7");
  });

  it("falls back to the socket address when no header names a client", () => {
    expect(
      clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.2" } }),
    ).toBe("10.0.0.2");
  });

  it("ignores x-real-ip, which the viewer can set", () => {
    expect(clientIp({ headers: { "x-real-ip": "203.0.113.9" } })).toBe(null);
  });

  it("returns null when nothing identifies the client", () => {
    expect(clientIp({ headers: {} })).toBe(null);
    expect(clientIp({})).toBe(null);
    expect(clientIp(null)).toBe(null);
    expect(clientIp({ headers: { "cloudfront-viewer-address": "  " } })).toBe(
      null,
    );
  });
});
