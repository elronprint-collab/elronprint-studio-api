import { gate, settle } from "./_account.js";
import { gunzipSync } from "zlib";
import { checkRateLimit } from "./_ratelimit.js";
// api/documents.js — "מסמכים וקבלות" v1
//
// יומן מסמכים פיננסי: הלקוח מצלם/מעלה מסמך, המערכת מחלצת ממנו כל מה שהיא יכולה,
// שומרת, ומציגה גרף הכנסות מול הוצאות. כל מסמך עם כסף נכנס או יוצא — חשבונית מס,
// קבלה מהסופר, חשבון חשמל, ארנונה, כביש 6.
//
// שלוש החלטות מבניות, כולן נובעות מבדיקת 5 קבלות אמיתיות שלו (31/08):
//
// 1. שני שלבים, לא אחד. screen הוא בדיקה זולה (max_tokens נמוך) שעונה רק אם
//    המסמך קריא. רק אם עבר — extract מלא. מתוך 5 קבלות אמיתיות, 2 היו חתוכות
//    ואחת דהויה; בלי הסינון היינו משלמים חילוץ מלא על כולן.
//
// 2. הכיוון (הכנסה/הוצאה) לא נקבע על ידי המודל. הוא מחזיר הצעה, הלקוח מאשר.
//    טעות שם הופכת הוצאה של 5,000 להכנסה של 5,000 ומשבשת את כל הגרף.
//
// 3. שדה שלא נקרא חוזר null — לעולם לא ניחוש. רק amount חוסם שמירה, וגם אותו
//    אפשר להקליד ידנית. קבלה תקינה עם כותרת דהויה לא נזרקת.
//
// ⚠️ אזהרה כנה: לא הצלחתי להריץ מול fal מסביבת הפיתוח (הדומיין חסום שם).
// הקוד הזה מאומת לוגית, לא אמפירית. לכן debug:true מחזיר את הפלט הגולמי של
// המודל — ההרצה האמיתית הראשונה תהיה אצלו, ונראה בדיוק מה חזר במקום לנחש.
//
// שכבת ה-LLM מועתקת מ-reimagine.js v77 מילה במילה (askFal/readFalText/
// looksLikeUnknownModel/רשימת המועמדים). לא ייבוא — reimagine.js הוא 306KB
// ותקלה שם לא צריכה להפיל את זה. אותו כלל שהוא קבע ל-separate.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;

const ALLOWED = [
  "https://elronprint.co.il",
  "https://www.elronprint.co.il",
];

function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED.includes(origin)) return origin;
  try {
    const h = new URL(origin).hostname;
    if (h.endsWith(".myshopify.com")) return origin;
  } catch (_) {}
  return null;
}

function cors(res, origin) {
  const ok = allowOrigin(origin);
  if (ok) res.setHeader("Access-Control-Allow-Origin", ok);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-epai-token");
}

/* ---------------- Supabase ---------------- */

const enc = encodeURIComponent;

function sbHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: sbHeaders() });
  if (!r.ok) throw new Error("Supabase GET " + path + " -> " + r.status);
  return JSON.parse((await r.text()) || "[]");
}

async function sbPost(path, body, prefer) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "POST",
    headers: sbHeaders(prefer ? { Prefer: prefer } : null),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Supabase POST " + path + " -> " + r.status + " " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sbPatch(path, body) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Supabase PATCH " + path + " -> " + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sbDelete(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "DELETE", headers: sbHeaders(),
  });
  if (!r.ok) throw new Error("Supabase DELETE " + path + " -> " + r.status);
}

/* ---------------- שכבת ה-LLM (מועתקת מ-reimagine.js v77) ---------------- */

const FAL_MODEL_PIN = process.env.FAL_LLM_MODEL || "";
let _falVisionModel = null;

const FAL_VISION_CANDIDATES = [
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-pro-1.5",
  "google/gemini-flash-1.5",
  "anthropic/claude-haiku-4.5",
];

function looksLikeUnknownModel(status, body) {
  const b = body || "";
  if (status === 404 || /no endpoints found|model not found|unknown model/i.test(b)) return true;
  if (status === 422 && /literal_error/i.test(b) && /"model"/.test(b)) return true;
  return false;
}

function readFalText(d) {
  const cand = d?.output ?? d?.text ?? d?.response ?? d?.content ?? d?.message ?? d?.completion;
  if (typeof cand === "string" && cand.trim()) return cand.trim();
  if (Array.isArray(cand)) {
    const joined = cand
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .filter(Boolean).join(" ").trim();
    if (joined) return joined;
  }
  const choice = d?.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice.trim();
  console.error(
    "[documents] fal LLM: could not find the text in the response. Top-level keys were:",
    JSON.stringify(Object.keys(d || {}))
  );
  return null;
}

async function askVision({ system, ask, image, mediaType, maxTokens }) {
  const endpoint = "fal-ai/any-llm/vision";
  const list = FAL_MODEL_PIN ? [FAL_MODEL_PIN]
    : _falVisionModel ? [_falVisionModel]
    : FAL_VISION_CANDIDATES;

  let lastBody = "";
  for (const model of list) {
    const input = {
      model,
      prompt: ask,
      system_prompt: system,
      max_tokens: maxTokens || 700,
      image_url: `data:${mediaType};base64,${image}`,
    };

    let r;
    try {
      r = await fetch(`https://fal.run/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${process.env.FAL_KEY}`,
          "Content-Type": "application/json",
          /* 2026-09-01: fal שומר את גוף הבקשה 30 יום כברירת מחדל, והוא נצפה
             בדשבורד שלהם. כאן הגוף מכיל את צילום הקבלה של הלקוח — מסמך פיננסי
             של אדם אחר. הכותרת הזו מבטלת את השמירה. */
          "X-Fal-Store-IO": "0",
        },
        body: JSON.stringify(input),
      });
    } catch (e) {
      console.error("[documents] fal fetch threw:", e.message);
      return null;
    }

    if (r.ok) {
      const text = readFalText(await r.json());
      if (text) {
        if (!_falVisionModel && !FAL_MODEL_PIN) {
          _falVisionModel = model;
          console.log(`[documents] fal vision: using "${model}" (pin it in FAL_LLM_MODEL to skip the search)`);
        }
        return text;
      }
      lastBody = "answered but no readable text";
      continue;
    }

    lastBody = (await r.text()).slice(0, 400);
    if (!looksLikeUnknownModel(r.status, lastBody)) {
      console.error(`[documents] fal vision failed on "${model}":`, r.status, lastBody);
      return null;
    }
    console.warn(`[documents] fal vision: "${model}" is not available here, trying the next one`);
  }

  console.error("[documents] fal vision: no candidate model worked. Last response:", lastBody);
  return null;
}

/* ---------------- JSON שחוזר ממודל ---------------- */

/* מודלים עוטפים JSON ב-```json למרות שביקשנו שלא. לא נלחמים בזה, מקלפים. */
function parseModelJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

/* ---------------- שלב 1: סינון זול ---------------- */

const SCREEN_SYSTEM = `You inspect a photograph of a financial document (a receipt, tax invoice,
utility bill, municipal tax notice, toll road charge, or similar). You are NOT extracting data yet.
You only judge whether the photo is usable.

Answer with a JSON object and nothing else. No markdown, no prose, no code fences.

{
  "is_document": true | false,
  "total_visible": true | false,
  "cropped": true | false,
  "readable": "good" | "poor" | "unusable",
  "reason_he": "<one short sentence in HEBREW naming what is missing, or empty if fine>"
}

Rules:
- "is_document" is false for a photo that is not a financial document at all.
- "total_visible" is true ONLY if you can actually see a final total amount line.
- "cropped" is true if the top (merchant header) or the bottom (totals) is cut off,
  or the photo shows only the middle of a long receipt.
- "readable" is "unusable" when the text cannot be made out at all.
- "reason_he" must be in Hebrew and must name the concrete missing thing,
  for example "לא רואים את שורת הסה\\"כ" or "הכותרת של העסק חתוכה".
  Never write a generic sentence like "התמונה לא ברורה".`;

/* ---------------- שלב 2: חילוץ מלא ---------------- */

