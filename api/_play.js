// api/_play.js — אימות מנוי Google Play לאפליקציית נת"צ (com.elronprint.netz)
//
// הקובץ מתחיל בקו תחתון, ולכן Vercel לא הופך אותו לפונקציה נפרדת.
// משתמש בחשבון שירות (Service Account) שמפתח ה-JSON שלו שמור
// במשתנה הסביבה GOOGLE_PLAY_SA_JSON. בלי חבילות npm — רק crypto ו-fetch.

import crypto from "crypto";

export const PLAY_PACKAGE = "com.elronprint.netz";
export const PLAY_PRODUCT = "netz_monthly";

let cachedToken = null; // { token, exp }

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function serviceAccount() {
  const raw = process.env.GOOGLE_PLAY_SA_JSON;
  if (!raw) throw new Error("GOOGLE_PLAY_SA_JSON missing");
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_PLAY_SA_JSON invalid");
  return sa;
}

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const sa = serviceAccount();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + claim);
  const jwt = header + "." + claim + "." + b64url(signer.sign(sa.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok || !j.access_token) throw new Error("Google token " + r.status + " " + JSON.stringify(j));
  cachedToken = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cachedToken.token;
}

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PLAY_PACKAGE;

/* מחזיר {ok, expiry, state, acknowledged} או {ok:false, status}.
   ok=true רק אם המינוי שייך למוצר שלנו ועדיין בתוקף. */
export async function playCheck(purchaseToken) {
  const tok = await accessToken();
  const r = await fetch(API + "/purchases/subscriptionsv2/tokens/" + encodeURIComponent(purchaseToken), {
    headers: { Authorization: "Bearer " + tok }
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) return { ok: false, status: r.status, error: j && j.error && j.error.message };
  const items = Array.isArray(j.lineItems) ? j.lineItems : [];
  let expiry = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].productId !== PLAY_PRODUCT) continue;
    const t = new Date(items[i].expiryTime || 0).getTime();
    if (t > expiry) expiry = t;
  }
  const state = String(j.subscriptionState || "");
  const live = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"].indexOf(state) !== -1;
  return {
    ok: expiry > Date.now() && live,
    expiry: expiry ? new Date(expiry).toISOString() : null,
    state: state,
    acknowledged: j.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    linked: j.linkedPurchaseToken || null
  };
}

/* גוגל מחזירה את הכסף אוטומטית אם רכישה לא אושרה (acknowledge) תוך 3 ימים. */
export async function playAcknowledge(purchaseToken) {
  const tok = await accessToken();
  const r = await fetch(API + "/purchases/subscriptions/" + PLAY_PRODUCT + "/tokens/" +
    encodeURIComponent(purchaseToken) + ":acknowledge", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: "{}"
  });
  return r.ok;
}
