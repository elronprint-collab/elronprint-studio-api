import { checkRateLimit } from "./_ratelimit.js";
// api/generate.js — שלב 1: יצירת העיצוב (FLUX.1 dev)
// המפתח נשמר ב-Environment Variable בשם FAL_KEY

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

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.length > 1000) {
    return res.status(400).json({ error: "Invalid prompt" });
  }

  try {
    const r = await fetch("https://fal.run/fal-ai/flux/dev", {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: `${prompt}, isolated design, clean edges, high detail, t-shirt print artwork`,
        image_size: { width: 1152, height: 1536 }, // יחס 3:4 כמו שטח ההדפסה
        num_inference_steps: 28,
        guidance_scale: 3.5,
        output_format: "png",
        enable_safety_checker: true,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("fal generate failed:", r.status, t);
      return res.status(502).json({ error: "Generation failed" });
    }
    const data = await r.json();
    const imageUrl = data?.images?.[0]?.url;
    if (!imageUrl) return res.status(502).json({ error: "No image returned" });

    return res.status(200).json({ imageUrl });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Generation failed" });
  }
}
