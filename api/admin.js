import crypto from "crypto";
import { checkRateLimit } from "./_ratelimit.js";

// api/admin.js — לוח בקרה לבעלים בלבד
//
// מציג את הנרשמים לכלי ה-AI (טבלת students ב-Supabase) ומאפשר להוסיף קרדיטים ידנית.
//
// אבטחה — הנקודה הקריטית בקובץ הזה:
// הדף חושף כתובות מייל של לקוחות. לכן ההרשאה נבדקת אך ורק בשרת:
// הטוקן מתורגם לחשבון מול Supabase, והמייל של אותו חשבון נבדק מול OWNER_EMAILS.
// שום דגל שמגיע מהדפדפן לא נלקח בחשבון. מי שאינו בעלים מקבל 403 ולא רואה כלום.

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

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
    },
    extra || {}
  );
}

async function sbGet(path) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { headers: sbHeaders() });
  const t = await r.text();
  if (!r.ok) throw new Error("Supabase GET " + path + " -> " + r.status + " " + t);
  return t ? JSON.parse(t) : [];
}

async function sbPatch(path, body) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Supabase PATCH " + path + " -> " + r.status + " " + (await r.text()));
}

function tokenHash(t) {
  return crypto
    .createHmac("sha256", process.env.SHOPIFY_APP_SECRET || "fallback")
    .update(String(t))
    .digest("hex");
}

async function studentFromToken(token) {
  if (!token || String(token).length < 32) return null;
  const rows = await sbGet(
    "sessions?token_hash=eq." + encodeURIComponent(tokenHash(token)) +
    "&select=expires_at,students(id,email,design_credits)&limit=1"
  );
  const s = rows[0];
  if (!s || !s.students) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return s.students;
}

function isOwner(email) {
  const list = String(process.env.OWNER_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
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

  // ---- הרשאה: נבדקת בשרת בלבד ----
  const me = await studentFromToken(body.token);
  if (!me) return res.status(401).json({ error: "צריך להתחבר.", needLogin: true });
  if (!isOwner(me.email)) return res.status(403).json({ error: "אין הרשאה לדף הזה." });

  try {
    // ---- רשימת נרשמים ----
    if (body.action === "list") {
      const students = await sbGet("students?select=*&order=id.desc&limit=500");
      const runs = await sbGet("design_runs?select=student_id,charged&limit=5000");

      const byStudent = {};
      for (const r of runs) {
        const k = String(r.student_id);
        if (!byStudent[k]) byStudent[k] = { total: 0, charged: 0 };
        byStudent[k].total += 1;
        if (r.charged) byStudent[k].charged += 1;
      }

      const list = students.map((s) => {
        const stats = byStudent[String(s.id)] || { total: 0, charged: 0 };
        return {
          email: s.email || "",
          credits: s.design_credits || 0,
          runs: stats.total,
          paidRuns: stats.charged,
          createdAt: s.created_at || s.inserted_at || null,
          owner: isOwner(s.email),
        };
      });

      const totals = {
        students: list.length,
        runs: runs.length,
        paidRuns: runs.filter((r) => r.charged).length,
      };

      return res.status(200).json({ students: list, totals });
    }

    // ---- הוספת קרדיטים ידנית ----
    if (body.action === "addCredits") {
      const email = String(body.email || "").trim().toLowerCase();
      const amount = parseInt(body.amount, 10);

      if (!email) return res.status(400).json({ error: "חסר מייל." });
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) {
        return res.status(400).json({ error: "כמות לא תקינה." });
      }

      const rows = await sbGet(
        "students?email=eq." + encodeURIComponent(email) + "&select=id,email,design_credits&limit=1"
      );
      const target = rows[0];
      if (!target) return res.status(404).json({ error: "לא נמצא לקוח עם המייל הזה." });

      const next = Math.max(0, (target.design_credits || 0) + amount);
      await sbPatch("students?id=eq." + encodeURIComponent(target.id), { design_credits: next });

      return res.status(200).json({ email: target.email, credits: next });
    }

    return res.status(400).json({ error: "פעולה לא מוכרת." });
  } catch (err) {
    console.error("[admin]", err);
    return res.status(502).json({ error: "שגיאת שרת." });
  }
}
