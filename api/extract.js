import crypto from "crypto";
import sharp from "sharp";
import { checkRateLimit } from "./_ratelimit.js";
// api/extract.js — "חילוץ עיצוב" v2
//
// v2 change: THE BOX WAS SWALLOWING THE WEARER. First real run returned a "print file" containing a
// pink crop top, two arms, a midriff and a pair of denim shorts — everything except a clean graphic.
// Two causes, both in the locating step:
//  1. The stock photo carried a shop watermark ("MN FASHION ERA") laid across the model’s body and
//     jeans. It is part of the PHOTO, not the shirt, but it reads as lettering, so the box stretched
//     down to include it. The instruction now says overlay text and watermarks are never part of the
//     printed design, and explains the tell: printed ink follows the folds of the fabric, overlay text
//     sits flat across whatever is behind it.
//  2. Nothing checked the answer. A printed design is a small part of a photo of a person, so a box
//     covering most of the frame is wrong by definition. tooBig() measures it, and an oversized answer
//     earns one retry with the instruction hardened. If the retry is no better the run still finishes,
//     with a Hebrew notice suggesting he crop the photo around the design and upload again — a bad file
//     he was warned about beats a bad file presented as finished.
// Background removal could not have saved this: once the crop contains the model, birefnet keeps her,
// because she IS the salient object. The crop is the only place this can be fixed.
//
// A DIFFERENT TOOL FROM reimagine.js, AND DELIBERATELY SO. reimagine GENERATES: it reads a design,
// swaps the cast and the wording, and paints something new. That means an image model decides the
// result, and the same reference can come back excellent one minute and broken the next — which is
// exactly what made it exhausting to work with.
// This endpoint generates NOTHING. It finds the printed graphic inside a photo or mockup, cuts away
// the wearer, the garment and the room, removes the background, and lays what is left on a print
// canvas. The artwork, the lettering, the colours and the composition come out exactly as they went
// in. The only model calls are for LOCATING the graphic and for REMOVING the background — neither
// invents pixels — plus an optional upscale on small inputs.
// The practical consequence: the same image gives the same file every time, like the mockup generator
// and the background remover rather than like reimagine.
//
// OUT:  PNG, transparent, 4500x5400, 300 DPI, artwork centred, nothing cropped.
// UP TO 3 GRAPHICS per run (front and back mockups are the norm), one file each, ONE credit.
//
// Decisions taken with him, in order, before any of this was written:
//  1. Upscale only when it is needed — under 1500px the artwork would print soft, so it goes through
//     an upscaler; at or above that it is left alone, because an untouched file is always truer.
//  2. Centre, never crop. Transparent margins cost nothing (Printify ignores them); a corner cut off
//     in the server is gone for good.
//  3. New endpoint and a new section. reimagine.js and its page are not touched, so nothing that
//     works today can break.
//  4. Quota unchanged: one free run per account, credits after that, owner accounts exempt.
// Plus, agreed while mapping the edges:
//  - skip background removal when the upload is ALREADY transparent (it can only nibble fine edges)
//  - report print quality honestly (excellent / usable / too low) instead of shipping a soft file
//    that says 300 DPI and is really 400px stretched eleven times
//  - warn when white areas inside the artwork became holes — white and transparent look identical to
//    a background remover, so this cannot be fixed, only flagged
//  - refuse commercial logos, brand wordmarks and copyrighted characters. This tool outputs someone
//    else's artwork verbatim at print resolution, so the gate matters MORE here than in reimagine.
//
// Known limits of the INPUT, which no code here can fix — they are reported, not repaired:
//  - a creased or angled shirt yields a warped graphic; a flat mockup is far better
//  - fabric shadows come across as grey patches inside the artwork
//  - a WhatsApp-compressed photo has already lost the detail before it arrives

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const MAX_GRAPHICS = 3;          // a mockup showing five shirts must not run five pipelines
const GOOD_PX = 1500;            // at or above this the artwork is left alone
const LOW_PX = 800;              // below this no upscale saves it - say so plainly
const UPSCALE_TARGET = 2400;     // what the upscaler aims for
const CROP_PAD = 3;              // percent, so a tight box does not clip the artwork
const MIN_CROP_FRAC = 0.02;      // a box smaller than this is not a graphic
const HOLE_WARN = 0.30;          // enclosed transparency above this means white became holes

