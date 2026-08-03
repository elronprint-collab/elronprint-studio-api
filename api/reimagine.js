import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v20
// v17 change: removed the esrgan upscale + third birefnet pass. That block started at
// ~28s and never finished inside the 60s function limit, causing FUNCTION_INVOCATION_TIMEOUT.
// Removing it also means the image the user receives is the one that actually passed QC.
// v18 change: prompt-only. The model was reproducing not just the drawing TECHNIQUE but the
// paper it was drawn on — cream/toned stock — and birefnet treats that tinted paper as part
// of the artwork, so it survived removal as a solid block behind the subject. The prompts now
// separate technique from substrate and demand pure white. No logic touched.
// v19 change: added a fallback. When the generated artwork is a tight close-up that fills its
// frame, birefnet's mask covers the whole rectangle and the plain background survives as a
// solid block. If QC reports the edges are still opaque, we now strip it ourselves with an
// edge-seeded scanline flood fill - the same connectivity approach as the magic wand in the
// app, so enclosed light areas (skin, eyes) are never touched. Runs ONLY on failed output.
// v20 change: fixes v19. birefnet normally leaves a transparent margin around its mask, so
// the outermost pixels are NOT the surface we need to strip - v19 sampled them, read
// (0,0,0), decided the background was dark and refused to run. v20 walks inward from the
// border THROUGH transparent pixels and samples the first opaque surface it meets, and the
// fill itself now passes freely through already-transparent pixels.

import sharp from "sharp";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const EDGE_LIMIT = 0.015;
const PALE_LIMIT = 0.12;
const RIM_LIMIT  = 0.35;
const ERODE_RADIUS = 2;
const ALPHA_FLOOR = 130;

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

/* ---------------- fal helper ---------------- */
async function fal(model, input) {
  const r = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error(`fal ${model} failed:`, r.status, t);
    throw new Error(`${model} failed`);
  }
  const d = await r.json();
  const url = d?.images?.[0]?.url || d?.image?.url || d?.url;
  if (!url) throw new Error(`${model}: no image returned`);
  return url;
}

