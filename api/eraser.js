import { checkRateLimit } from "./_ratelimit.js";
import { gate, settle } from "./_account.js";
// api/eraser.js v3 — מחק קסם עם ניסיון על כמה מודלים של fal עד שאחד מצליח
//
// v3 (2026-08-30): הכלי עבר לחיוב קרדיטים.
// עד כה הוא היה פתוח לגמרי — כל קריאה הפעילה מודל בתשלום בפאל על חשבון החנות,
// בלי התחברות ובלי תקרה מלבד הגבלת הקצב לפי IP. עכשיו: התחברות, יתרה, וחיוב
// אחרי הצלחה בלבד. כישלון של כל שלושת המודלים לא גובה קרדיט.

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

  const body = req.body || {};
  const { imageUrl, maskUrl } = body;
  if (!isAllowedUrl(imageUrl) || !isAllowedUrl(maskUrl)) {
    return res.status(400).json({ error: "Invalid imageUrl or maskUrl" });
  }

  /* השער לפני כל קריאה לפאל, אחרי בדיקת הקלט — כדי שבקשה פגומה תיפסל בזול. */
  let acct;
  try {
    acct = await gate(req, body);
  } catch (e) {
    console.error("[eraser] account check failed:", e.message);
    return res.status(503).json({ error: "לא הצלחנו לאמת את החשבון. נסו שוב." });
  }
  if (acct.deny) return res.status(acct.deny.status).json(acct.deny.body);

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
      const left = await settle(acct.student, acct.quota, acct.owner);
      return res.status(200).json({
        imageUrl: outUrl, model,
        freeLeft: left.freeLeft, credits: left.credits, owner: !!acct.owner,
      });
    } catch (err) {
      lastErr = `${model}: ${err.message}`;
      console.error("fal eraser exception:", lastErr);
    }
  }

  /* כל המודלים נכשלו — הלקוח לא קיבל דבר, ולכן גם לא חויב. */
  console.error("[eraser] all models failed - NOT charging the run");
  return res.status(502).json({ error: "Eraser failed", detail: lastErr.slice(0, 300) });
}
