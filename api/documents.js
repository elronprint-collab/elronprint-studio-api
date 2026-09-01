import { gate, settle } from "./_account.js";
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

  const g = await gate(req, body);
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

  return {
    status: 200,
    body: {
      ok: true,
      data,
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
  const g = await gate(req, body);
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
  const g = await gate(req, body);
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
  const g = await gate(req, body);
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
     שהלקוח ביקש. הקובץ היתום יופיע בלוג. */
  if (path && path.indexOf(String(g.student.id) + "/") === 0) {
    try {
      const r = await fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + path, {
        method: "DELETE", headers: sbHeaders(),
      });
      if (!r.ok) console.error("[documents] orphaned file, delete returned", r.status, path);
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
  const g = await gate(req, body);
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
  const g = await gate(req, body);
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

/* search — חיפוש חופשי. ILIKE ולא to_tsvector: עברית עובדת בוודאות,
   ובנפח של לקוח בודד אין הבדל מורגש. */
async function doSearch(req, body) {
  const g = await gate(req, body);
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
  const g = await gate(req, body);
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
  const g = await gate(req, body);
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
      case "search":  out = await doSearch(req, body);   break;
      case "chart":   out = await doChart(req, body);    break;
      case "email":   out = await doEmail(req, body);    break;
      default:
        return res.status(400).json({ error: "פעולה לא מוכרת." });
    }
    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error("[documents] " + action + " threw:", e.message);
    return res.status(500).json({ error: "שגיאה בשרת. נסו שוב." });
  }
}