const EXTRACT_SYSTEM = `You read a photograph of an Israeli financial document and extract its data.
The document may be a tax invoice (חשבונית מס), a receipt (קבלה), a supplier invoice,
a utility bill (חשמל, מים, גז), a municipal tax notice (ארנונה), a toll road charge (כביש 6),
or any other document recording money paid or received.

Answer with a JSON object and nothing else. No markdown, no prose, no code fences.

{
  "supplier_name": string | null,
  "supplier_taxid": string | null,
  "doc_kind": "tax_invoice" | "receipt" | "invoice" | "bill" | "unknown",
  "doc_number": string | null,
  "doc_date": "YYYY-MM-DD" | null,
  "amount_total": number | null,
  "amount_before_vat": number | null,
  "vat_amount": number | null,
  "vat_rate": number | null,
  "allocation_number": string | null,
  "payment_method": string | null,
  "period_start": "YYYY-MM-DD" | null,
  "period_end": "YYYY-MM-DD" | null,
  "currency": string,
  "direction_guess": "income" | "expense",
  "raw_text": string
}

THE MOST IMPORTANT RULE: any field you cannot actually read gets null.
Never infer, never estimate, never complete a number from a partial one. A null field
is handled gracefully by the system; an invented number silently corrupts the customer's books.

Field rules:
- "doc_kind" is "tax_invoice" ONLY if the document carries the words חשבונית מס AND
  shows VAT separately. A supermarket receipt with no separated VAT is "receipt".
  A utility or municipal bill is "bill". If you cannot tell, use "unknown".
- "vat_rate" is the percentage PRINTED ON THE DOCUMENT, as a number (17, 18).
  Israeli VAT has changed over the years, so never assume the current rate —
  an older document legitimately shows a different one. If no rate is printed, null.
- "doc_date" is the date of the transaction, not a printing or due date, when both appear.
- "amount_total" is the final amount actually payable, after discounts.
- "period_start"/"period_end" apply to bills that cover a billing period
  (electricity, water, arnona are commonly issued for two months). Otherwise null.
- "allocation_number" is a מספר הקצאה from the חשבוניות ישראל system, if printed.
- "currency" defaults to "ILS" unless the document clearly states another currency.
- "direction_guess" is a SUGGESTION ONLY — the customer confirms it. Almost every
  document a business photographs is money going out, so default to "expense" and use
  "income" only when the document clearly records money received BY the document's holder.
- "raw_text" is every line of text you can read from the document, joined by newlines.
  This feeds the search index, so include merchant name, item lines and any reference
  numbers. If part is unreadable, include what you can and skip the rest.

Numbers must be plain JSON numbers: 1869.00, not "1,869.00 ₪".`;

/* ---------------- ניקוי מה שחזר מהמודל ---------------- */

const KINDS = ["tax_invoice", "receipt", "invoice", "bill", "unknown"];

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^\d.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00Z");
    return Number.isNaN(d.getTime()) ? null : s;
  }
  /* המודל התבקש ל-ISO. אם הוא בכל זאת החזיר dd/mm/yyyy — זה הפורמט הישראלי,
     ולכן היום ראשון והחודש שני. פירוש הפוך היה יוצר תאריכים שגויים בשקט. */
  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      return `${m[3]}-${mm}-${dd}`;
    }
  }
  return null;
}

function str(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max || 200);
}

function normalise(raw) {
  const r = raw || {};
  const kind = KINDS.includes(r.doc_kind) ? r.doc_kind : "unknown";
  return {
    supplier_name:     str(r.supplier_name, 200),
    supplier_taxid:    str(r.supplier_taxid, 40),
    doc_kind:          kind,
    doc_number:        str(r.doc_number, 60),
    doc_date:          isoDate(r.doc_date),
    amount_total:      num(r.amount_total),
    amount_before_vat: num(r.amount_before_vat),
    vat_amount:        num(r.vat_amount),
    vat_rate:          num(r.vat_rate),
    allocation_number: str(r.allocation_number, 40),
    payment_method:    str(r.payment_method, 60),
    period_start:      isoDate(r.period_start),
    period_end:        isoDate(r.period_end),
    currency:          str(r.currency, 8) || "ILS",
    direction_guess:   r.direction_guess === "income" ? "income" : "expense",
    raw_text:          str(r.raw_text, 20000),
  };
}

/* ---------------- מה חסר, בעברית ---------------- */

function missingFields(d) {
  const out = [];
  if (d.amount_total === null) out.push({ field: "amount_total", he: "לא זוהה סכום לתשלום" });
  if (!d.doc_date)             out.push({ field: "doc_date",     he: "לא זוהה תאריך" });
  if (!d.supplier_name)        out.push({ field: "supplier_name", he: "לא זוהה שם הספק" });
  if (!d.payment_method)       out.push({ field: "payment_method", he: "לא זוהה אמצעי תשלום" });
  if (d.doc_kind === "tax_invoice") {
    if (!d.supplier_taxid)   out.push({ field: "supplier_taxid", he: "חשבונית מס ללא מספר עוסק/ח.פ" });
    if (d.vat_amount === null) out.push({ field: "vat_amount",  he: "חשבונית מס ללא מע\"מ מופרד" });
  }
  return out;
}

/* מספר הקצאה — התראה בלבד, לעולם לא חסימה.
   הסף הוא 5,000 ש"ח מ-1.6.2026. הוא נקבע ברפורמת חשבוניות ישראל ויורד עם השנים,
   ולכן הוא ENV ולא קבוע: כשהסף ישתנה, משנים משתנה בוורסל בלי לגעת בקוד. */
const ALLOCATION_THRESHOLD = Number(process.env.ALLOCATION_THRESHOLD || 5000);

function allocationWarning(d) {
  if (d.doc_kind !== "tax_invoice") return null;
  if (d.amount_total === null || d.amount_total < ALLOCATION_THRESHOLD) return null;
  if (d.allocation_number) return null;
  return `חשבונית מס מעל ${ALLOCATION_THRESHOLD.toLocaleString("he-IL")} ₪ ללא מספר הקצאה. כדאי לבדוק מול הספק.`;
}

/* ---------------- כפילויות ---------------- */

async function findDuplicate(studentId, d) {
  if (!d.supplier_name || !d.doc_date || d.amount_total === null) return null;
  const rows = await sbGet(
    "documents?student_id=eq." + enc(studentId) +
    "&supplier_name=eq." + enc(d.supplier_name) +
    "&doc_date=eq." + enc(d.doc_date) +
    "&amount_total=eq." + enc(d.amount_total) +
    "&select=id,supplier_name,doc_date,amount_total&limit=1"
  );
  return rows[0] || null;
}

/* ---------------- פעולות ---------------- */

/* screen — בדיקה זולה לפני שמשלמים על חילוץ מלא. לא נכנס למכסה. */
async function doScreen(body) {
  const { image, mediaType } = body;
  if (!image) return { status: 400, body: { error: "לא התקבלה תמונה." } };

  const text = await askVision({
    system: SCREEN_SYSTEM,
    ask: "Inspect this photo and answer with the JSON object only.",
    image, mediaType: mediaType || "image/jpeg",
    maxTokens: 200,
  });

  const j = parseModelJson(text);
  /* אם הסינון עצמו נכשל — לא חוסמים. עדיף לשלם על חילוץ מיותר מאשר לדחות
     מסמך תקין בגלל תקלה שלנו. */
  if (!j) {
    console.error("[documents] screen unreadable, letting it through. Raw:", String(text).slice(0, 300));
    return { status: 200, body: { ok: true, screened: false } };
  }

  const usable = j.is_document !== false && j.readable !== "unusable" && j.total_visible !== false;
  if (!usable) {
    const reason = str(j.reason_he, 200) ||
      (j.is_document === false ? "זה לא נראה כמו מסמך פיננסי." : "לא ניתן לקרוא את המסמך.");
    return {
      status: 200,
      body: {
        ok: false, screened: true,
        cropped: j.cropped === true,
        reason,
        hint: "אפשר לצלם שוב, או להמשיך ולהקליד את הפרטים ידנית.",
      },
    };
  }

  return {
    status: 200,
    body: { ok: true, screened: true, cropped: j.cropped === true, readable: j.readable || "good" },
  };
}

