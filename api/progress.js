// api/progress.js — מעקב התקדמות תלמידים באקדמיה + בדיקת בחנים
// GET  /apps/ai-academy/progress            -> { loggedIn, progress: {...}, quizScores: {...} }
// POST /apps/ai-academy/progress            -> body: { lessonSlug, status }  ("completed" | "in_progress")
// POST /apps/ai-academy/progress            -> body: { action:"quiz", lessonSlug, answers:{ "<questionId>": "<index>" } }
//                                              -> { score, correctCount, total, results:[...] }
//
// התשובות הנכונות נשמרות אך ורק כאן, בצד השרת. הדפדפן לא מקבל אותן לעולם
// לפני שהתלמיד שלח את הבוחן — אחרת אפשר היה לראות אותן בכלי המפתחים.
//
// עצמאי לחלוטין: אין תלות בקבצים אחרים ואין חבילות npm חדשות.
// אותה תבנית כמו me.js / lessons.js — אימות חתימת App Proxy + fetch רגיל מול Supabase REST.

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET = process.env.SHOPIFY_APP_SECRET;

const VALID_STATUS = ['in_progress', 'completed'];

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    extra || {}
  );
}

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: sbHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase GET ' + path + ' -> ' + r.status + ' ' + text);
  return text ? JSON.parse(text) : [];
}

async function sbPost(path, body, prefer) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'POST',
    headers: sbHeaders({ Prefer: prefer || 'return=representation' }),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase POST ' + path + ' -> ' + r.status + ' ' + text);
  return text ? JSON.parse(text) : [];
}

// אימות החתימה של Shopify App Proxy — זהה למה שיש ב-chat.js / me.js
function verifyProxySignature(query, secret) {
  if (!secret) return false;
  const { signature, ...rest } = query || {};
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = rest[key];
      return key + '=' + (Array.isArray(value) ? value.join(',') : value);
    })
    .join('');

  const digest = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// מוצא את התלמיד לפי מזהה הלקוח של Shopify. יוצר שורה אם היא לא קיימת (רק בכתיבה).
async function findStudent(customerId, createIfMissing) {
  const rows = await sbGet(
    'students?shopify_customer_id=eq.' + encodeURIComponent(customerId) + '&select=id&limit=1'
  );
  if (rows.length) return rows[0].id;
  if (!createIfMissing) return null;

  const created = await sbPost('students', { shopify_customer_id: customerId });
  return created && created[0] ? created[0].id : null;
}

// זהות התלמיד לפי סשן משלנו (נוצר ב-api/auth.js)
function epaiHash(s) {
  return crypto
    .createHmac('sha256', APP_SECRET || 'fallback')
    .update(String(s))
    .digest('hex');
}

function tokenFromReq(req, body) {
  return (
    req.headers['x-epai-token'] ||
    req.query.token ||
    (body && body.token) ||
    null
  );
}

