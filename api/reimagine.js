import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v32
// v26 change: TWO-STEP CONTROLLED MODE, and a different generator.
// The whole file up to v25 was built around FIDELITY to the reference — nano-banana/edit was
// told "same palette, no new colours, keep the main figure". That is an EDIT model: its job is
// to preserve what it is shown. Asking it for "similar but different" fought the model itself,
// which is why every version either came back too close or fell apart. v26 stops fighting it.
//   POST {action:"analyze", image}        -> Claude reads the reference and returns a SPEC (JSON)
//                                            the user can EDIT on the page. Nothing is generated.
//   POST {action:"generate", spec}        -> the spec is turned into a prompt and drawn FROM TEXT
//                                            by flux/dev. The reference image is never shown to
//                                            the generator, so "different" is the default, not a
//                                            request. Then the existing birefnet + QC + canvas
//                                            pipeline runs unchanged.
// The legacy one-shot path (POST {image} with no action) is untouched and still works.
//
// v27 change: THE SPEC NOW COMES BACK ALREADY VARIED.
// v26 described the reference faithfully, so pressing generate without editing anything reproduced
// the reference. The form only protected a user who used it. v27 splits the spec in two:
//   KEEP faithful  -> genre, palette, technique, typography, composition   (this is the "same vibe")
//   VARY on purpose -> subject, elements, text                             (this is what makes it a copy)
// So the default result is already a step away from the reference, and the user edits only if they
// want something else. What was swapped is stated in "notes" so nothing happens behind their back.
//
// v28 change: THE SPEC FIELDS MAY NOW BE WRITTEN IN HEBREW.
// flux reads English only, so a Hebrew value used to be ignored or drawn as nonsense. Before every
// generation the spec is scanned for Hebrew letters; if any are found, Claude translates the whole
// spec to English in one call (~1-2s) and the ENGLISH copy is what reaches the generator. The
// translated spec is returned to the page so the user can see what was actually drawn.
// The "text" field is treated differently on purpose: text there is meant to be DRAWN, and flux
// cannot draw Hebrew letters legibly. Hebrew in that field is therefore dropped rather than mangled,
// and the response carries a "notice" saying so.
//
// v29 change: THE TOOL IS NO LONGER OPEN TO THE WORLD.
// Every run costs real money (Claude + flux + birefnet), and until now anyone could loop the
// endpoint. Generation now requires a session token from api/auth.js — the SAME passwordless
// email login already built for the academy, so a person who registered there is known here too.
// Quota: FREE_RUNS free designs per account, then paid credits from students.design_credits.
// Analysis stays open — it costs little, it is the shop window, and it produces nothing sellable.
//
// v30 change: THE PRINT FILE IS THE PRODUCT, SO THE FREE RUNS RETURN A WATERMARKED PREVIEW.
// A print-ready 4500x5400 PNG is exactly what a competing seller would take and print elsewhere;
// giving three of those away free means giving away the whole product. Free runs now return a
// ~1200px preview with a tiled diagonal watermark — enough to fall in love with, useless to print.
// The clean 4500x5400 file is released only when a credit is spent. Everything upstream is
// identical either way, so the preview and the paid file are the SAME design, not a re-generation.
//
// v31 change: OWNER ACCOUNTS BYPASS THE WHOLE GATE.
// v30 would have watermarked the shop owner's own first three designs and then asked him to buy
// credits from himself. Emails listed in the OWNER_EMAILS env var (comma separated) skip the
// quota entirely, always receive the clean 4500x5400 file, and are never charged. They still have
// to be logged in, so runs stay attributable.
//
// v32 change: NO WATERMARK, AND THE FREE TIER IS ONE CLEAN DESIGN PER EMAIL.
// His call, after weighing it: a watermarked preview is a weaker hook than one real print file.
// So FREE_RUNS is 1 and that run returns the full clean 4500x5400 file. From the second design on,
// credits are required. The watermark machinery is KEPT but switched off behind WATERMARK_FREE —
// flip that one constant back to true to restore watermarked previews without touching anything else.
// Known and accepted trade-off: someone can register several emails to farm free files.
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
// v21 change: prompt-only, and the real fix. The reference the tool is used with is usually a
// FULL-BLEED PANEL (the "BORN" square), and the prompts told the model to be faithful to the
// reference - so it produced full-bleed rectangles, which have no background to remove at all.
// Composition is now forced to an isolated cut-out with wide margins regardless of the
// reference's framing. Subject, technique and text fidelity are unchanged.
// v22 change: cleanEdges only. The alpha erosion is a min filter of radius 2, so it shrinks
// EVERY shape by 2px on every side. Thick artwork does not notice, but thin lettering does:
// a 6px stroke came back as a 2px ghost, which is why small caption text ("PURE", "SOUND &
// FIRE") almost vanished while the heavy blackletter above it survived intact. The erosion
// is now guarded by a morphological opening: any structure that a radius-4 opening wipes out
// completely is thin, and those pixels keep their (floor-filtered) alpha instead of being
// eroded. Thick regions come out byte-identical to v21 and the faint halo is still removed,
// because the guarded branch still applies ALPHA_FLOOR. Nothing else in the file is touched.
// v23 change: three fixes, from a run whose reference was a crow standing on a skull.
// (a) cleanEdges — v22 protected EVERY thin structure, including the short hairline spurs the
//     generator hangs off the corners of heavy lettering, which v21's erosion used to delete
//     silently. The thin mask is now split into connected components and judged by longest
//     dimension: caption strokes and hatching (tens of px) stay protected, spurs (under ten)
//     go back through the erosion. Thick artwork is still byte-identical to v21.
// (b) prompt — the analysis dropped the crow and promoted the skull it stood on. Added a
//     "which element is the subject" rule: the living/foreground figure wins over the object
//     it rests on, and it must be named before anything is written.
// (c) prompt — the reference was one-colour black ink and the output invented red lettering,
//     because CHANGE EVERYTHING ELSE explicitly told it to change the palette. Palette is now
//     carried across, ranks above the colour rule, and monochrome stays monochrome.
// v24 change: fixes a regression introduced by v23(c). Palette fidelity was allowed to outrank
// the colour rule outright, so a reference whose graphic was WHITE lettering on a black shirt
// produced white lettering — and white artwork drawn on the mandatory pure-white #FFFFFF
// background is cut away by the background removal, leaving only the thin dark outlines. The
// "GAME DAY" run came back as hollow outline letters, invisible on a black shirt. Palette
// fidelity now has one hard exception: nothing in the artwork may be white or near-white,
// because white IS the background here. A light-on-dark reference is translated to a deep
// version of the same hue. Also adds a `hollow` QC check (share of transparency that is
// enclosed empty space) so an outline-only result triggers the existing retry instead of shipping.
// v25 change: the reference is usually a PHOTO OF A MODEL WEARING a printed shirt, and every
// version so far has fought that with words alone — "ignore the wearer" appears four times in
// the prompts. It does not hold, because nano-banana/edit is an image-EDIT model: hand it a
// photo of a woman holding a football and it will hand back a woman holding a football with
// different shirt text. The GAME DAY v24 run came back as exactly that, model and all.
// So stop arguing with it and stop showing it the wearer. The analysis call already looks at
// the image, so it now also returns GRAPHIC: x0,y0,x1,y1 — the printed graphic's box in
// percent — and the handler crops the reference to that box before the generator ever sees
// it. No extra API call. Falls back to the full image whenever the box is missing, malformed
// or implausibly small.

