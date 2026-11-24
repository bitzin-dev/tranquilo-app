import type { VercelRequest, VercelResponse } from "@vercel/node";

type RouteModule = {
  default: (req: VercelRequest, res: VercelResponse) => unknown;
};

const routes = new Map<string, () => Promise<RouteModule>>(
  Object.entries({
    "GET /api/items": () => import("./items.ts"),
    "POST /api/submit-collection": () => import("./submit-collection.ts"),
    "POST /api/subscribe": () => import("./subscribe.ts"),
    "POST /api/track": () => import("./track.ts"),
    "POST /api/webhooks/resend": () => import("./webhooks/resend.ts"),
    "POST /api/webhooks/patreon": () => import("./webhooks/patreon.ts"),
    "GET /sitemap.xml": () => import("./sitemap.ts"),
    "GET /v/{slug}": () => import("./v/[slug].ts"),
    "GET /s/{slug}": () => import("./v/[slug].ts"),
    "GET /img/{source}/{id}/{tier}": () =>
      import("./img/[source]/[id]/[tier].ts"),
    "GET /og/{slug}.png": () => import("./og/[slug].ts"),
  }),
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const script = routes.get(`${req.method} ${req.query.path}`);

  if (script) {
    const mod = await script();
    return await mod.default(req, res);
  }

  return res.status(404).json({ error: "Not found" });
}
