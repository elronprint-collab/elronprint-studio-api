import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש": מקבל תמונה של חולצה עם הדפס קיים,
// מנתח אותה עם Claude (שלב הבנה), ואז יוצר עיצוב חדש בהשראתה דרך FLUX —
// לא העתקה: דמות/כיתוב משתנים, נשאר רק הסגנון/הרעיון.
// דורש משתנה סביבה נוסף: ANTHROPIC_API_KEY (בנוסף ל-FAL_KEY הקיים)

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

const ANALYSIS_SYSTEM_PROMPT = `You are a creative director for a t-shirt printing studio.
You will be shown a photo of a t-shirt with a printed design on it.

Your job is to describe a NEW, DIFFERENT design that is only INSPIRED by the
one shown — same general style, mood, and color palette — but NOT a copy.

Hard rules:
- If the design has a specific character, animal, or figure, you MUST swap it
  for a different one in the same category (e.g. a lion becomes a fox or wolf,
  never the same animal). Never describe the original subject directly.
- If there is any text/lettering in the photo, do NOT reuse it. Either invent
  new short text, or omit text entirely if the user's note doesn't ask for it.
- Describe only: overall art style, color palette, composition, and mood.
- Do not mention the t-shirt, garment, fabric, folds, model, or background —
  describe the artwork only, as if it will be generated on its own, isolated.
- Output ONLY a single short paragraph (2-4 sentences) written as a direct
  image-generation prompt in English. No preamble, no "Sure, here's...".`;

// שלב 1: Claude מסתכל על התמונה ומתאר עיצוב חדש בהשראתה (לא העתקה)
async function analyzeAndReimagine(base64Data, mediaType, note) {
  const userInstruction = note
    ? `The user also gave this guidance for the new version: "${note}". Follow it if it doesn't conflict with the hard rules above.`
    : "The user gave no specific guidance — use your own creative judgement for the swap.";

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: userInstruction },
          ],
        },
      ],
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

// שלב 2: אותה קריאת FLUX בדיוק כמו ב-generate.js
async function generateWithFlux(prompt) {
  const r = await fetch("https://fal.run/fal-ai/flux/dev", {
    method: "POST",
    headers: {
      "Authorization": `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: `${prompt}, rich modern cartoon illustration, soft shading with highlights and dynamic lighting, bold clean linework, vibrant colors, high detail, isolated subject, t-shirt print artwork`,
      image_size: { width: 1152, height: 1536 },
      num_inference_steps: 28,
      guidance_scale: 3.5,
      output_format: "png",
      enable_safety_checker: true,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("fal generate failed:", r.status, t);
    throw new Error("Generation failed");
  }
  const data = await r.json();
  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) throw new Error("No image returned");
  return imageUrl;
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

  const { image, note } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "Missing image" });
  }
  const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Invalid image format" });
  }
  const [, mediaType, base64Data] = match;
  const cleanNote = typeof note === "string" ? note.trim().slice(0, 300) : "";

  try {
    const newPrompt = await analyzeAndReimagine(base64Data, mediaType, cleanNote);
    const imageUrl = await generateWithFlux(newPrompt);
    return res.status(200).json({ imageUrl });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Reimagine failed" });
  }
}