import sharp from "sharp";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

const EDGE_LIMIT = 0.015;
const PALE_LIMIT = 0.12;
const RIM_LIMIT  = 0.35;
const HOLE_LIMIT = 0.55;
const ERODE_RADIUS = 2;
const ALPHA_FLOOR = 130;
const THIN_GUARD_RADIUS = ERODE_RADIUS + 2;
const MIN_THIN_LEN_DIV = 64;
const MIN_THIN_LEN_FLOOR = 16;

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

WHICH ELEMENT IS THE SUBJECT — DECIDE THIS FIRST AND NAME IT.
Reference graphics are usually built from several elements: a creature, an object it
rests on, branches, banners, ornaments. Exactly one of them is the SUBJECT, and it is
almost always the living or foreground figure — the animal, bird, person, creature or
character — not the object it perches on, stands on, holds or is framed by. A crow
standing on a skull is a CROW design, not a skull design. A snake coiled round a dagger
is a SNAKE design. A tiger inside a wreath is a TIGER design.
Before you write anything, name the subject in your own head, then carry THAT element
across. Dropping the main figure and promoting a secondary prop to be the new subject is
a failure, even though the result may look good on its own. If you are torn between two
elements, choose the one a person would name if asked "what is on that shirt?".

ONE SUBJECT ONLY — NOTHING BESIDE IT.
The artwork contains the single subject and nothing else. No stacks of books, plants,
cups, flowers, leaves, sparkles, wreaths, frames or decorative motifs beside, behind or
under it. If the pose needs something in the hands, allow at most ONE small held item.

CHANGE EVERYTHING ELSE — EXCEPT THE PALETTE.
Change the pose, the activity, the hair, the outfit, the composition and the camera
angle. If your description could be mistaken for the original graphic, rewrite it.

PALETTE FIDELITY — RANKS ABOVE THE COLOUR RULE BELOW.
The new design uses the SAME colours as the reference graphic and introduces no others.
- If the graphic is single-colour work — black ink only, one-colour screen print,
  monochrome linework — the new design is the SAME single colour throughout, lettering
  included. Do not add a second colour. Do not make the text red, gold or any accent
  colour that is absent from the reference.
- If the graphic uses two or three colours, name those colours and use only those.
- Only when the graphic is genuinely full-colour may you range freely.
Name the palette explicitly in your prompt, and say how many colours it has.

ONE HARD EXCEPTION TO PALETTE FIDELITY — WHITE.
Nothing you describe may be white, near-white, ivory, cream, pale grey or any very light
tint, because the background of the new design IS pure white and everything white will be
cut away automatically. Anything you paint white simply disappears and leaves a hollow
outline behind.
Reference graphics printed on black, charcoal or navy garments are very often WHITE
artwork. When that is the case you must FLIP it: describe the same subject, the same
technique and the same shapes, but rendered in a deep, dark, saturated version — solid
black ink, deep charcoal, or a deep saturated hue. Never write "white lettering", "white
linework", "white silhouette" or "light coloured". Say the palette is dark on white.

