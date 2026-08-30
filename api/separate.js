import crypto from "crypto";
import sharp from "sharp";
import { checkRateLimit } from "./_ratelimit.js";
// api/separate.js — "הפרדת אלמנטים" v1
//
// A STANDALONE ENDPOINT. It shares no file with api/extract.js by his explicit decision: a bad
// deploy must be able to take down one tool without taking down the other. The proven pipeline
// below (edge cleanup, background removal, print canvas, upload, quota) is COPIED VERBATIM out of
// extract.js rather than imported, so a future edit here cannot reach "חילוץ עיצוב" and a future
// edit there cannot reach this. Duplication is the point, not an oversight.
//
// COST OF THAT CHOICE, stated plainly: api/ now holds 12 routed functions and the Vercel Hobby
// ceiling is 12. This uses the last slot. The next new endpoint will require either a Pro upgrade
// or merging two existing functions. He was told this before choosing and chose it anyway.
//
// WHAT THIS DOES, and why extract.js could not:
// extract.js asks "where is the printed artwork" — its unit is a print AREA on a garment (front
// print, back print, sleeve print). Feed it a brand sheet (two jerseys, a crest, a wordmark, a
// number, a colour strip) and it answers `full`, because there is no wearer to cut away, so the
// whole sheet goes through as ONE artwork and comes back as one transparent picture of two shirts.
// That is that tool working as written. "Which separable pieces is this made of" is a different
// question, so it gets its own prompt, its own size floor and its own endpoint.
//
// TWO STEPS, forced by the platform rather than chosen. maxDuration is 60s and the budget below is
// 57s; processOne costs roughly 10-20s per element, so eight elements in one invocation would time
// out and return nothing at all.
//   action:"detect"    -> one Claude call, N cheap sharp crops, returns labelled thumbnails with a
//                         per-element quality grade. Produces no file and is NEVER charged.
//   action:"separate"  -> takes only the elements the user ticked and runs the pipeline on each.
//                         Charged once per run, after files exist, exactly like extract.js.
//
// OUT: PNG, transparent, 4500x5400, 300 DPI, artwork centred, nothing cropped — one file per element.
//
// HONEST LIMIT, and this mode invites it more than any other tool here: the 300 DPI tag is metadata.
// Sharpness comes from the source. A brand sheet screenshotted through WhatsApp holds a ~300px
// crest, and no upscaler makes that a print file. gradeQuality reports it per element ON THE PICK
// SCREEN, so he can see it before spending a credit rather than after.
//
// IP GATE: this outputs someone else's artwork verbatim at print resolution, so the gate matters
// more here than anywhere. It runs on BOTH actions — "separate" can be called directly without ever
// calling "detect" — and it fails CLOSED: if the check itself errors, the run is refused.

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const MAX_ELEMENTS = 12;         // a brand sheet genuinely has this many separable parts
const MAX_PICKS = 6;             // per run, so a pick of twelve cannot silently drop nine
/* An element is FAR smaller than a print area. A crest on a brand sheet is well under 1% of the
   frame, so extract.js's 2% floor would reject every real answer here. */
const MIN_ELEMENT_FRAC = 0.0004;
const ELEMENT_PAD = 2;           // percent, tighter than extract.js - elements sit close together
const THUMB_PX = 300;            // preview size on the pick screen

const GOOD_PX = 1500;            // at or above this the artwork is left alone
const LOW_PX = 800;              // below this no upscale saves it - say so plainly
const UPSCALE_TARGET = 2400;     // what the upscaler aims for
const HOLE_WARN = 0.30;          // enclosed transparency above this means white became holes

const ERODE_RADIUS = 2;
const ALPHA_FLOOR = 130;
const THIN_GUARD_RADIUS = ERODE_RADIUS + 2;
const MIN_THIN_LEN_DIV = 64;
const MIN_THIN_LEN_FLOOR = 16;

/* Must stay identical to the value in extract.js and auth.js — one shared free run per account
   across every paid tool, which is the model he chose on 2026-08-24. */
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

/* An element covering most of the sheet IS the sheet, not a piece of it. Same measurement extract.js
   uses to catch a box that has swallowed the wearer, reused here for a different failure. */
