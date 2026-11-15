import { checkRateLimit } from "./_ratelimit.js";
import { gate, settle } from "./_account.js";
import { makePrintFile, uploadCloudinary } from "./_print.js";
// api/generate.js — שלב 1: יצירת העיצוב (FLUX.1 dev)
//
// v2 — תיקון התרגום מעברית.
// הבעיה בגרסה הקודמת: translate.googleapis.com/translate_a/single הוא endpoint
// לא רשמי שגוגל חוסמת מכתובות דאטה-סנטר כמו Vercel. הקוד החזיר את הטקסט המקורי
// בשקט, כך שעברית נשלחה כמו שהיא ל-FLUX — ש-לא מבין עברית ומייצר לפי
// הסיומת האנגלית בלבד. התוצאה: איור גנרי שאין לו קשר לבקשה.
//
// התיקון:
//   1. התרגום עובר דרך fal (אותו FAL_KEY שכבר קיים) — אמין משרת.
//   2. גוגל נשאר כגיבוי שני בלבד.
//   3. אם שניהם נכשלו והטקסט עדיין בעברית — מחזירים שגיאה במקום לייצר זבל.
//   4. התשובה כוללת promptUsed כדי שאפשר יהיה לראות מה באמת נשלח.

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

function hasHebrew(text) {
  return /[\u0590-\u05FF]/.test(text);
}

/* 2026-11-15: מעבר לחינם. התרגום עובר קודם ל-Gemini (GEMINI_API_KEY, מסלול
   חינמי), והתמונה נוצרת ב-Cloudflare Workers AI (flux-1-schnell, מכסה יומית
   חינמית, CF_API_TOKEN). fal נשאר כגיבוי בלבד: אם השירות החינמי נכשל ויש
   יתרה ב-fal, הוא יענה כמו קודם. */
const TRANSLATE_SYSTEM =
  "You convert a Hebrew description of a t-shirt graphic into a short English image-generation prompt. " +
  "Output ONLY the English prompt - no quotes, no explanation, no preamble. " +
  "Keep it under 40 words. Preserve every concrete subject, object, colour and style the user named. " +
  "Do not invent a different subject. Do not add text or lettering to the image.";

async function translateWithGemini(text) {
  if (!process.env.GEMINI_API_KEY) throw new Error("no GEMINI_API_KEY");
  const models = [process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash-lite", "gemini-3.8-flash"];
  let last = "no model";
  for (const model of models) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: TRANSLATE_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      }
    );
    const raw = await r.text();
    if (!r.ok) { last = `gemini ${model} ${r.status} ${raw.slice(0, 200)}`; continue; }
    let d = null;
    try { d = JSON.parse(raw); } catch (_) {}
    const out = (d?.candidates?.[0]?.content?.parts || [])
      .map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim().replace(/^["']|["']$/g, "");
    if (out && !hasHebrew(out)) return out;
    last = `gemini ${model} returned no usable english`;
  }
  throw new Error(last);
}

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "5633e768dfc1afc72319ed31d87b6e7c";
const CF_IMAGE_MODEL = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

/* מחזיר כתובת של התמונה בקלאודינרי, או null אם Cloudflare לא ענה
   (אין מפתח, המכסה היומית נגמרה, תקלה) — ואז הקורא עובר ל-fal. */
async function generateWithCloudflare(fullPrompt) {
  if (!process.env.CF_API_TOKEN) { console.error("[generate] CF_API_TOKEN missing"); return null; }
  let r, raw;
  try {
    r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_IMAGE_MODEL}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fullPrompt.slice(0, 2000), steps: 8 }),
      }
    );
    raw = await r.text();
  } catch (e) {
    console.error("[generate] cloudflare fetch threw:", e.message);
    return null;
  }
  if (!r.ok) {
    console.error("[generate] cloudflare failed:", r.status, raw.slice(0, 300));
    return null;
  }
  let d = null;
  try { d = JSON.parse(raw); } catch (_) {}
  const b64 = d?.result?.image;
  if (typeof b64 !== "string" || b64.length < 1000) {
    console.error("[generate] cloudflare returned no image:", raw.slice(0, 300));
    return null;
  }
  try {
    return await uploadCloudinary(Buffer.from(b64, "base64"), "generated.jpg");
  } catch (e) {
    console.error("[generate] cloudinary upload failed:", e.message);
    return null;
  }
}