const ERODE_RADIUS = 2;
const ALPHA_FLOOR = 130;
const THIN_GUARD_RADIUS = ERODE_RADIUS + 2;
const MIN_THIN_LEN_DIV = 64;
const MIN_THIN_LEN_FLOOR = 16;

const FREE_RUNS = 1;

/* ---------------- CORS ---------------- */
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

/* ---------------- fal ---------------- */
async function fal(model, input) {
  const r = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error(`fal ${model} failed:`, r.status, t.slice(0, 300));
    throw new Error(`${model} failed`);
  }
  const d = await r.json();
  const url = d?.images?.[0]?.url || d?.image?.url || d?.url;
  if (!url) throw new Error(`${model}: no image returned`);
  return url;
}

/* ---------------- step 1: find the graphics, and check what they are ----------------
   One vision call answers everything we need about the upload, so a run costs one call whether the
   mockup shows one shirt or three. It never invents pixels — it only reports where to cut. */
/* ---------------- vision: one VLM call, billed through fal ----------------
   Was api.anthropic.com. Moved because the Anthropic account is no longer the one being billed —
   every call to it now fails, which took BOTH tools down at once. fal already carries the FAL_KEY
   this file uses for upscaling and background removal, so routing the vision call through fal's
   OpenRouter endpoint puts the whole pipeline on a single account.

   The prompts below are UNCHANGED. Only the transport moved: system_prompt carries what was `system`,
   prompt carries the user turn, and the image goes in as the same base64 data URI, which this
   endpoint accepts directly — no upload step, so nothing else in the pipeline had to change.

   temperature 0 because these prompts ask for a JSON object, not prose; the default of 1 would make
   the same sheet return different boxes on different runs.

   The response reports what the call actually cost, so it is logged rather than estimated. The
   failure path logs status AND body — the previous version threw away the body, which is exactly
   why a dead account looked like a generic "operation failed" for so long. */
/* Back on the model these prompts were written and tuned against. The first fal run used Gemini and
   the boxes were visibly wrong — a collar returned as "front logo", an empty black rectangle as
   "bottom logo", and the same number listed three times despite an explicit rule against duplicates.
   Same prompt, different model, worse reading. The transport stays on fal, so billing is unaffected;
   only the slug changed. Any OpenRouter vision slug works here if this ever needs revisiting. */
const VISION_MODEL = "anthropic/claude-sonnet-4.6";

async function visionJson(systemPrompt, userPrompt, base64Data, mediaType, maxTokens, tag) {
  const r = await fetch("https://fal.run/openrouter/router/vision", {
    method: "POST",
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      system_prompt: systemPrompt,
      prompt: userPrompt,
      image_urls: [`data:${mediaType};base64,${base64Data}`],
      temperature: 0,
      max_tokens: maxTokens,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`vision ${tag} failed: ${r.status} ${body.slice(0, 300)}`);
  }
  const d = await r.json();
  if (typeof d?.usage?.cost === "number") {
    console.log(`[vision] ${tag}: $${d.usage.cost.toFixed(6)} (${d.usage.total_tokens} tokens)`);
  }
  return d?.output || "";
}