/* extract — החילוץ המלא. זה מה שנכנס למכסה, ורק אחרי הצלחה. */
async function doExtract(req, body) {
  const { image, mediaType } = body;
  if (!image) return { status: 400, body: { error: "לא התקבלה תמונה." } };

  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  const text = await askVision({
    system: EXTRACT_SYSTEM,
    ask: "Read this document and answer with the JSON object only.",
    image, mediaType: mediaType || "image/jpeg",
    maxTokens: 1600,
  });

  if (!text) {
    return { status: 502, body: { error: "קריאת המסמך נכשלה. נסו שוב בעוד רגע." } };
  }

  const parsed = parseModelJson(text);
  if (!parsed) {
    console.error("[documents] extract returned unparseable text:", String(text).slice(0, 500));
    return {
      status: 502,
      body: { error: "לא הצלחנו לקרוא את המסמך.", debugRaw: String(text).slice(0, 500) },
    };
  }

  const data = normalise(parsed);
  const balance = await settle(g.student, g.quota, g.owner);
  const dup = await findDuplicate(g.student.id, data).catch(() => null);

  /* אם המסמך נושא את מספר העוסק של הלקוח עצמו — הוא זה שהוציא אותו, כלומר
     הכנסה. זה הופך את הניחוש לוודאות. הלקוח עדיין יכול לשנות. */
  let certain = false;
  const mine = await myTaxId(g.student.id);
  if (mine && digits(data.supplier_taxid) === mine) {
    data.direction_guess = "income";
    certain = true;
  }

  return {
    status: 200,
    body: {
      ok: true,
      data,
      directionCertain: certain,
      missing: missingFields(data),
      warning: allocationWarning(data),
      duplicate: dup ? { id: dup.id, supplier: dup.supplier_name, date: dup.doc_date, amount: dup.amount_total } : null,
      balance,
      owner: !!g.owner,
      /* v1 בכוונה מחזיר את הפלט הגולמי: ההרצה האמיתית הראשונה היא אצל הלקוח,
         ובלי זה כל תקלה תהיה ניחוש. להסיר כשהכלי יציב. */
      debugRaw: body.debug ? String(text).slice(0, 2000) : undefined,
    },
  };
}

/* תקרת מסמכים לחשבון. האחסון מצטבר לנצח — לקוח משלם פעם אחת על החילוץ
   והקבצים שלו נשארים — ולכן בלי תקרה חשבון אחד יכול למלא את התוכנית.
   ENV ולא קבוע, כדי לשנות בוורסל בלי לגעת בקוד. */
const MAX_DOCS = Number(process.env.MAX_DOCS_PER_ACCOUNT || 500);

async function countDocs(studentId) {
  const r = await fetch(
    SUPABASE_URL + "/rest/v1/documents?student_id=eq." + enc(studentId) + "&select=id",
    { headers: sbHeaders({ Prefer: "count=exact", Range: "0-0" }) }
  );
  if (!r.ok) throw new Error("Supabase count -> " + r.status);
  /* content-range נראה כך: "0-0/137". המספר אחרי הלוכסן הוא הסך הכל. */
  const cr = r.headers.get("content-range") || "";
  const total = Number(cr.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

/* save — הלקוח אישר/תיקן. רק סכום חוסם. */
async function doSave(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  /* בעלים לא מוגבל. כשל בספירה לא חוסם שמירה — עדיף לחרוג מהתקרה
     מאשר לחסום לקוח בגלל תקלה שלנו. */
  if (!g.owner) {
    try {
      const n = await countDocs(g.student.id);
      if (n >= MAX_DOCS) {
        return {
          status: 409,
          body: {
            error: "הגעתם לתקרה של " + MAX_DOCS + " מסמכים בחשבון. אפשר למחוק מסמכים ישנים כדי לפנות מקום.",
            limit: MAX_DOCS, stored: n,
          },
        };
      }
    } catch (e) {
      console.error("[documents] count failed, allowing save:", e.message);
    }
  }

  const d = normalise(body.data || {});
  const direction = body.direction === "income" ? "income" : "expense";

  if (d.amount_total === null) {
    return { status: 400, body: { error: "חסר סכום. אפשר להקליד אותו ידנית.", needAmount: true } };
  }

  /* תאריך חסר לא חוסם — ברירת המחדל היא היום, מסומן כמשוער, והלקוח יכול לתקן. */
  const estimated = !d.doc_date;
  const docDate = d.doc_date || new Date().toISOString().slice(0, 10);

  const row = {
    student_id:        g.student.id,
    direction,
    amount_total:      d.amount_total,
    doc_date:          docDate,
    date_estimated:    estimated,
    doc_kind:          d.doc_kind,
    supplier_name:     d.supplier_name,
    supplier_taxid:    d.supplier_taxid,
    doc_number:        d.doc_number,
    amount_before_vat: d.amount_before_vat,
    vat_amount:        d.vat_amount,
    vat_rate:          d.vat_rate,
    allocation_number: d.allocation_number,
    payment_method:    d.payment_method,
    period_start:      d.period_start,
    period_end:        d.period_end,
    currency:          d.currency,
    file_url:          str(body.fileUrl, 800),
    file_path:         str(body.filePath, 400),
    raw_text:          d.raw_text,
    extraction:        body.data || null,
    needs_review:      missingFields(d).length > 0,
    note:              str(body.note, 500),
  };

  const saved = await sbPost("documents", row, "return=representation");
  return { status: 200, body: { ok: true, document: saved[0] || null } };
}

/* update — תיקון ידני של מסמך קיים. */
const EDITABLE = [
  "direction", "amount_total", "doc_date", "date_estimated", "doc_kind",
  "supplier_name", "supplier_taxid", "doc_number", "amount_before_vat",
  "vat_amount", "vat_rate", "allocation_number", "payment_method",
  "period_start", "period_end", "currency", "note",
];

async function doUpdate(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };
  const id = str(body.id, 60);
  if (!id) return { status: 400, body: { error: "חסר מזהה מסמך." } };

  const patch = {};
  for (const k of EDITABLE) {
    if (!(k in (body.patch || {}))) continue;
    const v = body.patch[k];
    if (k === "amount_total" || k === "amount_before_vat" || k === "vat_amount" || k === "vat_rate") {
      patch[k] = num(v);
    } else if (k === "doc_date" || k === "period_start" || k === "period_end") {
      patch[k] = isoDate(v);
    } else if (k === "direction") {
      patch[k] = v === "income" ? "income" : "expense";
    } else if (k === "date_estimated") {
      patch[k] = !!v;
    } else if (k === "doc_kind") {
      patch[k] = KINDS.includes(v) ? v : "unknown";
    } else {
      patch[k] = str(v, 500);
    }
  }
  if (!Object.keys(patch).length) return { status: 400, body: { error: "אין מה לעדכן." } };
  if ("amount_total" in patch && patch.amount_total === null) {
    return { status: 400, body: { error: "סכום לא יכול להיות ריק." } };
  }

  /* student_id בתנאי — מונע עריכה של מסמך של לקוח אחר גם אם הועבר id זר. */
  const rows = await sbPatch(
    "documents?id=eq." + enc(id) + "&student_id=eq." + enc(g.student.id), patch
  );
  if (!rows.length) return { status: 404, body: { error: "המסמך לא נמצא." } };
  return { status: 200, body: { ok: true, document: rows[0] } };
}

async function doDelete(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };
  const id = str(body.id, 60);
  if (!id) return { status: 400, body: { error: "חסר מזהה מסמך." } };

  /* הקובץ נמחק יחד עם הרשומה. בלי זה כל קבלה שנמחקה משאירה צילום באחסון
     לנצח — ולכלי שמחזיק מסמכים פיננסיים של לקוחות זו גם בעיית נפח וגם
     בעיה של שמירת מידע שהלקוח ביקש למחוק.
     קוראים את file_path לפני המחיקה, אחרת הוא אבוד ואי אפשר למצוא את הקובץ. */
  let path = null;
  try {
    const rows = await sbGet(
      "documents?id=eq." + enc(id) + "&student_id=eq." + enc(g.student.id) + "&select=file_path&limit=1"
    );
    path = rows[0] ? rows[0].file_path : null;
  } catch (e) {
    console.error("[documents] could not read file_path before delete:", e.message);
  }

  await sbDelete("documents?id=eq." + enc(id) + "&student_id=eq." + enc(g.student.id));

  /* כשל במחיקת הקובץ לא מפיל את הפעולה — הרשומה כבר נמחקה, וזה מה
     שהלקוח ביקש. הקובץ היתום יופיע בלוג.
     2026-09-01: הגרסה הראשונה שלחה DELETE ל-/object/{bucket}/{path} בלי גוף
     והחזירה 400. Supabase מוחק מול הדלי עצמו עם רשימת נתיבים ב-prefixes —
     זו הצורה שהספרייה הרשמית משתמשת בה, וזו הצורה כאן. */
  if (path && path.indexOf(String(g.student.id) + "/") === 0) {
    try {
      const r = await fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET, {
        method: "DELETE",
        headers: sbHeaders(),
        body: JSON.stringify({ prefixes: [path] }),
      });
      if (!r.ok) {
        console.error("[documents] orphaned file, delete returned", r.status,
                      (await r.text()).slice(0, 200), path);
      }
    } catch (e) {
      console.error("[documents] orphaned file, delete threw:", e.message, path);
    }
  }

  return { status: 200, body: { ok: true } };
}