TEXT RULE.
- If the printed graphic contains NO text, the new design contains no text either.
- If it DOES contain text, invent DIFFERENT wording of your own.
  * English only, one to three words maximum, in capitals inside quotation marks.
  * All capitals, spelled consistently — never mix a lowercase letter into a capitalised
    word.
  * Never reuse the original words, and never use a real brand, band, company, book or
    film name, or a known trademarked slogan.
  * The letters are FILLED SOLID with dark colour, edge to edge. Never hollow, never
    outline-only, never open letterforms with an empty or white interior, never a
    "colouring book" bubble outline waiting to be filled in.
  * Solid clean letters with no outline, no stroke and no drop shadow around them, and no
    spurs, whiskers, spikes, hairlines, ticks or stray marks sticking out of the letter
    corners. Smooth, closed letterforms.
  * The lettering takes its colour from the reference palette, not from a new accent colour.
  * Place it so it does not overlap the subject's face.

NO BACKGROUND.
The subject stands alone on pure white — hex #FFFFFF, flat and empty — which will be cut
away automatically. Never describe a setting, room, street, city, furniture, sky, wall,
floor, panel, rectangle or scene. The white must be pure: not cream, not ivory, not
eggshell, not warm white, not a wash, not a gradient, not a halo, not lightly tinted and
not textured. State explicitly in your prompt that the background is pure white #FFFFFF
and completely empty.

COLOUR RULE — subordinate to the style rule AND to palette fidelity. It tells you how
to pick colours only when the reference leaves you a choice; it never licenses adding a
hue the reference does not have.
The print must read on a white shirt as well as black.
- For ILLUSTRATED styles: dark linework inside the drawing, saturated mid-to-deep
  colours, no large white or cream fills, strong contrast between adjacent shapes.
- For PHOTOREALISTIC style: no drawn linework. Instead specify deep saturated clothing
  and hair, dramatic directional lighting and strong tonal contrast.
- In both cases avoid neon, glow and pale fluorescent colours. Lettering in particular
  must be a deep saturated colour, never pale cyan, pale yellow or white.

COMPOSITION RULE — THIS OVERRIDES THE REFERENCE. READ IT TWICE.
The reference is very often a FULL-BLEED PANEL: a square or rectangle filled edge to edge
with imagery, sometimes with lettering sitting on top of it. DO NOT REPRODUCE THAT SHAPE.
Copy the subject, the technique and the spirit — never the panel.

The new design is always a CUT-OUT: one subject floating free on empty white, the way a
sticker looks before it is stuck to anything. Concretely:
- The subject occupies roughly 70-80% of the frame and NOTHING touches any edge. There is
  clear empty space above, below, left and right of everything you describe.
- No panel, no rectangle, no square, no rounded square, no circle, no badge, no frame, no
  border, no card, no block of colour, no photo crop, no vignette, no backdrop.
- Never a tightly cropped close-up that runs off the edges. If the subject is a face,
  include the whole head and the shoulders with room around them, not a zoomed crop of a
  nose and lips.
- State explicitly in your prompt that the subject is isolated, complete, and surrounded by
  empty white space on all four sides.
If your description would fill the frame edge to edge, you have written it wrong. Zoom out
and rewrite it.

Also: no logos, no brand names, no real people, no recognisable copyrighted characters.

OUTPUT FORMAT — follow exactly.
First line: either
STYLE: photoreal
or
STYLE: illustration
Second line: the location of the PRINTED GRAPHIC inside the image you were shown, as
GRAPHIC: x0,y0,x1,y1
where each value is a whole number from 0 to 100, a percentage of the image's width or
height, x0,y0 being the top-left corner of the box and x1,y1 the bottom-right. Draw the box
tightly around the printed artwork itself — not the shirt, not the person, not the photo.
If the image is already a standalone artwork file with no garment or wearer in it, write
GRAPHIC: full
Getting this box right matters as much as the prompt: the wearer is cropped away using it,
and anything you leave inside the box may end up in the new design.
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
          { type: "text", text: "If this is a photo of someone wearing a shirt, describe ONLY the graphic printed on the shirt and ignore the wearer entirely. Same subject category and rendering technique as that graphic - and if the graphic has several elements, carry across the MAIN figure (the creature or person), not the object it sits on - but a different pose and different details. Keep the reference's colour palette: if the graphic is one-colour ink, yours is that same single colour, lettering included - EXCEPT that nothing may be white or pale, because the background is white and would swallow it, so a white-on-black reference becomes deep dark ink on white. Every letter and shape is filled solid, never a hollow outline. Subject alone, no objects beside it, and absolutely no outline or stroke tracing the artwork. The reference is probably a full-bleed panel filled edge to edge - do NOT copy that shape; your design is one isolated subject floating on empty white with wide margins on every side, nothing touching an edge. Copy the drawing technique but NOT the surface it is drawn on — even if the reference sits on cream or textured stock, your design sits on pure white #FFFFFF and nothing else. Remember the STYLE: line first." },
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
  let rest = raw.replace(/^\s*STYLE:\s*(photoreal|illustration)\s*/i, "").trim();

  let box = null;
  const g = rest.match(/^\s*GRAPHIC:\s*([^\n]*)/i);
  if (g) {
    const v = g[1].trim();
    const nums = v.match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (nums) {
      const [x0, y0, x1, y1] = nums.slice(1, 5).map(Number);
      if (x1 > x0 && y1 > y0 && x1 <= 100 && y1 <= 100) box = { x0, y0, x1, y1 };
    }
    rest = rest.replace(/^\s*GRAPHIC:\s*[^\n]*\n?/i, "").trim();
  }
  const prompt = rest;

  console.log(`[reimagine] style=${style} graphic=${box ? `${box.x0},${box.y0},${box.x1},${box.y1}` : "full"} prompt:`, prompt.slice(0, 250));
  return { style, prompt, box };
}

