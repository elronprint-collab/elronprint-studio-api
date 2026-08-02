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
  // v3 נבחר בבדיקה מול עברית מנוקדת 2026-08-02: אפס טעויות הגייה,
  // מבטא קל בלבד. אל תחליף את הסדר בלי בדיקת אוזן מחדש.
  {
    model: "fal-ai/elevenlabs/tts/eleven-v3",
    input: (t, v) => ({ text: t, voice: v || "Rachel" }),
  },
  {
    model: "fal-ai/elevenlabs/tts/multilingual-v2",
    input: (t, v) => ({ text: t, voice: v || "Rachel", stability: 0.45, similarity_boost: 0.75 }),
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
  presenter: "fal-ai/flux/dev",
};

// אווטאר: תמונה סטטית + אודיו → וידאו מדבר.
// אותה שיטה כמו בקריינות — מנסים לפי הסדר עד שאחד עונה,
// כי fal מחליפים מזהי מודלים כל הזמן.
const AVATAR_CANDIDATES = [
  // כל המודלים האלה דורשים prompt — תיאור באנגלית של מה שקורה בפריים.
  // בלעדיו fal מחזיר 422 "Field required". התיאור לא משנה את מה שנאמר,
  // רק את התנועה, ההבעה והמצלמה.
  {
    model: "fal-ai/hedra/character-2",
    input: (img, aud, prompt) => ({
      image_url: img, audio_url: aud, prompt, aspect_ratio: "9:16",
    }),
    // hedra גוזר את האורך מהאודיו לבד, אין לו פרמטר שניות
  },
  {
    // num_frames ~25 fps. ברירת המחדל של המודל היא ~5 שניות.
    // כל שנייה נוספת עולה בזמן ובכסף כמעט ליניארית.
    model: "fal-ai/infinitalk",
    input: (img, aud, prompt, seconds) => ({
      image_url: img, audio_url: aud, prompt, resolution: "480p",
      ...(seconds ? { num_frames: Math.min(Math.round(seconds * 25), 500) } : {}),
    }),
  },
  {
    model: "fal-ai/ai-avatar",
    input: (img, aud, prompt) => ({ image_url: img, audio_url: aud, prompt }),
  },
  {
    model: "fal-ai/sonic",
    input: (img, aud, prompt) => ({ image_url: img, audio_url: aud, prompt }),
  },
];

// סנכרון שפתיים: וידאו קיים + אודיו חדש → אותו וידאו עם שפתיים מתאימות.
// הרבה יותר מהיר וזול מיצירת אווטאר מאפס, כי לא מייצרים וידאו —
// רק משנים את אזור הפה. זה מה שמאפשר קליפ דוברת קבוע לשימוש חוזר.
const LIPSYNC_CANDIDATES = [
  {
    // bounce ולא cut_off: קליפ הבסיס באורך 5 שניות, וטקסט ארוך יותר
    // היה נחתך באמצע. bounce מריץ את הקליפ קדימה־אחורה עד שהוא מכסה
    // את כל האודיו, וזה נראה חלק יותר מלולאה שקופצת חזרה להתחלה.
    model: "fal-ai/sync-lipsync",
    input: (vid, aud) => ({ video_url: vid, audio_url: aud, sync_mode: "bounce" }),
  },
  {
    model: "fal-ai/veed/lipsync",
    input: (vid, aud) => ({ video_url: vid, audio_url: aud }),
  },
  {
    model: "fal-ai/latentsync",
    input: (vid, aud) => ({ video_url: vid, audio_url: aud }),
  },
];

const DEFAULT_AVATAR_PROMPT =
  "A person speaking directly to the camera in a warm, natural, friendly way, " +
  "subtle head movement and natural facial expression, static camera, indoor daylight";

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
      case "engines":   return res.json({
        engines: TTS_CANDIDATES.map((c) => c.model),
        avatars: AVATAR_CANDIDATES.map((c) => c.model),
        lipsync: LIPSYNC_CANDIDATES.map((c) => c.model),
      });
      case "presenter": return res.json(await falSubmit(MODELS.presenter, presenterInput(body)));
      case "avatar":    return res.json(await submitAvatar(body));
      case "lipsync":   return res.json(await submitLipsync(body));
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

