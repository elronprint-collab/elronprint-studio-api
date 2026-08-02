import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v13 (style-matched: photoreal stays photoreal)

import sharp from "sharp";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const EDGE_LIMIT = 0.015;
const PALE_LIMIT = 0.12;

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
You will be shown an image containing a printed design.

Write a prompt for a NEW design in the SAME rendering style and the SAME subject
category as the reference — but a clearly different picture.

STYLE RULE — THIS COMES FIRST AND OVERRIDES THE COLOUR RULE BELOW.
Identify how the reference is rendered, and reproduce that exact technique:
- A photograph or photorealistic render stays PHOTOREALISTIC: real skin texture, real
  fabric, natural lighting, real depth of field. It must NOT become an illustration,
  anime, cartoon or vector art, and must have NO drawn outlines of any kind.
- Anime or manga stays anime. Flat vector stays flat vector. Watercolour stays
  watercolour. Comic ink stays comic ink. Oil painting stays oil painting.
Name the technique explicitly at the start of your prompt.

KEEP THE SUBJECT TYPE. THIS IS MANDATORY.
A woman stays a woman. A man stays a man. A dog stays a dog. A car stays a car.
NEVER substitute a different category.

ONE SUBJECT ONLY — NOTHING BESIDE IT.
The artwork contains the single subject and nothing else. Do NOT add stacks of books,
plants, cups, pillows, flowers, leaves, sparkles, wreaths, frames, decorative motifs or
any object sitting next to, behind or under the subject. If the pose needs something in
the hands, allow at most ONE small held item, touching the hands.

CHANGE EVERYTHING ELSE.
Change the pose and body position, the activity, the hair, the outfit, the colour
palette and the camera angle. If your description could be mistaken for the reference
image, rewrite it.

TEXT RULE.
- If the reference contains NO text, the new design contains no text either.
- If the reference DOES contain text, invent DIFFERENT wording of your own.
  * English only, one to three words maximum, in capitals inside quotation marks.
  * Never reuse the reference's words, and never use a real brand, band, company,
    book or film name, or a known trademarked slogan.
  * Place it so it does not overlap the subject's face.

NO BACKGROUND, NO STICKER BORDER.
The subject stands alone on plain white that will be deleted. Never describe a setting,
room, street, city, furniture, sky, wall, floor, panel, rectangle or scene. This is NOT
a sticker — no white outline, no die-cut edge, no border around the artwork.

COLOUR RULE — subordinate to the style rule.
The print must read on a white shirt as well as black.
- For ILLUSTRATED styles: bold dark outlines on every element, saturated mid-to-deep
  colours, no large white or cream fills, strong contrast between adjacent shapes.
- For PHOTOREALISTIC style: do NOT add outlines — that would break the realism.
  Instead specify deep saturated clothing and hair, dramatic directional lighting and
  strong tonal contrast, so the subject separates clearly from a white garment. Skin is
  rendered naturally.
- In both cases, avoid neon or glow effects, which only read on dark garments.

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
          { type: "text", text: "Match the reference's rendering technique exactly. Same subject category, different pose, activity, outfit and palette. Subject alone, no objects beside it. Remember the STYLE: line first." },
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
  ", single subject only, nothing beside the subject, no extra objects, no props, no plants, no decorations, plain white background, no background panel, no rectangle, no scene, no furniture, no border, no white outline, not a sticker, no neon glow, entire subject inside the frame with empty margins on all sides, vertical 4:5 composition";

const ILLUSTRATION_SUFFIX =
  ", bold dark outlines on every element, deep saturated colours, strong value contrast, no white or cream fills, commercial illustration quality" + COMMON_SUFFIX;

const PHOTOREAL_SUFFIX =
  ", photorealistic, sharp photographic detail, realistic skin texture, realistic fabric, dramatic directional lighting, strong tonal contrast, deep saturated clothing, no illustration, no anime, no cartoon, no vector art, no drawn outlines, no painterly brushwork" + COMMON_SUFFIX;