/* ---------------- crop the reference down to the printed graphic ----------------
   Words never won this argument. nano-banana/edit reproduces what it is shown, so the
   wearer, the football and the denim shorts have to physically leave the input, not merely
   be forbidden in the prompt. The box comes free with the analysis call. Padded slightly so
   a tight box does not clip the artwork, and refused when it is implausibly small — a bad
   box that throws away the graphic is worse than no crop at all. */
const CROP_PAD = 3;
const MIN_CROP_FRAC = 0.03;
const MIN_REF_DIM = 768;

async function cropToGraphic(dataUri, box) {
  if (!box) return dataUri;
  const m = dataUri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return dataUri;

  const buf = Buffer.from(m[2], "base64");
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return dataUri;

  const pct = (v) => Math.min(100, Math.max(0, v));
  const x0 = pct(box.x0 - CROP_PAD), y0 = pct(box.y0 - CROP_PAD);
  const x1 = pct(box.x1 + CROP_PAD), y1 = pct(box.y1 + CROP_PAD);

  const left = Math.round((x0 / 100) * meta.width);
  const top = Math.round((y0 / 100) * meta.height);
  const width = Math.max(1, Math.round(((x1 - x0) / 100) * meta.width));
  const height = Math.max(1, Math.round(((y1 - y0) / 100) * meta.height));

  if ((width * height) / (meta.width * meta.height) < MIN_CROP_FRAC) {
    console.warn(`[reimagine] graphic box too small (${width}x${height}) - using full reference`);
    return dataUri;
  }
  if (left + width > meta.width || top + height > meta.height) {
    console.warn("[reimagine] graphic box out of bounds - using full reference");
    return dataUri;
  }

  let pipe = sharp(buf).extract({ left, top, width, height });
  // a shirt graphic inside a 600px product photo crops down to a couple of hundred pixels;
  // give the edit model something it can actually read
  if (Math.max(width, height) < MIN_REF_DIM) {
    pipe = pipe.resize(MIN_REF_DIM, MIN_REF_DIM, { fit: "inside", kernel: "lanczos3" });
  }
  const out = await pipe.png({ compressionLevel: 3 }).toBuffer();
  const om = await sharp(out).metadata();
  console.log(`[reimagine] cropped reference ${meta.width}x${meta.height} -> ${width}x${height} at ${left},${top} (sent ${om.width}x${om.height})`);
  return `data:image/png;base64,${out.toString("base64")}`;
}

/* ---------------- step 2: generate ---------------- */
const COMMON_SUFFIX =
  ", single subject only, isolated cut-out floating on empty space, complete subject with wide empty margins on all four sides, nothing touching any edge, not full-bleed, no panel, no rectangle, no square, no rounded square, no circle, no badge, no card, no frame, no vignette, no photo crop, not a tight close-up, zoomed out, nothing beside the subject, no extra objects, no props, no decorations, isolated on a pure white #FFFFFF background, flat empty pure white backdrop, no paper, no paper texture, no toned paper, no cream background, no ivory, no beige, no tan, no kraft, no parchment, no newsprint, no canvas texture, no aged paper, no vintage paper, no weathered surface, no sepia tone, no off-white, no warm white, no grain, no speckle, no stains, no tint, no gradient behind the subject, no background panel, no rectangle, no scene, no furniture, no border, no outline around the artwork, no white keyline, no contour stroke, no glow, not a sticker, no die-cut edge, no neon, no pale fluorescent colours, solid filled letters, no hollow letters, no outline-only lettering, no open letterforms, no empty letter interiors, no colouring-book outlines, nothing white in the artwork, no white fills, no white linework, clean closed letterforms, no spurs on the letters, no whiskers or spikes on the letters, no stray hairlines, no ticks or specks around the lettering, entire subject inside the frame with empty margins on all sides, vertical 4:5 composition";

const ILLUSTRATION_SUFFIX =
  ", dark linework inside the drawing, deep saturated colours, strong value contrast, no white or cream fills, commercial illustration quality" + COMMON_SUFFIX;

