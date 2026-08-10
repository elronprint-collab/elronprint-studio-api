// ============================================================
// /api/me.js — אומר לדף האקדמיה אם התלמיד מחובר
// לא נוגע במסד הנתונים. רק מאמת חתימת פרוקסי וקורא את מזהה הלקוח.
// משתני סביבה: SHOPIFY_APP_SECRET
// ============================================================

import crypto from 'crypto';

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

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'https://placeholder.local');
    const query = {};
    url.searchParams.forEach(function (v, k) {
      query[k] = v;
    });

    res.setHeader('Cache-Control', 'no-store');

    if (!verifyProxySignature(query)) {
      return res.status(401).json({ loggedIn: false, error: 'חתימה לא תקינה' });
    }

    const customerId = query.logged_in_customer_id;
    return res.status(200).json({ loggedIn: !!customerId });
  } catch (err) {
    console.error('me handler error:', err);
    return res.status(500).json({ loggedIn: false });
  }
}