/* ---------------- הקובץ עצמו ----------------
   קבלות הן מסמכים פיננסיים של הלקוח, ולכן הן לא עולות ל-Cloudinary כמו
   שאר הכלים: העלאה לא-חתומה שם יוצרת כתובת ציבורית שכל מי שמחזיק בה פותח.
   כאן הדלי ב-Supabase פרטי, ההעלאה נעשית מול כתובת חתומה לזמן קצר,
   והצפייה דורשת קישור חתום שפג. הנתיב כולל את מזהה הלקוח, כך שגם אם
   הועבר נתיב זר — הוא לא ייחתם.

   ⚠️ נתיבי ה-Storage של Supabase נכתבו לפי המבנה המתועד ולא הורצו מכאן
   (הדומיין חסום בסביבה שלי). כשל יחזיר את גוף השגיאה ללוג, לא ניחוש. */

const BUCKET = "documents";

function safeName(name) {
  const base = String(name || "receipt").split(/[\\/]/).pop();
  const ext = (base.match(/\.(jpe?g|png|webp|heic|pdf)$/i) || [null, "jpg"])[1].toLowerCase();
  return Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
}

async function doUploadUrl(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  const path = String(g.student.id) + "/" + safeName(body.filename);
  const r = await fetch(
    SUPABASE_URL + "/storage/v1/object/upload/sign/" + BUCKET + "/" + path,
    { method: "POST", headers: sbHeaders(), body: JSON.stringify({}) }
  );
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    console.error("[documents] signed upload url failed:", r.status, t);
    return { status: 502, body: { error: "לא ניתן להעלות את הקובץ כרגע.", detail: t } };
  }
  const j = JSON.parse((await r.text()) || "{}");
  const token = j.token || String(j.url || "").split("token=")[1] || "";
  return {
    status: 200,
    body: {
      ok: true,
      filePath: path,
      uploadUrl: SUPABASE_URL + "/storage/v1/object/upload/sign/" + BUCKET + "/" + path +
                 "?token=" + encodeURIComponent(token),
    },
  };
}

async function doFileLink(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  const path = str(body.filePath, 400);
  /* הנתיב חייב להתחיל במזהה הלקוח — אחרת אפשר היה לבקש חתימה על קובץ של אחר. */
  if (!path || path.indexOf(String(g.student.id) + "/") !== 0) {
    return { status: 403, body: { error: "אין גישה לקובץ הזה." } };
  }

  const r = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" + BUCKET + "/" + path, {
    method: "POST", headers: sbHeaders(),
    body: JSON.stringify({ expiresIn: Math.min(Number(body.expiresIn) || 3600, 86400) }),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    console.error("[documents] sign download failed:", r.status, t);
    return { status: 502, body: { error: "לא ניתן לפתוח את הקובץ.", detail: t } };
  }
  const j = JSON.parse((await r.text()) || "{}");
  const signed = j.signedURL || j.signedUrl || "";
  return { status: 200, body: { ok: true, url: signed ? SUPABASE_URL + "/storage/v1" + signed : null } };
}

/* ---------------- ח.פ של הלקוח (רשות) ----------------
   אותה חשבונית היא הוצאה אצל הקונה והכנסה אצל המוכר, ושום דבר במסמך לא אומר
   בצד של מי אתה עומד — ולכן הכיוון נשאר ניחוש שהלקוח מאשר.
   מי שמזין את מספר העוסק שלו הופך את זה לוודאי: אם המספר על המסמך הוא שלו,
   הוא הוציא אותו, כלומר זו הכנסה.
   השדה הוא רשות בכוונה. לא לכל לקוח יש ח.פ (עוסק פטור, אדם פרטי), וחיוב
   היה חוסם את השימוש הראשון עוד לפני שהלקוח ראה שהכלי עובד. */

function digits(v) {
  const d = String(v == null ? "" : v).replace(/\D/g, "");
  return d || null;
}

async function myTaxId(studentId) {
  try {
    const rows = await sbGet(
      "students?id=eq." + enc(studentId) + "&select=business_taxid&limit=1"
    );
    return rows[0] ? digits(rows[0].business_taxid) : null;
  } catch (e) {
    /* אם העמודה עוד לא קיימת — הכלי ממשיך לעבוד בדיוק כמו קודם. */
    console.error("[documents] could not read business_taxid:", e.message);
    return null;
  }
}

async function doProfile(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };
  return { status: 200, body: { ok: true, businessTaxid: await myTaxId(g.student.id) } };
}

async function doSetTaxid(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  /* מחרוזת ריקה = הסרה. אחרת חייב להיות מספר בן 9 ספרות. */
  const raw = String(body.businessTaxid == null ? "" : body.businessTaxid).trim();
  let value = null;
  if (raw) {
    const d = digits(raw);
    if (!d || d.length !== 9) {
      return { status: 400, body: { error: "מספר עוסק/ח.פ הוא 9 ספרות." } };
    }
    value = d;
  }
  await sbPatch("students?id=eq." + enc(g.student.id), { business_taxid: value });
  return { status: 200, body: { ok: true, businessTaxid: value } };
}

/* search — חיפוש חופשי. ILIKE ולא to_tsvector: עברית עובדת בוודאות,
   ובנפח של לקוח בודד אין הבדל מורגש. */
async function doSearch(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  const q = str(body.q, 120);
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
  let path = "documents?student_id=eq." + enc(g.student.id);

  if (q) {
    /* פסיק, נקודתיים וסוגריים שוברים את תחביר הפילטרים של PostgREST. */
    const safe = q.replace(/[,():*]/g, " ").trim();
    if (safe) path += "&search_blob=ilike." + enc("%" + safe + "%");
  }
  if (body.from) { const f = isoDate(body.from); if (f) path += "&doc_date=gte." + enc(f); }
  if (body.to)   { const t = isoDate(body.to);   if (t) path += "&doc_date=lte." + enc(t); }
  if (body.direction === "income" || body.direction === "expense") {
    path += "&direction=eq." + body.direction;
  }
  if (body.minAmount != null) { const m = num(body.minAmount); if (m !== null) path += "&amount_total=gte." + m; }
  if (body.maxAmount != null) { const m = num(body.maxAmount); if (m !== null) path += "&amount_total=lte." + m; }

  path += "&select=id,direction,amount_total,doc_date,date_estimated,doc_kind," +
          "supplier_name,supplier_taxid,doc_number,vat_amount,vat_rate,payment_method," +
          "period_start,period_end,currency,file_url,needs_review,note,created_at" +
          "&order=doc_date.desc&limit=" + limit;

  const rows = await sbGet(path);

  /* הסכום הכולל של התוצאות — זה מה שמחליף קטגוריות: מחפשים "חשמל"
     ורואים מיד כמה יצא על חשמל, בלי שאף אחד תייג כלום. */
  let income = 0, expense = 0;
  for (const r of rows) {
    const a = Number(r.amount_total) || 0;
    if (r.direction === "income") income += a; else expense += a;
  }

  return {
    status: 200,
    body: {
      ok: true,
      count: rows.length,
      truncated: rows.length === limit,
      totals: { income, expense, net: income - expense },
      documents: rows,
    },
  };
}

/* chart — סיכום חודשי להכנסות מול הוצאות. */
async function doChart(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };

  const months = Math.min(Math.max(Number(body.months) || 12, 1), 60);
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  const from = start.toISOString().slice(0, 10);

  const rows = await sbGet(
    "documents?student_id=eq." + enc(g.student.id) +
    "&doc_date=gte." + enc(from) +
    "&select=direction,amount_total,doc_date&order=doc_date.asc&limit=5000"
  );

  const buckets = new Map();
  for (let i = 0; i < months; i++) {
    const d = new Date(start);
    d.setUTCMonth(start.getUTCMonth() + i);
    buckets.set(d.toISOString().slice(0, 7), { month: d.toISOString().slice(0, 7), income: 0, expense: 0 });
  }
  for (const r of rows) {
    const key = String(r.doc_date).slice(0, 7);
    const b = buckets.get(key);
    if (!b) continue;
    const a = Number(r.amount_total) || 0;
    if (r.direction === "income") b.income += a; else b.expense += a;
  }

  const series = Array.from(buckets.values()).map((b) => ({ ...b, net: b.income - b.expense }));
  const totals = series.reduce(
    (t, b) => ({ income: t.income + b.income, expense: t.expense + b.expense }),
    { income: 0, expense: 0 }
  );

  return {
    status: 200,
    body: { ok: true, months, series, totals: { ...totals, net: totals.income - totals.expense } },
  };
}

