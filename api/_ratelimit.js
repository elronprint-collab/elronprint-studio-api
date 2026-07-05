// api/_ratelimit.js — הגבלת קצב לפי IP + תקרה כללית
// עובד בזיכרון של האינסטנס — מספיק כהגנה מפני שימוש לרעה בחנות קטנה.
// לשדרוג עתידי (הגבלה מבוזרת אמיתית): Upstash Redis.

const ipHits = new Map();   // ip -> [timestamps]
let globalHits = [];        // timestamps

const IP_LIMIT = 15;             // 15 בקשות = 5 עיצובים לכל IP (3 שלבים לעיצוב)
const IP_WINDOW_MS = 10 * 60e3;  // בחלון של 10 דקות
const GLOBAL_LIMIT = 180;        // 180 בקשות = 60 עיצובים סה"כ
const GLOBAL_WINDOW_MS = 60 * 60e3; // לשעה

function prune(arr, windowMs, now) {
  while (arr.length && now - arr[0] > windowMs) arr.shift();
}

export function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : null) || "unknown";
}

// מחזיר null אם מותר, או מספר שניות להמתנה אם נחסם
export function checkRateLimit(req) {
  const now = Date.now();
  const ip = getClientIp(req);

  prune(globalHits, GLOBAL_WINDOW_MS, now);
  if (globalHits.length >= GLOBAL_LIMIT) {
    return Math.ceil((GLOBAL_WINDOW_MS - (now - globalHits[0])) / 1000);
  }

  let hits = ipHits.get(ip);
  if (!hits) { hits = []; ipHits.set(ip, hits); }
  prune(hits, IP_WINDOW_MS, now);
  if (hits.length >= IP_LIMIT) {
    return Math.ceil((IP_WINDOW_MS - (now - hits[0])) / 1000);
  }

  hits.push(now);
  globalHits.push(now);

  // ניקוי תקופתי כדי שהמפה לא תתנפח
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      prune(v, IP_WINDOW_MS, now);
      if (!v.length) ipHits.delete(k);
    }
  }
  return null;
}