const PHOTOREAL_SUFFIX =
  ", photorealistic, sharp photographic detail, realistic skin texture, realistic fabric, dramatic directional lighting, strong tonal contrast, deep saturated clothing, no illustration, no anime, no cartoon, no vector art, no drawn outlines, no painterly brushwork" + COMMON_SUFFIX;

async function generate(prompt, style, dataUri) {
  const suffix = style === "photoreal" ? PHOTOREAL_SUFFIX : ILLUSTRATION_SUFFIX;
  try {
    return await fal("fal-ai/nano-banana/edit", {
      prompt: `The reference may be a photo of someone wearing a printed shirt — if so, use ONLY the graphic printed on the shirt as your reference and ignore the wearer, the garment and the surroundings completely. Draw a new standalone artwork in that graphic's technique, same kind of subject - keep the graphic's MAIN figure, not a secondary prop it rests on - same colour palette as the reference with no new colours added but nothing white or pale (white would vanish into the white background - a white-on-black reference becomes deep dark ink), every letter and shape filled solid and never a hollow outline, different pose and different details, alone with nothing next to it and no outline traced around it. Never reproduce the reference's panel or full-bleed framing - draw one isolated subject, zoomed out, complete, with wide empty margins on all four sides and nothing touching any edge. Match the drawing technique but never the surface it is drawn on: the background here is pure white #FFFFFF, flat and empty, never cream or toned or textured paper: ${prompt}${suffix}`,
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

  /* white fills sit on a white background, so background removal eats them and leaves only
     the dark outlines behind. The tell is not how much ink there is but where the empty
     space is: hollow letterforms enclose huge pockets of nothing that never touch the
     border. Flood the transparent area inwards from the four edges; whatever transparency
     it cannot reach is enclosed. Measured on real output: a solid design scores 0.17, the
     hollow "GAME DAY" run scored 0.78. */
  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (A(x, y) >= 128) { ink[y * w + x] = 1; inkCount++; }
    }
  }
  const reached = new Uint8Array(w * h);
  const fstack = new Int32Array(w * h);
  let fsp = 0;
  const seed = (q) => { if (!ink[q] && !reached[q]) { reached[q] = 1; fstack[fsp++] = q; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (fsp > 0) {
    const q = fstack[--fsp];
    const x = q % w, y = (q / w) | 0;
    if (x > 0) seed(q - 1);
    if (x < w - 1) seed(q + 1);
    if (y > 0) seed(q - w);
    if (y < h - 1) seed(q + w);
  }
  let enclosed = 0;
  for (let q = 0; q < w * h; q++) if (!ink[q] && !reached[q]) enclosed++;
  const holeRatio = inkCount + enclosed ? enclosed / (inkCount + enclosed) : 0;

  const edgeRatio = edgeTotal ? edgeHits / edgeTotal : 0;
  const paleRatio = solid ? pale / solid : 0;
  const rimRatio = boundary ? whiteRim / boundary : 0;
  const report = {
    edgeRatio, paleRatio, rimRatio, holeRatio,
    cropped: edgeRatio > EDGE_LIMIT,
    tooPale: paleRatio > PALE_LIMIT,
    outlined: rimRatio > RIM_LIMIT,
    hollow: inkCount > 0.01 * w * h && holeRatio > HOLE_LIMIT,
  };
  console.log(`[reimagine] QC edge=${edgeRatio.toFixed(3)} pale=${paleRatio.toFixed(3)} rim=${rimRatio.toFixed(3)} hole=${holeRatio.toFixed(3)} cropped=${report.cropped} tooPale=${report.tooPale} outlined=${report.outlined} hollow=${report.hollow}`);
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
  if (qc.hollow) {
    parts.push("CRITICAL: the previous attempt came back as HOLLOW OUTLINE SHAPES with nothing inside them - empty letters and empty forms, like a colouring book page. That happens when you paint something white: white is the background here and it is cut away. Fill every letter and every shape SOLID with dark saturated colour, edge to edge. Nothing in the artwork may be white, near-white, cream or pale");
  }
  if (qc.outlined) {
    parts.push("CRITICAL: the previous attempt had a white outline traced around the artwork and the lettering, like a sticker. Draw NO outline, NO keyline, NO stroke and NO glow around the subject or the letters. The artwork must end exactly where the drawing ends");
  }
  return ". " + parts.join(". ") + ".";
}

/* ---------------- edge cleanup ----------------
   Background removal leaves a faint light halo a pixel or two wide, which prints as a
   grey outline on a black garment. Drop very faint alpha, then erode the alpha channel
   with a separable min filter.

   The erosion is unavoidably indiscriminate: it takes `radius` pixels off every shape,
   which is invisible on a 100px blackletter stroke and fatal on a 6px caption stroke.
   So it is guarded. `thinGuard` runs a binary morphological opening (erode then dilate,
   both separable, both with early exit) at a slightly larger radius; anything the opening
   erases completely is a thin structure. Those pixels skip the erosion and keep their
   floor-filtered alpha. Pixels inside thick shapes are unaffected, so thick artwork is
   byte-for-byte what v21 produced, and the halo is still removed everywhere because the
   guarded branch is fed the same ALPHA_FLOOR-filtered alpha. */
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
  console.log(`[reimagine] cleanEdges: ${kept} thin-artwork px protected, ${specks} spur px eroded (minLen ${minLen})`);
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
/* ================= v29: account gate, free quota, paid credits ================= */

const FREE_RUNS = 1;                     // free designs per account (gift on registration)
const WATERMARK_FREE = false;            // true = free run returns a watermarked preview instead

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

/* ================= v26: two-step controlled mode =================
   Step 1 reads the reference and writes down WHAT IT IS MADE OF, as fields the user can edit.
   Step 2 draws from those fields only. The reference never reaches the generator. */

const SPEC_SYSTEM_PROMPT = `You are a creative director for a print-on-demand t-shirt studio.

You will be shown a reference design. It may be a standalone artwork file, or a photo of
someone WEARING a printed garment. If it is a photo, read ONLY the printed graphic and
ignore the wearer, the garment, the room and the photography completely.

Your job is to design a NEW piece for the same shelf. Not a copy, not a variation of this
execution — a different design that would sell to the same buyer for the same occasion.

Split your answer in two, and this split is the whole point:

KEEP FAITHFUL to the reference (this is what makes it feel like the same kind of product):
  genre, palette, technique, typography, composition

DELIBERATELY CHANGE (this is what stops it being a copy):
  subject   -> a DIFFERENT main character or object, equally appealing for the same occasion
  elements  -> mostly different supporting motifs; at most ONE may overlap with the reference
  text      -> different wording with the same intent, if the reference has text at all

Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:

{
  "genre":       "the category in 2-6 words, e.g. 'glam birthday celebration design'",
  "subject":     "your NEW main focus, 2-8 words",
  "elements":    ["4-8 supporting motifs for your new design, each 1-3 words"],
  "palette":     "the reference colours in 3-10 words",
  "technique":   "the reference rendering style in 3-10 words",
  "typography":  "the reference lettering style in 3-12 words, or '' if it has no text",
  "text":        "your NEW wording, or '' if the reference has no text",
  "composition": "the reference arrangement in 4-12 words",
  "notes":       "one sentence naming what the reference had and what you swapped it for"
}

RULES
- The new subject must be a real alternative, not a restyling. Ghost -> black cat, pumpkin,
  owl. Crown -> tiara, butterfly, star. Never the same thing with a new adjective.
- Describe genre and composition at GENRE level. "ornate script over a jewelled block word"
  is a genre; "Birthday in pink script above QUEEN in rhinestones" is a copy.
- Keep every value short enough to fit in a text input.
- Write in English; the generator only reads English.
- Never mention the reference image, the wearer, or that you were shown anything.`;

async function analyzeSpec(base64Data, mediaType) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: SPEC_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: "Return the JSON spec. Remember: keep genre, palette, technique, typography and composition faithful, but give me a DIFFERENT subject, different elements and different text. JSON only." },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("anthropic spec failed:", r.status, t);
    throw new Error("Analysis failed");
  }
  const data = await r.json();
  let raw = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (!raw) throw new Error("No analysis text returned");

  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("Spec was not JSON");

  let spec;
  try {
    spec = JSON.parse(raw.slice(a, b + 1));
  } catch (e) {
    console.error("spec parse failed:", raw.slice(0, 400));
    throw new Error("Spec was not valid JSON");
  }
  return normaliseSpec(spec);
}