const MAX_BOX_FRAC = 55;                 // percent of the image area
function boxArea(b) { return ((b.x1 - b.x0) * (b.y1 - b.y0)) / 100; }

/* Fraction of the SMALLER box covered by the overlap. Intersection-over-union would let a small box
   sitting entirely inside a large one score low and survive; here that nests to 1.0 and is caught. */
function overlapFrac(a, b) {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = w * h;
  if (inter <= 0) return 0;
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  return inter / Math.max(1e-9, Math.min(areaA, areaB));
}

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

/* ---------------- step 1: what pieces is this made of ----------------
   Two rules here earn their place:
   - a piece must be separable ON ITS OWN. Half a stripe or one letter out of a word is not an
     element; asking for those is how you get twenty useless crops.
   - the garment is never an element. This is the v36 lesson from reimagine.js: a shirt shape
     reaching the output is the worst failure this family of tools has, and a prompt rule is far
     cheaper than discovering it inside a print file. */
const ELEMENTS_SYSTEM = `You are looking at a design image — a brand sheet, a mockup, a poster or an
artwork file. It will be split into separate printable pieces.

List every SEPARABLE ELEMENT: a piece a designer would treat as its own file.

Typical elements: a crest, badge, emblem or logo mark; a wordmark or block of lettering; a number;
an illustrated figure, animal or character; an icon; a self-contained ornament or motif.

RULES

1. An element must stand alone. If cutting it out would leave something meaningless — half a stripe,
   a single letter of a word, one corner of a pattern — it is NOT an element. A whole word or a whole
   phrase set in one style IS one element. Do not split a word into letters.

2. NEVER list a garment or a mockup as an element. A t-shirt, jersey, hoodie, sleeve, collar, the
   fabric, a hanger, a mannequin, a model, a flat lay or a product photo is the SURFACE the design
   sits on, not a piece of the design. If the sheet shows a shirt, list the artwork PRINTED on that
   shirt, never the shirt.

3. Prefer the cleanest copy. Brand sheets often show the same mark twice — small and warped on a
   garment, and again large and flat on a plain panel. List the large flat one and ignore the
   distorted duplicate. Never list the same mark twice.

4. Ignore: background textures, colour swatches, plain stripes and blocks, specimen alphabets, page
   headings, spec text, captions describing the design, and any interface or watermark laid over the
   picture.

5. At most ${MAX_ELEMENTS} elements, most useful first.

For each element give a tight bounding box around the mark itself and a SHORT HEBREW label (2-3
words) so a non-designer can recognise it in a list — for example: סמל המועדון, כיתוב ראשי, מספר,
דמות, אייקון, כיתוב אחורי.

Also answer: is any part of this someone else's property? Answer with the specific reason, or the
single word none.
Say yes for: a company logo, brand name or wordmark (Nike, adidas, Puma, Macron, a swoosh, a
trefoil); a sports league, federation or competition mark (UEFA, the Champions League starball, FIFA,
NBA, a real football club's crest); a recognisable copyrighted character; the title or author of a
real published book, film, song or band; an artist's signature, watermark or studio mark.
Say none for: generic animals, objects, scenery, ordinary slogans and invented names.

Answer with ONLY a JSON object, no prose, no markdown fences:
{"elements":[{"label":"...","box":"x0,y0,x1,y1"}, ...],"protected":"..." or "none"}

Box values are whole numbers 0-100, percentages of the image width or height, x0,y0 top-left and
x1,y1 bottom-right. If there are no separable elements answer {"elements":[],"protected":"..."}.`;

