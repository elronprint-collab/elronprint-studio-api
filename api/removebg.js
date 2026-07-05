import { checkRateLimit } from "./_ratelimit.js";
// api/removebg.js — שלב 3 (אופציונלי): הסרת רקע → PNG עם רקע שקוף (BiRefNet)

const ALLOWED = [
  "https://elronprint.co.il",
  "https://www.elronprint.co.il",
];
function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED.includes(origin)) return origin;
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith(".myshopify.com") || host.endsWith(".shopifypreview.com")) return origin;
  } catch {}
  return null;
}
function cors(req, res) {
  const origin = allowOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const retryAfter = checkRateLimit(req);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests", retryAfter });
  }

  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.startsWith("https://")) {
    return res.status(400).json({ error: "Invalid imageUrl" });
  }
  let host;
  try { host = new URL(imageUrl).hostname; } catch { return res.status(400).json({ error: "Invalid imageUrl" }); }
  if (!host.endsWith("fal.media") && !host.endsWith("fal.ai") && !host.endsWith("fal.run")) {
    return res.status(400).json({ error: "URL not allowed" });
  }

  try {
    const r = await fetch("https://fal.run/fal-ai/birefnet/v2", {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: imageUrl,
        model: "General Use (Heavy)",
        operating_resolution: "2048x2048",
        output_format: "png",
        refine_foreground: true,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("fal removebg failed:", r.status, t);
      return res.status(502).json({ error: "Background removal failed" });
    }
    const data = await r.json();
    const outUrl = data?.image?.url;
    if (!outUrl) return res.status(502).json({ error: "No image returned" });

    return res.status(200).json({ imageUrl: outUrl });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Background removal failed" });
  }
}