const FIND_SYSTEM = `You inspect an image before its printed artwork is extracted for printing.

The image is one of:
(a) a standalone artwork file — the design on its own, with no garment and no wearer, or
(b) a photo or mockup of a printed garment, possibly worn.

Answer two questions.

1. GRAPHICS — the printed artwork areas.
   For (b): give a bounding box for EACH separate printed graphic — a front print, a back print, a
   sleeve print, or two shirts shown side by side. List at most 3, largest first.

   Draw each box tightly around the INK ON THE FABRIC and nothing else. Start from the topmost mark of
   the design and stop at the bottommost mark. The box must NOT include:
     - skin, hands, arms, neck or face
     - denim, trousers, shorts, a belt or a waistband
     - bare shirt fabric well beyond the design
     - the background, the floor or the room

   IGNORE OVERLAY TEXT THAT IS NOT PRINTED ON THE GARMENT. Stock photos and shop listings very often
   carry a watermark, a shop name or a caption laid over the picture — across the model's body, the
   trousers or the background. It is part of the PHOTO, not part of the shirt. Never extend a box to
   reach it, and never treat it as a graphic of its own. Printed ink follows the folds and creases of
   the fabric; overlay text sits flat and crosses whatever is behind it.

   A box that covers most of the picture is wrong by definition — a printed design occupies a small
   part of a photo of a person. If yours is that big, you have included the wearer: shrink it to the
   ink alone.

   For (a), when the image is already just the artwork: answer with the single word full
   If there is no printed artwork at all: answer with the single word none

2. PROTECTED — is any part of this artwork someone else's property? Answer with the specific reason,
   or the single word: none
   Say yes for: a company logo, brand name or wordmark (Nike, adidas, Puma, a swoosh, a trefoil); a
   recognisable copyrighted character (Spider-Man, Mickey Mouse, a Pokemon); the title or author of a
   real published book, film, song or band; an artist's signature, watermark or studio mark.
   Say none for: generic animals, objects, scenery, ordinary slogans and made-up phrases.

Answer with ONLY a JSON object, no prose, no markdown fences:
{"graphics":["x0,y0,x1,y1", ...] or "full" or "none","protected":"..." or "none"}

Box values are whole numbers 0-100, percentages of the image width or height, x0,y0 top-left and
x1,y1 bottom-right.`;

