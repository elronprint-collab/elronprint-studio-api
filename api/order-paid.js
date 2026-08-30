// api/order-paid.js
// ElronPrint — זיכוי אוטומטי של קרדיטים אחרי תשלום
//
// שופיפיי שולח לכאן הודעה בכל פעם שהזמנה משולמת (webhook: orders/paid).
// הקובץ בודק שההודעה באמת הגיעה משופיפיי, מוצא כמה קרדיטים נקנו לפי ה-SKU,
// ומוסיף אותם לחשבון של הלקוח לפי כתובת המייל שבהזמנה.
//
// משתני סביבה נדרשים ב-Vercel:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   ← כבר קיימים (auth.js משתמש בהם)
//   SHOPIFY_WEBHOOK_SECRET               ← חדש. מתקבל ממסך יצירת ה-webhook בשופיפיי.
//
// ⚠ חובה: bodyParser כבוי. חתימת שופיפיי מחושבת על הבייטים הגולמיים,
//   ואם Vercel יפרסר את ה-JSON לפני שנחשב את החתימה — היא לעולם לא תתאים.

export const config = { api: { bodyParser: false } };

import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HOOK_SECRET  = process.env.SHOPIFY_WEBHOOK_SECRET;

/* כמה קרדיטים כל מוצר נותן, לפי ה-SKU שהוגדר בשופיפיי.
   להוסיף חבילה חדשה = להוסיף שורה כאן, עם הסוג הנכון.

   הסוג הכרחי, לא נוח: קרדיטים של עיצוב ושל אווטאר יושבים בשתי עמודות נפרדות
   במסד ובשתי טבלאות זיכוי נפרדות, כי סרטון אווטאר עולה פי כמה מעיצוב.
   עד 2026-08-30 הקובץ הזה הכיר רק אווטאר, ולכן לקוח שקנה חבילת עיצובים
   שילם ולא קיבל דבר — הזיכוי חייב היה להיעשות ידנית. */
const SKU_CREDITS = {
  "AVATAR-10": { kind: "avatar", credits: 10 },
  "AVATAR-25": { kind: "avatar", credits: 25 },
  "DESIGN-20": { kind: "design", credits: 20 },
  "DESIGN-50": { kind: "design", credits: 50 }
};

/* לאן כל סוג נכתב. שינוי כאן בלי שינוי במסד ישבור זיכויים. */
const KINDS = {
  avatar: { column: "avatar_credits", table: "avatar_grants", label: "avatar" },
  design: { column: "design_credits", table: "design_grants", label: "design" }
};

/* ---------- Supabase ---------- */

function sbHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json"
  }, extra || {});
}

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: sbHeaders() });
  const t = await r.text();
  if (!r.ok) throw new Error("Supabase GET " + path + " -> " + r.status + " " + t);
  return t ? JSON.parse(t) : [];
}

async function sbPost(path, body, prefer) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "POST",
    headers: sbHeaders({ Prefer: prefer || "return=representation" }),
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Supabase POST " + path + " -> " + r.status + " " + t);
  return t ? JSON.parse(t) : [];
}

async function sbPatch(path, body) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("Supabase PATCH " + path + " -> " + r.status + " " + (await r.text()));
}

const enc = encodeURIComponent;

/* ---------- קריאת הגוף הגולמי ---------- */

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* השוואת חתימות בזמן קבוע — מונעת דליפת מידע דרך מדידת זמן.
   timingSafeEqual זורק אם האורכים שונים, ולכן הבדיקה הראשונה חובה. */