const SPEC_KEYS = ["genre", "subject", "elements", "palette", "technique", "typography", "text", "composition", "notes"];

function normaliseSpec(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const k of SPEC_KEYS) {
    let v = src[k];
    if (k === "elements") {
      if (typeof v === "string") v = v.split(/[,;\u060C]/);
      out.elements = Array.isArray(v)
        ? v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10)
        : [];
    } else {
      out[k] = String(v == null ? "" : v).trim().slice(0, 300);
    }
  }
  return out;
}

/* The prompt is assembled from the spec ONLY. No reference image is passed to the generator,
   so the result is a new design in the same genre rather than a variation of the original. */
function specToPrompt(spec) {
  const parts = [];
  if (spec.genre) parts.push(spec.genre);
  if (spec.subject) parts.push(`main focus: ${spec.subject}`);
  if (spec.elements && spec.elements.length) parts.push(`featuring ${spec.elements.join(", ")}`);
  if (spec.technique) parts.push(`rendered as ${spec.technique}`);
  if (spec.palette) parts.push(`colour palette: ${spec.palette}`);
  if (spec.composition) parts.push(`composition: ${spec.composition}`);
  if (spec.text) {
    parts.push(`with the text "${spec.text}"${spec.typography ? ` set as ${spec.typography}` : ""}, spelled exactly, clearly legible`);
  } else if (spec.typography) {
    parts.push(`lettering style: ${spec.typography}`);
  }

  return (
    parts.join(", ") +
    ", original t-shirt print artwork, one self-contained design, " +
    "isolated on a pure flat white #FFFFFF background with wide empty margins on all four sides, " +
    "nothing touching any edge, no mockup, no shirt, no person, no photo frame, no border, " +
    "every shape and letter filled solid, high detail, crisp edges"
  );
}