/* email — שולח את המסמכים למייל שהלקוח התחבר איתו. ידני בלחיצה, לא מתוזמן. */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₪";
}

const KIND_HE = {
  tax_invoice: "חשבונית מס", receipt: "קבלה",
  invoice: "חשבונית", bill: "חשבון", unknown: "לא מזוהה",
};

function reportHtml(rows, totals, title) {
  const lines = rows.map((r) => `
    <tr>
      <td>${esc(r.doc_date)}${r.date_estimated ? " *" : ""}</td>
      <td>${esc(r.supplier_name || "—")}</td>
      <td>${esc(KIND_HE[r.doc_kind] || r.doc_kind)}</td>
      <td>${r.direction === "income" ? "הכנסה" : "הוצאה"}</td>
      <td>${esc(money(r.amount_total))}</td>
      <td>${r.vat_amount == null ? "—" : esc(money(r.vat_amount))}</td>
      <td>${r.file_url ? `<a href="${esc(r.file_url)}">קובץ</a>` : "—"}</td>
    </tr>`).join("");

  return `<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8">
<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f6f6;padding:20px">
  <div style="max-width:760px;margin:0 auto;background:#fff;padding:24px;border-radius:10px">
    <h2 style="margin:0 0 4px">${esc(title)}</h2>
    <p style="color:#666;margin:0 0 18px">אלרון פרינט · מסמכים וקבלות</p>
    <p style="font-size:16px">
      הכנסות: <b>${esc(money(totals.income))}</b><br>
      הוצאות: <b>${esc(money(totals.expense))}</b><br>
      מאזן: <b>${esc(money(totals.net))}</b>
    </p>
    <table cellpadding="7" cellspacing="0" border="0"
           style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f0f0f0;text-align:right">
          <th>תאריך</th><th>ספק</th><th>סוג</th><th>כיוון</th><th>סכום</th><th>מע"מ</th><th>מסמך</th>
        </tr>
      </thead>
      <tbody>${lines || `<tr><td colspan="7">אין מסמכים בתקופה הזו.</td></tr>`}</tbody>
    </table>
    <p style="color:#888;font-size:12px;margin-top:18px">
      * תאריך משוער — לא זוהה על המסמך ונקבע לפי מועד ההעלאה.<br>
      הדוח הזה הוא ריכוז של מה שהעליתם ואינו תחליף לייעוץ של רואה חשבון.
    </p>
  </div>
</body></html>`;
}

async function doEmail(req, body) {
  const g = await gate(req, body, "document");
  if (g.deny) return { status: g.deny.status, body: g.deny.body };
  if (!RESEND_KEY) {
    console.error("[documents] RESEND_API_KEY missing");
    return { status: 500, body: { error: "שליחת מייל לא מוגדרת." } };
  }
  if (!g.student.email) return { status: 400, body: { error: "אין כתובת מייל לחשבון." } };

  const from = isoDate(body.from);
  const to   = isoDate(body.to);
  let path = "documents?student_id=eq." + enc(g.student.id);
  if (from) path += "&doc_date=gte." + enc(from);
  if (to)   path += "&doc_date=lte." + enc(to);
  path += "&select=direction,amount_total,doc_date,date_estimated,doc_kind," +
          "supplier_name,vat_amount,file_url&order=doc_date.asc&limit=1000";

  const rows = await sbGet(path);
  let income = 0, expense = 0;
  for (const r of rows) {
    const a = Number(r.amount_total) || 0;
    if (r.direction === "income") income += a; else expense += a;
  }
  const totals = { income, expense, net: income - expense };
  const title = from || to
    ? `ריכוז מסמכים ${from || "מההתחלה"} עד ${to || "היום"}`
    : "ריכוז המסמכים שלי";

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.DOCUMENTS_FROM || "ElronPrint <noreply@elronprint.co.il>",
      to: [g.student.email],
      subject: title,
      html: reportHtml(rows, totals, title),
    }),
  });

  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    console.error("[documents] resend failed:", r.status, t);
    return { status: 502, body: { error: "שליחת המייל נכשלה." } };
  }

  return { status: 200, body: { ok: true, sent: rows.length, to: g.student.email, totals } };
}

/* ---------------- קריאת שם מוצר מאריזה ("הקניות שלי") ---------------- */
/* 2026-09-07: נוסף כאן ולא בקובץ חדש, כי api/ עומד על 12/12 במסלול Hobby.
   לא נוגע בטבלאות, לא בקרדיטים ולא בשום פעולה קיימת. */

const PRODUCT_SYSTEM = `You read a photograph of a grocery product package, usually Israeli, and identify the product.

Return ONLY a JSON object, no markdown, no explanation:
{
  "found": true | false,
  "name": "",
  "brand": "",
  "size": ""
}

Rules:
- "name" is the product as a shopper would write it on a shopping list, in Hebrew when the package is Hebrew. Include the brand when it is part of how people name it. Example: "טחינה אל ארז", "קוטג' תנובה 5%".
- "brand" is the manufacturer alone, "" if unclear.
- "size" is the net weight or volume as printed, e.g. "500 גרם", "1.5 ליטר". "" if not visible.
- "found" is false when the photo is not a product package, or the writing is too blurred to read.
- Never guess a product you cannot actually see. An empty answer is better than a wrong one.
- Keep "name" under 40 characters.`;

async function doProduct(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }

  const { image, mediaType } = body;
  if (!image) return { status: 400, body: { error: "לא התקבלה תמונה." } };

  const text = await askVision({
    system: PRODUCT_SYSTEM,
    ask: "Identify the product in this photo and answer with the JSON object only.",
    image, mediaType: mediaType || "image/jpeg",
    maxTokens: 200,
  });

  const j = parseModelJson(text);
  if (!j) {
    console.error("[documents] product unreadable. Raw:", String(text).slice(0, 300));
    return { status: 200, body: { found: false } };
  }

  const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 60);
  const name = clean(j.name);
  if (j.found === false || !name) return { status: 200, body: { found: false } };

  return { status: 200, body: { found: true, name, brand: clean(j.brand), size: clean(j.size) } };
}

/* ---------------- קריאת תאריך תפוגה מאריזה ("הקניות שלי") ---------------- */
/* 2026-09-07: על אריזות מודפסים לא פעם שני תאריכים — ייצור ותפוגה. הכלל שנקבע
   מולו: התפוגה היא תמיד המאוחר מבין השניים. */

const EXPIRY_SYSTEM = `You read a photograph of a printed date on a food or grocery package, usually Israeli.

Return ONLY a JSON object, no markdown, no explanation:
{
  "found": true | false,
  "expiry": "YYYY-MM-DD",
  "printed": "",
  "two_dates": true | false
}

Rules:
- Packages often print TWO dates: a production date and an expiry date. The expiry is ALWAYS the LATER of the two. Return the later one and set "two_dates" to true.
- Hebrew labels: "בתוקף עד", "תאריך אחרון לשימוש", "לשימוש עד", "עדיף להשתמש לפני" mark the expiry. "ייצור", "תאריך ייצור", "יוצר ב" mark production. When a label is visible, trust the label over the ordering.
- Israeli dates are usually DD/MM/YY or DD/MM/YYYY. A day above 12 disambiguates. When the year has two digits, assume 20YY.
- "printed" is the raw text exactly as you read it, for the user to verify against.
- "found" is false when no date is legible, or you cannot tell which number is a date. Never guess a date. A wrong expiry date is worse than no date at all.`;

async function doExpiry(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }

  const { image, mediaType } = body;
  if (!image) return { status: 400, body: { error: "לא התקבלה תמונה." } };

  const text = await askVision({
    system: EXPIRY_SYSTEM,
    ask: "Read the printed date(s) in this photo and answer with the JSON object only.",
    image, mediaType: mediaType || "image/jpeg",
    maxTokens: 200,
  });

  const j = parseModelJson(text);
  if (!j) {
    console.error("[documents] expiry unreadable. Raw:", String(text).slice(0, 300));
    return { status: 200, body: { found: false } };
  }

  const iso = String(j.expiry || "").trim();
  /* לא סומכים על המודל לפורמט. תאריך שלא נראה כמו תאריך — נדחה. */
  if (j.found === false || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { status: 200, body: { found: false } };
  }
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2040) {
    return { status: 200, body: { found: false } };
  }

  return {
    status: 200,
    body: {
      found: true,
      expiry: iso,
      printed: String(j.printed == null ? "" : j.printed).replace(/\s+/g, " ").trim().slice(0, 60),
      twoDates: j.two_dates === true,
    },
  };
}