async function studentIdFromToken(token) {
  if (!token || String(token).length < 32) return null;
  try {
    const rows = await sbGet(
      'sessions?token_hash=eq.' + encodeURIComponent(epaiHash(token)) +
      '&select=student_id,expires_at&limit=1'
    );
    const s = rows[0];
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    return s.student_id;
  } catch (e) {
    console.error('studentIdFromToken:', e);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!verifyProxySignature(req.query, APP_SECRET)) {
      return res.status(401).json({ error: 'חתימה לא תקינה' });
    }

    const customerId = req.query.logged_in_customer_id;
    let sessionStudentId = await studentIdFromToken(tokenFromReq(req, null));

    // אורח — לא שגיאה. פשוט אין התקדמות להציג ואין מה לשמור.
    if (!sessionStudentId && !customerId) {
      if (req.method === 'POST') {
        return res.status(200).json({ loggedIn: false, saved: false });
      }
      return res.status(200).json({ loggedIn: false, progress: {} });
    }

    // ---------- קריאה ----------
    if (req.method === 'GET') {
      const studentId = sessionStudentId || await findStudent(customerId, false);
      if (!studentId) return res.status(200).json({ loggedIn: true, progress: {} });

      const rows = await sbGet(
        'progress?student_id=eq.' + encodeURIComponent(studentId) + '&select=status,lessons(slug)'
      );

      const progress = {};
      for (const row of rows) {
        if (row && row.lessons && row.lessons.slug) {
          progress[row.lessons.slug] = row.status;
        }
      }
      // הציון הגבוה ביותר בכל בוחן
      const quizScores = {};
      try {
        const qrows = await sbGet(
          'quiz_results?student_id=eq.' + encodeURIComponent(studentId) + '&select=score,lessons(slug)'
        );
        for (const row of qrows) {
          if (row && row.lessons && row.lessons.slug) {
            const s = row.lessons.slug;
            if (quizScores[s] === undefined || row.score > quizScores[s]) {
              quizScores[s] = row.score;
            }
          }
        }
      } catch (e) {
        console.error('quizScores load failed:', e);
      }

      return res.status(200).json({ loggedIn: true, progress, quizScores });
    }

    // ---------- כתיבה ----------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          body = {};
        }
      }
      body = body || {};

      const lessonSlug = String(body.lessonSlug || '').trim();
      const status = VALID_STATUS.includes(body.status) ? body.status : 'completed';

      if (!lessonSlug) {
        return res.status(400).json({ error: 'חסר שיעור' });
      }

      const lessons = await sbGet(
        'lessons?slug=eq.' + encodeURIComponent(lessonSlug) + '&select=id&limit=1'
      );
      if (!lessons.length) {
        return res.status(404).json({ error: 'שיעור לא נמצא' });
      }

      if (!sessionStudentId) {
        sessionStudentId = await studentIdFromToken(tokenFromReq(req, body));
      }
      const studentId = sessionStudentId || await findStudent(customerId, true);
      if (!studentId) {
        return res.status(500).json({ error: 'שגיאה בשרת. נסה שוב בעוד רגע.' });
      }

      // ---------- בדיקת בוחן ----------
      if (body.action === 'quiz') {
        const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};

        const questions = await sbGet(
          'quiz_questions?lesson_id=eq.' + encodeURIComponent(lessons[0].id) +
          '&select=id,correct_answer,explanation,points&order=sort_order.asc'
        );
        if (!questions.length) {
          return res.status(404).json({ error: 'אין בוחן לשיעור הזה' });
        }

        let earned = 0;
        let total = 0;
        let correctCount = 0;
        const results = [];

        for (const q of questions) {
          const pts = q.points || 1;
          total += pts;
          const given = answers[q.id] === undefined || answers[q.id] === null
            ? null
            : String(answers[q.id]);
          const isCorrect = given !== null && given === String(q.correct_answer);
          if (isCorrect) {
            earned += pts;
            correctCount += 1;
          }
          results.push({
            id: q.id,
            correct: isCorrect,
            correctAnswer: String(q.correct_answer),
            explanation: q.explanation || ''
          });
        }

        const score = total > 0 ? Math.round((earned / total) * 100) : 0;

        await sbPost(
          'quiz_results',
          {
            student_id: studentId,
            lesson_id: lessons[0].id,
            score: score,
            answers: answers
          },
          'return=minimal'
        );

        return res.status(200).json({
          loggedIn: true,
          saved: true,
          score: score,
          correctCount: correctCount,
          total: questions.length,
          results: results
        });
      }

      const now = new Date().toISOString();

      // upsert — מסתמך על האילוץ UNIQUE (student_id, lesson_id)
      await sbPost(
        'progress?on_conflict=student_id,lesson_id',
        {
          student_id: studentId,
          lesson_id: lessons[0].id,
          status: status,
          completed_at: status === 'completed' ? now : null,
          updated_at: now,
        },
        'resolution=merge-duplicates,return=minimal'
      );

      return res.status(200).json({ loggedIn: true, saved: true, status: status });
    }

    return res.status(405).json({ error: 'שיטה לא נתמכת' });
  } catch (err) {
    console.error('progress handler error:', err);
    return res.status(500).json({ error: 'שגיאה בשרת. נסה שוב בעוד רגע.' });
  }
}
