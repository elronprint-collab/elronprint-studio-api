import { checkRateLimit } from "./_ratelimit.js";
import { gate, settle, studentFromToken, isOwner } from "./_account.js";
// api/eraser.js v6 — מחק קסם + יצירת רקעים למחולל הברכות
//
// v6 (2026-09-03): action:"background" נוסף לקובץ הזה.
// למה כאן ולא בקובץ נפרד: Vercel Hobby מגביל ל-12 פונקציות והיינו על 13, אז
// background.js לא נפרס בכלל. התקרה היא על מספר קבצים, לא על מספר פעולות, ולכן
// שתי משימות בקובץ אחד נספרות כאחת. אותו דפוס שכבר עובד ב-reimagine.js
// (analyze + generate באותו קובץ). האלטרנטיבה הייתה למחוק פונקציה עובדת.
//
// eraser.js נבחר כי הוא הקטן בשרת וכבר החזיק את שלושת הרכיבים שיצירת רקע צריכה:
// קריאה ל-fal, בדיקת חשבון, ותשובת JSON. reimagine.js נפסל בכוונה — 1,500 שורות
// שמריצות את עיצוב מחדש, ואין סיבה לגעת בהן בשביל דבר לא קשור.
//
// ⚠ בקשה שמגיעה BLI action מטופלת בדיוק כמו קודם, אות באות. זה מה שמבטיח
//   שמחק קסם ממשיך לעבוד בלי לגעת בעמוד שלו.
//
// v5 (2026-09-02): fal-ai/inpaint הוסר מהתור.
// הוא מודל גנרטיבי שנקרא בלי prompt, כלומר הוא ממציא תוכן חדש במקום למלא
// מהסביבה. בכלי שמבטיח "מחיקה" זו תוצאה שגויה, ולקוח שילם עליה קרדיט.
// נשארו שני מחקים אמיתיים בלבד. אם שניהם נכשלים מוחזרת שגיאה ולא נגבה קרדיט.
//
// v4 (2026-09-02): תיקון 422 של fal-ai/lama.
// כל קריאה ל-lama נכשלה עם 422 {"loc":["body","mask_image_url"],"msg":"Field required"} —
// שלחנו mask_url, ו-lama מצפה ל-mask_image_url. התוצאה: המחק השמרני שממלא
// מהסביבה מעולם לא רץ, ותמיד נפלנו ל-bria/eraser שממלא בצורה יצירתית יותר.
// עכשיו שם שדה המסכה נקבע לכל מודל בנפרד. שום דבר אחר לא שונה.
//
// v3 (2026-08-30): הכלי עבר לחיוב קרדיטים.
// עד כה הוא היה פתוח לגמרי — כל קריאה הפעילה מודל בתשלום בפאל על חשבון החנות,
// בלי התחברות ובלי תקרה מלבד הגבלת הקצב לפי IP. עכשיו: התחברות, יתרה, וחיוב
// אחרי הצלחה בלבד. כישלון של כל שלושת המודלים לא גובה קרדיט.

export const config = { maxDuration: 60 };

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

/* שם שדה המסכה שונה בין המודלים. lama דורש mask_image_url; bria ו-inpaint
   מקבלים mask_url. שליחת השם הלא נכון מוחזרת כ-422 עוד לפני שהמודל רץ. */
const MODELS = [
  { id: "fal-ai/lama",         maskField: "mask_image_url" },
  { id: "fal-ai/bria/eraser",  maskField: "mask_url" },
];

/* ================= יצירת רקעים למחולל הברכות =================
   action:"background". נפרד לגמרי ממחק קסם: אין מסכה, אין הסרת רקע, ואין קרדיטים.

   שלוש החלטות שכדאי לזכור:

   1. בעלים בלבד. אין כאן מסלול לקוח — זה כלי פנימי לייצור מלאי הרקעים. לקוח בוחר
      מתוך מה שכבר קיים, הוא לא מייצר. לכן לא gate() אלא בדיקת בעלות ישירה:
      מי שאינו ב-OWNER_EMAILS מקבל 403 לפני שנשלחת קריאה בתשלום.

   2. תמונה מלאה, לא שקופה. כל שאר הכלים בשרת מסירים רקע — כאן הרקע הוא כל העניין.

   3. fal ולא higgsfield: חשבון higgsfield בתוכנית חינם עם 0 קרדיטים (נבדק 2026-09-03),
      בעוד FAL_KEY כבר מחויב ופעיל ומריץ את עיצוב מחדש.

   הפרומפט בנוי סביב כלל אחד: המרכז נשאר פנוי. רקע עמוס באמצע הופך ברכה לבלתי
   קריאה, וזו הסיבה שרקע "יפה" יכול להיראות גרוע בכלי. */

const BG_MODEL = "fal-ai/flux/dev";
const BG_W = 1080;                 /* היחס שהכלי מצייר עליו היום */
const BG_H = 1350;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const BG_HEAD =
  "a decorative background image for a greeting card, portrait orientation, " +
  "elegant and festive, rich colour, soft depth of field, professional photography quality, ";
