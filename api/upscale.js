import { checkRateLimit } from "./_ratelimit.js";
// api/upscale.js v2 — שיפור איכות תמונה: הגדלה + שחזור חדות ופרטים (Clarity Upscaler)
// מקבל תמונות מ-Cloudinary (העלאות לקוחות) ומ-fal, מחזיר תמונה חדה ומוגדלת

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
  let u;
  try { u = new URL(imageUrl); } catch { return res.status(400).json({ error: "Invalid imageUrl" }); }
  const host = u.hostname;
  const isCloudinary = host === "res.cloudinary.com" && u.pathname.startsWith("/dztd5g0p8/");
  const isFal = host.endsWith("fal.media") || host.endsWith("fal.ai") || host.endsWith("fal.run");
  if (!isCloudinary && !isFal) {
    return res.status(400).json({ error: "URL not allowed" });
  }

  try {
    const r = await fetch("https://fal.run/fal-ai/clarity-upscaler", {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: imageUrl,
        upscale_factor: 2,
        creativity: 0.3,
        resemblance: 0.8,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("fal clarity failed:", r.status, t);
      return res.status(502).json({ error: "Upscale failed" });
    }
    const data = await r.json();
    const outUrl = data?.image?.url || data?.images?.[0]?.url;
    if (!outUrl) return res.status(502).json({ error: "No image returned" });

    return res.status(200).json({ imageUrl: outUrl });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Upscale failed" });
  }
}