const SPEC_NEGATIVE =
  "photograph of a person, model wearing a shirt, garment, mockup, hanger, watermark, signature, " +
  "cropped, cut off, full-bleed panel, coloured background, cream paper, texture, frame, border, " +
  "hollow outline text, misspelled text, blurry, low resolution";

const HEBREW_RE = /[\u0590-\u05FF]/;

function specHasHebrew(spec) {
  for (const k of SPEC_KEYS) {
    const v = spec[k];
    if (k === "elements") {
      if ((v || []).some((x) => HEBREW_RE.test(x))) return true;
    } else if (HEBREW_RE.test(v || "")) {
      return true;
    }
  }
  return false;
}

/* One Claude call translates the whole spec at once. Cheaper and more consistent than
   translating field by field, and it keeps the design vocabulary coherent across fields. */
async function translateSpec(spec) {
  const payload = {
    genre: spec.genre,
    subject: spec.subject,
    elements: spec.elements,
    palette: spec.palette,
    technique: spec.technique,
    typography: spec.typography,
    composition: spec.composition,
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system:
        "You translate t-shirt design specs into English for an image generator.\n" +
        "Return ONLY the same JSON object with the same keys, every value translated to natural " +
        "English design vocabulary. Keep values short. 'elements' stays an array. Values already in " +
        "English pass through unchanged. No prose, no markdown fences.",
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    }),
  });

  if (!r.ok) {
    console.error("translate failed:", r.status, await r.text());
    return spec; // never block a generation over translation
  }

  const data = await r.json();
  let raw = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a === -1 || b === -1) return spec;

  try {
    const t = JSON.parse(raw.slice(a, b + 1));
    return normaliseSpec(Object.assign({}, spec, t, { text: spec.text, notes: spec.notes }));
  } catch (e) {
    console.error("translate parse failed:", raw.slice(0, 200));
    return spec;
  }
}

/* Returns { spec, notice }. spec is guaranteed English-safe for the generator. */
async function prepareSpec(spec) {
  let notice = "";

  // Hebrew in "text" would be DRAWN, and flux cannot draw Hebrew legibly. Drop it, don't mangle it.
  if (HEBREW_RE.test(spec.text || "")) {
    spec = Object.assign({}, spec, { text: "" });
    notice =
      "הטקסט בעברית לא נכלל בעיצוב — מנוע היצירה לא מצייר אותיות עבריות קריאות. " +
      "העיצוב נוצר בלי טקסט, ואפשר להוסיף כיתוב בעברית בכלי עיצוב.";
  }

  if (specHasHebrew(spec)) {
    console.log("[reimagine] hebrew detected - translating spec");
    spec = await translateSpec(spec);
  }

  return { spec, notice };
}

async function generateFromSpec(spec) {
  const prompt = specToPrompt(spec);
  console.log("[reimagine] v26 prompt:", prompt.slice(0, 300));
  return await fal("fal-ai/flux/dev", {
    prompt,
    negative_prompt: SPEC_NEGATIVE,
    image_size: { width: 1152, height: 1536 },
    num_inference_steps: 34,
    guidance_scale: 3.5,
    output_format: "png",
    enable_safety_checker: true,
  });
}

const PREVIEW_W = 1200, PREVIEW_H = 1440;
const WATERMARK_TEXT = "ElronPrint";

/* Tiled diagonal watermark. Drawn as one SVG the size of the preview so it cannot be cropped off,
   and kept semi-transparent so the design stays readable — the point is to block printing, not
   to ruin the picture. */
