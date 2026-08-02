import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v8 (with automatic quality retry)

import sharp from "sharp";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.90, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const EDGE_LIMIT = 0.015;   // >1.5% of border pixels opaque = artwork is cut off
const PALE_LIMIT = 0.12;    // >12% near-white = will vanish on a white shirt

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

Write a prompt for a NEW design that borrows only the ART STYLE of the reference —
its rendering technique and mood — and nothing else.

ORIGINALITY RULE — THE MOST IMPORTANT RULE.
The result must be unmistakably a different picture, not a redraw. You MUST invent a
new subject and a new situation. Specifically:
- If the reference shows a person, change their activity entirely — not just their
  hair colour or outfit. Someone lying down becomes someone standing, walking,
  dancing, gardening, cycling. Someone holding a book holds something else.
- Never reuse the reference's pose, camera angle, props, or composition.
- If you find yourself describing what is in the reference image, stop and invent
  something else in the same spirit.
- Prefer replacing a human subject with an animal, plant or object in the same style —
  this gives full control over colour and is usually the strongest result.

NO BACKGROUND, NO STICKER BORDER.
The subject stands alone on plain white that will be deleted. Never describe a setting,
room, furniture, pillow, bed, sky, wall, floor, panel, rectangle or scene. Equally
important: this is NOT a sticker — no white outline, no contour, no die-cut edge, no
border of any kind drawn around the artwork.

COLOUR RULE — applies to the subject only.
White, cream, ivory or pale grey areas on the subject vanish on a white shirt. So:
- Name an explicit saturated mid-to-deep colour for every large part of the subject.
- No large white, cream or very pale area anywhere on the subject. If the natural
  subject would be white (swan, polar bear, fox chest, foam, porcelain), recolour it
  to a saturated alternative or choose a different subject.
- Ignore the reference's palette if it is pale or pastel — deepen it substantially.
- No neon or glow effects — they only read on dark garments.
- Bold dark outlines on every element, with clear darkness differences between
  neighbouring shapes.

COMPOSITION RULE.
The entire subject, including raised arms, tails, wings and held objects, must sit well
inside the frame with clear empty space on all four sides. Nothing may touch or cross
the frame edge. Prefer compact, centred compositions over tall narrow ones.

Also: no readable text, no book titles, no logos, no brand names, no real people, no
recognisable copyrighted characters.

Write 2-4 sentences as a direct image-generation prompt in English, naming the
saturated colour of each major part of the subject.
End with exactly: "isolated subject centered on plain pure white, no background, no scene, no furniture, no panel, no rectangle, no border, no white outline around the artwork, not a sticker, no shadow, no shirt, no mockup, no text, bold dark outlines, no white or cream fills on the subject, deep saturated colours, strong value contrast, commercial illustration quality, entire subject fully inside the frame with generous empty margins on all four sides, nothing touching the frame edge, vertical 4:5 composition"
Output ONLY the prompt. No preamble.`;

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
          { type: "text", text: "Borrow ONLY the art style. Invent a completely different subject and situation. No background, no sticker border, saturated colours, nothing touching the frame edge." },
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
const STYLE_SUFFIX =
  ", plain white background, no background panel, no rectangle, no scene, no furniture, no border, no white outline, not a sticker, subject in deep saturated colour, bold dark outlines, no neon glow";

async function generate(prompt, dataUri) {
  try {
    return await fal("fal-ai/nano-banana/edit", {
      prompt: `Use the reference ONLY for art style. Draw a completely different subject: ${prompt}${STYLE_SUFFIX}`,
      image_urls: [dataUri],
      num_images: 1,
      output_format: "png",
    });
  } catch (e) {
    console.warn("nano-banana failed, falling back to FLUX:", e.message);
  }
  return await fal("fal-ai/flux/dev", {
    prompt: `${prompt}, rich modern illustration, bold dark linework, vibrant saturated colors, high detail, isolated subject, t-shirt print artwork${STYLE_SUFFIX}`,
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
    parts.push("CRITICAL: the previous attempt was cut off by the frame. Zoom out. Make the subject noticeably smaller and fully contained, with wide empty margins on every side. Nothing may touch the edge");
  }
  if (qc.tooPale) {
    parts.push("CRITICAL: the previous attempt was too light and would disappear on a white shirt. Replace every white, cream, ivory and pale grey area with a deep saturated colour. Darken the whole palette substantially");
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

    const prompt = await analyzeAndReimagine(base64Data, mediaType);
    step("analyze");

    // attempt 1
    let art = await generate(prompt, image);
    let cutout = await fal("fal-ai/birefnet", { image_url: art });
    step("attempt1");

    let qc = await inspect(cutout);

    // one corrective retry, only if there is time for it
    if ((qc.cropped || qc.tooPale) && elapsed() < 30000) {
      console.log("[reimagine] QC failed - regenerating with corrections");
      try {
        const art2 = await generate(prompt + retryHint(qc), image);
        const cut2 = await fal("fal-ai/birefnet", { image_url: art2 });
        const qc2 = await inspect(cut2);
        step("attempt2");

        // keep attempt 2 only if it actually improved
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

    // upscale the accepted art, then cut out again (ESRGAN drops alpha)
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
      quality: { edge: +qc.edgeRatio.toFixed(3), pale: +qc.paleRatio.toFixed(3) },
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Reimagine failed" });
  }
}