/* ---------------- גיבוי "הקניות שלי" ---------------- */
/* 2026-09-09: דף בדפדפן לא יכול להתעורר לבד ולא יכול לשלוח מייל, ולכן
   הגיבוי נשמר כאן בכל שינוי. אין כאן חשבון: הזיהוי הוא קוד שהלקוח בוחר,
   ומי שמחזיק בקוד רואה את הנתונים. זו הסיבה לאורך המינימלי.
   הנתונים נשמרים כמחרוזת אחת ולא מפורקים לעמודות — זה גיבוי, לא מסד. */

/* וורסל חוסם גוף בקשה מעל 4.5MB. עוצרים לפני, עם הודעה ברורה,
   כי כישלון שקט בגיבוי הוא הדבר הגרוע ביותר שיכול לקרות כאן. */
const SHOP_BACKUP_MAX = 4000000;

function shopKey(v) {
  const s = String(v == null ? "" : v).trim();
  return /^[A-Za-z0-9._-]{8,64}$/.test(s) ? s : null;
}

async function doShopSave(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }
  const key = shopKey(body.key);
  if (!key) {
    return { status: 400, body: { error: "קוד גיבוי לא תקין. לפחות 8 תווים, אותיות באנגלית וספרות." } };
  }

  const data = typeof body.data === "string" ? body.data : JSON.stringify(body.data || null);
  if (!data || data.length < 2) return { status: 400, body: { error: "אין מה לגבות." } };
  if (data.length > SHOP_BACKUP_MAX) {
    return {
      status: 413,
      body: {
        error: "הגיבוי גדול מדי לשמירה בענן (" + Math.round(data.length / 100000) / 10 + "MB). " +
               "הגיבוי למכשיר עדיין עובד.",
        size: data.length, limit: SHOP_BACKUP_MAX,
      },
    };
  }

  const now = new Date().toISOString();
  await sbPost("shopping_backups", { key, data, updated_at: now }, "resolution=merge-duplicates");
  return { status: 200, body: { ok: true, size: data.length, savedAt: now } };
}

async function doShopLoad(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }
  const key = shopKey(body.key);
  if (!key) return { status: 400, body: { error: "קוד גיבוי לא תקין." } };

  const rows = await sbGet(
    "shopping_backups?key=eq." + enc(key) + "&select=data,updated_at&limit=1"
  );
  if (!rows.length) return { status: 200, body: { ok: true, found: false } };
  return { status: 200, body: { ok: true, found: true, data: rows[0].data, updatedAt: rows[0].updated_at } };
}

/* ---------------- בדיקת מקור המחירים של שופרסל ---------------- */
/* 2026-09-09: פעולת אבחון בלבד. לא שומרת כלום ולא נוגעת בשום טבלה.
   מטרתה לענות על שאלה אחת שאי אפשר לענות עליה מבחוץ: האם שרת יכול
   לבקש מדף שקיפות המחירים של שופרסל את הסניף שלנו דרך הכתובת,
   ולקבל קישור הורדה חתום. אם כן — הדרך פתוחה. אם לא — נדע מיד למה,
   כי הפעולה מחזירה את מה שבאמת חזר ולא פרשנות שלו. */

/* 2026-09-09: הכתובת נלקחה מ-Main.js של שופרסל. הדף הראשי מתעלם
   מהפרמטרים כי הסינון מתבצע בבקשה נפרדת לנתיב הזה, שמחזיר רק את
   הטבלה. שני הפרמטרים הם catID ו-storeId, בדיוק כפי שהקוד שלהם שולח. */
const SHUF_GRID = "https://prices.shufersal.co.il/FileObject/UpdateCategory";

async function doShufProbe(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }

  const store = String(body.store || "121").replace(/\D/g, "") || "121";
  /* catID=2 הוא PricesFull ברשימת הקטגוריות שלהם. */
  const url = SHUF_GRID + "?catID=2&storeId=" + store;

  const t0 = Date.now();
  let r, html;
  try {
    r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "he-IL,he;q=0.9",
      },
    });
    html = await r.text();
  } catch (e) {
    return { status: 502, body: { error: "הבקשה לשופרסל נכשלה.", detail: e.message } };
  }
  const ms = Date.now() - t0;

  /* כל הקישורים לקבצים המלאים שמופיעים בדף */
  const links = (html.match(/https:\/\/[^"'\s]*pricefull[^"'\s]*\.gz[^"'\s]*/gi) || []);
  const mine  = links.filter((u) => u.indexOf("-" + store.padStart(3, "0") + "-") > -1);

  /* כמה סניפים שונים מופיעים בדף — כך נדע אם הסינון בכלל תפס */
  const stores = {};
  (html.match(/Price(?:Full)?7290027600007-\d{3}-(\d{3})-/g) || []).forEach((m) => {
    const k = m.slice(-4, -1);
    stores[k] = (stores[k] || 0) + 1;
  });
  const storeList = Object.keys(stores);

  return {
    status: 200,
    body: {
      ok: true,
      httpStatus: r.status,
      ms,
      htmlLength: html.length,
      filtered: storeList.length === 1 && storeList[0] === store.padStart(3, "0"),
      storesOnPage: storeList.slice(0, 12),
      pricefullLinks: links.length,
      myBranchLinks: mine.length,
      firstMine: mine[0] || null,
      firstAny: links[0] || null,
    },
  };
}

/* ---------------- שליפת מוצר בודד מקובץ המחירים ---------------- */
/* 2026-09-09: שלב שני. מוריד את קובץ ה-PriceFull של הסניף, פורס אותו,
   וקורא את ה-XML. עדיין לא שומר כלום — המטרה לראות שהנתונים יוצאים
   נכון על ברקוד אמיתי לפני שבונים אחסון וחיפוש.
   gunzip מובנה ב-Node (zlib), אין צורך בספרייה חיצונית. */

/* חילוץ תוכן של תגית XML בודדת. הקבצים האלה שטוחים ובלי מרחבי שמות,
   ולכן ביטוי רגולרי מספיק וזול בהרבה מפרסר מלא על 7,000 רשומות. */
function xmlTag(chunk, tag) {
  const m = chunk.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? m[1].trim() : null;
}

/* שמות התגיות משתנים בין רשתות ולפעמים בין גרסאות של אותה רשת,
   ולכן בודקים כמה חלופות במקום להניח אחת. */
function xmlAny(chunk, tags) {
  for (const t of tags) {
    const v = xmlTag(chunk, t);
    if (v) return v;
  }
  return null;
}

function parseItems(xml) {
  const out = [];
  const parts = xml.split(/<Item>/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const code = xmlAny(chunk, ["ItemCode"]);
    if (!code) continue;
    out.push({
      code,
      name:  xmlAny(chunk, ["ItemName", "ItemNm"]),
      maker: xmlAny(chunk, ["ManufacturerName", "ManufactureName"]),
      qty:   xmlAny(chunk, ["Quantity"]),
      unit:  xmlAny(chunk, ["UnitQty", "UnitOfMeasure"]),
      price: Number(xmlAny(chunk, ["ItemPrice"])) || null,
      unitPrice: Number(xmlAny(chunk, ["UnitOfMeasurePrice"])) || null,
    });
  }
  return out;
}

