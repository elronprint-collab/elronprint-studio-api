// ============================================================
// ElronPrint AI Academy — נקודת הקצה של המורה הפרטי
// מיקום: /api/chat.js  בפרויקט elronprint-studio-api
//
// זרימה:
//   עמוד Shopify -> App Proxy (חותם את הבקשה) -> הקובץ הזה -> Gemini
//
// ⚠️ הקובץ הזה לא מוסיף שום ספרייה חדשה לפרויקט.
//    הוא עובד עם fetch בלבד, כדי לא לגעת בכלים הקיימים שכבר רצים שם.
//
// משתני סביבה נדרשים ב-Vercel (Settings -> Environment Variables):
//   SHOPIFY_APP_SECRET      — הסוד של האפליקציה המותאמת בשופיפיי
//   SUPABASE_URL            — כתובת הפרויקט ב-Supabase
//   SUPABASE_SERVICE_KEY    — מפתח service_role (לעולם לא בדפדפן!)
//   GEMINI_API_KEY          — המפתח מ-Google AI Studio
// ============================================================

import crypto from 'crypto';

const MODEL = 'gemini-3.5-flash-lite';
const MAX_QUESTION_CHARS = 1500;
const HISTORY_LIMIT = 10;

// ------------------------------------------------------------
// גישה ל-Supabase דרך ה-REST API (בלי ספריות)
// ------------------------------------------------------------
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders(extra = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbGet(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbPost(path, body, prefer) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbPatch(path, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} -> ${res.status} ${await res.text()}`);
}

// ------------------------------------------------------------
// אימות חתימת Shopify App Proxy
// ------------------------------------------------------------
function verifyProxySignature(query, secret) {
  const { signature, ...rest } = query;
  if (!signature || !secret) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(',') : rest[key];
      return `${key}=${value}`;
    })
    .join('');

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// הוראת המערכת — מגדירה את אופי המורה
// ------------------------------------------------------------
function buildSystemPrompt(student, lesson) {
  const lines = [
    'אתה מורה פרטי לבינה מלאכותית, שמלמד בעברית בלבד.',
    'הקהל שלך הוא מתחילים גמורים. הסבר פשוט, בלי מונחים באנגלית שלא הוסברו.',
    'אל תיתן רק תשובה — תלמד. תן דוגמה קונקרטית ואז בקש מהתלמיד לנסות בעצמו.',
    'תשובות קצרות: עד 4 פסקאות. אם השאלה גדולה, פרק אותה לשלבים.',
    'אם התלמיד שואל משהו שאינו קשור ללימוד AI, החזר אותו בעדינות לנושא.',
    'לעולם אל תמציא עובדות. אם אינך יודע, אמור זאת.',
    `רמת התלמיד: ${student.level}.`,
  ];

  if (lesson) {
    lines.push(
      `התלמיד נמצא כעת בשיעור "${lesson.title}".`,
      `תקציר השיעור: ${lesson.summary || '—'}`,
      `המשימה בשיעור: ${lesson.task || '—'}`,
      'קשר את התשובה שלך לשיעור הזה כשזה רלוונטי.'
    );
  }

  return lines.join('\n');
}

// ------------------------------------------------------------
// ההנדלר
// ------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- 1. אימות שהבקשה הגיעה דרך החנות ---
  if (!verifyProxySignature(req.query, process.env.SHOPIFY_APP_SECRET)) {
    return res.status(401).json({ error: 'חתימה לא תקינה' });
  }

  // ---- מצב אורח (זמני) ----
  // שופיפיי לא מוסרת מזהה לקוח בחשבונות מהסוג החדש, לכן כל מי שאינו מזוהה
  // נספר תחת תלמיד יחיד בשם "guest" עם מכסה כללית גבוהה יותר.
  // הבקשה עדיין חייבת לעבור אימות חתימה למעלה — זה לא פתוח לכל העולם.
  // כשנפתור את ההתחברות: להחזיר כאן 401 ולמחוק את GUEST_LIMIT.
  const customerId = req.query.logged_in_customer_id || 'guest';
  const isGuest = customerId === 'guest';
  const GUEST_LIMIT = 100;

  // --- 2. קלט ---
  const { message, lessonId } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'לא נשלחה שאלה' });
  }
  const question = message.trim().slice(0, MAX_QUESTION_CHARS);

  try {
    // --- 3. תלמיד (יצירה בפעם הראשונה) ---
    const found = await sbGet(
      `students?shopify_customer_id=eq.${encodeURIComponent(customerId)}&select=*&limit=1`
    );
    let student = found[0];

    if (!student) {
      const created = await sbPost(
        'students',
        { shopify_customer_id: String(customerId) },
        'return=representation'
      );
      student = created[0];
    }

    // --- 4. בדיקת מכסה יומית ---
    const today = new Date().toISOString().slice(0, 10);
    const usageRows = await sbGet(
      `usage_daily?student_id=eq.${student.id}&day=eq.${today}&select=questions_count&limit=1`
    );
    const used = usageRows[0]?.questions_count || 0;

    const limit = isGuest ? GUEST_LIMIT : student.daily_question_limit;

    if (used >= limit) {
      return res.status(429).json({
        error: `הגענו למכסת ${limit} השאלות להיום. נתראה מחר!`,
      });
    }

    // --- 5. הקשר: השיעור הנוכחי + היסטוריית שיחה ---
    let lesson = null;
    if (lessonId) {
      const rows = await sbGet(
        `lessons?id=eq.${encodeURIComponent(lessonId)}&select=title,summary,task&limit=1`
      );
      lesson = rows[0] || null;
    }

    const history = await sbGet(
      `chat_messages?student_id=eq.${student.id}&select=role,content` +
        `&order=created_at.desc&limit=${HISTORY_LIMIT}`
    );

    const contents = history
      .reverse()
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    contents.push({ role: 'user', parts: [{ text: question }] });

    // --- 6. פנייה ל-Gemini בזרימה ---
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent` +
      `?alt=sse&key=${process.env.GEMINI_API_KEY}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(student, lesson) }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
      }),
    });

    if (!upstream.ok) {
      console.error('Gemini error:', upstream.status, await upstream.text());
      return res.status(502).json({ error: 'המורה לא זמין כרגע, נסה שוב בעוד רגע' });
    }

    // --- 7. העברת התשובה לדפדפן תוך כדי כתיבה ---
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = '';
    let buffer = '';
    let usageMeta = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const chunk = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (chunk) {
            fullAnswer += chunk;
            res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
          }
          if (json.usageMetadata) usageMeta = json.usageMetadata;
        } catch {
          // מקטע חלקי — מתעלמים
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // --- 8. שמירה ועדכון מונים (אחרי שהתשובה כבר אצל התלמיד) ---
    const tokensIn = usageMeta?.promptTokenCount || 0;
    const tokensOut = usageMeta?.candidatesTokenCount || 0;

    await sbPost('chat_messages', [
      { student_id: student.id, lesson_id: lessonId || null, role: 'user', content: question },
      {
        student_id: student.id,
        lesson_id: lessonId || null,
        role: 'assistant',
        content: fullAnswer,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      },
    ]);

    await sbPost('rpc/bump_usage', {
      p_student_id: student.id,
      p_tokens_in: tokensIn,
      p_tokens_out: tokensOut,
    });

    await sbPatch(`students?id=eq.${student.id}`, {
      last_seen_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('chat handler error:', err);
    if (!res.headersSent) {
      // אבחון זמני — מחזיר את הסיבה האמיתית כדי שנראה אותה בעמוד
      res.status(500).json({ error: 'שגיאה בשרת: ' + (err && err.message ? err.message : String(err)) });
    } else {
      res.end();
    }
  }
}
