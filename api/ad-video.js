// api/ad-video.js  —  גרסה 2
// ElronPrint — מנוע פרסומות AI (Creatify clone)
//
// שינויים מגרסה 1:
//   - שגיאות של fal מדווחות במלואן (קוד + טקסט) במקום "Unexpected end of JSON input"
//   - הקריינות מנסה כמה מודלים בזה אחר זה עד שאחד מצליח
//
// משתני סביבה נדרשים (כבר קיימים ב-Vercel): FAL_KEY, ANTHROPIC_API_KEY

export const config = { maxDuration: 60 };

const FAL_QUEUE = "https://queue.fal.run";
const CLAUDE_MODEL = "claude-sonnet-5";

// ─────────────────────────────────────────────────────────────
// מועמדים לקריינות עברית — מנוסים לפי הסדר עד שאחד עונה.
// לכל אחד מבנה קלט משלו, כי כל ספק מצפה לשדות אחרים.
// ─────────────────────────────────────────────────────────────
const TTS_CANDIDATES = [
  {
    model: "fal-ai/elevenlabs/tts/multilingual-v2",
    input: (t, v) => ({ text: t, voice: v || "Rachel", stability: 0.45, similarity_boost: 0.75 }),
  },
  {
    model: "fal-ai/elevenlabs/tts/eleven-v3",
    input: (t, v) => ({ text: t, voice: v || "Rachel" }),
  },
  {
    model: "fal-ai/minimax/speech-02-hd",
    input: (t, v) => ({ text: t, voice_setting: { voice_id: v || "Wise_Woman", speed: 1, vol: 1 } }),
  },
  {
    model: "fal-ai/minimax-tts/text-to-speech",
    input: (t, v) => ({ text: t, voice_setting: { voice_id: v || "Wise_Woman" } }),
  },
];

const MODELS = {
  avatar: "fal-ai/hedra/character-2",
  presenter: "fal-ai/flux/dev",
};

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
      case "voice":     return res.json(await submitVoice(body));
      case "presenter": return res.json(await falSubmit(MODELS.presenter, presenterInput(body)));
      case "avatar":    return res.json(await falSubmit(MODELS.avatar, avatarInput(body)));
      case "status":    return res.json(await falStatus(body));
      default:          return res.status(400).json({ error: "action לא מוכר: " + action });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "שגיאה לא צפויה" });
  }
}

// ─── קריאה בטוחה ל-fal ────────────────────────────────────────
// קוראים קודם כטקסט. רק אז מנסים לפרסר. ככה שגיאת 404 או HTML
// לא מתחזה ל"JSON פגום" ואנחנו רואים מה באמת קרה.

async function falFetch(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const raw = await r.text();

  if (!r.ok) {
    const detail = raw ? raw.slice(0, 400) : "(תשובה ריקה)";
    const e = new Error(`fal ${r.status}: ${detail}`);
    e.status = r.status;
    throw e;
  }

  if (!raw) throw new Error("fal החזיר תשובה ריקה עם קוד " + r.status);

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("fal החזיר תשובה שאינה JSON: " + raw.slice(0, 200));
  }
}

// ─── קריינות: מנסה מודל אחרי מודל ─────────────────────────────

async function submitVoice({ text, voiceId }) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  if (!text) throw new Error("חסר טקסט לקריינות");

  const failures = [];

  for (const cand of TTS_CANDIDATES) {
    try {
      const data = await falFetch(`${FAL_QUEUE}/${cand.model}`, {
        method: "POST",
        body: JSON.stringify(cand.input(text, voiceId)),
      });
      return { requestId: data.request_id, model: cand.model, queued: true };
    } catch (e) {
      failures.push(`${cand.model} → ${e.message}`);
      // 401/403 = בעיית מפתח, לא בעיית מודל. אין טעם להמשיך לנסות.
      if (e.status === 401 || e.status === 403) break;
    }
  }

  throw new Error("אף מודל קריינות לא עבד.\n" + failures.join("\n"));
}

// ─── שאר הפעולות ──────────────────────────────────────────────

async function falSubmit(model, input) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  const data = await falFetch(`${FAL_QUEUE}/${model}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { requestId: data.request_id, model, queued: true };
}

async function falStatus({ requestId, model }) {
  if (!requestId || !model) throw new Error("חסר requestId או model");

  const st = await falFetch(`${FAL_QUEUE}/${model}/requests/${requestId}/status`);

  if (st.status !== "COMPLETED") {
    return { status: st.status || "IN_QUEUE", position: st.queue_position ?? null, model };
  }

  const out = await falFetch(`${FAL_QUEUE}/${model}/requests/${requestId}`);
  return { status: "COMPLETED", url: extractUrl(out), model };
}

function extractUrl(out = {}) {
  return (
    out?.video?.url ||
    out?.audio?.url ||
    out?.audio_url?.url ||
    out?.audio_url ||
    out?.images?.[0]?.url ||
    out?.image?.url ||
    out?.url ||
    null
  );
}

// ─── נתוני מוצר ───────────────────────────────────────────────

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

// ─── תסריט ────────────────────────────────────────────────────

async function writeScript({ product, tone = "אנרגטי", seconds = 20 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY לא מוגדר ב-Vercel");
  if (!product) throw new Error("חסרים נתוני מוצר");

  const words = Math.round(seconds * 2.4);

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

  const raw = await r.text();
  if (!r.ok) throw new Error("Claude " + r.status + ": " + raw.slice(0, 300));

  const data = JSON.parse(raw);
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

// ─── קלטים ────────────────────────────────────────────────────

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

function avatarInput({ imageUrl, audioUrl }) {
  if (!imageUrl) throw new Error("חסרה תמונת דובר");
  if (!audioUrl) throw new Error("חסר קובץ קריינות");
  return { image_url: imageUrl, audio_url: audioUrl, aspect_ratio: "9:16" };
}