async function doShufItem(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }

  const store = String(body.store || "121").replace(/\D/g, "") || "121";
  const want  = String(body.barcode || "").replace(/\D/g, "");
  const t0 = Date.now();

  /* 1. קישור טרי. החתימה פגה תוך כשעה, ולכן היא נשלפת בכל קריאה. */
  let listHtml;
  try {
    const lr = await fetch(SHUF_GRID + "?catID=2&storeId=" + store, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
    });
    if (!lr.ok) return { status: 502, body: { error: "רשימת הקבצים לא נטענה.", httpStatus: lr.status } };
    listHtml = await lr.text();
  } catch (e) {
    return { status: 502, body: { error: "הבקשה לרשימת הקבצים נכשלה.", detail: e.message } };
  }

  const links = listHtml.match(/https:\/\/[^"'\s]*pricefull[^"'\s]*\.gz[^"'<]*/gi) || [];
  if (!links.length) return { status: 502, body: { error: "לא נמצא קובץ מלא לסניף הזה." } };
  /* ה-HTML מגיע עם &amp; במקום & — בלי הפענוח הזה הקישור לא תקף. */
  const fileUrl = links[0].replace(/&amp;/g, "&");
  const tList = Date.now() - t0;

  /* 2. הורדה ופריסה */
  let items, gzBytes, xmlChars;
  try {
    const fr = await fetch(fileUrl);
    if (!fr.ok) {
      return { status: 502, body: { error: "הורדת הקובץ נכשלה.", httpStatus: fr.status } };
    }
    const buf = Buffer.from(await fr.arrayBuffer());
    gzBytes = buf.length;
    const xml = gunzipSync(buf).toString("utf8");
    xmlChars = xml.length;
    items = parseItems(xml);
  } catch (e) {
    return { status: 502, body: { error: "פריסת הקובץ נכשלה.", detail: e.message } };
  }

  const found = want ? items.filter((it) => it.code.replace(/^0+/, "") === want.replace(/^0+/, "")) : [];

  return {
    status: 200,
    body: {
      ok: true,
      ms: Date.now() - t0,
      msList: tList,
      fileName: (fileUrl.split("/").pop() || "").split("?")[0],
      gzBytes,
      xmlChars,
      itemCount: items.length,
      searched: want || null,
      found: found.length ? found[0] : null,
      sample: items.slice(0, 3),
    },
  };
}

/* ---------------- מאגר המוצרים המקומי ---------------- */
/* 2026-09-09: shufItem מוכיח שאפשר למשוך בזמן אמת, אבל 3 שניות בכל
   סריקה זה יותר מדי, והכלי היה נשבר בכל פעם ששופרסל למטה. לכן הקובץ
   נשמר אצלנו פעם ביום, והחיפוש הוא מול המאגר.
   sync = מילוי המאגר. lookup = מה שהכלי קורא לו בזמן סריקה. */

/* Supabase לא בולע 8,500 שורות בבקשה אחת בלי להיחנק. */
const SHUF_BATCH = 800;

/* יחידות מידה כפי שהן מופיעות בפועל בקבצים של שופרסל. */
const UNIT_WORDS = 'ג|גר|גרם|ק"ג|קג|קילו|מ"ל|מל|מיליליטר|ליטר|ל|יח|יחידות|יחי\'|מטר|מטרים|ס"מ';
const HAS_SIZE = new RegExp('\\d+(?:[.,]\\d+)?\\s*(?:' + UNIT_WORDS + ')(?![\\u0590-\\u05FFa-zA-Z])', 'i');

function buildName(it) {
  /* השם בקובץ לרוב כבר כולל גודל, אבל לא תמיד ולא באותו פורמט.
     הכלל: לא נוגעים בשם של הרשת אם כבר יש בו גודל, ורק אם אין —
     מוסיפים אותו מהשדות הנפרדים qty ו-unit, שהם נקיים.
     2026-09-09: הניסיון הראשון בנה את השם תמיד מ-qty והוא ייצר שתי
     תקלות אמיתיות — "שקיות זיפר M 25 יחידות" הפך ל-"1 יחידות" כי
     qty מתאר אריזה אחת, ו"ניילון נצמד 30 מטר" קיבל גודל כפול. */
  const base = String(it.name || "").replace(/\s+/g, " ").trim();
  if (!base) return null;
  if (HAS_SIZE.test(base)) return base.slice(0, 80);

  const q = Number(it.qty);
  const u = String(it.unit || "").trim();
  if (!q || !u) return base.slice(0, 80);

  const num = Number.isInteger(q) ? String(q) : String(q).replace(/0+$/, "").replace(/\.$/, "");
  return (base + " " + num + " " + u).slice(0, 80);
}

async function shufFetchItems(store) {
  const lr = await fetch(SHUF_GRID + "?catID=2&storeId=" + store, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
  });
  if (!lr.ok) throw new Error("רשימת הקבצים החזירה " + lr.status);
  const html = await lr.text();

  const links = html.match(/https:\/\/[^"'\s]*pricefull[^"'\s]*\.gz[^"'<]*/gi) || [];
  if (!links.length) throw new Error("לא נמצא קובץ מלא לסניף " + store);
  const fileUrl = links[0].replace(/&amp;/g, "&");

  const fr = await fetch(fileUrl);
  if (!fr.ok) throw new Error("הורדת הקובץ החזירה " + fr.status);
  const buf = Buffer.from(await fr.arrayBuffer());
  const xml = gunzipSync(buf).toString("utf8");
  return { items: parseItems(xml), fileName: (fileUrl.split("/").pop() || "").split("?")[0] };
}

async function doShufSync(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }
  const store = String(body.store || "121").replace(/\D/g, "") || "121";
  const t0 = Date.now();

  let got;
  try { got = await shufFetchItems(store); }
  catch (e) { return { status: 502, body: { error: "משיכת הקובץ נכשלה.", detail: e.message } }; }

  const rows = [];
  const now = new Date().toISOString();
  for (const it of got.items) {
    const name = buildName(it);
    if (!name || it.price === null) continue;
    rows.push({
      store,
      code: String(it.code).replace(/^0+/, "") || String(it.code),
      name,
      maker: it.maker ? String(it.maker).slice(0, 80) : null,
      qty: it.qty, unit: it.unit,
      price: it.price, unit_price: it.unitPrice,
      updated_at: now,
    });
  }

  let saved = 0;
  try {
    for (let i = 0; i < rows.length; i += SHUF_BATCH) {
      await sbPost("shufersal_items", rows.slice(i, i + SHUF_BATCH), "resolution=merge-duplicates");
      saved += Math.min(SHUF_BATCH, rows.length - i);
    }
  } catch (e) {
    return { status: 502, body: { error: "השמירה נכשלה.", detail: e.message, saved } };
  }

  return {
    status: 200,
    body: { ok: true, ms: Date.now() - t0, store, fileName: got.fileName,
            parsed: got.items.length, saved, skipped: got.items.length - rows.length },
  };
}

/* lookup — זה מה שהכלי קורא לו ברגע הסריקה. */
async function doShufLookup(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }
  const code = String(body.barcode || "").replace(/\D/g, "").replace(/^0+/, "");
  if (!code) return { status: 400, body: { error: "חסר ברקוד." } };

  let rows = [];
  try {
    rows = await sbGet(
      "shufersal_items?code=eq." + enc(code) +
      "&select=store,code,name,maker,price,unit_price,updated_at&order=price.asc&limit=10"
    );
  } catch (e) {
    return { status: 502, body: { error: "החיפוש נכשל.", detail: e.message } };
  }

  if (!rows.length) return { status: 200, body: { ok: true, found: false } };
  return {
    status: 200,
    body: {
      ok: true, found: true,
      name: rows[0].name,
      maker: rows[0].maker,
      updatedAt: rows[0].updated_at,
      prices: rows.map((r) => ({ store: r.store, price: Number(r.price), unitPrice: Number(r.unit_price) })),
    },
  };
}

/* ---------------- רמי לוי ---------------- */
/* 2026-09-09: רמי לוי מפרסמים דרך פורטל Cerberus משותף (NCR), ולא
   בכתובת פתוחה כמו שופרסל. ההבדל היחיד הוא ההתחברות: שולחים
   שם משתמש RamiLevi בלי סיסמה, שומרים את העוגייה, ומשם זה
   REST רגיל. אימות: הפורטל נפתח ידנית והמשתמש הזה עבד.
   הרשימה הרשמית של המועצה לצרכנות מ-2015 גרסה readonly/123456 —
   זה כבר לא תקף, ולכן המשתמש כאן הוא שם הרשת.
   הקבצים שם מתעדכנים כל שעה, לא פעם ביום. */

const RL_BASE  = "https://url.publishedprices.co.il";
const RL_USER  = "RamiLevi";
const RL_CHAIN = "7290058140886";

/* שומרים רק את מה שהשרת ביקש, בלי לנתח את תוכן העוגיות. */
function cookieJar(res, jar) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie()
            : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  for (const c of raw) {
    const bit = String(c).split(";")[0];
    const eq = bit.indexOf("=");
    if (eq > 0) jar[bit.slice(0, eq).trim()] = bit.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.keys(jar).map((k) => k + "=" + jar[k]).join("; ");
}

