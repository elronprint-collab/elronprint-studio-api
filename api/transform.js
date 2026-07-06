import { checkRateLimit } from "./_ratelimit.js";
// api/transform.js — עיצוב מתמונה של הלקוח (image-to-image)
// הלקוח מעלה תמונה + הוראה בעברית ("תהפכו את הלוגו לסגנון גרפיטי")

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

// תרגום אוטומטי לאנגלית — כמו ב-generate.js
async function translateToEnglish(text) {
  if (!/[\u0590-\u05FF]/.test(text)) return text;
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
      encodeURIComponent(text);
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return text;
    const data = await r.json();
    const translated = (data && data[0] ? data[0] : [])
      .map((seg) => (seg && seg[0]) || "")
      .join("")
      .trim();
    return translated || text;
  } catch {
    return text;
  }
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

  const { prompt, image } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.length > 1000) {
    return res.status(400).json({ error: "Invalid prompt" });
  }
  // התמונה מגיעה כ-Data URL (base64) אחרי הקטנה בצד הלקוח
  if (
    !image ||
    typeof image !== "string" ||
    !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(image) ||
    image.length > 4_000_000 // ~3MB — מעל מגבלת גוף הבקשה של Vercel נחתכים ממילא
  ) {
    return res.status(400).json({ error: "Invalid image" });
  }

  const englishPrompt = await translateToEnglish(prompt);

  try {
    const r = await fetch("https://fal.run/fal-ai/flux/dev/image-to-image", {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: image, // fal מקבל גם Data URL
        prompt: `${englishPrompt}, clean edges, high detail, t-shirt print artwork`,
        strength: 0.82,           // כמה לשנות: 0=בלי שינוי, 1=מתעלם מהמקור
        num_inference_steps: 28,
        guidance_scale: 3.5,
        output_format: "png",
        enable_safety_checker: true,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("fal transform failed:", r.status, t);
      return res.status(502).json({ error: "Transform failed" });
    }
    const data = await r.json();
    const imageUrl = data?.images?.[0]?.url;
    if (!imageUrl) return res.status(502).json({ error: "No image returned" });

    return res.status(200).json({ imageUrl });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Transform failed" });
  }
}
