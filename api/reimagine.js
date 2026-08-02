import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v2
// pipeline: Claude vision -> nano-banana edit (fallback FLUX) -> background removal
//           -> upscale -> 4500x5400 @300DPI transparent PNG -> Cloudinary
// env: FAL_KEY, ANTHROPIC_API_KEY (both already set)

import sharp from "sharp";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.90, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

/* ---------------- CORS (unchanged) ---------------- */
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

Your job is to write a prompt for a NEW, DIFFERENT design that is only INSPIRED
by the one shown — same general style, mood and palette family — but NOT a copy.

Hard rules:
- If the design has a specific character, animal or figure, you MUST swap it for
  a different one in the same category. Never describe the original subject directly.
- Change at least three of: pose, scene, props, outfit, palette accent, camera angle.
- NEVER include readable text, book titles, logos, brand names, real people, or
  recognisable copyrighted characters. If the reference contains a book, product or
  brand, replace it with a generic unbranded object.
- Do not mention the t-shirt, garment, fabric, folds, model or photo background.
- Write 2-4 sentences as a direct image-generation prompt in English.
- End with exactly: "isolated subject on a flat pure white background, no shirt, no mockup, no frame, no shadow, no text, sharp clean outlines, high contrast rich colours, commercial illustration quality, full subject inside frame with generous margins on all sides, vertical 4:5 composition"
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
          { type: "text", text: "Write the prompt for a new original design inspired by this." },
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
  return text;
}

/* ---------------- step 2: generate ---------------- */
async function generate(prompt, dataUri) {
  // preferred: image-guided variation (keeps the style, changes the content)
  try {
    return await fal("fal-ai/nano-banana/edit", {
      prompt,
      image_urls: [dataUri],
      num_images: 1,
      output_format: "png",
    });
  } catch (e) {
    console.warn("nano-banana failed, falling back to FLUX:", e.message);
  }
  // fallback: text-only generation
  return await fal("fal-ai/flux/dev", {
    prompt: `${prompt}, rich modern illustration, soft shading with highlights, bold clean linework, vibrant colors, high detail, isolated subject, t-shirt print artwork`,
    image_size: { width: 1152, height: 1536 },
    num_inference_steps: 32,
    guidance_scale: 3.5,
    output_format: "png",
    enable_safety_checker: true,
  });
}

/* ---------------- step 5: print canvas ---------------- */
async function toPrintCanvas(url) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());

  const inner = await sharp(buf)
    .ensureAlpha()
    .trim()
    .resize(Math.round(CANVAS_W * SAFE), Math.round(CANVAS_H * SAFE), {
      fit: "inside",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const m = await sharp(inner).metadata();

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
    .png({ compressionLevel: 6 })
    .toBuffer();
}

// Cloudinary unsigned uploads are size-capped; shrink only if we must.
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

    const generated = await generate(prompt, image);
    step("generate");

    const cutout = await fal("fal-ai/birefnet", { image_url: generated });
    step("cutout");

    let upscaled = cutout;
    if (Date.now() - t0 < 18000) {
      try {
        upscaled = await fal("fal-ai/esrgan", {
          image_url: cutout,
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

    let canvas = await toPrintCanvas(upscaled);
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