/* ---------------- step 1: Claude writes an original prompt ---------------- */
const ANALYSIS_SYSTEM_PROMPT = `You are a creative director for a t-shirt printing studio.

WHAT TO ANALYSE — READ THIS BEFORE ANYTHING ELSE.
The image you are shown is one of two things:
(a) a standalone artwork file — the design itself, or
(b) a PHOTO OF SOMEONE WEARING A GARMENT, or a product mockup, where a design is
    printed on the garment.

If it is (b), the ONLY thing that matters is the PRINTED GRAPHIC on the garment.
Completely ignore the model, their face, hair, body, pose and expression; ignore the
garment itself, the room, the street, the sky, the lighting and the photographic style
of the photo. The subject, the rendering technique, the colours and the text you
describe must all come from the printed graphic alone. NEVER describe the person
wearing the shirt — that is the single worst mistake you can make here.

Now write a prompt for a NEW design in the SAME rendering style and the SAME subject
category as THAT GRAPHIC — but a clearly different picture.

NO OUTLINE AROUND THE ARTWORK. THIS IS A HARD RULE.
Do not describe a white outline, a light contour, a keyline, a stroke, a glow, a die-cut
edge or any band of colour tracing the silhouette of the subject or the lettering. The
artwork ends exactly where the drawing ends. State plainly that there is no outline
around the artwork.

STYLE RULE — OVERRIDES THE COLOUR RULE BELOW.
Identify how the GRAPHIC is rendered, and reproduce that exact technique:
- A photographic or photorealistic graphic stays photorealistic: real skin texture,
  real fabric, natural lighting, no drawn outlines.
- Anime or manga stays anime. Flat vector stays flat vector. Watercolour stays
  watercolour. Comic ink stays comic ink. Oil painting stays oil painting.
Note: a photo of a person wearing a shirt is NOT a photographic graphic. Judge only the
artwork printed on the fabric.
Name the technique explicitly at the start of your prompt.

TECHNIQUE IS NOT THE SAME AS THE SURFACE IT SITS ON.
Copy how the marks are made — the linework, the shading, the brushwork, the rendering.
Never copy the paper, board, canvas or backdrop those marks sit on. Even when the
reference graphic is clearly drawn on cream, tan, kraft, sepia, aged, textured or
speckled stock, the new design is drawn on nothing at all. Do not write the words paper,
parchment, newsprint, canvas, board, vintage, aged, weathered, sepia, toned, off-white,
cream, tan or beige anywhere in your prompt, and never describe grain, fibre, tooth,
stains or texture behind the subject.

KEEP THE SUBJECT TYPE. THIS IS MANDATORY.
Whatever the printed graphic depicts, the new design depicts the same kind of thing.
A woman stays a woman. A skull stays a skull. A car stays a car.
NEVER substitute a different category.

ONE SUBJECT ONLY — NOTHING BESIDE IT.
The artwork contains the single subject and nothing else. No stacks of books, plants,
cups, flowers, leaves, sparkles, wreaths, frames or decorative motifs beside, behind or
under it. If the pose needs something in the hands, allow at most ONE small held item.

CHANGE EVERYTHING ELSE.
Change the pose, the activity, the hair, the outfit, the colour palette and the camera
angle. If your description could be mistaken for the original graphic, rewrite it.

TEXT RULE.
- If the printed graphic contains NO text, the new design contains no text either.
- If it DOES contain text, invent DIFFERENT wording of your own.
  * English only, one to three words maximum, in capitals inside quotation marks.
  * All capitals, spelled consistently — never mix a lowercase letter into a capitalised
    word.
  * Never reuse the original words, and never use a real brand, band, company, book or
    film name, or a known trademarked slogan.
  * Solid saturated letters with no outline, no stroke and no drop shadow around them.
  * Place it so it does not overlap the subject's face.

NO BACKGROUND.
The subject stands alone on pure white — hex #FFFFFF, flat and empty — which will be cut
away automatically. Never describe a setting, room, street, city, furniture, sky, wall,
floor, panel, rectangle or scene. The white must be pure: not cream, not ivory, not
eggshell, not warm white, not a wash, not a gradient, not a halo, not lightly tinted and
not textured. State explicitly in your prompt that the background is pure white #FFFFFF
and completely empty.

COLOUR RULE — subordinate to the style rule.
The print must read on a white shirt as well as black.
- For ILLUSTRATED styles: dark linework inside the drawing, saturated mid-to-deep
  colours, no large white or cream fills, strong contrast between adjacent shapes.
- For PHOTOREALISTIC style: no drawn linework. Instead specify deep saturated clothing
  and hair, dramatic directional lighting and strong tonal contrast.
- In both cases avoid neon, glow and pale fluorescent colours. Lettering in particular
  must be a deep saturated colour, never pale cyan, pale yellow or white.

COMPOSITION RULE.
The entire subject, including raised arms, hair and lettering, sits well inside the
frame with clear empty space on all four sides. Nothing touches the edge.

Also: no logos, no brand names, no real people, no recognisable copyrighted characters.

OUTPUT FORMAT — follow exactly.
First line: either
STYLE: photoreal
or
STYLE: illustration
Then a blank line, then 2-4 sentences as a direct image-generation prompt in English.
No preamble, no markdown, nothing else.`;

