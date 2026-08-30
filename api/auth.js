// api/auth.js — התחברות עצמאית לאקדמיה (קוד חד-פעמי למייל)
//
// מחליף את ההתחברות של שופיפיי. התלמיד מקליד מייל בעמוד האקדמיה, מקבל קוד
// בן 6 ספרות, מקליד אותו באותו עמוד — ונכנס. הוא לא עוזב את הדף.
//
// ארבע פעולות, קובץ אחד:
//   POST {action:"send",    email}        -> שולח קוד למייל
//   POST {action:"verify",  email, code}  -> מחזיר token
//   POST {action:"session", token}        -> {loggedIn, email}
//   POST {action:"logout",  token}        -> מוחק את הסשן
//   POST {action:"balance", token}        -> {loggedIn, email, freeLeft, credits}
//   POST {action:"consume", token, tool}  -> מחייב שימוש אחד בכלי (חינם/קרדיט/בעלים)
//   POST {action:"grant", secret, email, credits, reference} -> מוסיף קרדיטים לכלי העיצוב
//   POST {action:"adminList",    token}                -> רשימת נרשמים (בעלים בלבד)
//   POST {action:"adminCredits", token, email, amount} -> שינוי קרדיטים (בעלים בלבד)
//
// balance/grant משרתים את כלי "עיצוב מחדש", שחולק את אותן טבלאות students/sessions —
// מי שנרשם לאקדמיה מזוהה גם בכלי, ולהפך. grant מוגן בסוד נפרד (DESIGN_GRANT_SECRET)
// והוא idempotent לפי reference, כך שאותה הזמנה לא תזוכה פעמיים.
//
// אותה תבנית כמו me.js / lessons.js / progress.js: אימות חתימת App Proxy,
// fetch רגיל מול Supabase REST, בלי חבילות npm חדשות.

import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET   = process.env.SHOPIFY_APP_SECRET;
const RESEND_KEY   = process.env.RESEND_API_KEY;

const FROM             = "אלרון פרינט <academy@elronprint.co.il>";
const CODE_TTL_MIN     = 10;   // תוקף הקוד בדקות
const SESSION_TTL_DAYS = 30;   // כמה זמן התלמיד נשאר מחובר
const MAX_ATTEMPTS     = 5;    // ניחושים לקוד לפני שהוא נפסל
const MAX_SENDS_PER_HR = 5;    // כמה קודים אפשר לבקש לאותו מייל בשעה
const FREE_RUNS        = 1;    // עיצוב חינם אחד לחשבון בכלי "עיצוב מחדש" (חייב להיות זהה ל-reimagine.js)

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

async function sbDelete(path) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: "DELETE",
    headers: sbHeaders({ Prefer: "return=minimal" })
  });
  if (!r.ok) throw new Error("Supabase DELETE " + path + " -> " + r.status + " " + (await r.text()));
}

/* ---------- חתימת App Proxy ---------- */

function verifyProxySignature(query) {
  if (!APP_SECRET) return false;
  const rest = Object.assign({}, query);
  const signature = rest.signature;
  delete rest.signature;
  if (!signature) return false;

  const msg = Object.keys(rest).sort().map(function (k) {
    const v = rest[k];
    return k + "=" + (Array.isArray(v) ? v.join(",") : v);
  }).join("");

  const digest = crypto.createHmac("sha256", APP_SECRET).update(msg).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(String(signature), "utf8")
    );
  } catch (e) {
    return false;
  }
}

/* ---------- עזרים ---------- */

// הקוד והטוקן אף פעם לא נשמרים כמו שהם — רק הטביעה שלהם
function hash(s) {
  return crypto.createHmac("sha256", APP_SECRET || "fallback").update(String(s)).digest("hex");
}

function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;
}