async function generate(prompt, style, dataUri) {
  const suffix = style === "photoreal" ? PHOTOREAL_SUFFIX : ILLUSTRATION_SUFFIX;
  try {
    return await fal("fal-ai/nano-banana/edit", {
      prompt: `Match the reference's rendering technique exactly. Keep the same kind of subject but draw a different pose, activity, outfit and palette, alone with nothing next to it: ${prompt}${suffix}`,
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
  const at = (x, y) => (y * w + x) * ch;

  let edgeHits = 0, edgeTotal = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!(x < 2 || y < 2 || x >= w - 2 || y >= h - 2)) continue;
      edgeTotal++;
      if (data[at(x, y) + 3] > 128) edgeHits++;
    }
  }

  let solid = 0, pale = 0;
  for (let i = 0; i < data.length; i += ch) {
    if (data[i + 3] < 200) continue;
    solid++;
    if (data[i] > 224 && data[i + 1] > 224 && data[i + 2] > 224) pale++;
  }

  const edgeRatio = edgeTotal ? edgeHits / edgeTotal : 0;
  const paleRatio = solid ? pale / solid : 0;
  const report = {
    edgeRatio, paleRatio,
    cropped: edgeRatio > EDGE_LIMIT,
    tooPale: paleRatio > PALE_LIMIT,
  };
  console.log(`[reimagine] QC edge=${edgeRatio.toFixed(3)} pale=${paleRatio.toFixed(3)} cropped=${report.cropped} tooPale=${report.tooPale}`);
  return report;
}

function retryHint(qc) {
  const parts = [];
  if (qc.cropped) {
    parts.push("CRITICAL: the previous attempt was cut off by the frame. Zoom out. Make the subject noticeably smaller and fully contained, with wide empty margins on every side");
  }
  if (qc.tooPale) {
    parts.push("CRITICAL: the previous attempt was too light and would disappear on a white shirt. Use much deeper, more saturated clothing and hair, and stronger tonal contrast. Keep the same rendering technique and the same kind of subject");
  }
  return ". " + parts.join(". ") + ".";
}

/* ---------------- print canvas ---------------- */
async function toPrintCanvas(url) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());

  const stats = await sharp(buf).ensureAlpha().stats();
  if (stats.isOpaque) console.warn("[reimagine] WARNING: image has no transparency");

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

    if ((qc.cropped || qc.tooPale) && elapsed() < 30000) {
      console.log("[reimagine] QC failed - regenerating with corrections");
      try {
        const art2 = await generate(prompt + retryHint(qc), style, image);
        const cut2 = await fal("fal-ai/birefnet", { image_url: art2 });
        const qc2 = await inspect(cut2);
        step("attempt2");

        const score = (q) => (q.cropped ? 1 : 0) + (q.tooPale ? 1 : 0);
        if (score(qc2) < score(qc)) {
          art = art2; cutout = cut2; qc = qc2;
          console.log("[reimagine] retry accepted");
        } else {
          console.log("[reimagine] retry rejected - keeping first attempt");
        }
      } catch (e) {
        console.warn("retry failed:", e.message);
      }
    } else if (qc.cropped || qc.tooPale) {
      console.warn("[reimagine] QC failed but no time budget for a retry");
    }

    if (elapsed() < 40000) {
      try {
        const big = await fal("fal-ai/esrgan", {
          image_url: art,
          scale: 2,
          model: "RealESRGAN_x4plus",
        });
        cutout = await fal("fal-ai/birefnet", { image_url: big });
        step("upscale");
      } catch (e) {
        console.warn("upscale skipped:", e.message);
      }
    } else {
      console.warn("[reimagine] upscale skipped - no time budget");
    }

    let canvas = await toPrintCanvas(cutout);
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
      quality: { edge: +qc.edgeRatio.toFixed(3), pale: +qc.paleRatio.toFixed(3) },
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Reimagine failed" });
  }
}