const BG_TAIL =
  ", the centre of the frame is calm and uncluttered so text can be placed over it, " +
  "detail and ornament kept to the edges and corners, gentle vignette, " +
  "no text, no letters, no words, no writing, no captions, no logos, no watermarks, " +
  "no people looking at the camera, no faces in the centre";
const BG_NEGATIVE =
  "text, letters, words, writing, caption, typography, logo, watermark, signature, " +
  "busy centre, cluttered composition, harsh contrast in the middle, " +
  "collage, split frame, borders, picture frame, ui, interface, low quality, blurry, jpeg artifacts";

/* fal מחזיק את התמונה זמנית. רקע חייב לשרוד לתמיד — הוא נטען אצל כל לקוח —
   ולכן מעתיקים לקלאודינרי ומחזירים את הכתובת הקבועה. */
async function bgToCloudinary(imageUrl) {
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
    console.error("[background] cloudinary failed:", r.status, text.slice(0, 300));
    throw new Error("Upload failed");
  }
  const d = JSON.parse(text);
  if (!d.secure_url) throw new Error("Upload failed");
  return { url: d.secure_url, bytes: d.bytes, width: d.width, height: d.height };
}

async function handleBackground(req, res, body) {
  const token = body.token || req.headers["x-epai-token"] || null;

  let student;
  try {
    student = await studentFromToken(token);
  } catch (e) {
    console.error("[background] account check failed:", e.message);
    return res.status(503).json({ error: "לא הצלחנו לאמת את החשבון. נסו שוב." });
  }
  if (!student) return res.status(401).json({ error: "צריך להתחבר.", needLogin: true });
  if (!isOwner(student.email)) {
    /* מכוון: הודעה סתומה. לקוח לא אמור לדעת שהמסלול הזה קיים. */
    console.warn(`[background] refused for ${student.email}`);
    return res.status(403).json({ error: "הפעולה אינה זמינה." });
  }

  const subject = String(body.subject || "").trim();
  if (subject.length < 3) return res.status(400).json({ error: "צריך לתאר את הרקע במילים." });
  if (subject.length > 400) return res.status(400).json({ error: "התיאור ארוך מדי." });

  /* 1-4 בבת אחת: רקע נבחר מתוך כמה אפשרויות ולא מתקבל בניסיון אחד. */
  const count = Math.min(4, Math.max(1, parseInt(body.count, 10) || 1));
  const prompt = BG_HEAD + subject + BG_TAIL;
  const started = Date.now();
  console.log(`[background] "${subject}" x${count}`);

  const results = [];
  const errors = [];
  for (let i = 0; i < count; i++) {
    /* אחרי 45 שניות עוצרים ומחזירים את מה שמוכן, במקום ליפול על תקרת ה-60
       ולאבד גם את התמונות שכבר עלו בכסף. */
    if (i > 0 && Date.now() - started > 45000) {
      console.warn(`[background] out of time after ${results.length} image(s)`);
      break;
    }
    try {
      const r = await fetch(`https://fal.run/${BG_MODEL}`, {
        method: "POST",
        headers: { "Authorization": `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          negative_prompt: BG_NEGATIVE,
          image_size: { width: BG_W, height: BG_H },
          num_images: 1,
          num_inference_steps: 34,
          guidance_scale: 3.5,
          enable_safety_checker: true,
        }),
      });
      if (!r.ok) throw new Error(`fal ${r.status} ${(await r.text()).slice(0, 200)}`);
      const d = await r.json();
      const falUrl = d?.images?.[0]?.url || d?.image?.url || d?.url;
      if (!falUrl) throw new Error("fal returned no image");
      const up = await bgToCloudinary(falUrl);
      console.log(`[background] ${i + 1}/${count} -> ${up.width}x${up.height} ${(up.bytes / 1024).toFixed(0)}KB`);
      results.push(up);
    } catch (e) {
      console.error(`[background] image ${i + 1} failed:`, e.message);
      errors.push(e.message);
    }
  }

  if (!results.length) {
    return res.status(502).json({ error: "יצירת הרקע נכשלה. נסו שוב בעוד רגע.", detail: errors[0] || null });
  }
  return res.status(200).json({
    backgrounds: results,
    asked: count, made: results.length, prompt,
    seconds: Math.round((Date.now() - started) / 1000),
  });
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

  /* פיצול המסלולים. בלי action — התנהגות מחק קסם כפי שהייתה, בדיוק. */
  if (body.action === "background") return handleBackground(req, res, body);

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
  for (const m of MODELS) {
    const model = m.id;
    try {
      const r = await fetch(`https://fal.run/${model}`, {
        method: "POST",
        headers: {
          "Authorization": `Key ${process.env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image_url: imageUrl, [m.maskField]: maskUrl }),
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
