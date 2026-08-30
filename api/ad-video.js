import crypto from "crypto";

/* ──────────────────────────────────────────────────────────────────────────
   שער גישה — נוסף 2026-08-30

   עד היום הקובץ הזה לא בדק כלום. הבדיקה נעשתה בעמוד בדפדפן בלבד: העמוד שאל
   את auth.js מה היתרה, ואם הייתה — קרא לכאן. כלומר קריאה ישירה ל-/api/ad-video
   מכלי מפתחים ייצרה סרטונים בלי התחברות ובלי קרדיטים, על חשבון החנות.
   כל שאר הכלים בתשלום בודקים בשרת; רק זה לא.

   מה שנבדק כאן: הטוקן -> סשן -> חשבון -> יש יתרה (ריצה חינם או קרדיט).
   מה שלא נעשה כאן: ניכוי. הניכוי ממשיך להתבצע ב-auth.js דרך avatarConsume,
   ולו הייתי מנכה גם כאן הלקוח היה מחויב פעמיים על אותו סרטון.
   ────────────────────────────────────────────────────────────────────────── */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET   = process.env.APP_SECRET;
const AVATAR_FREE_RUNS = 1;      // חייב להיות זהה לערך ב-auth.js
const encq = encodeURIComponent;

/* הפעולות שמוציאות כסף אמיתי. status ו-engines לא, והן נשארות פתוחות כדי
   שסקר מצב של ג'וב שכבר רץ לא ייפול אם הטוקן פג באמצע. */
const PAID_ACTIONS = ["script", "voice", "presenter", "avatar", "lipsync", "tryon"];

function gateHash(s) {
  return crypto.createHmac("sha256", APP_SECRET || "fallback").update(String(s)).digest("hex");
}

async function gateGet(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error("Supabase GET " + path + " -> " + r.status);
  return JSON.parse((await r.text()) || "[]");
}

function isOwnerMail(email) {
  const list = String(process.env.OWNER_EMAILS || "")
    .split(",").map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  return !!email && list.indexOf(String(email).trim().toLowerCase()) !== -1;
}

/* מחזיר null כשמותר להמשיך, או אובייקט תשובה כשצריך לעצור. */
async function denyReason(token) {
  if (!token || String(token).length < 32) {
    return { status: 401, body: { error: "צריך להתחבר כדי ליצור סרטון.", needLogin: true } };
  }
  const rows = await gateGet(
    "sessions?token_hash=eq." + encq(gateHash(token)) +
    "&select=student_id,expires_at,students(id,email,avatar_credits)&limit=1"
  );
  const sess = rows[0];
  if (!sess || new Date(sess.expires_at).getTime() < Date.now()) {
    return { status: 401, body: { error: "ההתחברות פגה. התחברו מחדש.", needLogin: true } };
  }

  const st = sess.students || {};
  if (isOwnerMail(st.email)) return null;

  const credits = st.avatar_credits || 0;
  if (credits > 0) return null;

  const free = await gateGet(
    "avatar_runs?student_id=eq." + encq(sess.student_id) + "&charged=is.false&select=id"
  );
  if (Math.max(0, AVATAR_FREE_RUNS - free.length) > 0) return null;

  return {
    status: 402,
    body: { error: "נגמרו הקרדיטים לסרטוני אווטאר.", needCredits: true, freeLeft: 0, credits: 0 }
  };
}

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

  // ── נוספו 2026-08-27: שני מודלים חדשים שלא היו קיימים כשהקובץ נכתב.
  // שניהם מבטיחים תנועת גוף ומחוות ולא רק שפתיים — זה הניסוי.
  // אומת מול עמודי fal הרשמיים: שניהם דורשים image_url + audio_url בלבד,
  // אין num_frames ואין פרמטר שניות — אורך הווידאו נגזר מאורך האודיו.
  // הפלט הוא {video:{url}} — כבר נתמך ב-falStatus.
  // נוספו בסוף הרשימה בכוונה, כדי שסדר ברירת המחדל לא ישתנה בכלל.
  {
    // $0.16 לשנייה. מקסימום 30 שניות אודיו.
    // ⚠ לא שולחים prompt — הטופס הרשמי לא כולל אותו, ושדה לא מוכר
    //   מוחזר ב-422. לכן הפונקציה מתעלמת מהפרמטר.
    model: "fal-ai/bytedance/omnihuman/v1.5",
    input: (img, aud) => ({ image_url: img, audio_url: aud }),
  },
  {
    // $0.115 לשנייה. prompt הוא אופציונלי כאן ולכן כן נשלח.
    model: "fal-ai/kling-video/ai-avatar/v2/pro",
    input: (img, aud, prompt) => ({ image_url: img, audio_url: aud, prompt }),
  },
];

