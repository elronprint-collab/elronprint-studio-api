import { checkRateLimit } from "./_ratelimit.js";
import { gate, settle } from "./_account.js";
// api/upscale.js v3 — שיפור איכות תמונה: הגדלה + שחזור חדות ופרטים (Clarity Upscaler)
//
// v3 (2026-08-30): הכלי עבר לחיוב קרדיטים, כמו מחק קסם לפניו.
// עד כה כל קריאה הפעילה את clarity-upscaler בפאל על חשבון החנות, בלי התחברות.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-epai-token");
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

  const body = req.body || {};
  const { imageUrl } = body;
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

  /* השער אחרי בדיקת הקלט ולפני הקריאה לפאל — קלט פגום נדחה בלי לגעת במסד,
     ובקשה בלי הרשאה נדחית בלי להוציא כסף. */
  let acct;
  try {
    acct = await gate(req, body);
  } catch (e) {
    console.error("[upscale] account check failed:", e.message);
    return res.status(503).json({ error: "לא הצלחנו לאמת את החשבון. נסו שוב." });
  }
  if (acct.deny) return res.status(acct.deny.status).json(acct.deny.body);

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
      console.error("[upscale] fal clarity failed:", r.status, t.slice(0, 200), "- NOT charging");
      return res.status(502).json({ error: "Upscale failed" });
    }
    const data = await r.json();
    const outUrl = data?.image?.url || data?.images?.[0]?.url;
    if (!outUrl) {
      console.error("[upscale] fal returned no image - NOT charging");
      return res.status(502).json({ error: "No image returned" });
    }

    /* חיוב רק כאן, אחרי שיש תמונה ביד. */
    const left = await settle(acct.student, acct.quota, acct.owner);
    return res.status(200).json({
      imageUrl: outUrl,
      freeLeft: left.freeLeft, credits: left.credits, owner: !!acct.owner,
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Upscale failed" });
  }
}
