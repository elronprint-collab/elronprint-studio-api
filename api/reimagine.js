import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v6
// pipeline: Claude vision -> nano-banana edit (fallback FLUX) -> 2x upscale
//           -> bg removal (LAST, so alpha survives) -> centered 4500x5400 @300DPI -> Cloudinary

import sharp from "sharp";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.90, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

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

Write a prompt for a NEW, DIFFERENT design that is only INSPIRED by the one shown —
same general style and mood — but NOT a copy.

Hard rules:
- If the design has a specific character, animal or figure, you MUST swap it for a
  different one in the same category. Never describe the original subject directly.
- Change at least three of: pose, scene, props, outfit, palette accent, camera angle.
- NEVER include readable text, book titles, logos, brand names, real people, or
  recognisable copyrighted characters. Replace any branded object with a generic one.
- Do not mention the t-shirt, garment, fabric, folds, model or photo background.

BACKGROUND RULE — ABSOLUTE, OVERRIDES EVERYTHING BELOW.
The artwork is a die-cut sticker. There is NO background of any kind: no coloured
panel, no rectangle, no circle, no scene backdrop, no sky, no wall, no gradient, no
border. The subject floats alone on empty pure white that will be deleted. Never
describe a setting, environment or backdrop — only the object or character itself
plus small props that touch it.

COLOUR RULE — applies ONLY to the subject and its props, never to the background.
The print must be visible on a WHITE shirt as well as black. White, cream, ivory or
pale grey fills on the SUBJECT become invisible on a white shirt. Therefore:
- Every large part of the subject gets an explicit saturated mid-to-deep colour, named
  in the prompt. A bathtub becomes deep teal, not white porcelain. A mug becomes
  mustard. A book becomes burgundy.
- No large white or cream filled area anywhere on the subject. Small highlights are fine.
- Ignore the reference image's palette if it is pale or pastel — deepen it.
- Avoid neon or glow effects, which only read on dark garments. Use solid colour with
  bold dark outlines instead.
- Every element carries a bold dark outline, and neighbouring shapes differ clearly in
  darkness so the artwork reads as a silhouette from a distance.

- Write 2-4 sentences as a direct image-generation prompt in English, naming the
  specific saturated colour of each major part of the subject.
- End with exactly: "die-cut sticker style, isolated subject centered on a plain pure white background, absolutely no background panel, no rectangle, no backdrop, no scene, no border, no shadow, no shirt, no mockup, no text, bold dark outlines on every element, no white or cream fills on the subject itself, deep saturated colours, strong value contrast, commercial illustration quality, entire subject fully inside the frame with generous empty margins on all four sides, vertical 4:5 composition"
- Output ONLY the prompt. No preamble.`;

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
      max_tokens: 400,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: "Write the prompt for a new original design inspired by this. Remember: die-cut sticker with no background at all, and a named saturated colour for every major part of the subject." },
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
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (!text) throw new Error("No analysis text returned");
  console.log("[reimagine] prompt:", text.slice(0, 300));
  return text;
}

/* ---------------- step 2: generate ---------------- */
const COLOUR_SUFFIX =
  ", die-cut sticker, plain white background, no background panel, no rectangle, no backdrop, no scene, no border, subject in deep saturated colour, bold dark outlines, no neon glow";

async function generate(prompt, dataUri) {
  try {
    return await fal("fal-ai/nano-banana/edit", {
      prompt: prompt + COLOUR_SUFFIX,
      image_urls: [dataUri],
      num_images: 1,
      output_format: "png",
    });
  } catch (e) {
    console.warn("nano-banana failed, falling back to FLUX:", e.message);
  }
  return await fal("fal-ai/flux/dev", {
    prompt: `${prompt}, rich modern illustration, bold dark linework, vibrant saturated colors, high detail, isolated subject, t-shirt print artwork${COLOUR_SUFFIX}`,
    image_size: { width: 1152, height: 1536 },
    num_inference_steps: 32,
    guidance_scale: 3.5,
    output_format: "png",
    enable_safety_checker: true,
  });
}

/* ---------------- step 5: centered print canvas ---------------- */
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
    const step = (name) => console.log(`[reimagine] ${name}: ${Date.now() - t0}ms`);

    const prompt = await analyzeAndReimagine(base64Data, mediaType);
    step("analyze");

    let art = await generate(prompt, image);
    step("generate");

    // upscale BEFORE cutting out — RealESRGAN drops the alpha channel
    if (Date.now() - t0 < 22000) {
      try {
        art = await fal("fal-ai/esrgan", {
          image_url: art,
          scale: 2,
          model: "RealESRGAN_x4plus",
        });
        step("upscale");
      } catch (e) {
        console.warn("upscale skipped:", e.message);
      }
    } else {
      console.warn("[reimagine] upscale skipped - no time budget");
    }

    const cutout = await fal("fal-ai/birefnet", { image_url: art });
    step("cutout");

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
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Reimagine failed" });
  }
}