// ─── ניקוד אוטומטי ────────────────────────────────────────────
// עברית נכתבת בלי ניקוד, אז מנוע קריינות צריך לנחש איך לבטא כל
// מילה — ובעברית הוא מנחש רע. מנקדים לפני, ואין מה לנחש.
// ראשי: Nakdan של דיקטה. גיבוי: Claude.

async function vocalize(text) {
  try {
    const r = await fetch("https://nakdan-5-0.loadbalancer.dicta.org.il/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "nakdan", data: text, genre: "modern", addmorph: false }),
    });

    const raw = await r.text();
    if (!r.ok || !raw) throw new Error("dicta " + r.status);

    const out = JSON.parse(raw);

    // דיקטה מחזירה מערך של מילים; לכל אחת אפשרויות ניקוד מדורגות.
    // לוקחים את הראשונה, ומשמרים רווחים וסימני פיסוק כמו שהם.
    const words = Array.isArray(out) ? out : out.data;
    if (!Array.isArray(words)) throw new Error("מבנה תשובה לא מוכר");

    const built = words
      .map((w) => {
        if (typeof w === "string") return w;
        if (w.sep) return w.word ?? "";
        const opt = w.options?.[0];
        const v = typeof opt === "string" ? opt : opt?.w ?? opt?.word;
        return (v || w.word || "").replace(/\|/g, "");
      })
      .join("");

    if (built.trim() && /[\u0591-\u05C7]/.test(built)) {
      return { text: built, method: "dicta" };
    }
    throw new Error("דיקטה לא החזירה ניקוד");
  } catch (e) {
    return await vocalizeWithClaude(text, e.message);
  }
}

async function vocalizeWithClaude(text, why = "") {
  if (!process.env.ANTHROPIC_API_KEY) return { text, method: "none", note: why };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content:
              "נקד את הטקסט הבא בניקוד מלא ותקני, בעברית ישראלית מודרנית.\n" +
              "החזר אך ורק את הטקסט המנוקד — בלי הסבר, בלי הקדמה, בלי מרכאות.\n" +
              "אל תשנה אף מילה ואל תוסיף מילים. רק ניקוד.\n\n" +
              text,
          },
        ],
      }),
    });

    if (!r.ok) return { text, method: "none", note: why };

    const data = await r.json();
    const out = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (out && /[\u0591-\u05C7]/.test(out)) return { text: out, method: "claude", note: why };
    return { text, method: "none", note: why };
  } catch {
    return { text, method: "none", note: why };
  }
}

// ─── קריינות: מנסה מודל אחרי מודל ─────────────────────────────

