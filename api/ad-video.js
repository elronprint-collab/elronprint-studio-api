// api/ad-video.js
// ElronPrint — מנוע פרסומות AI (Creatify clone)
// Endpoint אחד, מספר פעולות. כל קריאה מהדפדפן שולחת { action: "..." }
//
// פעולות:
//   product  → שולף נתוני מוצר מהחנות לפי URL
//   script   → Claude כותב תסריט פרסומת בעברית
//   presenter→ יוצר תמונת דוברת/דובר (flux) — רק אם המשתמש לא העלה תמונה
//   voice    → קריינות עברית (TTS)
//   avatar   → אווטאר מדבר (תמונה + אודיו → וידאו)
//   status   → בדיקת סטטוס של משימה בתור של fal
//
// משתני סביבה נדרשים (כבר קיימים ב-Vercel): FAL_KEY, ANTHROPIC_API_KEY

export const config = { maxDuration: 60 };

// ─────────────────────────────────────────────────────────────
// מזהי מודלים — כל שינוי עתידי נעשה כאן בלבד.
// חשוב: fal מחליפים/מעדכנים מודלים כל הזמן. אם קריאה מחזירה 404,
// תיכנס ל-fal.ai/models, תעתיק את המזהה החדש ותחליף כאן.
// ─────────────────────────────────────────────────────────────
const MODELS = {
  tts:       "fal-ai/elevenlabs/tts/multilingual-v2", // תומך עברית
  avatar:    "fal-ai/hedra/character-2",              // תמונה + אודיו → וידאו מדבר
  presenter: "fal-ai/flux/dev",                       // יצירת תמונת דובר
};

const CLAUDE_MODEL = "claude-sonnet-5";

const FAL_QUEUE = "https://queue.fal.run";

// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST בלבד" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { action } = body;

    switch (action) {
      case "product":   return res.json(await getProduct(body));
      case "script":    return res.json(await writeScript(body));
      case "presenter": return res.json(await falSubmit(MODELS.presenter, presenterInput(body)));
      case "voice":     return res.json(await falSubmit(MODELS.tts, voiceInput(body)));
      case "avatar":    return res.json(await falSubmit(MODELS.avatar, avatarInput(body)));
      case "status":    return res.json(await falStatus(body));
      default:          return res.status(400).json({ error: "action לא מוכר: " + action });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "שגיאה לא צפויה" });
  }
}

// ─── 1. נתוני מוצר ────────────────────────────────────────────
// אנחנו בעלי החנות, אז אין צורך בסקרייפינג — Shopify מחזיר JSON
// לכל מוצר בכתובת <product-url>.js