function newCode() {
  // 6 ספרות, מקור אקראי אמיתי
  return String(crypto.randomInt(100000, 1000000));
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function plus(ms) {
  return new Date(Date.now() + ms).toISOString();
}

const enc = encodeURIComponent;

/* ---------- שליחת המייל ---------- */

async function sendCodeEmail(email, code) {
  const html =
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;padding:32px">' +
      '<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center">' +
        '<h1 style="margin:0 0 4px;font-size:22px;color:#111">אלרון פרינט</h1>' +
        '<p style="margin:0 0 20px;color:#888;font-size:14px">כלי ה-AI של אלרון פרינט</p>' +
        '<p style="margin:0 0 24px;color:#555;font-size:15px">זה קוד הכניסה שלך:</p>' +
        '<div style="font-size:38px;font-weight:700;letter-spacing:10px;color:#2f6fed;' +
             'background:#f0f4ff;border-radius:10px;padding:18px 0;margin-bottom:24px">' + code + '</div>' +
        '<p style="margin:0 0 6px;color:#555;font-size:14px">הקוד תקף ל-' + CODE_TTL_MIN + ' דקות.</p>' +
        '<p style="margin:0;color:#999;font-size:13px">אם לא ביקשת קוד — אפשר להתעלם מהמייל הזה.</p>' +
      '</div>' +
      '<p style="text-align:center;color:#aaa;font-size:12px;margin-top:20px">elronprint.co.il</p>' +
    '</div>';

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: "קוד הכניסה שלך לאלרון פרינט: " + code,
      html: html
    })
  });

  if (!r.ok) throw new Error("Resend -> " + r.status + " " + (await r.text()));
}

/* ---------- סשן ---------- */

async function studentByToken(token) {
  if (!token || String(token).length < 32) return null;
  const rows = await sbGet(
    "sessions?token_hash=eq." + enc(hash(token)) +
    "&select=id,student_id,expires_at,students(id,email)&limit=1"
  );
  const s = rows[0];
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await sbDelete("sessions?id=eq." + enc(s.id));
    return null;
  }
  // last_seen לא חייב להצליח — לא מפיל את הבקשה
  sbPatch("sessions?id=eq." + enc(s.id), { last_seen_at: new Date().toISOString() }).catch(function () {});
  return {
    sessionId: s.id,
    studentId: s.student_id,
    email: (s.students && s.students.email) || null
  };
}

/* ---------- הפעולות ---------- */

async function doSend(email) {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await sbGet(
    "login_codes?email=eq." + enc(email) + "&created_at=gte." + enc(since) + "&select=id"
  );
  if (recent.length >= MAX_SENDS_PER_HR) {
    return { status: 429, body: { error: "ביקשת יותר מדי קודים. נסה שוב בעוד שעה." } };
  }

  const code = newCode();
  await sbPost("login_codes", {
    email: email,
    code_hash: hash(code),
    expires_at: plus(CODE_TTL_MIN * 60 * 1000)
  }, "return=minimal");

  await sendCodeEmail(email, code);
  return { status: 200, body: { sent: true, ttlMinutes: CODE_TTL_MIN } };
}

async function doVerify(email, code) {
  if (!/^\d{6}$/.test(String(code || ""))) {
    return { status: 400, body: { error: "הקוד צריך להיות 6 ספרות." } };
  }

  const rows = await sbGet(
    "login_codes?email=eq." + enc(email) +
    "&used_at=is.null&order=created_at.desc&limit=1" +
    "&select=id,code_hash,expires_at,attempts"
  );
  const rec = rows[0];
  if (!rec) return { status: 400, body: { error: "לא נמצא קוד פעיל. בקש קוד חדש." } };

  if (new Date(rec.expires_at).getTime() < Date.now()) {
    return { status: 400, body: { error: "הקוד פג תוקף. בקש קוד חדש." } };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    return { status: 429, body: { error: "יותר מדי ניסיונות. בקש קוד חדש." } };
  }
  if (rec.code_hash !== hash(code)) {
    await sbPatch("login_codes?id=eq." + enc(rec.id), { attempts: rec.attempts + 1 });
    return { status: 400, body: { error: "קוד שגוי. נסה שוב." } };
  }

  await sbPatch("login_codes?id=eq." + enc(rec.id), { used_at: new Date().toISOString() });

  // מוצאים או יוצרים את התלמיד לפי המייל
  let found = await sbGet("students?email=eq." + enc(email) + "&select=id&limit=1");
  let studentId = found[0] && found[0].id;
  if (!studentId) {
    const created = await sbPost("students", { email: email });
    studentId = created[0] && created[0].id;
  }
  if (!studentId) return { status: 500, body: { error: "לא הצלחנו ליצור את התלמיד." } };

  const token = newToken();
  await sbPost("sessions", {
    token_hash: hash(token),
    student_id: studentId,
    expires_at: plus(SESSION_TTL_DAYS * 86400 * 1000)
  }, "return=minimal");

  return { status: 200, body: { token: token, email: email, loggedIn: true } };
}