async function analyzeAndReimagine(base64Data, mediaType) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 450,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: "If this is a photo of someone wearing a shirt, describe ONLY the graphic printed on the shirt and ignore the wearer entirely. Same subject category and rendering technique as that graphic, but a different pose, palette and details. Subject alone, no objects beside it, and absolutely no outline or stroke tracing the artwork. Copy the drawing technique but NOT the surface it is drawn on — even if the reference sits on cream or textured stock, your design sits on pure white #FFFFFF and nothing else. Remember the STYLE: line first." },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("anthropic analyze failed:", r.status, t);
    throw new Error("Analysis failed");
  }
  const data = await r.json();
  const raw = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (!raw) throw new Error("No analysis text returned");

  const m = raw.match(/^\s*STYLE:\s*(photoreal|illustration)\s*/i);
  const style = m ? m[1].toLowerCase() : "illustration";
  const prompt = raw.replace(/^\s*STYLE:\s*(photoreal|illustration)\s*/i, "").trim();

  console.log(`[reimagine] style=${style} prompt:`, prompt.slice(0, 250));
  return { style, prompt };
}

/* ---------------- step 2: generate ---------------- */
const COMMON_SUFFIX =
  ", single subject only, nothing beside the subject, no extra objects, no props, no decorations, isolated on a pure white #FFFFFF background, flat empty pure white backdrop, no paper, no paper texture, no toned paper, no cream background, no ivory, no beige, no tan, no kraft, no parchment, no newsprint, no canvas texture, no aged paper, no vintage paper, no weathered surface, no sepia tone, no off-white, no warm white, no grain, no speckle, no stains, no tint, no gradient behind the subject, no background panel, no rectangle, no scene, no furniture, no border, no outline around the artwork, no white keyline, no contour stroke, no glow, not a sticker, no die-cut edge, no neon, no pale fluorescent colours, entire subject inside the frame with empty margins on all sides, vertical 4:5 composition";

const ILLUSTRATION_SUFFIX =
  ", dark linework inside the drawing, deep saturated colours, strong value contrast, no white or cream fills, commercial illustration quality" + COMMON_SUFFIX;

const PHOTOREAL_SUFFIX =
  ", photorealistic, sharp photographic detail, realistic skin texture, realistic fabric, dramatic directional lighting, strong tonal contrast, deep saturated clothing, no illustration, no anime, no cartoon, no vector art, no drawn outlines, no painterly brushwork" + COMMON_SUFFIX;

async function generate(prompt, style, dataUri) {
  const suffix = style === "photoreal" ? PHOTOREAL_SUFFIX : ILLUSTRATION_SUFFIX;
  try {
    return await fal("fal-ai/nano-banana/edit", {
      prompt: `The reference may be a photo of someone wearing a printed shirt — if so, use ONLY the graphic printed on the shirt as your reference and ignore the wearer, the garment and the surroundings completely. Draw a new standalone artwork in that graphic's technique, same kind of subject, different pose, palette and details, alone with nothing next to it and no outline traced around it. Match the drawing technique but never the surface it is drawn on: the background here is pure white #FFFFFF, flat and empty, never cream or toned or textured paper: ${prompt}${suffix}`,
      image_urls: [dataUri],
      num_images: 1,
      output_format: "png",
    });
  } catch (e) {
    console.warn("nano-banana failed, falling back to FLUX:", e.message);
  }
  return await fal("fal-ai/flux/dev", {
    prompt: `${prompt}, high detail, isolated subject, t-shirt print artwork${suffix}`,
    image_size: { width: 1152, height: 1536 },
    num_inference_steps: 32,
    guidance_scale: 3.5,
    output_format: "png",
    enable_safety_checker: true,
  });
}