// מדידה וירטואלית: תמונת אדם + תמונת בגד → האדם לובש את הבגד.
// זה מה שמאפשר דוברת שלובשת את החולצה שנמכרת בפועל.
const TRYON_CANDIDATES = [
  {
    model: "fal-ai/idm-vton",
    input: (human, garment, desc) => ({
      human_image_url: human,
      garment_image_url: garment,
      description: desc || "a printed t-shirt",
      category: "upper_body",
    }),
  },
  {
    model: "fal-ai/kling/v1-5/kolors-virtual-try-on",
    input: (human, garment) => ({ human_image_url: human, garment_image_url: garment }),
  },
  {
    model: "fal-ai/cat-vton",
    input: (human, garment) => ({
      human_image_url: human, garment_image_url: garment, cloth_type: "upper",
    }),
  },
];

async function submitTryon({ humanUrl, garmentUrl, description, model = null }) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  if (!humanUrl) throw new Error("חסרה תמונת דוברת");
  if (!garmentUrl) throw new Error("חסרה תמונת חולצה");

  const known = TRYON_CANDIDATES.filter((c) => c.model === model);
  const list = model
    ? (known.length ? known
                    : [{ model, input: (h, g) => ({ human_image_url: h, garment_image_url: g }) }])
    : TRYON_CANDIDATES;

  const failures = [];

  for (const cand of list) {
    try {
      const data = await falFetch(`${FAL_QUEUE}/${cand.model}`, {
        method: "POST",
        body: JSON.stringify(cand.input(humanUrl, garmentUrl, description)),
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

  throw new Error("אף מודל מדידה לא עבד.\n" + failures.join("\n"));
}

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
    // veed יושב תחת המרחב של veed עצמו, לא תחת fal-ai.
    // "fal-ai/veed/lipsync" מחזיר 404 Application "veed" not found.
    model: "veed/lipsync",
    input: (vid, aud) => ({ video_url: vid, audio_url: aud }),
  },
  {
    model: "fal-ai/sync-lipsync/v2",
    input: (vid, aud) => ({ video_url: vid, audio_url: aud, sync_mode: "bounce" }),
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-epai-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST בלבד" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { action } = body;

    if (PAID_ACTIONS.indexOf(action) !== -1) {
      const deny = await denyReason(body.token || req.headers["x-epai-token"]);
      if (deny) {
        console.warn("[ad-video] refused", action, "-", JSON.stringify(deny.body.error));
        return res.status(deny.status).json(deny.body);
      }
    }

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
      case "tryon":     return res.json(await submitTryon(body));
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

// ─── Azure — קולות עבריים אמיתיים ─────────────────────────────
// הילה ואברי הוקלטו בעברית על ידי דוברי עברית, בניגוד לקולות של
// ElevenLabs שהם דוברי אנגלית שמבטאים עברית. בנוסף Azure מחזיר
// את האודיו מיד, בלי תור — אין פה שום המתנה.
//
// fal צריך קישור ולא בייטים, אז מעלים את התוצאה ל-Cloudinary.

const AZURE_VOICES = {
  hila: "he-IL-HilaNeural",
  avri: "he-IL-AvriNeural",
};

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

function ssml(text, voice, rate) {
  const safe = String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="he-IL">` +
         `<voice name="${voice}"><prosody rate="${rate || "0%"}">${safe}</prosody></voice></speak>`;
}

async function azureSpeak(text, voiceKey = "hila", rate = "0%") {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error("AZURE_SPEECH_KEY או AZURE_SPEECH_REGION לא מוגדרים ב-Vercel");

  const voice = AZURE_VOICES[voiceKey] || voiceKey;

  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "ElronPrint",
    },
    body: ssml(text, voice, rate),
  });

  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Azure ${r.status}: ${detail.slice(0, 300) || "(תשובה ריקה)"}`);
  }

  const audio = Buffer.from(await r.arrayBuffer());
  if (!audio.length) throw new Error("Azure החזיר אודיו ריק");

  const url = await uploadToCloudinary(audio);
  return { url, provider: "azure", voice, done: true };
}

// העלאה לא־חתומה, אותו preset שכבר משמש את שאר הכלים
async function uploadToCloudinary(buf) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), "voice.mp3");
  form.append("upload_preset", CLOUD_PRESET);

  const r = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`,
    { method: "POST", body: form }
  );

  const raw = await r.text();
  if (!r.ok) throw new Error(`Cloudinary ${r.status}: ${raw.slice(0, 300)}`);

  const out = JSON.parse(raw);
  if (!out.secure_url) throw new Error("Cloudinary לא החזיר קישור");
  return out.secure_url;
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

async function submitVoice({ text, voiceId, niqqud = false, model = null, provider = null }) {
  if (!text) throw new Error("חסר טקסט לקריינות");

  // ברירת מחדל: Azure אם הוא מוגדר. fal נשאר כגיבוי ולהשוואה.
  const useAzure = provider === "azure" ||
                   (!provider && process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);

  if (useAzure) {
    let spoken = text;
    let niqqudInfo = null;
    if (niqqud) {
      const v = await vocalize(text);
      spoken = v.text;
      niqqudInfo = { method: v.method, text: v.text };
    }
    const out = await azureSpeak(spoken, voiceId || "hila");
    return { ...out, niqqud: niqqudInfo };
  }

  return falVoice({ text, voiceId, niqqud, model });
}

async function falVoice({ text, voiceId, niqqud = false, model = null }) {
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

function presenterInput({ describe = "", vertical = true, wide = false }) {
  // wide = פריים רחב שרואים בו את פלג הגוף העליון, כדי שהחולצה תיראה.
  // בלי זה מקבלים תקריב פנים ואין מקום להלביש עליו כלום.
  const framing = wide
    ? "waist-up shot, full torso and plain t-shirt clearly visible, arms relaxed at sides, "
    : "head and shoulders centered, ";

  return {
    prompt:
      "Photorealistic photo of " +
      (describe || "a friendly young woman, natural makeup, plain white crew-neck t-shirt") +
      ", standing facing the camera, " + framing +
      "neutral closed mouth, soft even daylight, plain uncluttered light background, " +
      "smartphone photo quality, sharp face, no text on clothing",
    image_size: vertical ? "portrait_16_9" : "square_hd",
    num_images: 1,
  };
}

async function submitLipsync({ videoUrl, audioUrl, model = null, extra = null }) {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY לא מוגדר ב-Vercel");
  if (!videoUrl) throw new Error("חסר קליפ דוברת");
  if (!audioUrl) throw new Error("חסר קובץ קריינות");

  // מזהי מודלים אצל fal משתנים תכופות. אם נשלח model שלא ברשימה,
  // מנסים אותו בכל זאת עם המבנה הסטנדרטי — ככה שינוי שם עתידי
  // לא מחייב פריסה מחדש של השרת.
  const known = LIPSYNC_CANDIDATES.filter((c) => c.model === model);
  const list = model
    ? (known.length ? known
                    : [{ model, input: (v, a) => ({ video_url: v, audio_url: a }) }])
    : LIPSYNC_CANDIDATES;

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
