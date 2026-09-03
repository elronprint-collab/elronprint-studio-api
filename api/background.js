import { checkRateLimit } from "./_ratelimit.js";
import { studentFromToken, isOwner } from "./_account.js";

// api/background.js — מייצר רקעים למחולל הברכות
//
// נבנה 2026-09-03. הכלי היה תקוע על 10 רקעים כי כל רקע חדש דרש יצירה ידנית,
// וארבעה מהם צוירו בקוד כי לא הייתה דרך לייצר תמונה אמיתית. הפונקציה הזו סוגרת את זה:
// מקבלת תיאור, מייצרת תמונה מלאה דרך fal, ומחזירה כתובת קבועה בקלאודינרי.
//
// שלוש החלטות שכדאי לזכור:
//
// 1. בעלים בלבד. אין כאן קרדיטים ואין מסלול לקוח — זה כלי פנימי לייצור מלאי הרקעים.
//    לקוח לא מייצר רקעים, הוא בוחר מתוך מה שכבר קיים. לכן אין gate() ואין settle():
//    מי שאינו ברשימת OWNER_EMAILS מקבל 403 ואף קריאה בתשלום לא נשלחת.
//
// 2. תמונה מלאה, לא שקופה. כל שאר הפונקציות בשרת מסירות רקע — כאן הרקע הוא כל העניין,
//    ולכן אין birefnet ואין ניקוי אלפא. אסור לחבר את הפונקציה הזו לצינור של הכלים האחרים.
//
// 3. flux/dev דרך fal, אותו מודל שכבר משמש ב"עיצוב מחדש". לא higgsfield: החשבון שם
//    בתוכנית חינם עם 0 קרדיטים (נבדק 2026-09-03), בעוד fal כבר מחויב ופעיל.
//
// הפרומפט נבנה סביב כלל אחד: המקום שבו יושב הכיתוב חייב להישאר פנוי. רקע יפה שיש בו
// עומס במרכז הופך ברכה לבלתי קריאה, וזו בדיוק הסיבה שרקעים "יפים" נראים גרוע בכלי.

export const config = { maxDuration: 60 };

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";
const MODEL = "fal-ai/flux/dev";

/* 1080x1350 — היחס של סטורי/פוסט וואטסאפ, אותו יחס שהכלי מצייר עליו היום. */
const WIDTH = 1080;
const HEIGHT = 1350;

/* ---------------- CORS ---------------- */
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

/* ---------------- fal ---------------- */
async function fal(model, input) {
  const r = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error(`fal ${model} failed:`, r.status, t.slice(0, 300));
    throw new Error(`${model} failed`);
  }
  const d = await r.json();
  const url = d?.images?.[0]?.url || d?.image?.url || d?.url;
  if (!url) throw new Error(`${model}: no image returned`);
  return url;
}

/* ---------------- prompt ----------------
   שני חלקים קבועים עוטפים את התיאור שלו. החלק הראשון קובע שזה רקע ולא איור עצמאי,
   והשני שומר על השטח שבו יושב הכיתוב. בלי שניהם flux מייצר תמונה מרהיבה שאי אפשר
   לכתוב עליה כלום — וזה בדיוק ההבדל בין רקע לתמונה. */
const PROMPT_HEAD =
  "a decorative background image for a greeting card, portrait orientation, " +
  "elegant and festive, rich colour, soft depth of field, professional photography quality, ";

const PROMPT_TAIL =
  ", the centre of the frame is calm and uncluttered so text can be placed over it, " +
  "detail and ornament kept to the edges and corners, gentle vignette, " +
  "no text, no letters, no words, no writing, no captions, no logos, no watermarks, " +
  "no people looking at the camera, no faces in the centre";

const NEGATIVE =
  "text, letters, words, writing, caption, typography, logo, watermark, signature, " +
  "busy centre, cluttered composition, harsh contrast in the middle, " +
  "collage, split frame, borders, picture frame, ui, interface, low quality, blurry, jpeg artifacts";