async function findElements(base64Data, mediaType) {
  const raw = await visionJson(
    ELEMENTS_SYSTEM,
    "List the separable elements. JSON only.",
    base64Data, mediaType, 1200, "elements"
  );
  const j = parseJsonish(raw);
  if (!j) {
    console.warn("[separate] elements unreadable:", String(raw).slice(0, 120));
    return { elements: [], protected: "" };
  }

  const prot = NONE_RE.test(String(j.protected || "")) ? "" : String(j.protected || "").trim();

  /* Deduplication has to be fuzzy, not exact. The first real run returned "מספר 10" THREE times with
     slightly different boxes, two of them on blank fabric — an exact-match check let all three
     through and the pick screen filled with near-identical junk. So: one entry per label, and any
     box overlapping an accepted one by more than half is treated as the same thing. */
  const kept = [];
  for (const e of (Array.isArray(j.elements) ? j.elements : [])) {
    const box = parseBox(e && (e.box || e.bbox || e));
    if (!box) continue;
    if (boxArea(box) > MAX_BOX_FRAC) continue;
    const label = String((e && e.label) || "").trim().slice(0, 40) || "אלמנט";
    if (kept.some((k) => k.label === label)) continue;
    if (kept.some((k) => overlapFrac(k.box, box) > 0.5)) continue;
    kept.push({ label, box });
    if (kept.length >= MAX_ELEMENTS) break;
  }
  const elements = kept;

  console.log(
    `[separate] ${elements.length} element(s): ` +
    elements.map((e) => `${e.label} @ ${e.box.x0},${e.box.y0},${e.box.x1},${e.box.y1}`).join(" | ") +
    ` protected=${JSON.stringify(prot.slice(0, 60))}`
  );
  return { elements, protected: prot };
}

/* The IP gate has to sit on the path that PRODUCES FILES, not only on the one that previews them.
   "separate" can be called directly without ever calling "detect", so the check runs again there.
   Kept small — one short answer, 120 tokens — because it spends budget processOne needs. */
const PROTECTED_SYSTEM = `Look at this image. Is any part of it someone else's intellectual property?

Say yes for: a company logo, brand name or wordmark (Nike, adidas, Puma, Macron, a swoosh, a
trefoil); a sports league, federation or competition mark (UEFA, the Champions League starball,
FIFA, NBA, a real football club's crest); a recognisable copyrighted character; the title or author
of a real published book, film, song or band; an artist's signature, watermark or studio mark.
Say none for: generic animals, objects, scenery, ordinary slogans and invented names.

Answer with ONLY a JSON object: {"protected":"the specific reason" or "none"}`;

async function checkProtected(base64Data, mediaType) {
  const raw = await visionJson(
    PROTECTED_SYSTEM, "JSON only.", base64Data, mediaType, 120, "protected"
  );
  const j = parseJsonish(raw);
  if (!j) throw new Error("protected check unreadable");
  return NONE_RE.test(String(j.protected || "")) ? "" : String(j.protected || "").trim();
}

/* ---------------- step 2: cut one element out ---------------- */
async function cropTo(buf, box) {
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return null;

  const pct = (v) => Math.min(100, Math.max(0, v));
  /* Padding must be PROPORTIONAL here, unlike extract.js. A flat 2% around a print area is nothing;
     around a 4%-wide crest on a dense brand sheet it doubles the box and drags in whatever sits
     beside it — which on this kind of sheet is another element. Capped at 15% of the box's own
     size, so a large element still gets the full margin and a small one gets a small one. */
  const padX = Math.min(ELEMENT_PAD, (box.x1 - box.x0) * 0.15);
  const padY = Math.min(ELEMENT_PAD, (box.y1 - box.y0) * 0.15);
  const x0 = pct(box.x0 - padX), y0 = pct(box.y0 - padY);
  const x1 = pct(box.x1 + padX), y1 = pct(box.y1 + padY);

  const left = Math.round((x0 / 100) * meta.width);
  const top = Math.round((y0 / 100) * meta.height);
  const width = Math.max(1, Math.min(meta.width - left, Math.round(((x1 - x0) / 100) * meta.width)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(((y1 - y0) / 100) * meta.height)));

  if ((width * height) / (meta.width * meta.height) < MIN_ELEMENT_FRAC) {
    console.warn(`[separate] box too small (${width}x${height}) - skipping it`);
    return null;
  }
  return sharp(buf).extract({ left, top, width, height }).png({ compressionLevel: 3 }).toBuffer();
}

/* A small JPEG for the pick screen. Returned inline as a data URI rather than uploaded: these are
   throwaway previews, and a Cloudinary round trip per element would cost seconds of the budget and
   leave junk in the account. */