function validSignature(raw, header) {
  if (!HOOK_SECRET || !header) return false;
  const mine = crypto.createHmac("sha256", HOOK_SECRET).update(raw).digest("base64");
  const a = Buffer.from(mine, "utf8");
  const b = Buffer.from(String(header), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------- כמה קרדיטים בהזמנה ---------- */

/* מחזיר סכום לכל סוג בנפרד. הזמנה אחת יכולה להכיל גם וגם. */
function creditsInOrder(order) {
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const totals = { avatar: 0, design: 0 };
  for (const it of items) {
    const hit = SKU_CREDITS[String(it.sku || "").trim().toUpperCase()];
    if (hit) totals[hit.kind] += hit.credits * (parseInt(it.quantity, 10) || 1);
  }
  return totals;
}

function orderEmail(order) {
  const e = order.email ||
            (order.customer && order.customer.email) ||
            (order.contact_email) || "";
  return String(e).trim().toLowerCase();
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST בלבד" });
  }

  let raw;
  try {
    raw = await rawBody(req);
  } catch (e) {
    console.error("[order-paid] could not read body:", e);
    return res.status(400).send("bad body");
  }

  if (!validSignature(raw, req.headers["x-shopify-hmac-sha256"])) {
    // לא מפרטים למה — מי שמזייף לא צריך רמזים
    console.warn("[order-paid] rejected: bad or missing signature");
    return res.status(401).send("unauthorized");
  }

  let order;
  try {
    order = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return res.status(400).send("bad json");
  }

  const totals = creditsInOrder(order);
  const email = orderEmail(order);
  const kinds = Object.keys(totals).filter(function (k) { return totals[k] > 0; });

  // הזמנה של חולצות בלבד — לא נוגעים בה, ומחזירים 200 כדי ששופיפיי לא ינסה שוב
  if (!kinds.length) {
    console.log("[order-paid] order", order.id, "has no credit items — ignored");
    return res.status(200).send("no credit items");
  }

  if (!email || email.indexOf("@") < 0) {
    // 200 בכוונה: ניסיון חוזר לא יעזור, אין מייל בהזמנה. נרשם ללוג לטיפול ידני.
    console.error("[order-paid] order", order.id, "has no email — MANUAL GRANT NEEDED,",
                  JSON.stringify(totals));
    return res.status(200).send("no email");
  }

  const reference = "order:" + order.id;

  try {
    /* הלקוח נטען פעם אחת, עם שתי העמודות, כדי לא לפנות למסד לכל סוג בנפרד. */
    let found = await sbGet(
      "students?email=eq." + enc(email) + "&select=id,avatar_credits,design_credits&limit=1"
    );
    let student = found[0];
    if (!student) {
      const created = await sbPost("students", { email: email });
      student = created[0];
    }
    if (!student) throw new Error("could not find or create student for " + email);

    const done = [];
    for (const kind of kinds) {
      const spec = KINDS[kind];
      const amount = totals[kind];

      /* בדיקת כפילות לכל סוג בנפרד, בטבלה שלו. שופיפיי שולח את אותו webhook שוב
         בכל תשובה שאינה 200 — ואם בניסיון קודם רק אחד מהסוגים הצליח, הבדיקה הזו
         מדלגת עליו ומשלימה רק את מה שחסר, במקום לזכות פעמיים או לוותר על השני. */
      const seen = await sbGet(
        spec.table + "?reference=eq." + enc(reference) + "&select=id&limit=1"
      );
      if (seen.length) {
        console.log("[order-paid] order", order.id, spec.label, "already granted — skipped");
        continue;
      }

      const next = (student[spec.column] || 0) + amount;
      const patch = {};
      patch[spec.column] = next;
      await sbPatch("students?id=eq." + enc(student.id), patch);
      await sbPost(
        spec.table,
        { student_id: student.id, credits: amount, reference: reference },
        "return=minimal"
      );
      student[spec.column] = next;
      done.push(amount + " " + spec.label + " -> " + next);
    }

    if (!done.length) {
      console.log("[order-paid] order", order.id, "was already fully granted");
      return res.status(200).send("already granted");
    }

    console.log("[order-paid] granted", done.join(", "), "to", email, "(order", order.id + ")");
    return res.status(200).send("ok");

  } catch (e) {
    // 500 בכוונה: שופיפיי ינסה שוב, וההגנה על כפילות למעלה תמנע זיכוי כפול.
    console.error("[order-paid] FAILED for order", order.id, email, credits, e);
    return res.status(500).send("retry");
  }
}
