// ============================================================
// /api/lessons.js — מחזיר לדף את הקורסים והשיעורים המפורסמים
// משתני סביבה: SUPABASE_URL, SUPABASE_SERVICE_KEY, SHOPIFY_APP_SECRET
// ============================================================

import crypto from 'crypto';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_SECRET = process.env.SHOPIFY_APP_SECRET;

function verifyProxySignature(query) {
  const signature = query.signature;
  if (!signature || !APP_SECRET) return false;

  const message = Object.keys(query)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => k + '=' + query[k])
    .join('');

  const digest = crypto
    .createHmac('sha256', APP_SECRET)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch (e) {
    return false;
  }
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Accept: 'application/json'
    }
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase GET ${path} -> ${r.status} ${body}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'https://placeholder.local');
    const query = {};
    url.searchParams.forEach(function (v, k) {
      query[k] = v;
    });

    res.setHeader('Cache-Control', 'no-store');

    if (!verifyProxySignature(query)) {
      return res.status(401).json({ error: 'חתימה לא תקינה' });
    }

    const courses = await sbGet(
      'courses?is_published=eq.true&select=id,slug,title,description,level,sort_order&order=sort_order.asc'
    );
    const lessons = await sbGet(
      'lessons?is_published=eq.true&select=id,course_id,slug,title,summary,body,example,task,sort_order&order=sort_order.asc'
    );

    const out = courses.map(function (c) {
      return {
        slug: c.slug,
        title: c.title,
        description: c.description,
        level: c.level,
        lessons: lessons
          .filter(function (l) {
            return l.course_id === c.id;
          })
          .map(function (l) {
            return {
              slug: l.slug,
              title: l.title,
              summary: l.summary,
              body: l.body,
              example: l.example,
              task: l.task
            };
          })
      };
    });

    return res.status(200).json({ courses: out });
  } catch (err) {
    console.error('lessons handler error:', err);
    return res.status(500).json({ error: 'שגיאה בטעינת השיעורים' });
  }
}