async function makeThumb(buf) {
  return (
    "data:image/jpeg;base64," +
    (await sharp(buf)
      .resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: false })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 72 })
      .toBuffer()).toString("base64")
  );
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
  console.log(`[separate] cleanEdges: ${kept} thin-artwork px protected, ${specks} spur px eroded (minLen ${minLen})`);
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
  console.log(`[separate] artwork ${m.width}x${m.height} centred on ${CANVAS_W}x${CANVAS_H}`);

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
  console.warn(`[separate] png ${(buffer.length / 1048576).toFixed(1)}MB - re-encoding as palette`);
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
      console.log(`[separate] upscaled ${startPx}px -> ${Math.max(m.width, m.height)}px`);
      if (Math.max(m.width, m.height) < UPSCALE_TARGET && startPx >= LOW_PX && msLeft > 40000) {
        work = await upscale(work);
        const m2 = await sharp(work).metadata();
        console.log(`[separate] second pass -> ${Math.max(m2.width, m2.height)}px`);
      }
    } catch (e) {
      console.warn("[separate] upscale failed, using the artwork as it is:", e.message);
    }
  }

  const hadAlpha = await alreadyTransparent(work);
  if (hadAlpha) {
    console.log("[separate] upload is already transparent - skipping background removal");
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

const NO_ELEMENTS_ERROR =
  "לא נמצאו אלמנטים נפרדים בתמונה. אם זה עיצוב אחד שלם, השתמשו בכלי חילוץ עיצוב במקום בהפרדה.";

/* ---------------- mode: detect ----------------
   One Claude call plus cheap sharp crops. Nothing is uploaded, nothing is charged. The per-element
   quality grade is the whole point of this screen: he sees that the crest is 300px BEFORE he spends
   a credit finding out. */
async function runDetect(res, base64Data, mediaType) {
  const found = await findElements(base64Data, mediaType);

  if (found.protected) {
    console.warn("[separate] REFUSED at detect - protected material:", found.protected);
    return res.status(422).json({ error: IP_ERROR, blocked: "ip", reason: found.protected });
  }
  if (!found.elements.length) {
    return res.status(422).json({ error: NO_ELEMENTS_ERROR, blocked: "no-elements" });
  }

  const original = Buffer.from(base64Data, "base64");
  const elements = [];
  for (let i = 0; i < found.elements.length; i++) {
    const el = found.elements[i];
    try {
      const c = await cropTo(original, el.box);
      if (!c) continue;
      const m = await sharp(c).metadata();
      const px = Math.max(m.width || 0, m.height || 0);
      const q = gradeQuality(px);
      elements.push({
        id: String(i),
        label: el.label,
        box: `${el.box.x0},${el.box.y0},${el.box.x1},${el.box.y1}`,
        thumb: await makeThumb(c),
        sourcePx: px,
        quality: q.grade,
        qualityText: q.he,
      });
    } catch (e) {
      console.warn(`[separate] thumb failed for element ${i}:`, e.message);
    }
  }
  if (!elements.length) {
    return res.status(422).json({ error: NO_ELEMENTS_ERROR, blocked: "no-elements" });
  }

  const weak = elements.filter((e) => e.quality === "low").length;
  const notice = weak
    ? `${weak} מתוך ${elements.length} האלמנטים ברזולוציה נמוכה מדי לקובץ הדפסה. ` +
      "אפשר לחלץ אותם, אבל הם יצאו מטושטשים — עדיף לבקש את הקובץ המקורי."
    : "";

  console.log(`[separate] detect: returned ${elements.length} element(s), ${weak} low quality`);
  return res.status(200).json({ elements, count: elements.length, maxPicks: MAX_PICKS, notice });
}

/* ---------------- mode: separate ----------------
   Boxes arrive from the browser and are re-parsed rather than trusted, the same way reimagine.js
   re-normalises a spec that came back from the page. */
async function runSeparate(res, body, base64Data, mediaType, msLeft, student, owner, quota) {
  const raw = Array.isArray(body.picks) ? body.picks : [];
  const picks = raw
    .map((p) => {
      const box = parseBox(p && (p.box || p));
      if (!box) return null;
      return { box, label: String((p && p.label) || "").trim().slice(0, 40) || "אלמנט" };
    })
    .filter(Boolean)
    .slice(0, MAX_PICKS);

  if (!picks.length) {
    return res.status(400).json({ error: "לא נבחרו אלמנטים לחילוץ.", needPicks: true });
  }
  const dropped = raw.length - picks.length;

  const prot = await checkProtected(base64Data, mediaType);
  if (prot) {
    console.warn("[separate] REFUSED at separate - protected material:", prot);
    return res.status(422).json({ error: IP_ERROR, blocked: "ip", reason: prot });
  }

  const original = Buffer.from(base64Data, "base64");

  const files = [];
  let skipped = 0;
  for (let i = 0; i < picks.length; i++) {
    /* Finishing three elements and saying so beats timing out at sixty seconds with nothing. */
    if (i > 0 && msLeft() < 15000) { skipped = picks.length - i; break; }
    try {
      const c = await cropTo(original, picks[i].box);
      if (!c) { console.warn(`[separate] element ${i + 1} box unusable - skipping`); continue; }
      const out = await processOne(c, msLeft());
      out.label = picks[i].label;
      files.push(out);
      console.log(`[separate] element ${i + 1}/${picks.length} "${picks[i].label}" done (${out.quality})`);
    } catch (e) {
      console.error(`[separate] element ${i + 1} failed:`, e.message);
    }
  }
  if (!files.length) {
    return res.status(502).json({ error: "החילוץ נכשל. נסו שוב או בחרו פחות אלמנטים." });
  }

  /* Charged once per run, after files exist — a failure never costs him or a customer anything. */
  let left = { freeLeft: quota.freeLeft, credits: quota.credits };
  if (owner) {
    await sbPost("design_runs", { student_id: student.id, charged: false }, "return=minimal")
      .catch((e) => console.error("[separate] owner run log failed:", e));
    left = { freeLeft: null, credits: null, owner: true };
  } else {
    try { left = await chargeRun(student, quota); }
    catch (e) { console.error("[separate] charge failed (files were delivered):", e); }
  }

  const notices = [];
  if (dropped > 0) notices.push(`אפשר לחלץ עד ${MAX_PICKS} אלמנטים בריצה אחת — ${dropped} לא נכללו.`);
  if (skipped) notices.push(`${skipped} אלמנטים לא הספיקו להיות מעובדים. הריצו אותם בריצה נוספת.`);
  const low = files.filter((f) => f.quality === "low").length;
  if (low) notices.push(`${low} מהקבצים ברזולוציה נמוכה — בדקו אותם לפני הדפסה.`);
  for (const f of files) if (f.holeWarning) { notices.push(f.holeWarning); break; }

  console.log(`[separate] done: ${files.length} file(s)`);
  return res.status(200).json({
    files,
    imageUrl: files[0].url,
    url: files[0].url,
    width: CANVAS_W, height: CANVAS_H, dpi: DPI,
    count: files.length,
    notice: notices.join(" "),
    freeLeft: left.freeLeft, credits: left.credits, owner: !!owner,
  });
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
  const { image } = body;
  if (!image || typeof image !== "string") return res.status(400).json({ error: "Missing image" });
  const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Invalid image format" });
  const [, mediaType, base64Data] = match;

  const t0 = Date.now();
  const msLeft = () => 57000 - (Date.now() - t0);

  const action = String(body.action || "detect").toLowerCase();
  if (action !== "detect" && action !== "separate") {
    return res.status(400).json({ error: "Unknown action" });
  }

  try {
    const student = await studentFromToken(body.token || req.headers["x-epai-token"] || req.query.token);
    if (!student) return res.status(401).json({ error: "צריך להתחבר כדי להשתמש בכלי.", needLogin: true });

    const owner = isOwner(student.email);
    const quota = owner ? { freeLeft: 0, credits: 0, canRun: true } : await quotaFor(student);

    /* Detect is the shop window: one Claude call, no file, never charged, so it runs even for an
       account with nothing left. Same reasoning as analyze in reimagine.js — gating the preview
       only hides what the tool is for. */
    if (action === "detect") return await runDetect(res, base64Data, mediaType);

    if (!quota.canRun) {
      return res.status(402).json({
        error: "נגמרו החילוצים החינמיים. אפשר לרכוש חבילת קרדיטים ולהמשיך.",
        needCredits: true, freeLeft: 0, credits: 0,
      });
    }

    return await runSeparate(res, body, base64Data, mediaType, msLeft, student, owner, quota);
  } catch (err) {
    console.error("[separate] failed:", err);
    return res.status(502).json({ error: "הפעולה נכשלה. נסו שוב." });
  }
}