async function getProduct({ url }) {
  if (!url) throw new Error("חסר URL של מוצר");

  const clean = String(url).split("?")[0].replace(/\/+$/, "");
  if (!/\/products\//.test(clean)) throw new Error("זה לא נראה כמו קישור למוצר");

  const r = await fetch(clean + ".js", { headers: { "User-Agent": "ElronPrint-AdTool" } });
  if (!r.ok) throw new Error("לא הצלחתי לשלוף את המוצר (" + r.status + ")");
  const p = await r.json();

  return {
    title: p.title,
    description: stripHtml(p.description).slice(0, 1200),
    price: (p.price / 100).toFixed(0) + " ₪",
    type: p.type,
    tags: p.tags,
    images: (p.images || []).map((i) => (i.startsWith("//") ? "https:" + i : i)).slice(0, 8),
  };
}

function stripHtml(s = "") {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// ─── 2. תסריט ─────────────────────────────────────────────────

async function writeScript({ product, tone = "אנרגטי", seconds = 20 }) {
  if (!product) throw new Error("חסרים נתוני מוצר");

  const words = Math.round((seconds * 2.4)); // ~2.4 מילים לשנייה בעברית מדוברת

  const prompt = `אתה קופירייטר של פרסומות UGC לטיקטוק ואינסטגרם בעברית.

המוצר:
שם: ${product.title}
תיאור: ${product.description}
מחיר: ${product.price}

כתוב תסריט לפרסומת של ${seconds} שניות בטון ${tone}, שדוברת אמיתית אומרת למצלמה.
כללים:
- עברית מדוברת וטבעית, לא שיווקית־מלאכותית. בלי "הזדמנות בלתי חוזרת".
- הוק חזק ב-3 השניות הראשונות.
- ${words} מילים בערך. זה קריטי — לא יותר.
- בלי אימוג'ים, בלי הערות במה, בלי סימני קריאה מרובים. רק מה שנאמר בפה.
- קריאה לפעולה קצרה בסוף.

החזר JSON בלבד, בלי טקסט לפני או אחרי, בלי backticks:
{"hook":"...","script":"...","caption":"...","hashtags":["...","..."]}
כאשר script הוא הטקסט המלא לקריינות (כולל ההוק), caption הוא כיתוב לפוסט.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!r.ok) throw new Error("שגיאת Claude: " + (await r.text()).slice(0, 200));
  const data = await r.json();

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    return { hook: "", script: text, caption: "", hashtags: [] };
  }
}

// ─── 3. קלטים למודלים ─────────────────────────────────────────

function presenterInput({ describe = "", vertical = true }) {
  return {
    prompt:
      "Photorealistic portrait photo of " +
      (describe || "a friendly young Israeli woman, natural makeup, casual t-shirt") +
      ", looking straight at the camera, head and shoulders centered, neutral closed mouth, " +
      "soft even daylight, plain uncluttered background, smartphone selfie quality, sharp face",
    image_size: vertical ? "portrait_16_9" : "square_hd",
    num_images: 1,
  };
}

function voiceInput({ text, voiceId }) {
  if (!text) throw new Error("חסר טקסט לקריינות");
  return {
    text,
    voice: voiceId || "Rachel",
    stability: 0.45,
    similarity_boost: 0.75,
    speed: 1.0,
  };
}

function avatarInput({ imageUrl, audioUrl }) {
  if (!imageUrl) throw new Error("חסרה תמונת דובר");
  if (!audioUrl) throw new Error("חסר קובץ קריינות");
  return {
    image_url: imageUrl,
    audio_url: audioUrl,
    aspect_ratio: "9:16",
  };
}

// ─── 4. תור fal ───────────────────────────────────────────────
// כל המודלים הכבדים רצים דרך התור: שולחים, מקבלים request_id,
// והדפדפן בודק סטטוס כל כמה שניות. זה מה שמונע timeout של Vercel
// (60 שניות מקסימום ב-Hobby, ואווטאר לוקח 1-4 דקות).

async function falSubmit(model, input) {
  const r = await fetch(`${FAL_QUEUE}/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const data = await r.json();
  if (!r.ok) throw new Error("fal (" + model + "): " + JSON.stringify(data).slice(0, 300));

  return { requestId: data.request_id, model, queued: true };
}

async function falStatus({ requestId, model }) {
  if (!requestId || !model) throw new Error("חסר requestId או model");

  const auth = { Authorization: `Key ${process.env.FAL_KEY}` };

  const s = await fetch(`${FAL_QUEUE}/${model}/requests/${requestId}/status`, { headers: auth });
  const st = await s.json();

  if (st.status !== "COMPLETED") {
    return { status: st.status || "IN_QUEUE", position: st.queue_position ?? null };
  }

  const r = await fetch(`${FAL_QUEUE}/${model}/requests/${requestId}`, { headers: auth });
  const out = await r.json();

  return { status: "COMPLETED", url: extractUrl(out), raw: out };
}

// כל מודל מחזיר מבנה קצת אחר — מושכים את ה-URL מכל המקומות המוכרים
function extractUrl(out = {}) {
  return (
    out?.video?.url ||
    out?.audio?.url ||
    out?.audio_url?.url ||
    out?.images?.[0]?.url ||
    out?.image?.url ||
    out?.url ||
    null
  );
}
