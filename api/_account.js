// api/_account.js — שער חשבון משותף לכלים שעברו לחיוב
//
// נוסף 2026-08-30, כשהוחלט שכל הכלים יחייבו קרדיטים ולא רק שלושת המשלמים.
//
// למה קובץ משותף ולא העתקה לכל כלי: יש שישה כלים להסב, ולוגיקת יתרה שמועתקת
// שש פעמים תתפצל. כאן היא נכתבת פעם אחת. הקובץ מתחיל בקו תחתון, ולכן ורסל
// לא סופרת אותו כפונקציה — חשוב, כי api/ כבר על התקרה של 12 בתוכנית Hobby.
//
// למה לא ייבוא מ-auth.js: auth.js הוא הפונקציה שמנהלת התחברות לכל החנות.
// ייבוא ממנה היה קושר כל כלי לקובץ הזה, וכשל בו היה מפיל הכל.
//
// הכללים זהים לאלה שב-extract.js: ריצה חינם אחת לחשבון המשותפת לכל הכלים,
// בעלים ללא הגבלה, וחיוב רק אחרי שהתוצאה קיימת — כישלון לא עולה כסף ללקוח.

import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET   = process.env.APP_SECRET;

/* חייב להישאר זהה ל-FREE_RUNS ב-extract.js, ב-separate.js וב-auth.js.
   שינוי כאן בלבד ייצור חוסר עקביות שלקוח יראה כתקלה. */
export const FREE_RUNS = 1;

const enc = encodeURIComponent;

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
  };
}

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: sbHeaders() });
  if (!r.ok) throw new Error("Supabase GET " + path + " -> " + r.status);
  return JSON.parse((await r.text()) || "[]");
}

async function sbPost(path, body, prefer) {
  const h = sbHeaders();
  if (prefer) h.Prefer = prefer;
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "POST", headers: h, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Supabase POST " + path + " -> " + r.status + " " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sbPatch(path, body) {
  const h = sbHeaders();
  h.Prefer = "return=minimal";
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "PATCH", headers: h, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Supabase PATCH " + path + " -> " + r.status);
}

function hash(s) {
  return crypto.createHmac("sha256", APP_SECRET || "fallback").update(String(s)).digest("hex");
}

export function isOwner(email) {
  const list = String(process.env.OWNER_EMAILS || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return !!email && list.indexOf(String(email).trim().toLowerCase()) !== -1;
}

export async function studentFromToken(token) {
  if (!token || String(token).length < 32) return null;
  const rows = await sbGet(
    "sessions?token_hash=eq." + enc(hash(token)) +
    "&select=id,student_id,expires_at,students(id,email,design_credits)&limit=1"
  );
  const s = rows[0];
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  const st = s.students || {};
  return { id: s.student_id, email: st.email || "", credits: st.design_credits || 0 };
}

export async function quotaFor(student) {
  const runs = await sbGet(
    "design_runs?student_id=eq." + enc(student.id) + "&charged=is.false&select=id"
  );
  const freeLeft = Math.max(0, FREE_RUNS - runs.length);
  return { freeLeft, credits: student.credits, canRun: freeLeft > 0 || student.credits > 0 };
}

/* נקרא רק אחרי שהתוצאה קיימת. כישלון של הכלי לא גובה קרדיט — זה ההסכם
   בכל הכלים המשלמים, ולקוח שמחויב על תוצאה שלא קיבל מגיע לוואטסאפ. */
export async function chargeRun(student, quota) {
  if (quota.freeLeft > 0) {
    await sbPost("design_runs", { student_id: student.id, charged: false }, "return=minimal");
    return { freeLeft: quota.freeLeft - 1, credits: quota.credits };
  }
  await sbPost("design_runs", { student_id: student.id, charged: true }, "return=minimal");
  await sbPatch("students?id=eq." + enc(student.id), {
    design_credits: Math.max(0, quota.credits - 1),
  });
  return { freeLeft: 0, credits: Math.max(0, quota.credits - 1) };
}

/* עוטף את שלושת השלבים. מחזיר { deny } לעצירה, או { student, quota, owner } להמשך.
   הטוקן נלקח גם מהגוף וגם מכותרת, כדי שכלי שכבר שולח אחד מהם לא יצטרך שינוי. */
export async function gate(req, body) {
  const token = (body && body.token) || req.headers["x-epai-token"] || null;
  const student = await studentFromToken(token);
  if (!student) {
    return { deny: { status: 401, body: { error: "צריך להתחבר כדי להשתמש בכלי.", needLogin: true } } };
  }
  const owner = isOwner(student.email);
  if (owner) return { student, owner: true, quota: { freeLeft: 0, credits: 0, canRun: true } };

  const quota = await quotaFor(student);
  if (!quota.canRun) {
    return {
      deny: {
        status: 402,
        body: {
          error: "נגמרו השימושים החינמיים. אפשר לרכוש חבילת קרדיטים ולהמשיך.",
          needCredits: true, freeLeft: 0, credits: 0,
        },
      },
    };
  }
  return { student, owner: false, quota };
}

/* חיוב אחרי הצלחה. לעולם לא מפיל את הבקשה: הלקוח כבר קיבל את התוצאה,
   וכשל ברישום החיוב הוא בעיה שלנו ללוג, לא שגיאה שהוא צריך לראות. */
export async function settle(student, quota, owner) {
  if (owner) {
    await sbPost("design_runs", { student_id: student.id, charged: false }, "return=minimal")
      .catch((e) => console.error("[account] owner run log failed:", e.message));
    return { freeLeft: null, credits: null, owner: true };
  }
  try {
    return await chargeRun(student, quota);
  } catch (e) {
    console.error("[account] charge failed AFTER delivering the result:", e.message);
    return { freeLeft: quota.freeLeft, credits: quota.credits };
  }
}