function buildPrompt(subject) {
  return PROMPT_HEAD + String(subject).trim() + PROMPT_TAIL;
}

/* ---------------- cloudinary ----------------
   fal מחזיק את התמונה זמנית בלבד. הרקעים חייבים לשרוד לתמיד, כי הם נצרבים לתוך העמוד
   ונטענים אצל כל לקוח — לכן מעתיקים אותם לקלאודינרי ומחזירים את הכתובת הקבועה. */
async function toCloudinary(imageUrl) {
  const src = await fetch(imageUrl);
  if (!src.ok) throw new Error("could not fetch the generated image");
  const buf = Buffer.from(await src.arrayBuffer());

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), "background.png");
  form.append("upload_preset", CLOUD_PRESET);
  form.append("folder", "elronprint-greetings");
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: "POST", body: form,
  });
  const text = await r.text();
  if (!r.ok) {
    console.error("cloudinary failed:", r.status, text.slice(0, 300));
    throw new Error("Upload failed");
  }
  const d = JSON.parse(text);
  if (!d.secure_url) throw new Error("Upload failed");
  return { url: d.secure_url, bytes: d.bytes, width: d.width, height: d.height };
}

/* ---------------- handler ---------------- */
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
  const token = body.token || req.headers["x-epai-token"] || null;

  const student = await studentFromToken(token);
  if (!student) {
    return res.status(401).json({ error: "צריך להתחבר.", needLogin: true });
  }
  if (!isOwner(student.email)) {
    /* מכוון: הודעה סתומה. לקוח לא אמור לדעת שהמסלול הזה קיים בכלל. */
    console.warn(`[background] refused for ${student.email}`);
    return res.status(403).json({ error: "הפעולה אינה זמינה." });
  }

  const subject = String(body.subject || "").trim();
  if (subject.length < 3) {
    return res.status(400).json({ error: "צריך לתאר את הרקע במילים." });
  }
  if (subject.length > 400) {
    return res.status(400).json({ error: "התיאור ארוך מדי." });
  }

  /* 1-4 בבת אחת. flux מחזיר תוצאה שונה בכל הרצה, ורקע נבחר מתוך כמה אפשרויות ולא
     מתקבל בניסיון אחד — לייצר אחד בכל פעם היה מבזבז את רוב הזמן על המתנה. */
  const count = Math.min(4, Math.max(1, parseInt(body.count, 10) || 1));

  const started = Date.now();
  const prompt = buildPrompt(subject);
  console.log(`[background] "${subject}" x${count}`);

  const results = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    /* אחרי 45 שניות מפסיקים ומחזירים את מה שכבר מוכן, במקום ליפול על 60 שניות
       ולאבד גם את התמונות שכבר עלו בכסף. */
    if (i > 0 && Date.now() - started > 45000) {
      console.warn(`[background] out of time after ${results.length} image(s)`);
      break;
    }
    try {
      const falUrl = await fal(MODEL, {
        prompt,
        negative_prompt: NEGATIVE,
        image_size: { width: WIDTH, height: HEIGHT },
        num_images: 1,
        num_inference_steps: 34,
        guidance_scale: 3.5,
        enable_safety_checker: true,
      });
      const up = await toCloudinary(falUrl);
      console.log(`[background] ${i + 1}/${count} -> ${up.width}x${up.height} ${(up.bytes / 1024).toFixed(0)}KB`);
      results.push(up);
    } catch (e) {
      console.error(`[background] image ${i + 1} failed:`, e.message);
      errors.push(e.message);
    }
  }

  if (!results.length) {
    return res.status(502).json({
      error: "יצירת הרקע נכשלה. נסו שוב בעוד רגע.",
      detail: errors[0] || null,
    });
  }

  return res.status(200).json({
    backgrounds: results,
    asked: count,
    made: results.length,
    prompt,
    seconds: Math.round((Date.now() - started) / 1000),
  });
}
