// fetchImageDataUri() fetches item.img -- the raw origin URL, not the /img
// proxy URL -- every time a social platform unfurls a shared link, but
// never carried the proxy's identifying headers. An unheaded request to a
// real Europeana thumbnail got a 403 from Cloudflare; the identical
// request with imageFetchHeaders() succeeded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchImageDataUri } from "../api/og/[slug].ts";
import { imageFetchHeaders } from "../lib/source-identity.ts";

describe("fetchImageDataUri", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the same identifying headers as the main proxy fetch", async () => {
    let sentHeaders: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        sentHeaders = init?.headers;
        return {
          ok: true,
          status: 200,
          headers: { get: () => "image/jpeg" },
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }),
    );
    await fetchImageDataUri(
      "https://api.europeana.eu/thumbnail/v2/x.jpg",
      "europeana",
    );
    expect(sentHeaders).toEqual(imageFetchHeaders("europeana"));
  });

  function respondWith(contentType: string | null) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => contentType },
        arrayBuffer: async () => new ArrayBuffer(4),
      })),
    );
  }

  it("rejects an HTML body served with a 200 status", async () => {
    respondWith("text/html");
    await expect(
      fetchImageDataUri("https://images.metmuseum.org/x.jpg", "met"),
    ).rejects.toThrow(/not an image/);
  });

  it("treats a missing content type as JPEG", async () => {
    respondWith(null);
    const uri = await fetchImageDataUri("https://example.org/x", "met");
    expect(uri.startsWith("data:image/jpeg;")).toBe(true);
  });

  it("accepts a content type with parameters", async () => {
    respondWith("image/png; charset=binary");
    const uri = await fetchImageDataUri("https://example.org/x.png", "met");
    expect(uri.startsWith("data:image/png;")).toBe(true);
  });
});