function metaToken(html) {
  const h = String(html || "");
  const m = h.match(/<meta[^>]+name=["']csrftoken["'][^>]*content=["']([^"']+)["']/i)
         || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']csrftoken["']/i);
  return m ? m[1] : "";
}

async function rlLogin() {
  const jar = {};

  /* 2026-09-09: קוד המקור של דף הכניסה שלהם נקרא בפועל. הטופס הוא
     id="login-form" action="/login/user" method="post", ושדותיו הם
     username, password, שדה נסתר r, וכפתור Submit. אין שם csrftoken —
     הניסיון הראשון שלח אותו על סמך הנחה, וההתחברות נדחתה בשקט
     והחזירה את דף הכניסה במקום JSON. */
  const g = await fetch(RL_BASE + "/login", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!g.ok) throw new Error("דף ההתחברות החזיר " + g.status);
  cookieJar(g, jar);
  const html = await g.text();

  /* 2026-09-09: הטוקן לא יושב בתוך הטופס אלא בתגית meta בראש הדף:
     <meta name="csrftoken" content="..."/>. חיפוש אחריו כשדה טופס
     החזיר ריק, הכניסה נדחתה בשקט, וכל הבקשות שאחריה קיבלו 401.
     הועתק מבקשת התחברות אמיתית של הדפדפן. */
  const csrf = metaToken(html);

  const form = new URLSearchParams();
  form.set("r", "");
  form.set("username", RL_USER);
  form.set("password", "");
  form.set("Submit", "Sign in");
  if (csrf) form.set("csrftoken", csrf);

  const p = await fetch(RL_BASE + "/login/user", {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieHeader(jar),
      "Referer": RL_BASE + "/login",
      "Origin": RL_BASE,
    },
    body: form.toString(),
  });
  cookieJar(p, jar);
  const location = p.headers.get("location") || null;

  /* נכנסים לדף הקבצים עצמו: זה מייצב את הסשן ומאפשר לקרוא את הטוקן. */
  let inner = "";
  try {
    const f = await fetch(RL_BASE + "/file", {
      headers: { "User-Agent": "Mozilla/5.0", "Cookie": cookieHeader(jar) },
    });
    cookieJar(f, jar);
    inner = await f.text();
  } catch (e) { /* לא קריטי — הטוקן עשוי לשבת בעוגייה */ }

  return { jar, csrf: rlCsrf(jar, inner) || csrf, loginStatus: p.status, location,
           loggedIn: /Logged in as/i.test(inner) };
}

/* 2026-09-09: גוף הבקשה הועתק מבקשה אמיתית של הדפדפן שלהם (DevTools).
   זו טבלת DataTables, ולכן היא שולחת הגדרת עמודות מלאה ולא רק חיפוש.
   הניסיון הקודם שלח ארבעה שדות בלבד והשרת החזיר את דף הכניסה.
   ה-csrftoken כן קיים — הוא פשוט לא בטופס הכניסה אלא בעוגייה, ולכן
   החיפוש אחריו ב-HTML לא מצא אותו. */
function rlCsrf(jar, html) {
  /* הטוקן של הדף הפנימי גובר: הוא זה שתקף לבקשות שאחרי ההתחברות. */
  return metaToken(html) || (jar && jar.csrftoken) || "";
}

async function rlList(session, term) {
  const cols = [
    ["fname", true, true],
    ["typeLabel", true, false],
    ["size", true, true],
    ["ftime", true, true],
    ["", true, false],
  ];

  const form = new URLSearchParams();
  form.set("sEcho", "1");
  form.set("iColumns", String(cols.length));
  form.set("sColumns", ",,,,");
  form.set("iDisplayStart", "0");
  form.set("iDisplayLength", "10000");
  cols.forEach(function (c, i) {
    form.set("mDataProp_" + i, c[0]);
    form.set("sSearch_" + i, "");
    form.set("bRegex_" + i, "false");
    form.set("bSearchable_" + i, String(c[1]));
    form.set("bSortable_" + i, String(c[2]));
  });
  form.set("sSearch", term || "");
  form.set("bRegex", "false");
  form.set("iSortingCols", "0");
  form.set("cd", "/");
  if (session.csrf) form.set("csrftoken", session.csrf);

  const r = await fetch(RL_BASE + "/file/json/dir", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Cookie": cookieHeader(session.jar),
      "Referer": RL_BASE + "/file",
      "Origin": RL_BASE,
    },
    body: form.toString(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("רשימת הקבצים החזירה " + r.status + " " + text.slice(0, 200));
  try { return JSON.parse(text); }
  catch (e) { throw new Error("הרשימה לא חזרה כ-JSON: " + text.slice(0, 200)); }
}

async function doRamiProbe(body) {
  if (process.env.SHOP_SECRET && body.secret !== process.env.SHOP_SECRET) {
    return { status: 403, body: { error: "אין הרשאה." } };
  }
  const store = String(body.store || "032").replace(/\D/g, "").padStart(3, "0");
  const t0 = Date.now();

  /* 2026-09-09: ההתחברות והרשימה מופרדות בכוונה. בגרסה הקודמת כשל
     ברשימה בלע גם את תוצאת ההתחברות, ולא היה אפשר לדעת איזה משני
     השלבים נשבר. עכשיו כל שלב מדווח על עצמו. */
  let session = null, loginError = null;
  try { session = await rlLogin(); }
  catch (e) { loginError = e.message; }

  if (!session) {
    return { status: 200, body: { ok: false, stage: "login", ms: Date.now() - t0, error: loginError } };
  }

  const info = {
    ms: Date.now() - t0,
    loginStatus: session.loginStatus,
    location: session.location,
    loggedIn: session.loggedIn,
    gotCsrf: !!session.csrf,
    csrfLen: session.csrf ? session.csrf.length : 0,
    cookies: Object.keys(session.jar),
  };

  let list = null, listError = null;
  try { list = await rlList(session, "PriceFull" + RL_CHAIN + "-001-" + store); }
  catch (e) { listError = e.message; }

  if (!list) {
    return { status: 200, body: Object.assign({ ok: false, stage: "list", error: listError }, info) };
  }

  const rows = Array.isArray(list.aaData) ? list.aaData : [];
  const names = rows.map((r) => (Array.isArray(r) ? r[0] : (r && (r.fname || r.name)) || "")).filter(Boolean);

  return {
    status: 200,
    body: Object.assign({
      ok: true,
      rowCount: rows.length,
      total: list.iTotalRecords,
      names: names.slice(0, 5),
      rawSample: rows.length ? JSON.stringify(rows[0]).slice(0, 300) : null,
    }, info),
  };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("[documents] SUPABASE_URL / SUPABASE_SERVICE_KEY missing");
    return res.status(500).json({ error: "השרת לא מוגדר." });
  }

  try {
    const rl = await checkRateLimit(req);
    if (rl && rl.limited) {
      return res.status(429).json({ error: "יותר מדי בקשות. נסו שוב בעוד רגע." });
    }
  } catch (e) {
    console.error("[documents] rate limit check failed, continuing:", e.message);
  }

  const body = req.body || {};
  const action = String(body.action || "").trim();

  try {
    let out;
    switch (action) {
      case "screen":  out = await doScreen(body);        break;
      case "extract": out = await doExtract(req, body);  break;
      case "save":    out = await doSave(req, body);     break;
      case "update":  out = await doUpdate(req, body);   break;
      case "delete":  out = await doDelete(req, body);   break;
      case "uploadUrl": out = await doUploadUrl(req, body); break;
      case "fileLink":  out = await doFileLink(req, body);  break;
      case "profile":  out = await doProfile(req, body);  break;
      case "setTaxid": out = await doSetTaxid(req, body); break;
      case "search":  out = await doSearch(req, body);   break;
      case "chart":   out = await doChart(req, body);    break;
      case "email":   out = await doEmail(req, body);    break;
      case "product": out = await doProduct(body);       break;
      case "expiry":  out = await doExpiry(body);        break;
      case "shopSave": out = await doShopSave(body);     break;
      case "shopLoad": out = await doShopLoad(body);     break;
      case "shufProbe": out = await doShufProbe(body); break;
      case "shufItem":  out = await doShufItem(body);  break;
      case "shufSync":   out = await doShufSync(body);   break;
      case "shufLookup": out = await doShufLookup(body); break;
      case "ramiProbe":  out = await doRamiProbe(body);  break;
      default:
        return res.status(400).json({ error: "פעולה לא מוכרת." });
    }
    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error("[documents] " + action + " threw:", e.message);
    return res.status(500).json({ error: "שגיאה בשרת. נסו שוב." });
  }
}