// ניסיון 1 — LLM דרך fal. אמין משרת, ומחזיר תיאור ויזואלי ולא תרגום מילולי.
async function translateWithLLM(text) {
  const r = await fetch("https://fal.run/fal-ai/any-llm", {
    method: "POST",
    headers: {
      "Authorization": `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-flash-1.5",
      system_prompt:
        "You convert a Hebrew description of a t-shirt graphic into a short English image-generation prompt. " +
        "Output ONLY the English prompt - no quotes, no explanation, no preamble. " +
        "Keep it under 40 words. Preserve every concrete subject, object, colour and style the user named. " +
        "Do not invent a different subject. Do not add text or lettering to the image.",
      prompt: text,
    }),
  });

  if (!r.ok) throw new Error(`fal llm ${r.status}`);
  const data = await r.json();
  const out = (data?.output || data?.response || "").trim();
  if (!out || hasHebrew(out)) throw new Error("llm returned no usable english");
  return out;
}

// ניסיון 2 — גוגל. נשאר כגיבוי, אבל כבר לא הדרך היחידה.
async function translateWithGoogle(text) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
    encodeURIComponent(text);
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`google ${r.status}`);

  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // גוגל החזיר HTML (חסימה / CAPTCHA) ולא JSON
    throw new Error("google returned non-json");
  }

  const translated = (data && data[0] ? data[0] : [])
    .map((seg) => (seg && seg[0]) || "")
    .join("")
    .trim();

  if (!translated || hasHebrew(translated)) throw new Error("google returned no usable english");
  return translated;
}

async function toEnglishPrompt(text) {
  if (!hasHebrew(text)) return { prompt: text, via: "none" };

  try {
    return { prompt: await translateWithGemini(text), via: "gemini" };
  } catch (e) {
    console.error("translate via gemini failed:", e.message);
  }

  try {
    return { prompt: await translateWithLLM(text), via: "llm" };
  } catch (e) {
    console.error("translate via fal llm failed:", e.message);
  }

  try {
    return { prompt: await translateWithGoogle(text), via: "google" };
  } catch (e) {
    console.error("translate via google failed:", e.message);
  }

  // חשוב: לא ממשיכים עם עברית. FLUX יתעלם ממנה ויחזיר איור אקראי,
  // וזו בדיוק התקלה שהגרסה הזו באה לתקן.
  return { prompt: null, via: "failed" };
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
  const { prompt } = body;
  if (!prompt || typeof prompt !== "string" || prompt.length > 1000) {
    return res.status(400).json({ error: "Invalid prompt" });
  }

  /* 2026-08-30: הכלי עבר לחיוב. כל קריאה דורשת התחברות, אבל קרדיט נגבה פעם אחת
     לכל שימוש בכלי, ולא לכל פעולה פנימית. כלי שקורא לכאן כשלב ביניים בתוך
     תהליך אחר שולח step:"inner" — אז מאמתים אותו אבל לא מחייבים פעמיים. */
  let acct;
  try {
    acct = await gate(req, body);
  } catch (e) {
    console.error("[generate] account check failed:", e.message);
    return res.status(503).json({ error: "לא הצלחנו לאמת את החשבון. נסו שוב." });
  }
  if (acct.deny) return res.status(acct.deny.status).json(acct.deny.body);
  const chargeable = String(body.step || "") !== "inner";

  const { prompt: englishPrompt, via } = await toEnglishPrompt(prompt);

  if (!englishPrompt) {
    return res.status(502).json({
      error: "התרגום מעברית נכשל. נסו לכתוב את התיאור באנגלית.",
    });
  }




  const STYLE = "rich modern cartoon illustration, soft shading with highlights and dynamic lighting, bold clean linework, vibrant colors, high detail, isolated subject, t-shirt print artwork";

  try {
    let imageUrl = await generateWithCloudflare(`${englishPrompt}, ${STYLE}, plain white background`);
    const engine = imageUrl ? "cloudflare" : "fal";

    if (!imageUrl) {
    const r = await fetch("https://fal.run/fal-ai/flux/dev", {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: `${englishPrompt}, ${STYLE}`,
        image_size: { width: 1152, height: 1536 },
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
    imageUrl = data?.images?.[0]?.url;
    if (!imageUrl) return res.status(502).json({ error: "No image returned" });
    }

    /* קובץ הדפסה 4500x5400 — נוצר רק אם הלקוח ביקש print:true.
       כישלון כאן לא מפיל את התשובה: הלקוח עדיין מקבל את התמונה השקופה. */
    let printUrl = null;
    if (body.print === true) {
      try { printUrl = await makePrintFile(imageUrl); }
      catch (e) { console.error("[generate] print file failed:", e.message); }
    }
    // promptUsed נשלח חזרה כדי שתקלות תרגום יהיו גלויות ולא שקטות
    const left = chargeable ? await settle(acct.student, acct.quota, acct.owner)
      : { freeLeft: acct.quota.freeLeft, credits: acct.quota.credits };
    return res.status(200).json({
      imageUrl, printUrl, promptUsed: englishPrompt, translatedVia: via, engine,
      freeLeft: left.freeLeft, credits: left.credits, owner: !!acct.owner,
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Generation failed" });
  }
}