/* ---------- כלי "עיצוב מחדש": יתרה וזיכוי ---------- */

function isOwnerEmail(email) {
  const list = String(process.env.OWNER_EMAILS || "")
    .split(",")
    .map(function (x) { return x.trim().toLowerCase(); })
    .filter(Boolean);
  return !!email && list.indexOf(String(email).trim().toLowerCase()) !== -1;
}

async function designBalance(studentId, credits) {
  const runs = await sbGet(
    "design_runs?student_id=eq." + enc(studentId) + "&charged=is.false&select=id"
  );
  return {
    freeLeft: Math.max(0, FREE_RUNS - runs.length),
    credits: credits || 0
  };
}

/* חיוב שימוש אחד בכלי דפדפן (הסרת רקע, עורך תמונות, ברכות וכו').
   אותו מונה בדיוק כמו "עיצוב מחדש": ריצה חינם אחת לחשבון, אחר כך קרדיט לשימוש.
   הבעלים לא מחויב אף פעם, אבל השימוש נרשם ל-design_runs לצורך היסטוריה. */
async function doConsume(body) {
  const s = await studentByToken(body.token);
  if (!s) return { status: 401, body: { error: "צריך להתחבר.", needLogin: true } };

  const tool = String(body.tool || "").slice(0, 40);

  if (isOwnerEmail(s.email)) {
    await sbPost("design_runs", { student_id: s.studentId, charged: false }, "return=minimal")
      .catch(function (e) { console.error("owner run log failed:", e); });
    return { status: 200, body: { ok: true, owner: true, tool: tool, freeLeft: null, credits: null } };
  }

  const rows = await sbGet(
    "students?id=eq." + enc(s.studentId) + "&select=design_credits&limit=1"
  );
  const credits = (rows[0] && rows[0].design_credits) || 0;
  const bal = await designBalance(s.studentId, credits);

  if (bal.freeLeft > 0) {
    await sbPost("design_runs", { student_id: s.studentId, charged: false }, "return=minimal");
    return {
      status: 200,
      body: { ok: true, owner: false, tool: tool, freeLeft: bal.freeLeft - 1, credits: credits }
    };
  }

  if (credits > 0) {
    await sbPost("design_runs", { student_id: s.studentId, charged: true }, "return=minimal");
    await sbPatch("students?id=eq." + enc(s.studentId), {
      design_credits: Math.max(0, credits - 1)
    });
    return {
      status: 200,
      body: { ok: true, owner: false, tool: tool, freeLeft: 0, credits: credits - 1 }
    };
  }

  return {
    status: 402,
    body: { error: "נגמרו הקרדיטים.", needCredits: true, freeLeft: 0, credits: 0 }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   קרדיטים של כלי האווטר — בריכה נפרדת לגמרי מ"עיצוב מחדש".
   נוסף 2026-08-27.

   למה נפרד: סרטון אווטר עולה ~35 אגורות ונמכר ב-~10 ש"ח,
   בעוד שעיצוב עולה אגורות בודדות. בריכה משותפת הייתה מאפשרת ללקוח
   לקנות קרדיטים בזול בכלי אחד ולהוציא אותם ביקר בכלי השני.

   עמודה: students.avatar_credits    טבלאות: avatar_runs, avatar_grants
   כל הפעולות כאן נוגעות רק בהן, ולעולם לא ב-design_credits.
   ═══════════════════════════════════════════════════════════════════ */

const AVATAR_FREE_RUNS = 1;   // סרטון חינם אחד לחשבון, כדי שלקוח יראה תוצאה לפני שהוא משלם

async function avatarBalance(studentId, credits) {
  const runs = await sbGet(
    "avatar_runs?student_id=eq." + enc(studentId) + "&charged=is.false&select=id"
  );
  return {
    freeLeft: Math.max(0, AVATAR_FREE_RUNS - runs.length),
    credits: credits || 0
  };
}

async function doAvatarConsume(body) {
  const s = await studentByToken(body.token);
  if (!s) return { status: 401, body: { error: "צריך להתחבר.", needLogin: true } };

  if (isOwnerEmail(s.email)) {
    await sbPost("avatar_runs", { student_id: s.studentId, charged: false }, "return=minimal")
      .catch(function (e) { console.error("owner avatar run log failed:", e); });
    return { status: 200, body: { ok: true, owner: true, freeLeft: null, credits: null } };
  }

  const rows = await sbGet(
    "students?id=eq." + enc(s.studentId) + "&select=avatar_credits&limit=1"
  );
  const credits = (rows[0] && rows[0].avatar_credits) || 0;
  const bal = await avatarBalance(s.studentId, credits);

  if (bal.freeLeft > 0) {
    await sbPost("avatar_runs", { student_id: s.studentId, charged: false }, "return=minimal");
    return {
      status: 200,
      body: { ok: true, owner: false, freeLeft: bal.freeLeft - 1, credits: credits }
    };
  }

  if (credits > 0) {
    await sbPost("avatar_runs", { student_id: s.studentId, charged: true }, "return=minimal");
    await sbPatch("students?id=eq." + enc(s.studentId), {
      avatar_credits: Math.max(0, credits - 1)
    });
    return {
      status: 200,
      body: { ok: true, owner: false, freeLeft: 0, credits: credits - 1 }
    };
  }

  return {
    status: 402,
    body: { error: "נגמרו הקרדיטים.", needCredits: true, freeLeft: 0, credits: 0 }
  };
}

/* שמירת סרטון מוגמר לחשבון הלקוח.
   נקראת אחרי שהסרטון כבר הועבר ל-Cloudinary, כך שהכתובת קבועה.
   לא מחייבת כלום — החיוב כבר קרה ב-avatarConsume לפני היצירה. */
async function doAvatarSave(body) {
  const s = await studentByToken(body.token);
  if (!s) return { status: 401, body: { error: "\u05e6\u05e8\u05d9\u05da \u05dc\u05d4\u05ea\u05d7\u05d1\u05e8.", needLogin: true } };

  const url = String(body.url || "").trim();
  if (!/^https:\/\//.test(url)) {
    return { status: 400, body: { error: "\u05db\u05ea\u05d5\u05d1\u05ea \u05dc\u05d0 \u05ea\u05e7\u05d9\u05e0\u05d4." } };
  }

  const seconds = Number(body.seconds);
  await sbPost("avatar_videos", {
    student_id: s.studentId,
    url: url.slice(0, 500),
    avatar_name: body.avatarName ? String(body.avatarName).slice(0, 80) : null,
    seconds: Number.isFinite(seconds) ? Math.round(seconds) : null
  }, "return=minimal");

  return { status: 200, body: { saved: true } };
}

/* רשימת הסרטונים של הלקוח, החדש ראשון.
   יושבת בשרת ולא בדפדפן — לכן היא זהה בנייד ובמחשב. */
async function doAvatarVideos(body) {
  const s = await studentByToken(body.token);
  if (!s) return { status: 200, body: { loggedIn: false, videos: [] } };

  const rows = await sbGet(
    "avatar_videos?student_id=eq." + enc(s.studentId) +
    "&select=url,avatar_name,seconds,created_at&order=created_at.desc&limit=100"
  );
  return { status: 200, body: { loggedIn: true, videos: rows || [] } };
}

async function doAvatarGrant(body) {
  const secret = process.env.DESIGN_GRANT_SECRET;
  if (!secret || String(body.secret || "") !== secret) {
    return { status: 401, body: { error: "לא מורשה" } };
  }

  const email = normEmail(body.email);
  if (!validEmail(email)) {
    return { status: 400, body: { error: "כתובת המייל לא תקינה." } };
  }

  const credits = parseInt(body.credits, 10);
  if (!Number.isFinite(credits) || credits < 1 || credits > 1000) {
    return { status: 400, body: { error: "מספר קרדיטים לא תקין." } };
  }

  // אותה הזמנה לא מזוכה פעמיים
  const reference = body.reference ? String(body.reference).slice(0, 200) : null;
  if (reference) {
    const seen = await sbGet("avatar_grants?reference=eq." + enc(reference) + "&select=id&limit=1");
    if (seen.length) {
      return { status: 200, body: { granted: false, already: true } };
    }
  }

  let found = await sbGet("students?email=eq." + enc(email) + "&select=id,avatar_credits&limit=1");
  let student = found[0];
  if (!student) {
    const created = await sbPost("students", { email: email });
    student = created[0];
  }
  if (!student) return { status: 500, body: { error: "לא הצלחנו ליצור את החשבון." } };

  const next = (student.avatar_credits || 0) + credits;
  await sbPatch("students?id=eq." + enc(student.id), { avatar_credits: next });
  await sbPost(
    "avatar_grants",
    { student_id: student.id, credits: credits, reference: reference },
    "return=minimal"
  );

  return { status: 200, body: { granted: true, credits: next } };
}

async function doGrant(body) {
  const secret = process.env.DESIGN_GRANT_SECRET;
  if (!secret || String(body.secret || "") !== secret) {
    return { status: 401, body: { error: "לא מורשה" } };
  }

  const email = normEmail(body.email);
  if (!validEmail(email)) {
    return { status: 400, body: { error: "כתובת המייל לא תקינה." } };
  }

  const credits = parseInt(body.credits, 10);
  if (!Number.isFinite(credits) || credits < 1 || credits > 1000) {
    return { status: 400, body: { error: "מספר קרדיטים לא תקין." } };
  }

  // אותה הזמנה לא מזוכה פעמיים
  const reference = body.reference ? String(body.reference).slice(0, 200) : null;
  if (reference) {
    const seen = await sbGet("design_grants?reference=eq." + enc(reference) + "&select=id&limit=1");
    if (seen.length) {
      return { status: 200, body: { granted: false, already: true } };
    }
  }

  // החשבון נוצר אם עוד לא קיים, כדי שאפשר יהיה לזכות לפני ההתחברות הראשונה
  let found = await sbGet("students?email=eq." + enc(email) + "&select=id,design_credits&limit=1");
  let student = found[0];
  if (!student) {
    const created = await sbPost("students", { email: email });
    student = created[0];
  }
  if (!student) return { status: 500, body: { error: "לא הצלחנו ליצור את החשבון." } };

  const next = (student.design_credits || 0) + credits;
  await sbPatch("students?id=eq." + enc(student.id), { design_credits: next });
  await sbPost(
    "design_grants",
    { student_id: student.id, credits: credits, reference: reference },
    "return=minimal"
  );

  return { status: 200, body: { granted: true, credits: next } };
}

/* ---------- handler ---------- */

/* ---------- לוח בקרה לבעלים ----------
   נוסף לכאן ולא כ-endpoint נפרד בגלל מגבלת מספר הפונקציות בתוכנית Hobby.
   ההרשאה נבדקת בשרת בלבד: הטוקן -> חשבון -> המייל מול OWNER_EMAILS.
   שום דגל שמגיע מהדפדפן לא נלקח בחשבון. */

async function requireOwner(token) {
  const s = await studentByToken(token);
  if (!s) return { err: { status: 401, body: { error: "צריך להתחבר.", needLogin: true } } };
  if (!isOwnerEmail(s.email)) {
    return { err: { status: 403, body: { error: "אין הרשאה לדף הזה." } } };
  }
  return { session: s };
}

async function doAdminList(body) {
  const gate = await requireOwner(body.token);
  if (gate.err) return gate.err;

  const students = await sbGet("students?select=*&order=id.desc&limit=500");
  const runs = await sbGet("design_runs?select=student_id,charged&limit=5000");

  const byStudent = {};
  for (const r of runs) {
    const k = String(r.student_id);
    if (!byStudent[k]) byStudent[k] = { total: 0, charged: 0 };
    byStudent[k].total += 1;
    if (r.charged) byStudent[k].charged += 1;
  }

  const list = students.map(function (st) {
    const stats = byStudent[String(st.id)] || { total: 0, charged: 0 };
    return {
      id: st.id,
      email: st.email || "",
      credits: st.design_credits || 0,
      runs: stats.total,
      paidRuns: stats.charged,
      createdAt: st.created_at || st.inserted_at || null,
      owner: isOwnerEmail(st.email)
    };
  });

  return {
    status: 200,
    body: {
      students: list,
      totals: {
        students: list.length,
        runs: runs.length,
        paidRuns: runs.filter(function (r) { return r.charged; }).length
      }
    }
  };
}

async function doAdminCredits(body) {
  const gate = await requireOwner(body.token);
  if (gate.err) return gate.err;

  const target = normEmail(body.email);
  const amount = parseInt(body.amount, 10);

  if (!validEmail(target)) return { status: 400, body: { error: "מייל לא תקין." } };
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) {
    return { status: 400, body: { error: "כמות לא תקינה." } };
  }

  const rows = await sbGet(
    "students?email=eq." + enc(target) + "&select=id,email,design_credits&limit=1"
  );
  const st = rows[0];
  if (!st) return { status: 404, body: { error: "לא נמצא לקוח עם המייל הזה." } };

  const next = Math.max(0, (st.design_credits || 0) + amount);
  await sbPatch("students?id=eq." + enc(st.id), { design_credits: next });

  return { status: 200, body: { email: st.email, credits: next } };
}

/* מחיקת לקוח מלוח הבקרה.
   הרשאה נבדקת בשרת בלבד, כמו בשאר פעולות הלוח — הטוקן מול OWNER_EMAILS.

   שתי הגנות שקיימות כאן ולא בשאר הפעולות:
   1. חשבון בעלים לא ניתן למחיקה. מחיקה בטעות של חשבון הבעלים מנתקת את הגישה ללוח עצמו, ואז אין
      דרך לתקן מהממשק.
   2. מחיקת השורות התלויות קודמת למחיקת הלקוח. ל-design_runs יש student_id, ואם מוגדר עליו מפתח זר
      מחיקת הלקוח לבדו תיחסם. סדר כזה עובד בשני המקרים — עם מפתח זר ובלעדיו.

   הטוקנים של אותו לקוח נמחקים גם הם, אחרת טוקן שכבר בדפדפן שלו ממשיך להיות תקף אחרי המחיקה. */
async function doAdminDelete(body) {
  const gate = await requireOwner(body.token);
  if (gate.err) return gate.err;

  /* Identify by id first. A row can exist with a blank e-mail — one did — and such a row can never
     be addressed by e-mail at all, so it was undeletable from the dashboard. The id always exists. */
  const rawId = body.id;
  const hasId = rawId !== undefined && rawId !== null && String(rawId).trim() !== "";

  let st;
  if (hasId) {
    const rows = await sbGet("students?id=eq." + enc(String(rawId).trim()) + "&select=id,email&limit=1");
    st = rows[0];
    if (!st) return { status: 404, body: { error: "הלקוח כבר לא קיים. רעננו את הרשימה." } };
    if (st.email && isOwnerEmail(st.email)) {
      return { status: 400, body: { error: "אי אפשר למחוק חשבון בעלים." } };
    }
  } else {
    const target = normEmail(body.email);
    if (!validEmail(target)) return { status: 400, body: { error: "מייל לא תקין." } };
    if (isOwnerEmail(target)) {
      return { status: 400, body: { error: "אי אפשר למחוק חשבון בעלים." } };
    }
    const rows = await sbGet("students?email=eq." + enc(target) + "&select=id,email&limit=1");
    st = rows[0];
    if (!st) return { status: 404, body: { error: "לא נמצא לקוח עם המייל הזה." } };
  }

  /* Every table that references students must be cleared first, or Postgres refuses the delete with
     a foreign-key error. avatar_runs was found the hard way, from a real 23503 telling us the row
     was "still referenced from table avatar_runs". Rather than wait for the next failure, the rest
     of this list was read off the tables this same file writes to with a student_id. login_codes is
     keyed by e-mail rather than student in some builds, which is why an unknown-column response is
     tolerated below instead of failing the delete.
     Unknown tables are tolerated (a 404 from PostgREST is fine); a real FK failure is not, and is
     reported below with the table named so the next one takes minutes instead of a debugging round. */
  const DEPENDENTS = [
    "design_runs", "design_grants",
    "avatar_runs", "avatar_grants", "avatar_videos",
    "login_codes", "sessions"
  ];
  const stuck = [];
  for (const table of DEPENDENTS) {
    try {
      await sbDelete(table + "?student_id=eq." + enc(st.id));
    } catch (e) {
      const msg = String(e.message || "");
      /* A table that does not exist in this project is not a problem worth failing over. */
      if (/-> 40[04]\b/.test(msg) && !/23503/.test(msg)) {
        console.warn("[auth] adminDelete: skipping " + table + " (" + msg.slice(0, 80) + ")");
        continue;
      }
      stuck.push(table);
      console.error("[auth] adminDelete: could not clear " + table + ":", msg.slice(0, 200));
    }
  }

  /* Stop before touching students. Deleting the dependants and then failing leaves the account
     present but stripped of its history — which is what happened here on the first attempt, and is
     worse than not starting, because a retry looks like it changed nothing. */
  if (stuck.length) {
    return {
      status: 409,
      body: {
        error: "לא ניתן למחוק — נשארו רשומות מקושרות בטבלאות: " + stuck.join(", ") + ".",
        blockedBy: stuck
      }
    };
  }

  try {
    await sbDelete("students?id=eq." + enc(st.id));
  } catch (e) {
    const msg = String(e.message || "");
    /* Name the table in the message so the next unknown dependant is a one-line fix. */
    const m = msg.match(/referenced from table \\?"([^"\\]+)/);
    console.error("[auth] adminDelete: students delete failed:", msg.slice(0, 300));
    return {
      status: 409,
      body: {
        error: m
          ? ("לא ניתן למחוק — יש רשומות מקושרות בטבלה \"" + m[1] + "\". צריך להוסיף אותה לרשימת התלויות.")
          : "לא ניתן למחוק את הלקוח. בדקו את הלוג.",
        blockedBy: m ? [m[1]] : []
      }
    };
  }
  const label = st.email || ("\u05dc\u05e7\u05d5\u05d7 #" + st.id);
  console.log("[auth] adminDelete: removed " + label);

  return { status: 200, body: { deleted: true, email: st.email || "", label: label } };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!verifyProxySignature(req.query || {})) {
      return res.status(401).json({ error: "חתימה לא תקינה" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const action = String(body.action || "");
    const email  = normEmail(body.email);

    if (action === "send" || action === "verify") {
      if (!validEmail(email)) {
        return res.status(400).json({ error: "כתובת המייל לא תקינה." });
      }
    }

    if (action === "send") {
      const out = await doSend(email);
      return res.status(out.status).json(out.body);
    }

    if (action === "verify") {
      const out = await doVerify(email, body.code);
      return res.status(out.status).json(out.body);
    }

    if (action === "session") {
      const s = await studentByToken(body.token);
      return res.status(200).json(s ? { loggedIn: true, email: s.email } : { loggedIn: false });
    }

    if (action === "balance") {
      const s = await studentByToken(body.token);
      if (!s) return res.status(200).json({ loggedIn: false });
      const rows = await sbGet("students?id=eq." + enc(s.studentId) + "&select=design_credits&limit=1");
      if (isOwnerEmail(s.email)) {
        return res.status(200).json({ loggedIn: true, email: s.email, owner: true });
      }
      const bal = await designBalance(s.studentId, rows[0] && rows[0].design_credits);
      return res.status(200).json(Object.assign({ loggedIn: true, email: s.email }, bal));
    }

    if (action === "consume") {
      const out = await doConsume(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "avatarBalance") {
      const s = await studentByToken(body.token);
      if (!s) return res.status(200).json({ loggedIn: false });
      if (isOwnerEmail(s.email)) {
        return res.status(200).json({ loggedIn: true, email: s.email, owner: true });
      }
      const rows = await sbGet("students?id=eq." + enc(s.studentId) + "&select=avatar_credits&limit=1");
      const bal = await avatarBalance(s.studentId, rows[0] && rows[0].avatar_credits);
      return res.status(200).json(Object.assign({ loggedIn: true, email: s.email }, bal));
    }

    if (action === "avatarConsume") {
      const out = await doAvatarConsume(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "avatarSave") {
      const out = await doAvatarSave(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "avatarVideos") {
      const out = await doAvatarVideos(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "avatarGrant") {
      const out = await doAvatarGrant(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "adminList") {
      const out = await doAdminList(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "adminCredits") {
      const out = await doAdminCredits(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "adminDelete") {
      const out = await doAdminDelete(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "grant") {
      const out = await doGrant(body);
      return res.status(out.status).json(out.body);
    }

    if (action === "logout") {
      if (body.token) {
        await sbDelete("sessions?token_hash=eq." + enc(hash(body.token))).catch(function () {});
      }
      return res.status(200).json({ loggedIn: false });
    }

    return res.status(400).json({ error: "פעולה לא מוכרת" });

  } catch (err) {
    console.error("auth handler error:", err);
    return res.status(500).json({ error: "שגיאה בשרת. נסה שוב בעוד רגע." });
  }
}
