import { checkRateLimit } from "./_ratelimit.js";
// api/eraser.js v2 — מחק קסם עם ניסיון על כמה מודלים של fal עד שאחד מצליח

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
function isAllowedUrl(url) {
  if (!url || typeof url !== "string" || !url.startsWith("https://")) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname;
  const isCloudinary = host === "res.cloudinary.com" && u.pathname.startsWith("/dztd5g0p8/");
  const isFal = host.endsWith("fal.media") || host.endsWith("fal.ai") || host.endsWith("fal.run");
  return isCloudinary || isFal;
}

const MODELS = [
  "fal-ai/lama",
  "fal-ai/bria/eraser",
  "fal-ai/inpaint",
];

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const retryAfter = checkRateLimit(req);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests", retryAfter });
  }

  const { imageUrl, maskUrl } = req.body || {};
  if (!isAllowedUrl(imageUrl) || !isAllowedUrl(maskUrl)) {
    return res.status(400).json({ error: "Invalid imageUrl or maskUrl" });
  }

  let lastErr = "";
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://fal.run/${model}`, {
        method: "POST",
        headers: {
          "Authorization": `Key ${process.env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image_url: imageUrl, mask_url: maskUrl }),
      });
      if (!r.ok) {
        lastErr = `${model}: ${r.status} ${await r.text()}`;
        console.error("fal eraser failed:", lastErr.slice(0, 500));
        continue;
      }
      const data = await r.json();
      const outUrl = data?.image?.url || data?.images?.[0]?.url;
      if (!outUrl) {
        lastErr = `${model}: no image in response`;
        console.error(lastErr);
        continue;
      }
      console.log("eraser success with model:", model);
      return res.status(200).json({ imageUrl: outUrl, model });
    } catch (err) {
      lastErr = `${model}: ${err.message}`;
      console.error("fal eraser exception:", lastErr);
    }
  }

  return res.status(502).json({ error: "Eraser failed", detail: lastErr.slice(0, 300) });
}