function parseJsonish(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json/gi, "").replace(/```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function parseBox(v) {
  const nums = String(v || "").match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (!nums) return null;
  const [x0, y0, x1, y1] = nums.slice(1, 5).map(Number);
  if (!(x1 > x0 && y1 > y0 && x1 <= 100 && y1 <= 100)) return null;
  return { x0, y0, x1, y1 };
}

const NONE_RE = /^\s*(none|no|n\/a|-)\s*$/i;

/* A printed design is a small part of a photo of a person. When the returned box covers most of the
   frame it has taken in the model, the denim and the background — which is exactly what produced a
   "print file" of a pink crop top, two arms and a pair of shorts. Measured, then retried once with the
   instruction hardened, rather than trusted. */
const MAX_BOX_FRAC = 55;                 // percent of the image area
function boxArea(b) { return ((b.x1 - b.x0) * (b.y1 - b.y0)) / 100; }
function tooBig(b) { return boxArea(b) > MAX_BOX_FRAC; }

const RETRY_NOTE =
  "\n\nYour previous answer boxed far too much of the picture: it included the wearer, their skin and " +
  "their clothing below the shirt, and possibly a watermark laid over the photo. Answer again with a " +
  "box around THE PRINTED INK ONLY — the design on the fabric, from its topmost mark to its bottommost " +
  "mark, with no skin, no denim, no waistband and no overlay text.";

async function findGraphics(base64Data, mediaType, harden) {
  let raw;
  try {
    raw = await visionJson(
      FIND_SYSTEM + (harden ? RETRY_NOTE : ""),
      "Locate the printed artwork. JSON only.",
      base64Data, mediaType, 300, "find"
    );
  } catch (err) {
    /* Unchanged fallback: treat the whole image as the artwork rather than failing the run. */
    console.error("[extract] find call failed:", err.message);
    return { boxes: null, protected: "", whole: true };
  }
  const j = parseJsonish(raw);
  if (!j) {
    console.warn("[extract] find unreadable, treating the upload as the artwork:", String(raw).slice(0, 80));
    return { boxes: null, protected: "", whole: true };
  }

  const prot = NONE_RE.test(String(j.protected || "")) ? "" : String(j.protected || "").trim();
  const g = j.graphics;

  if (typeof g === "string" && /^full$/i.test(g.trim())) {
    console.log(`[extract] standalone artwork (no garment) protected=${JSON.stringify(prot.slice(0, 60))}`);
    return { boxes: null, protected: prot, whole: true };
  }
  if (typeof g === "string" && NONE_RE.test(g)) {
    console.log("[extract] no printed artwork found in the image");
    return { boxes: [], protected: prot, whole: false };
  }
  const boxes = (Array.isArray(g) ? g : [g]).map(parseBox).filter(Boolean).slice(0, MAX_GRAPHICS);
  if (!boxes.length) {
    console.warn("[extract] no usable boxes, treating the upload as the artwork");
    return { boxes: null, protected: prot, whole: true };
  }
  const swallowed = boxes.filter(tooBig);
  if (swallowed.length) {
    console.warn(
      "[extract] box covers " +
      swallowed.map((b) => `${boxArea(b).toFixed(0)}%`).join(", ") +
      " of the image - it has swallowed the wearer"
    );
  }
  console.log(
    `[extract] found ${boxes.length} graphic(s): ` +
    boxes.map((b) => `${b.x0},${b.y0},${b.x1},${b.y1}`).join(" | ") +
    ` protected=${JSON.stringify(prot.slice(0, 60))}`
  );
  return { boxes, protected: prot, whole: false };
}

/* ---------------- step 2: cut the wearer away ---------------- */
async function cropTo(buf, box) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return null;

  const pct = (v) => Math.min(100, Math.max(0, v));
  const x0 = pct(box.x0 - CROP_PAD), y0 = pct(box.y0 - CROP_PAD);
  const x1 = pct(box.x1 + CROP_PAD), y1 = pct(box.y1 + CROP_PAD);

  const left = Math.round((x0 / 100) * meta.width);
  const top = Math.round((y0 / 100) * meta.height);
  const width = Math.max(1, Math.min(meta.width - left, Math.round(((x1 - x0) / 100) * meta.width)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(((y1 - y0) / 100) * meta.height)));

  if ((width * height) / (meta.width * meta.height) < MIN_CROP_FRAC) {
    console.warn(`[extract] box too small (${width}x${height}) - skipping it`);
    return null;
  }
  return sharp(buf).extract({ left, top, width, height }).png({ compressionLevel: 3 }).toBuffer();
}

/* ---------------- edge cleanup ----------------
   Verbatim from reimagine.js. Background removal leaves a faint halo that prints as a grey line on
   dark fabric; this erodes it while protecting thin artwork (v22/v23), so lettering strokes and
   hatching survive and only spurs are removed. Proven code - not rewritten for the new tool. */
function thinGuard(a, w, h, r) {
  const n = w * h;
  const b = new Uint8Array(n);
  for (let p = 0; p < n; p++) b[p] = a[p] ? 1 : 0;

  const ex = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w || !b[row + xx]) { m = 0; break; }
      }
      ex[row + x] = m;
    }
  }
  const er = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h || !ex[yy * w + x]) { m = 0; break; }
      }
      er[y * w + x] = m;
    }
  }

  const dx = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && er[row + xx]) { m = 1; break; }
      }
      dx[row + x] = m;
    }
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h && dx[yy * w + x]) { m = 1; break; }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/* A thin structure is worth protecting only if it is a real piece of artwork. The v22 guard
   protected every thin structure, including the short hairline spurs the generator likes to
   hang off the corners of heavy lettering — v21's erosion used to delete those silently. So
   label the connected components of the thin mask and judge each by its longest dimension:
   a caption letter or a hatching line runs tens of pixels, a spur is under ten. */
function protectThinArtwork(a, guard, w, h) {
  const n = w * h;
  const minLen = Math.max(MIN_THIN_LEN_FLOOR, Math.round(Math.max(w, h) / MIN_THIN_LEN_DIV));
  const protect = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const pixels = new Int32Array(n);
  let kept = 0, specks = 0;

  for (let p = 0; p < n; p++) {
    if (seen[p] || !a[p] || guard[p]) continue;
    let sp = 0, cnt = 0;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    seen[p] = 1; stack[sp++] = p;
    while (sp > 0) {
      const q = stack[--sp];
      pixels[cnt++] = q;
      const x = q % w, y = (q / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0)     { const r = q - 1; if (!seen[r] && a[r] && !guard[r]) { seen[r] = 1; stack[sp++] = r; } }
      if (x < w - 1) { const r = q + 1; if (!seen[r] && a[r] && !guard[r]) { seen[r] = 1; stack[sp++] = r; } }
      if (y > 0)     { const r = q - w; if (!seen[r] && a[r] && !guard[r]) { seen[r] = 1; stack[sp++] = r; } }
      if (y < h - 1) { const r = q + w; if (!seen[r] && a[r] && !guard[r]) { seen[r] = 1; stack[sp++] = r; } }
    }
    if (Math.max(x1 - x0 + 1, y1 - y0 + 1) >= minLen) {
      for (let i = 0; i < cnt; i++) protect[pixels[i]] = 1;
      kept += cnt;
    } else specks += cnt;
  }
  console.log(`[extract] cleanEdges: ${kept} thin-artwork px protected, ${specks} spur px eroded (minLen ${minLen})`);
  return protect;
}

async function cleanEdges(buf, radius = ERODE_RADIUS, floor = ALPHA_FLOOR) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  const a = new Uint8Array(w * h);
  for (let p = 0, i = 3; p < w * h; p++, i += ch) a[p] = data[i] < floor ? 0 : data[i];

  const guard = thinGuard(a, w, h, THIN_GUARD_RADIUS);
  const protect = protectThinArtwork(a, guard, w, h);

  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) { m = 0; break; }
        const v = a[row + xx];
        if (v < m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (protect[p]) { data[p * ch + 3] = a[p]; continue; }
      let m = 255;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) { m = 0; break; }
        const v = tmp[yy * w + x];
        if (v < m) m = v;
      }
      data[p * ch + 3] = m;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: ch } }).png({ compressionLevel: 1 }).toBuffer();
}


/* ---------------- step 3: background, upscale, canvas ---------------- */

/* A file that already carries transparency has had its background dealt with. Running a remover over
   it can only nibble fine edges, so it is skipped — agreed while mapping the edge cases. */
async function alreadyTransparent(buf) {
  try {
    const st = await sharp(buf).ensureAlpha().stats();
    return !st.isOpaque;
  } catch { return false; }
}

async function removeBackground(buf) {
  const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
  const url = await fal("fal-ai/birefnet", { image_url: dataUri });
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

/* Upscaling is the one step that adds detail that was not there, so it runs only where the artwork
   would otherwise print soft. Failure is not fatal: the original is simply used as it is. */
async function upscale(buf) {
  const dataUri = `data:image/png;base64,${buf.toString("base64")}`;
  const url = await fal("fal-ai/esrgan", { image_url: dataUri, scale: 2 });
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

/* How much of the transparency is ENCLOSED by artwork rather than reachable from the border. White
   fills inside a design are cut away with the background and leave holes; they read as large pockets
   of trapped emptiness. Cannot be fixed here — white and transparent are the same thing to a remover
   — so it is measured and reported. */
async function holeRatio(buf) {
  const { data, info } = await sharp(buf)
    .ensureAlpha().resize(220, 220, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const n = w * h;

  const ink = new Uint8Array(n);
  let inkCount = 0;
  for (let p = 0, i = 3; p < n; p++, i += ch) if (data[i] >= 128) { ink[p] = 1; inkCount++; }
  if (!inkCount) return 0;

  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (q) => { if (!ink[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp > 0) {
    const q = stack[--sp];
    const x = q % w, y = (q / w) | 0;
    if (x > 0) seed(q - 1);
    if (x < w - 1) seed(q + 1);
    if (y > 0) seed(q - w);
    if (y < h - 1) seed(q + w);
  }
  let enclosed = 0;
  for (let q = 0; q < n; q++) if (!ink[q] && !seen[q]) enclosed++;
  return enclosed / (inkCount + enclosed);
}

/* Centre on the print canvas. Never crops: transparent margins cost nothing downstream, a cut-off
   corner is gone for good. */
async function toPrintCanvas(buf) {
  const inner = await sharp(buf)
    .ensureAlpha()
    .trim({ threshold: 12 })
    .resize(Math.round(CANVAS_W * SAFE), Math.round(CANVAS_H * SAFE), {
      fit: "inside",
      kernel: "lanczos3",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 1 })
    .toBuffer();

  const m = await sharp(inner).metadata();
  console.log(`[extract] artwork ${m.width}x${m.height} centred on ${CANVAS_W}x${CANVAS_H}`);

  return sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: inner, left: Math.round((CANVAS_W - m.width) / 2), top: Math.round((CANVAS_H - m.height) / 2) }])
    .withMetadata({ density: DPI })
    .png({ compressionLevel: 3, effort: 1 })
    .toBuffer();
}

async function fitUploadSize(buffer) {
  const MAX = 9.5 * 1024 * 1024;
  if (buffer.length <= MAX) return buffer;
  console.warn(`[extract] png ${(buffer.length / 1048576).toFixed(1)}MB - re-encoding as palette`);
  return sharp(buffer).png({ compressionLevel: 9, palette: true, colours: 256, dither: 1 })
    .withMetadata({ density: DPI }).toBuffer();
}

async function uploadCloudinary(buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), "artwork.png");
  form.append("upload_preset", CLOUD_PRESET);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: "POST", body: form });
  const text = await r.text();
  if (!r.ok) { console.error("cloudinary failed:", r.status, text.slice(0, 300)); throw new Error("Upload failed"); }
  const d = JSON.parse(text);
  if (!d.secure_url) throw new Error("Upload failed");
  return d.secure_url;
}

/* Honest print grading, so a soft file is never handed over as though it were ready. The number that
   matters is the artwork's REAL pixel size before it was stretched onto the canvas. */
function gradeQuality(px) {
  if (px >= GOOD_PX) return { grade: "excellent", he: "איכות מצוינת · מוכן להדפסה" };
  if (px >= LOW_PX)  return { grade: "usable",    he: "איכות סבירה · הוגדל אוטומטית, כדאי לבדוק לפני הדפסה" };
  return { grade: "low", he: "האיכות נמוכה לקובץ הדפסה. בקשו את הקובץ המקורי במקום צילום או תמונה מוואטסאפ." };
}

/* One graphic, end to end. Returns the finished file plus what should be said about it. */
async function processOne(buf, msLeft) {
  const src = await sharp(buf).metadata();
  const startPx = Math.max(src.width || 0, src.height || 0);

  let work = buf;
  let upscaled = false;
  if (startPx < GOOD_PX && msLeft > 22000) {
    try {
      work = await upscale(work);
      upscaled = true;
      const m = await sharp(work).metadata();
      console.log(`[extract] upscaled ${startPx}px -> ${Math.max(m.width, m.height)}px`);
      if (Math.max(m.width, m.height) < UPSCALE_TARGET && startPx >= LOW_PX && msLeft > 40000) {
        work = await upscale(work);
        const m2 = await sharp(work).metadata();
        console.log(`[extract] second pass -> ${Math.max(m2.width, m2.height)}px`);
      }
    } catch (e) {
      console.warn("[extract] upscale failed, using the artwork as it is:", e.message);
    }
  }

  const hadAlpha = await alreadyTransparent(work);
  if (hadAlpha) {
    console.log("[extract] upload is already transparent - skipping background removal");
  } else {
    work = await removeBackground(work);
  }

  let holes = 0;
  try { holes = await holeRatio(work); } catch {}

  work = await cleanEdges(work);
  let canvas = await fitUploadSize(await toPrintCanvas(work));
  const url = await uploadCloudinary(canvas);

  const q = gradeQuality(startPx);
  return {
    url,
    imageUrl: url,
    width: CANVAS_W,
    height: CANVAS_H,
    dpi: DPI,
    sourcePx: startPx,
    upscaled,
    quality: q.grade,
    qualityText: q.he,
    holes: +holes.toFixed(3),
    holeWarning: holes > HOLE_WARN
      ? "נמצאו אזורים לבנים בתוך העיצוב שהפכו לשקופים. בדקו את הקובץ לפני הדפסה."
      : "",
  };
}

/* ---------------- account, quota, credits ----------------
   Lifted verbatim from reimagine.js so both tools charge identically: one free run per account,
   credits after that, owner e-mails exempt and never charged. A run is charged only AFTER a file
   exists, so a failure never costs him or a customer anything. */
/* Owner accounts — unlimited clean files, never charged, never watermarked. */
function isOwner(email) {
  const list = String(process.env.OWNER_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
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

async function sbPost(path, body, prefer) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, {
    method: "POST",
    headers: sbHeaders({ Prefer: prefer || "return=representation" }),
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Supabase POST " + path + " -> " + r.status + " " + t);
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

/* Same HMAC as api/auth.js — the raw token is never stored anywhere, only its fingerprint. */
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

async function quotaFor(student) {
  const runs = await sbGet(
    "design_runs?student_id=eq." + encodeURIComponent(student.id) + "&select=id&charged=is.false"
  );
  const freeUsed = runs.length;
  const freeLeft = Math.max(0, FREE_RUNS - freeUsed);
  return {
    freeLeft,
    credits: student.design_credits || 0,
    canRun: freeLeft > 0 || (student.design_credits || 0) > 0,
  };
}

/* Charged AFTER a successful generation, never before — a failed run must not cost the user. */
async function chargeRun(student, quota) {
  const useCredit = quota.freeLeft <= 0;
  await sbPost("design_runs", { student_id: student.id, charged: useCredit }, "return=minimal");
  if (useCredit) {
    await sbPatch("students?id=eq." + encodeURIComponent(student.id), {
      design_credits: Math.max(0, (student.design_credits || 0) - 1),
    });
  }
  return {
    freeLeft: Math.max(0, quota.freeLeft - (useCredit ? 0 : 1)),
    credits: Math.max(0, quota.credits - (useCredit ? 1 : 0)),
  };
}


const IP_ERROR =
  "התמונה כוללת לוגו מסחרי, סימן מסחרי או דמות מוגנת. " +
  "הכלי מפיק קבצי הדפסה, ולכן אינו מעבד חומר כזה — העלו עיצוב מקורי או כזה שיש לכם רישיון עליו.";

const NO_ART_ERROR =
  "לא זוהה עיצוב מודפס בתמונה. העלו תמונה של חולצה מודפסת, או את קובץ העיצוב עצמו.";

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
  const { image } = body;
  if (!image || typeof image !== "string") return res.status(400).json({ error: "Missing image" });
  const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Invalid image format" });
  const [, mediaType, base64Data] = match;

  const t0 = Date.now();
  const msLeft = () => 57000 - (Date.now() - t0);

  try {
    // ---- account gate ----
    const student = await studentFromToken(body.token || req.headers["x-epai-token"] || req.query.token);
    if (!student) return res.status(401).json({ error: "צריך להתחבר כדי להשתמש בכלי.", needLogin: true });

    const owner = isOwner(student.email);
    const quota = owner ? { freeLeft: 0, credits: 0, canRun: true } : await quotaFor(student);
    if (!quota.canRun) {
      return res.status(402).json({
        error: "נגמרו החילוצים החינמיים. אפשר לרכוש חבילת קרדיטים ולהמשיך.",
        needCredits: true, freeLeft: 0, credits: 0,
      });
    }

    // ---- step 1: locate, and check what it is ----
    let found = await findGraphics(base64Data, mediaType);
    /* One retry when the box has clearly taken in the wearer. Cheap, and it is the difference between
       a print file and a photograph of a woman in a crop top. */
    if (Array.isArray(found.boxes) && found.boxes.some(tooBig)) {
      console.warn("[extract] retrying the search with the instruction hardened");
      try {
        const again = await findGraphics(base64Data, mediaType, true);
        if (Array.isArray(again.boxes) && again.boxes.length && !again.boxes.some(tooBig)) {
          console.log("[extract] retry gave a sane box - using it");
          found = { ...again, protected: again.protected || found.protected };
        } else {
          console.warn("[extract] retry no better - keeping the first answer");
        }
      } catch (e) {
        console.warn("[extract] retry failed:", e.message);
      }
    }
    if (found.protected) {
      console.warn("[extract] REFUSED - protected material:", found.protected);
      return res.status(422).json({ error: IP_ERROR, blocked: "ip", reason: found.protected });
    }
    if (Array.isArray(found.boxes) && found.boxes.length === 0) {
      return res.status(422).json({ error: NO_ART_ERROR, blocked: "no-art" });
    }

    const original = Buffer.from(base64Data, "base64");

    // ---- step 2: one buffer per graphic ----
    let pieces = [];
    if (found.whole || !found.boxes) {
      pieces = [original];                       // the upload IS the artwork
    } else {
      for (const box of found.boxes) {
        try {
          const c = await cropTo(original, box);
          if (c) pieces.push(c);
        } catch (e) {
          console.warn("[extract] crop failed for one box:", e.message);
        }
      }
      if (!pieces.length) pieces = [original];   // every box unusable - fall back to the whole image
    }

    // ---- step 3: run each one through, stopping early rather than timing out ----
    const files = [];
    let skipped = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0 && msLeft() < 15000) { skipped = pieces.length - i; break; }
      try {
        const out = await processOne(pieces[i], msLeft());
        files.push(out);
        console.log(`[extract] graphic ${i + 1}/${pieces.length} done at ${Date.now() - t0}ms (${out.quality})`);
      } catch (e) {
        console.error(`[extract] graphic ${i + 1} failed:`, e.message);
      }
    }
    if (!files.length) return res.status(502).json({ error: "החילוץ נכשל. נסו שוב או העלו תמונה אחרת." });

    // ---- charged once per run, after files exist, never per graphic ----
    let left = { freeLeft: quota.freeLeft, credits: quota.credits };
    if (owner) {
      await sbPost("design_runs", { student_id: student.id, charged: false }, "return=minimal")
        .catch((e) => console.error("[extract] owner run log failed:", e));
      left = { freeLeft: null, credits: null, owner: true };
    } else {
      try { left = await chargeRun(student, quota); }
      catch (e) { console.error("[extract] charge failed (files were delivered):", e); }
    }

    const notices = [];
    if (Array.isArray(found.boxes) && found.boxes.some(tooBig)) {
      notices.push(
        "לא הצלחנו לבודד את העיצוב מהחולצה — ייתכן שהתוצאה כוללת חלקים מהתמונה המקורית. " +
        "כדאי לחתוך את התמונה סביב העיצוב ולהעלות שוב."
      );
    }
    if (skipped) notices.push(`נמצאו עוד ${skipped} עיצובים בתמונה שלא עובדו — העלו אותם בנפרד.`);
    for (const f of files) if (f.holeWarning) { notices.push(f.holeWarning); break; }

    console.log(`[extract] done: ${files.length} file(s) in ${Date.now() - t0}ms`);
    return res.status(200).json({
      files,
      // first file also at the top level, so a simple client can ignore the array
      imageUrl: files[0].url,
      url: files[0].url,
      width: CANVAS_W, height: CANVAS_H, dpi: DPI,
      count: files.length,
      notice: notices.join(" "),
      freeLeft: left.freeLeft, credits: left.credits, owner: !!owner,
    });
  } catch (err) {
    console.error("[extract] failed:", err);
    return res.status(502).json({ error: "החילוץ נכשל. נסו שוב." });
  }
}