/* ---------------- quality control ---------------- */
async function inspect(url) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .resize(220, 220, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: w, height: h, channels: ch } = info;
  const A = (x, y) => data[(y * w + x) * ch + 3];

  let edgeHits = 0, edgeTotal = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!(x < 2 || y < 2 || x >= w - 2 || y >= h - 2)) continue;
      edgeTotal++;
      if (A(x, y) > 128) edgeHits++;
    }
  }

  let solid = 0, pale = 0;
  for (let i = 0; i < data.length; i += ch) {
    if (data[i + 3] < 200) continue;
    solid++;
    if (data[i] > 224 && data[i + 1] > 224 && data[i + 2] > 224) pale++;
  }

  // a drawn white outline shows up as near-white pixels sitting on the silhouette
  let boundary = 0, whiteRim = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * ch;
      if (data[i + 3] < 200) continue;
      if (A(x - 1, y) > 60 && A(x + 1, y) > 60 && A(x, y - 1) > 60 && A(x, y + 1) > 60) continue;
      boundary++;
      if (data[i] > 215 && data[i + 1] > 215 && data[i + 2] > 215) whiteRim++;
    }
  }

  const edgeRatio = edgeTotal ? edgeHits / edgeTotal : 0;
  const paleRatio = solid ? pale / solid : 0;
  const rimRatio = boundary ? whiteRim / boundary : 0;
  const report = {
    edgeRatio, paleRatio, rimRatio,
    cropped: edgeRatio > EDGE_LIMIT,
    tooPale: paleRatio > PALE_LIMIT,
    outlined: rimRatio > RIM_LIMIT,
  };
  console.log(`[reimagine] QC edge=${edgeRatio.toFixed(3)} pale=${paleRatio.toFixed(3)} rim=${rimRatio.toFixed(3)} cropped=${report.cropped} tooPale=${report.tooPale} outlined=${report.outlined}`);
  return report;
}

function retryHint(qc) {
  const parts = [];
  if (qc.cropped) {
    parts.push("CRITICAL: the previous attempt was cut off by the frame. Zoom out. Make the subject noticeably smaller and fully contained, with wide empty margins on every side");
  }
  if (qc.tooPale) {
    parts.push("CRITICAL: the previous attempt was too light and would disappear on a white shirt. Use much deeper, more saturated colours and stronger tonal contrast. Keep the same rendering technique and the same kind of subject");
  }
  if (qc.outlined) {
    parts.push("CRITICAL: the previous attempt had a white outline traced around the artwork and the lettering, like a sticker. Draw NO outline, NO keyline, NO stroke and NO glow around the subject or the letters. The artwork must end exactly where the drawing ends");
  }
  return ". " + parts.join(". ") + ".";
}

/* ---------------- edge cleanup ----------------
   Background removal leaves a faint light halo a pixel or two wide, which prints as a
   grey outline on a black garment. Drop very faint alpha, then erode the alpha channel
   with a separable min filter. */
async function cleanEdges(buf, radius = ERODE_RADIUS, floor = ALPHA_FLOOR) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  const a = new Uint8Array(w * h);
  for (let p = 0, i = 3; p < w * h; p++, i += ch) a[p] = data[i] < floor ? 0 : data[i];

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
      let m = 255;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) { m = 0; break; }
        const v = tmp[yy * w + x];
        if (v < m) m = v;
      }
      data[(y * w + x) * ch + 3] = m;
    }
  }

  return sharp(data, { raw: { width: w, height: h, channels: ch } }).png({ compressionLevel: 1 }).toBuffer();
}

/* ---------------- fallback: edge-seeded background flood fill ----------------
   birefnet returns a mask of "the salient object". When the generated artwork is a tight
   close-up that fills its frame, that mask covers essentially the whole rectangle and the
   plain background survives as a solid block. This is the recovery path.

   It is a scanline flood fill seeded from the four borders, so ONLY background connected
   to an edge is removed — light areas enclosed inside the drawing (skin, the hole in a
   letter, an eye) are never touched, because the fill cannot reach them. That connectivity
   is what makes this safe on artwork whose subject is nearly the same tone as its
   background; a plain colour threshold would eat the face.

   Guarded twice: it only runs when birefnet has clearly failed, and only when the detected
   background is near-white. */