function watermarkSvg(w, h) {
  const step = 260;
  let marks = "";
  for (let y = -h; y < h * 2; y += step) {
    for (let x = -w; x < w * 2; x += step * 1.6) {
      marks +=
        `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="34" ` +
        `font-weight="700" fill="#000000" fill-opacity="0.20" ` +
        `transform="rotate(-30 ${x} ${y})">${WATERMARK_TEXT}</text>`;
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${marks}</svg>`
  );
}

async function toPreviewCanvas(buf) {
  buf = await cleanEdges(buf);

  const inner = await sharp(buf)
    .ensureAlpha()
    .trim({ threshold: 12 })
    .resize(Math.round(PREVIEW_W * SAFE), Math.round(PREVIEW_H * SAFE), {
      fit: "inside",
      kernel: "lanczos3",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 6 })
    .toBuffer();

  const m = await sharp(inner).metadata();

  return sharp({
    create: {
      width: PREVIEW_W, height: PREVIEW_H, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: inner,
        left: Math.round((PREVIEW_W - m.width) / 2),
        top: Math.round((PREVIEW_H - m.height) / 2),
      },
      { input: watermarkSvg(PREVIEW_W, PREVIEW_H), left: 0, top: 0 },
    ])
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/* Everything after generation is shared with the legacy path: cut out, QC, print canvas, upload. */
async function finishArtwork(art, t0, preview) {
  const elapsed = () => Date.now() - t0;

  let cutout = await fal("fal-ai/birefnet", { image_url: art });
  let qc = await inspect(cutout);
  console.log(`[reimagine] cutout+qc: ${elapsed()}ms`);

  let cutBuf = Buffer.from(await (await fetch(cutout)).arrayBuffer());
  if (qc.cropped) {
    console.log("[reimagine] edges still opaque after birefnet - running flood fill");
    try {
      cutBuf = await stripLeftoverBackground(cutBuf);
    } catch (e) {
      console.warn("flood fill failed, keeping birefnet output:", e.message);
    }
  }

  let canvas = preview ? await toPreviewCanvas(cutBuf) : await toPrintCanvas(cutBuf);
  if (!preview) canvas = await fitUploadSize(canvas);
  const imageUrl = await uploadCloudinary(canvas);
  console.log(`[reimagine] done${preview ? " (preview)" : ""}: ${elapsed()}ms`);

  return {
    imageUrl,
    url: imageUrl,
    preview: !!preview,
    width: preview ? PREVIEW_W : CANVAS_W,
    height: preview ? PREVIEW_H : CANVAS_H,
    dpi: preview ? 72 : DPI,
    quality: {
      edge: +qc.edgeRatio.toFixed(3),
      pale: +qc.paleRatio.toFixed(3),
      rim: +qc.rimRatio.toFixed(3),
      hole: +qc.holeRatio.toFixed(3),
    },
  };
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
  const action = String(body.action || "").toLowerCase();

  /* ---- v26 step 2: draw from an edited spec. No reference image involved. ---- */
  if (action === "generate") {
    try {
      const spec = normaliseSpec(body.spec);
      if (!spec.genre && !spec.subject) {
        return res.status(400).json({ error: "Missing spec" });
      }

      // ---- account gate ----
      const student = await studentFromToken(
        body.token || req.headers["x-epai-token"] || req.query.token
      );
      if (!student) {
        return res.status(401).json({
          error: "צריך להתחבר כדי ליצור עיצוב.",
          needLogin: true,
        });
      }

      const owner = isOwner(student.email);

      const quota = owner
        ? { freeLeft: 0, credits: 0, canRun: true }   // owner: no quota, and freeLeft 0 => full file
        : await quotaFor(student);

      if (!quota.canRun) {
        return res.status(402).json({
          error: "נגמרו העיצובים החינמיים. אפשר לרכוש חבילת קרדיטים ולהמשיך.",
          needCredits: true,
          freeLeft: 0,
          credits: 0,
        });
      }

      // WATERMARK_FREE is off, so the free design is a real print file like any paid one
      const isPreview = WATERMARK_FREE && !owner && quota.freeLeft > 0;

      const t0 = Date.now();
      const prepared = await prepareSpec(spec);
      const art = await generateFromSpec(prepared.spec);
      const out = await finishArtwork(art, t0, isPreview);

      // charged only now, after a design actually exists
      let left = { freeLeft: quota.freeLeft, credits: quota.credits };
      if (owner) {
        // logged for history, but nothing is deducted
        await sbPost("design_runs", { student_id: student.id, charged: false }, "return=minimal")
          .catch((e) => console.error("[reimagine] owner run log failed:", e));
        left = { freeLeft: null, credits: null, owner: true };
      } else {
        try {
          left = await chargeRun(student, quota);
        } catch (e) {
          console.error("[reimagine] charge failed (design was delivered):", e);
        }
      }

      return res.status(200).json(
        Object.assign(
          {
            spec: prepared.spec,
            notice: prepared.notice,
            freeLeft: left.freeLeft,
            credits: left.credits,
            owner: !!owner,
          },
          out
        )
      );
    } catch (err) {
      console.error("[reimagine] generate failed:", err);
      return res.status(502).json({ error: "Generate failed" });
    }
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

  /* ---- v26 step 1: read the reference, return an editable spec, generate nothing ---- */
  if (action === "analyze") {
    try {
      const spec = await analyzeSpec(base64Data, mediaType);
      console.log("[reimagine] spec:", JSON.stringify(spec).slice(0, 300));
      return res.status(200).json({ spec });
    } catch (err) {
      console.error("[reimagine] analyze failed:", err);
      return res.status(502).json({ error: "Analyze failed" });
    }
  }

  try {
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;
    const step = (name) => console.log(`[reimagine] ${name}: ${elapsed()}ms`);

    const { style, prompt, box } = await analyzeAndReimagine(base64Data, mediaType);
    step("analyze");

    let reference = image;
    try {
      reference = await cropToGraphic(image, box);
    } catch (e) {
      console.warn("[reimagine] crop failed, using full reference:", e.message);
    }

    let art = await generate(prompt, style, reference);
    let cutout = await fal("fal-ai/birefnet", { image_url: art });
    step("attempt1");

    let qc = await inspect(cutout);
    const bad = (q) => q.cropped || q.tooPale || q.outlined || q.hollow;
    const score = (q) => (q.cropped ? 1 : 0) + (q.tooPale ? 1 : 0) + (q.outlined ? 1 : 0) + (q.hollow ? 2 : 0);

    if (bad(qc) && elapsed() < 30000) {
      console.log("[reimagine] QC failed - regenerating with corrections");
      try {
        const art2 = await generate(prompt + retryHint(qc), style, reference);
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
        hole: +qc.holeRatio.toFixed(3),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Reimagine failed" });
  }
}