async function submitVoice({ text, voiceId, niqqud = false, model = null }) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  if (!text) throw new Error("חסר טקסט לקריינות");

  let spoken = text;
  let niqqudInfo = null;

  if (niqqud) {
    const v = await vocalize(text);
    spoken = v.text;
    niqqudInfo = { method: v.method, text: v.text };
  }

  const failures = [];

  // אם נשלח model מפורש — בודקים רק אותו. אחרת עוברים על כל הרשימה.
  const list = model
    ? TTS_CANDIDATES.filter((c) => c.model === model)
    : TTS_CANDIDATES;

  if (model && list.length === 0) throw new Error("מודל לא מוכר: " + model);

  for (const cand of list) {
    try {
      const data = await falFetch(`${FAL_QUEUE}/${cand.model}`, {
        method: "POST",
        body: JSON.stringify(cand.input(spoken, voiceId)),
      });
      return {
        requestId: data.request_id,
        model: cand.model,
        statusUrl: data.status_url || null,
        responseUrl: data.response_url || null,
        niqqud: niqqudInfo,
        queued: true,
      };
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
  return {
    requestId: data.request_id,
    model,
    statusUrl: data.status_url || null,
    responseUrl: data.response_url || null,
    queued: true,
  };
}

// חשוב: את המשימה שולחים לנתיב המלא של המודל
// (fal-ai/elevenlabs/tts/multilingual-v2), אבל את הסטטוס בודקים
// רק בשתי הרמות הראשונות (fal-ai/elevenlabs). fal מחזיר לנו את
// הכתובות הנכונות בתשובת השליחה, אז מעדיפים אותן כשהן קיימות.

function queueBase(model = "") {
  return model.split("/").slice(0, 2).join("/");
}

async function falStatus({ requestId, model, statusUrl, responseUrl }) {
  if (!requestId && !statusUrl) throw new Error("חסר requestId");

  const base = `${FAL_QUEUE}/${queueBase(model)}/requests/${requestId}`;
  const sUrl = statusUrl || `${base}/status`;
  const rUrl = responseUrl || base;

  const st = await falFetch(sUrl);

  if (st.status !== "COMPLETED") {
    return { status: st.status || "IN_QUEUE", position: st.queue_position ?? null, model };
  }

  const out = await falFetch(rUrl);
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

async function submitLipsync({ videoUrl, audioUrl, model = null, extra = null }) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  if (!videoUrl) throw new Error("חסר קליפ דוברת");
  if (!audioUrl) throw new Error("חסר קובץ קריינות");

  const list = model
    ? LIPSYNC_CANDIDATES.filter((c) => c.model === model)
    : LIPSYNC_CANDIDATES;

  if (model && list.length === 0) throw new Error("מודל סנכרון לא מוכר: " + model);

  const failures = [];

  for (const cand of list) {
    try {
      const data = await falFetch(`${FAL_QUEUE}/${cand.model}`, {
        method: "POST",
        body: JSON.stringify({ ...cand.input(videoUrl, audioUrl), ...(extra || {}) }),
      });
      return {
        requestId: data.request_id,
        model: cand.model,
        statusUrl: data.status_url || null,
        responseUrl: data.response_url || null,
        skipped: failures,
        queued: true,
      };
    } catch (e) {
      failures.push(`${cand.model} → ${e.message}`);
      if (e.status === 401 || e.status === 403) break;
    }
  }

  throw new Error("אף מודל סנכרון שפתיים לא עבד.\n" + failures.join("\n"));
}

async function submitAvatar({ imageUrl, audioUrl, model = null, prompt = null, seconds = null, extra = null }) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  if (!imageUrl) throw new Error("חסרה תמונת דובר");
  if (!audioUrl) throw new Error("חסר קובץ קריינות");

  const list = model
    ? AVATAR_CANDIDATES.filter((c) => c.model === model)
    : AVATAR_CANDIDATES;

  if (model && list.length === 0) throw new Error("מודל אווטאר לא מוכר: " + model);

  const failures = [];

  for (const cand of list) {
    try {
      const data = await falFetch(`${FAL_QUEUE}/${cand.model}`, {
        method: "POST",
        body: JSON.stringify({
          ...cand.input(imageUrl, audioUrl, prompt || DEFAULT_AVATAR_PROMPT, seconds),
          ...(extra || {}),   // מאפשר לנסות פרמטרים חדשים בלי לפרוס מחדש
        }),
      });
      return {
        requestId: data.request_id,
        model: cand.model,
        statusUrl: data.status_url || null,
        responseUrl: data.response_url || null,
        // מי נכשל לפניו ולמה — כדי שלא נעבוד בעיוורון
        skipped: failures,
        queued: true,
      };
    } catch (e) {
      failures.push(`${cand.model} → ${e.message}`);
      if (e.status === 401 || e.status === 403) break;
    }
  }

  throw new Error("אף מודל אווטאר לא עבד.\n" + failures.join("\n"));
}