function floodFillBackground(data, w, h, ch, tolIn = 24, tolOut = 70) {
  const idx = (x, y) => (y * w + x) * ch;
  const OPAQUE = 128;
  const key = (i) => (data[i] >> 4) * 289 + (data[i + 1] >> 4) * 17 + (data[i + 2] >> 4);

  /* Pass 1 - find the background colour.
     birefnet usually leaves a transparent margin already, so the outermost pixels are not
     the background we need to strip; the background is the first OPAQUE thing we meet
     walking inward. Walk in from the border through transparent pixels and sample the
     colour of every opaque pixel we bump into. */
  const reached = new Uint8Array(w * h);
  let probe = [];
  const seed = (x, y) => {
    const p = y * w + x;
    if (reached[p]) return;
    reached[p] = 1;
    probe.push(x, y);
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  const buckets = new Map();
  while (probe.length) {
    const y = probe.pop(), x = probe.pop();
    const i = idx(x, y);
    if (data[i + 3] >= OPAQUE) {
      // first opaque pixel on this path - this is the surface we would be stripping
      buckets.set(key(i), (buckets.get(key(i)) || 0) + 1);
      continue;
    }
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  if (!buckets.size) {
    console.warn("[reimagine] flood fill skipped - nothing opaque reachable from the edges");
    return false;
  }

  let bestKey = 0, bestCount = -1;
  for (const [k, c] of buckets) if (c > bestCount) { bestCount = c; bestKey = k; }
  const bg = [
    ((bestKey / 289) | 0) * 16 + 8,
    (((bestKey % 289) / 17) | 0) * 16 + 8,
    (bestKey % 17) * 16 + 8,
  ];

  // guard: only strip a light surface (white through cream/ivory), never a dark or
  // saturated one - those are far more likely to be the artwork itself
  if (Math.min(bg[0], bg[1], bg[2]) < 170) {
    console.warn(`[reimagine] flood fill skipped - surface is not light enough (${bg.join(",")})`);
    return false;
  }

  const dist = (i) =>
    Math.max(
      Math.abs(data[i] - bg[0]),
      Math.abs(data[i + 1] - bg[1]),
      Math.abs(data[i + 2] - bg[2])
    );

  /* Pass 2 - the actual fill. Already-transparent pixels are free to walk through, so a
     transparent margin left by birefnet does not block us. Opaque pixels are only entered
     when their colour is within tolerance of the background. */
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (seen[p]) return;
    const i = idx(x, y);
    if (data[i + 3] < OPAQUE) { seen[p] = 1; stack.push(x, y); return; }
    if (dist(i) > tolOut) return;
    seen[p] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  let cleared = 0;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    const i = idx(x, y);
    if (data[i + 3] >= OPAQUE) {
      const d = dist(i);
      // soft edge: fully clear inside tolIn, ramp up to tolOut
      const alpha = d <= tolIn ? 0 : Math.round(((d - tolIn) / (tolOut - tolIn)) * 255);
      if (alpha < data[i + 3]) { data[i + 3] = alpha; cleared++; }
    }

    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  console.log(`[reimagine] flood fill bg=(${bg.join(",")}) cleared ${((cleared / (w * h)) * 100).toFixed(1)}% of pixels`);
  return true;
}

async function stripLeftoverBackground(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const did = floodFillBackground(data, w, h, ch);
  if (!did) return buf;
  return sharp(data, { raw: { width: w, height: h, channels: ch } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/* ---------------- print canvas ---------------- */
async function toPrintCanvas(buf) {
  const stats = await sharp(buf).ensureAlpha().stats();
  if (stats.isOpaque) console.warn("[reimagine] WARNING: image has no transparency");

  buf = await cleanEdges(buf);

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
  console.log(`[reimagine] artwork ${m.width}x${m.height} on ${CANVAS_W}x${CANVAS_H}`);

  return sharp({
    create: {
      width: CANVAS_W, height: CANVAS_H, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: inner,
      left: Math.round((CANVAS_W - m.width) / 2),
      top: Math.round((CANVAS_H - m.height) / 2),
    }])
    .withMetadata({ density: DPI })
    .png({ compressionLevel: 3, effort: 1 })
    .toBuffer();
}

async function fitUploadSize(buffer) {
  const MAX = 9.5 * 1024 * 1024;
  if (buffer.length <= MAX) return buffer;
  console.warn(`[reimagine] png ${(buffer.length / 1048576).toFixed(1)}MB - re-encoding as palette`);
  return sharp(buffer)
    .png({ compressionLevel: 9, palette: true, colours: 256, dither: 1 })
    .withMetadata({ density: DPI })
    .toBuffer();
}

/* ---------------- upload ---------------- */
async function uploadCloudinary(buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), "design.png");
  form.append("upload_preset", CLOUD_PRESET);
  const r = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: "POST", body: form }
  );
  const text = await r.text();
  if (!r.ok) {
    console.error("cloudinary failed:", r.status, text.slice(0, 500));
    throw new Error("Upload failed");
  }
  const d = JSON.parse(text);
  if (!d.secure_url) {
    console.error("cloudinary no url:", text.slice(0, 500));
    throw new Error("Upload failed");
  }
  return d.secure_url;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const retryAfter = checkRateLimit(req);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests", retryAfter });
  }

  const { image } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "Missing image" });
  }
  const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Invalid image format" });
  }
  const [, mediaType, base64Data] = match;

  try {
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;
    const step = (name) => console.log(`[reimagine] ${name}: ${elapsed()}ms`);

    const { style, prompt } = await analyzeAndReimagine(base64Data, mediaType);
    step("analyze");

    let art = await generate(prompt, style, image);
    let cutout = await fal("fal-ai/birefnet", { image_url: art });
    step("attempt1");

    let qc = await inspect(cutout);
    const bad = (q) => q.cropped || q.tooPale || q.outlined;
    const score = (q) => (q.cropped ? 1 : 0) + (q.tooPale ? 1 : 0) + (q.outlined ? 1 : 0);

    if (bad(qc) && elapsed() < 30000) {
      console.log("[reimagine] QC failed - regenerating with corrections");
      try {
        const art2 = await generate(prompt + retryHint(qc), style, image);
        const cut2 = await fal("fal-ai/birefnet", { image_url: art2 });
        const qc2 = await inspect(cut2);
        step("attempt2");

        if (score(qc2) < score(qc)) {
          art = art2; cutout = cut2; qc = qc2;
          console.log("[reimagine] retry accepted");
        } else {
          console.log("[reimagine] retry rejected - keeping first attempt");
        }
      } catch (e) {
        console.warn("retry failed:", e.message);
      }
    } else if (bad(qc)) {
      console.warn("[reimagine] QC failed but no time budget for a retry");
    }

    // birefnet kept the whole frame - recover the background ourselves
    let cutBuf = Buffer.from(await (await fetch(cutout)).arrayBuffer());
    if (qc.cropped) {
      console.log("[reimagine] edges still opaque after birefnet - running flood fill");
      try {
        cutBuf = await stripLeftoverBackground(cutBuf);
        step("floodfill");
      } catch (e) {
        console.warn("flood fill failed, keeping birefnet output:", e.message);
      }
    }

    let canvas = await toPrintCanvas(cutBuf);
    console.log(`[reimagine] png size: ${(canvas.length / 1048576).toFixed(1)}MB`);
    canvas = await fitUploadSize(canvas);
    step("canvas");

    const imageUrl = await uploadCloudinary(canvas);
    step("upload");

    return res.status(200).json({
      imageUrl,
      url: imageUrl,
      width: CANVAS_W,
      height: CANVAS_H,
      dpi: DPI,
      style,
      quality: {
        edge: +qc.edgeRatio.toFixed(3),
        pale: +qc.paleRatio.toFixed(3),
        rim: +qc.rimRatio.toFixed(3),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Reimagine failed" });
  }
}
