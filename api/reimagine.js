import crypto from "crypto";
import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v55
// v55 change: THE WEARER IS CROPPED OUT ON THE EDIT PATH TOO.
// cropToGraphic has been in this file since v25, but it only ever ran in the LEGACY one-shot path —
// the box came from analyzeAndReimagine, and the two-step spec analyser never produced one. So every
// edit-path run was handed the entire product photo, and an EDIT model faithfully redraws what it is
// shown: four reviewed results came back as a photo of a person with a torn-out background instead of
// a print file. The box cannot ride along inside the spec (the theme rebuilds the spec from its form
// inputs at step 3, which is the same reason `ref` never round-tripped), so it is fetched at generate
// time by one small vision call. Costs ~1-2s and a few tokens, runs only for a freshly uploaded data
// URI, and EVERY failure path — bad JSON, a 500, a network error, an implausible box — falls back to
// the full reference, so a run can never be worse off than before.
// v54 change: WHO DRAWS THE WORDS IS NOW DECIDED PER DESIGN, NOT GLOBALLY.
// v53 handed ALL lettering to the model whenever a reference existed. Six reviewed pairs say that is
// too wide: it works only for large, heavy, few-word display type ("NURSE CREW" copied perfectly),
// and fails everywhere else — flowing script came back as hollow whiskered outlines, a long bold-sans
// slogan came back thin and grey with the spaces swallowed, and small cover type came back as
// gibberish carrying an invented real book title. So editCanKeepLettering() gates it: short + Latin +
// not a fragile typeface. Outside that window the edit path behaves exactly as v52 did.
// NOT ADDRESSED HERE, and the bigger problem: the tool faithfully preserves OTHER PEOPLE'S property —
// Nike, adidas and Puma wordmarks, an artist's signature, a real book title and author. He chose to fix
// the text first; the brand gate is the agreed next job.
// v53 change: ON THE EDIT PATH, THE DESIGN'S OWN LETTERING IS KEPT INSTEAD OF A CAPTION BOLTED UNDER IT.
// This is the first change made AFTER the edit path was confirmed running (log: "editing the reference:").
// Everything from v44 to v52 assumed a generator that cannot spell, so the server drew the words in plain
// DejaVu Sans UNDER the artwork. On most reference shirts THE LETTERING IS THE DESIGN — arched script over
// the animal, small caps across it, a curved line below — so scrubbing it out and printing a flat caption
// underneath caps the quality of every result no matter how good the drawing is.
// An EDIT model is not generating letters from nothing: it is copying shapes it can see. That may be
// enough to keep the reference's own typography and swap only which letters are shown. So when a reference
// is available:
//   - spec.text and spec.typography are NOT blanked, and stripLettering is NOT applied
//   - the edit instruction asks for the existing lettering to be kept exactly and the words swapped
//   - no server caption is composited (`wanted` stays null), so the artwork fills the whole canvas
// The flux path is byte-for-byte v52: no reference means no reliable letterforms to copy, so the server
// still owns the words there. That preparation now lives in prepareForFlux() and is applied lazily, so a
// FAILED edit still falls back to the old, safe behaviour.
// ⚠️ THIS IS AN EXPERIMENT WITH FOUR POSSIBLE OUTCOMES, and only the first is a win: correct words in the
// reference's own lettering / right style but MISSPELLED / gibberish letterforms / the reference's ORIGINAL
// words left untouched. Outcomes 2-4 all mean reverting. To revert without touching anything else, set
// EDIT_KEEPS_LETTERING to false — that restores v52 behaviour exactly.
// Hebrew is unaffected: prepareSpec already drops Hebrew from the text field before any of this runs.
//
// v52 change: THE REFERENCE NOW REACHES STEP 3 WITHOUT TOUCHING THE THEME.
// The Vercel log settled it: "no reference available - falling back to flux (theme must echo `ref`)".
// The analyse step was parking the reference correctly, but step 3 posts only the spec, so the edit path
// added in v51 had never actually run once. Rather than make him edit a Shopify section, the reference is
// now remembered SERVER-SIDE against his account: analyse writes students.last_ref, generate reads it back.
// Requires ONE line of SQL, once (see below). Until that column exists every read and write of it fails
// harmlessly inside its own try/catch and behaviour is exactly as before — so this file is safe to deploy
// before the SQL is run, it simply keeps falling back to flux until then.
//
//   alter table students add column if not exists last_ref text;
//
// POSTSCRIPT: the server-side recall never fired, because the theme sends no token on the ANALYSE call, so
// studentFromToken returned null and the write was skipped. What actually closed it was one line in
// sections/epd-design-remix.liquid — the step-3 payload now carries `image: uploadedDataUrl`. The recall
// code is kept as a harmless second route.
//
// v51 change: THE GENERATOR NOW SEES THE REFERENCE. This is an architecture change, not a patch.
// Until now one model looked at his design and wrote eight sentences, and a second model painted from
// scratch having never seen it. Every bug in this file's history is a failure of that handoff: a word
// written twice so it was drawn twice, "realism" written about a flat print, trees written and never
// drawn, a sun disc nobody asked for. So when a reference image is available the artwork is now made by
// nano-banana/edit — the model SEES the design and is asked to change only the cast and the wording,
// which keeps style, composition and elements by construction instead of by description.
// flux stays as the fallback for when no reference is available, and every downstream guard (cut-out,
// QC, empty check, server lettering, print canvas) is untouched and still runs.
// ⚠️ THE REFERENCE HAS TO REACH STEP 3. Step 2 posts only the spec, so v51 accepts it from three places,
// in order: body.image / body.ref (if the theme sends it), spec.ref (round-tripped from the analyse
// response), or nothing — in which case it logs "no reference available" and falls back to flux. If that
// line shows up in the log, the theme needs to echo `ref` back and that is a one-line change.
// v50 change: the STYLE problem, finally traced to its source rather than guessed at.
// Two moose runs came back as glossy shaded cartoons from a reference that is a FLAT screen print with
// no shading at all. The generator was not the culprit — the ANALYSER was. It wrote technique =
// "moderate realism level, hand-drawn aesthetic", "realism" matched PAINTERLY_RE, FLAT_RE never fired,
// and flux was duly asked for a rendered picture. The tell is the WILD run: identical "realism" wording,
// but its palette was single-colour so the v49 flat rule overrode it and the vintage look survived.
// So: the analyser is told that garment PRINTS are flat by default and must not be called realistic
// unless the reference is genuinely a photograph or a painting; FLAT_RE now also recognises the words
// real print briefs actually use; and the caption colour stops overriding an explicitly stated
// lettering colour (the moose caption came out forest green when the palette said dark charcoal).
// v49 change: two faults, both read off real output rather than guessed.
// 1. THE LETTERING SWALLOWED THE SUBJECT. His composition read "…the big cat strides horizontally
//    across the lower two-thirds, OVERLAPPING BEHIND THE LETTERING…". flux obeyed "behind the
//    lettering" and dropped "lower two-thirds", so the leopard came back as a strip of spotted back
//    peeking out from under the word. On a print file the subject has to stay readable, so occlusion
//    wording is rewritten to placement wording ("below the lettering") and the prompt says outright
//    that the subject is never hidden.
// 2. A LIMITED PALETTE NEVER BOUND THE SUBJECT. Four runs in a row — moose, orange cat, golden puppy,
//    leopard — the lettering and line work obeyed the stated palette while the ANIMAL came back in
//    naturalistic full colour. When the palette is single-colour or two-colour, the prompt now says the
//    subject is printed in those inks too, and the negative rejects naturalistic colouring.
// v48 change: three faults found across a six-pair review batch. All three are mine.
// 1. THE WORDING WAS BEING ASKED FOR TWICE. v47 scrubs lettering out of composition only when the
//    SERVER draws the words. On the flux path nothing was scrubbed, so composition named the words AND
//    their placement while the text field named them again — flux got the same string from two
//    directions and drew it in every place mentioned. Seen twice: "WILD" printed above AND below the
//    leopard, and "FISH / CAT" printed three times (plus a garbled "CFLAT"). dedupeWording() now strips
//    the WORDS out of composition and elements while KEEPING the placement, so the wording is requested
//    exactly once. The prompt says so explicitly and the negative bans repeated lettering.
// 2. `subject` WAS NEVER SCRUBBED — the fifth spot in this family (v34, v38, v39, v46, v47). On a
//    text-only reference the analyser writes subject = "bold white lettering …", so flux was still
//    ordered to draw letters after text and typography had been blanked. That produced the black blob
//    with "SACED THNALT PiCAL" on it. subject is scrubbed now, and when it scrubs away to nothing the
//    design IS its typography: flux is SKIPPED ENTIRELY and the caption is drawn on its own.
// 3. A BLANK ARTWORK WAS DELIVERED SILENTLY. One run came back as an empty transparent canvas carrying
//    only the caption, with nothing in the log to say why. inspect() now reports inkRatio and an `empty`
//    flag, and finishArtwork refuses to ship an empty print file — it fails with a message he can read
//    instead of a blank PNG.
// v47 change: TWO THINGS v46 GOT WRONG, both proved from the Vercel log and his screenshots.
// 1. THE FONT WAS NEVER IN THE BUNDLE. Log: "bundled font failed to load: Cannot find module
//    'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'". The dependency installs fine, but Vercel's file
//    tracer prunes anything it cannot see being used, and it does not follow require.resolve() when
//    the path is held in a variable. So the .ttf was dropped from /var/task and every caption fell
//    back to the wordless canvas. Fixed on BOTH sides: vercel.json now force-includes the file
//    (includeFiles), and loadFont() tries several real paths and logs each one it tried.
// 2. THE COMPOSITION FIELD STILL CARRIED THE WORDING. v46 blanked text and typography, but the
//    analyser had written "large cursive 'A Moose Destroys You' filling the lower third" into
//    COMPOSITION, and specToPrompt passes composition through verbatim — so the prompt still asked
//    for lettering while the negative banned it, and flux drew "WORST CASE SCORARIO" anyway. That is
//    the fourth spot in this family (v34, v38, v39, v46). stripLettering() now scrubs composition and
//    elements whenever the server owns the words, and the analyser is told not to quote the wording.
// v46 change: THREE FIXES, all of them mine, none of them the model's.
// 1. TYPOGRAPHY SURVIVED THE SERVER-TEXT SWITCH. v45 blanks spec.text when it hands the wording to
//    the server, but left spec.typography alone — so specToPrompt still pushed "lettering style: ..."
//    into the prompt while negativeFor banned all text in the same call. flux followed the positive
//    and invented gibberish ("A MOOSE DESTROY YOU", "BION SIG SLIST OF LWIES!"). Same family as
//    v34/v38/v39: two of my own rules fighting. typography is now blanked alongside text.
// 2. v42 WAS NEVER IN THIS FILE. The colour fix (white/pale -> MID-TONE or DEEP, never cream) existed
//    only in ANALYSIS_SYSTEM_PROMPT, the dead legacy nano-banana prompt. v43 was built on the v41 base
//    and lost it. Restored into the ACTIVE analyser rule, the ACTIVE suffix and the ACTIVE negative.
// 3. THE FONT NOW TRAVELS WITH THE CODE. v44 asked librsvg for "DejaVu Sans, Liberation Sans, Arial"
//    BY NAME. Vercel guarantees none of them, and a missing font renders tofu rather than nothing, so
//    the blank-layer check never fired and the caption came out as faint illegible marks. The words
//    are now converted to glyph OUTLINES with opentype.js before sharp sees them — no fontconfig, no
//    font-family lookup, identical on every host. Also fixes silent truncation: the old line splitter
//    turned a long caption into single words and then kept only the first three.
// REQUIRES package.json: "opentype.js" and "dejavu-fonts-ttf".
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
// v34 change: THE FIXED SUFFIX NO LONGER FIGHTS A FLAT STYLE.
// He asked for a flat vector look, wrote it in the technique field, and still got shaded, glossy,
// high-detail artwork. Cause was mine: the suffix appended "high detail, crisp edges" to EVERY
// prompt, so "flat, no shading" and "high detail" arrived in the same sentence and flux followed
// the richer one. The suffix is now chosen by the spec: a flat/vector/minimal technique gets
// flat-art wording plus shading terms added to the negative prompt; everything else keeps the
// detailed wording exactly as before, so rich designs are unaffected.
//
// v35 change: ONE-CLICK STYLE PRESETS.
// He does not read English and, in his words, would not know what to type in Hebrew either — the
// flat-style win only happened because I dictated the exact wording. So the style now arrives as a
// short key (`spec.style`) chosen by a button on the page, and the SERVER owns the vocabulary.
// The preset is applied at prompt-build time only. It NEVER overwrites the user's fields: subject,
// elements and text are what stop the design being a copy, so a style button must not touch them,
// and the form on screen keeps showing exactly what he asked for. Switching presets therefore
// leaves no residue. `style: ""` or an unknown key = behave exactly like v34.
//
// v36 change: THE ARTWORK IS NEVER A GARMENT.
// He fed in a video thumbnail of a woman wearing a printed tee, and the tool drew a T-SHIRT with
// lettering on it instead of the lettering alone. The system prompt already says to ignore the
// garment, but a prompt is advice, not a guarantee — when the reference is a photo rather than a
// clean design file, the analysis can still come back describing the shirt. So the spec is now
// SCRUBBED in code before the prompt is built: garment and mockup words are stripped from
// subject/genre/composition/elements, and if that empties the subject entirely the request is
// refused with a clear Hebrew message rather than silently drawing a shirt.
//
// v37 change: TWO GARMENT-COLOUR PRESETS, and the trick that makes white printing possible.
// He wanted a button for "black print on a light shirt" and one for "white print on a dark shirt".
// The second cannot be done by asking for white artwork: the pipeline draws on a mandatory white
// background and then removes it, so white art is cut away with the background — that is exactly
// the hollow-letter disaster of v23/v24. Instead `monolight` generates the design in BLACK like
// any other, and the preset carries `invert: true`, which negates the RGB channels AFTER the
// cut-out while leaving alpha untouched. The result is genuinely white artwork on transparency.
// Inversion only makes sense on a monochrome design, so both presets force monochrome wording.
//
// v38 change: THE FIXED SUFFIX WAS ALSO BLOCKING PAINTERLY WORK.
// He dictated "semi-realistic digital painting, smooth airbrushed skin, detailed realistic facial
// features" into the spec and STILL got a big-eyed cartoon. Cause is the same class of bug as v34,
// in a different place: the shared suffix ends with "every shape and letter filled solid" — a
// definition of flat vector art — so a painterly brief and a flat instruction arrived in one
// sentence and flux followed the flat one. That clause is now dropped for painterly briefs, and a
// new `real` preset ("מציאותי ומאויר") states the rendering AND swaps the suffix wording.
// Everything else keeps the old suffix verbatim, so no existing style shifts.
//
// v39 change: NO INVENTED LETTERING WHEN THE DESIGN IS NOT SUPPOSED TO HAVE ANY.
// The first good painterly run came back with fake garbled words scrawled across the jacket, where
// the reference had ornamental patches. flux fills decorative space with letter-shaped noise, and
// garbled type on a printed shirt is worse than no type at all. So when `spec.text` is empty the
// prompt now says so explicitly and the negative blocks text/lettering/words/typography.
// When the user DOES ask for text, nothing changes — the wording that makes lettering legible has
// been in the prompt since v26 and must not be contradicted.
//
// v40 change: TWO HARD-WON RULES THAT THE v26 REWRITE LEFT BEHIND.
// A bunny design came back with a big teal backdrop blob still attached AND transparent holes
// where the white bellies should be. Both were solved YEARS of versions ago — but only inside the
// LEGACY nano-banana prompt, which no longer runs. When v26 replaced the generator I rebuilt the
// prompt from scratch and never carried these across:
//   1. v19-v21: no backdrop SHAPE. "no frame/border" is not the same as "no coloured panel behind
//      the subject" — a rounded blob is neither a frame nor a border, so nothing stopped it, and
//      birefnet then treats the blob as the salient object and keeps it.
//   2. v24: NOTHING IN THE ARTWORK MAY BE WHITE. White is the background here and gets cut away,
//      which is why the bellies became holes. Light areas must be off-white//cream-tinted instead.
// Both now live in the ACTIVE specToPrompt path and in the shared negative.
//
// v41 change: HE REVERSED THE BRIEF — "SAME DESIGN, DIFFERENT CAST".
// v27 was built on what he asked for on 11 Aug: change subject AND elements, describe everything
// at GENRE level so the result is a different design for the same shelf. On 16 Aug he said the
// opposite and was explicit: "אותו עיצוב בדיוק" — same composition, same elements, same rendering
// — change ONLY the identity of the character (this woman -> another woman, this animal -> another
// animal) and the wording. And: if the reference is realistic/human, the result must NOT be a
// cartoon. So the keep/change line moves: elements and composition cross over to KEEP, the
// v43 resolves a conflict I created between my own two rules. v40 said "never describe a backdrop
// shape"; v41 then said "describe composition and elements EXACTLY as they are". On a badge-style
// reference (black lettering on a lilac disc) the newer rule won and the disc came back. The
// no-backdrop rule now explicitly OVERRIDES the keep-faithful rule, and the composition field
// itself says to describe the arrangement of the artwork only, never the shape behind it.
//
// v45 change: SERVER LETTERING IS NO LONGER THE DEFAULT — only where flux genuinely cannot cope.
// Evidence changed the decision. On a "HARVEST TIME" brief flux produced arched lettering with
// plaid texture fills woven into the design — far better than a plain caption bolted underneath.
// Its spelling only collapses on long strings and script faces. So: flux keeps the lettering for
// short Latin text, and the server takes over ONLY when flux cannot win — Hebrew (which it cannot
// draw at all) or long text (where it reliably misspells). Everything from v44 is still here.
//
// v44 change: THE SERVER DRAWS THE LETTERING, NOT FLUX.
// flux cannot spell. It produced "STELLAR PRES" and "Scxperrints" on a two-word brief, and it gets
// worse with longer words and script faces. No prompt fixes that — the prompt has demanded exact
// spelling since v26. So when the spec has text, the artwork is generated WORDLESS (reusing v39's
// no-text path) and the lettering is composited afterwards from an SVG, which is always spelled
// correctly. Trade-off he was told about: the caption sits UNDER the artwork rather than woven
// into it. Fails soft — if the text layer comes back blank (missing fonts on the host) the design
// is still delivered, wordless, with a notice rather than an error.
//
// analysis now describes the EXECUTION rather than the genre, and technique must be reported at
// its true realism level. Closer to the source means a thinner copyright margin — he was told.
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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import opentype from "opentype.js";

export const config = { maxDuration: 60 };

const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

/* v53: THE MASTER SWITCH. false = v52 behaviour always (server draws every caption). */
const EDIT_LETTERING_ENABLED = true;

/* v54: WHEN the model is allowed to keep the lettering, decided per design rather than globally.
   Read off six reviewed source→result pairs, not guessed:
     ✅ "NURSE CREW"  — big chunky hand-drawn display capitals, 9 letters → copied perfectly
     ❌ "Make It Yours" — flowing script → hollow outline letters with ragged, whiskered edges
     ❌ "No, I Don't Have a Coupon" — bold sans but LONG → thin grey letters, spaces swallowed
     ❌ a book cover inside the artwork — small type → gibberish, and a real title/author invented
   The pattern is not script-vs-print and it is not text-only-vs-illustrated. It is that the model
   copies letterforms it can see the SHAPE of: large, heavy, few. Everything else it re-invents.
   So the model gets the lettering only inside that window; outside it the server draws the words,
   which at least spells them correctly and fills them solid. */
const EDIT_TEXT_MAX = 14;              // non-space characters, same threshold the server uses
const FRAGILE_TYPE_RE = new RegExp(
  "\\b(script|cursive|calligraph\\w*|handwritten|hand-lettered|brush|signature|flowing|swash|" +
  "monoline|thin|light|delicate|fine[- ]?line|small)\\b",
  "i"
);

function editCanKeepLettering(spec) {
  if (!EDIT_LETTERING_ENABLED) return false;
  const t = String(spec.text || "").trim();
  if (!t) return true;                                   // nothing to draw either way
  if (HEBREW_RE.test(t)) return false;                   // the model cannot draw Hebrew at all
  if (t.replace(/\s+/g, "").length > EDIT_TEXT_MAX) return false;
  if (FRAGILE_TYPE_RE.test(String(spec.typography || ""))) return false;
  return true;
}

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

/* v51: the reference-editing path. The instruction is deliberately SHORT — everything the old prompt
   had to spell out (style, palette, composition, elements) is already visible in the image, and naming
   it again is what kept producing contradictions. Only the two things that must CHANGE are named.

   v53: the wording clause is rewritten. It used to be one line among several; it is now the most
   specific instruction in the prompt, because keeping the reference's own lettering is the whole
   point of this version. The model is copying letterforms it can see, not inventing them, so it is
   told to treat the typography as something to PRESERVE and only the letters as something to change. */
function editInstruction(spec) {
  const parts = [];
  parts.push(
    "This is an existing t-shirt design. Redraw it as a NEW design that keeps the same drawing style, " +
    "the same colours, the same layout and the same surrounding elements, changing only what I name below."
  );
  if (spec.subject) {
    parts.push(`Replace the main character with: ${spec.subject}. Same size, same pose, same position in the layout.`);
  }
  if (spec.text) {
    parts.push(
      `THE LETTERING: keep every piece of lettering exactly where it is and exactly as it is drawn — ` +
      `the same typeface, the same weight, the same curve or arc, the same size, the same colour and the ` +
      `same position in the layout. Do NOT remove the lettering and do NOT move it. Change only WHICH ` +
      `LETTERS are shown: the words now read exactly "${spec.text}", spelled letter for letter as written ` +
      `here. If the design has several separate lines of lettering, distribute these words across them in ` +
      `the same order, keeping each line's own style. Every letter is fully formed, closed and legible — ` +
      `no invented letters, no half-formed shapes, no leftover words from the original design.`
    );
  } else {
    parts.push("Remove all wording. No text, no letters anywhere in the artwork.");
  }
  parts.push(
    "If the reference is a photo of someone wearing the shirt, use ONLY the printed graphic and ignore " +
    "the wearer, the garment and the background completely. Output the artwork alone on a flat pure " +
    "white #FFFFFF background, complete, with wide empty margins on all four sides and nothing touching " +
    "an edge. No panel, no badge, no disc, no frame behind it. Nothing in the artwork may be white or " +
    "near-white — white is cut away, so use a mid-tone or deep shade instead."
  );
  return parts.join(" ");
}

async function editFromSpec(spec, reference) {
  const prompt = editInstruction(spec);
  console.log(
    `[reimagine] editing the reference (lettering drawn by the model: ${spec.text ? "yes" : "no text"}):`,
    prompt.slice(0, 220)
  );
  return await fal("fal-ai/nano-banana/edit", {
    prompt,
    image_urls: [reference],
    num_images: 1,
    output_format: "png",
  });
}

/* Where the reference can come from, best first. */
function referenceFrom(body, spec) {
  const ok = (v) => typeof v === "string" && /^(https?:|data:image\/)/.test(v) && v.length > 32;
  if (ok(body && body.image)) return body.image;
  if (ok(body && body.ref)) return body.ref;
  if (ok(spec && spec[REF_KEY])) return spec[REF_KEY];
  return null;
}

/* v55: THE WEARER HAS TO PHYSICALLY LEAVE THE INPUT ON THE EDIT PATH TOO.
   cropToGraphic has existed since v25 but ran ONLY in the legacy one-shot path, because the box came
   from analyzeAndReimagine and the two-step spec analyser never returned one. So on the edit path the
   model was handed the whole product photo — model, hands, bracelets, jeans, shoes — and being an EDIT
   model it faithfully redrew all of it. Four reviewed runs came back as a photo of a person with a
   torn-out background instead of a print file.
   The box cannot travel through the spec: the theme rebuilds the spec from its form inputs at step 3,
   so any extra key is dropped (that is the same reason `ref` never round-tripped). So it is fetched
   here, with one small vision call. ~1-2s and a few tokens per run, only when the reference is a fresh
   upload, and every failure falls back to using the full image exactly as before. */
const GRAPHIC_BOX_SYSTEM = `You locate the printed graphic inside a t-shirt image.

The image is either a standalone artwork file, or a photo/mockup of someone WEARING a printed garment.

If a garment or a wearer is present, answer with the bounding box of the PRINTED GRAPHIC ONLY — the
artwork on the fabric. Not the shirt, not the person, not their hands, hair, jewellery or jeans, not
the room. Draw the box tightly around the artwork, including all of its lettering.

If the image is already just the artwork with no garment and no wearer, answer: full

Answer with ONE line and nothing else, in one of these two forms:
GRAPHIC: x0,y0,x1,y1
GRAPHIC: full

where each value is a whole number 0-100, a percentage of the image width or height; x0,y0 is the
top-left corner and x1,y1 the bottom-right.`;

async function graphicBox(dataUri) {
  const m = String(dataUri || "").match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return null;
  const [, mediaType, base64Data] = m;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      system: GRAPHIC_BOX_SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: "Where is the printed graphic? One line only." },
        ],
      }],
    }),
  });
  if (!r.ok) {
    console.error("[reimagine] graphic box call failed:", r.status);
    return null;
  }
  const data = await r.json();
  const raw = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();

  if (/GRAPHIC:\s*full/i.test(raw)) {
    console.log("[reimagine] graphic box: full image (no garment detected)");
    return null;
  }
  const nums = raw.match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (!nums) {
    console.warn("[reimagine] graphic box: unreadable answer, using the full reference:", raw.slice(0, 80));
    return null;
  }
  const [x0, y0, x1, y1] = nums.slice(1, 5).map(Number);
  if (!(x1 > x0 && y1 > y0 && x1 <= 100 && y1 <= 100)) {
    console.warn(`[reimagine] graphic box: implausible (${x0},${y0},${x1},${y1}), using the full reference`);
    return null;
  }
  console.log(`[reimagine] graphic box: ${x0},${y0},${x1},${y1}`);
  return { x0, y0, x1, y1 };
}

/* Crops the reference down to the printed graphic when there is a wearer to remove. Never throws:
   on any failure the original reference is returned and behaviour is exactly as before. */
async function cropReferenceToGraphic(reference) {
  if (!/^data:image\//.test(String(reference || ""))) return reference;   // already a parked URL
  try {
    const box = await graphicBox(reference);
    if (!box) return reference;
    return await cropToGraphic(reference, box);
  } catch (e) {
    console.warn("[reimagine] graphic crop failed, using the full reference:", e.message);
    return reference;
  }
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
  // v48: how much of the frame actually carries artwork. One run shipped a completely empty canvas
  // with only the caption on it and nothing in the log explained why, so this is measured and named.
  const inkRatio = inkCount / (w * h);
  const report = {
    edgeRatio, paleRatio, rimRatio, holeRatio, inkRatio,
    cropped: edgeRatio > EDGE_LIMIT,
    tooPale: paleRatio > PALE_LIMIT,
    outlined: rimRatio > RIM_LIMIT,
    hollow: inkCount > 0.01 * w * h && holeRatio > HOLE_LIMIT,
    empty: inkRatio < EMPTY_LIMIT,
  };
  console.log(`[reimagine] QC edge=${edgeRatio.toFixed(3)} pale=${paleRatio.toFixed(3)} rim=${rimRatio.toFixed(3)} hole=${holeRatio.toFixed(3)} ink=${inkRatio.toFixed(4)} cropped=${report.cropped} tooPale=${report.tooPale} outlined=${report.outlined} hollow=${report.hollow} empty=${report.empty}`);
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

Your job is to describe THE SAME DESIGN with a different cast. The layout, the supporting
elements, the colours and the drawing style all stay as they are. Only WHO is in it and WHAT
IT SAYS change.

Split your answer in two, and this split is the whole point:

KEEP FAITHFUL — describe what is actually there, in detail:
  genre, palette, technique, typography, composition, elements

CHANGE ONLY THESE TWO:
  subject -> the SAME KIND of character, a different individual. A woman stays a woman with the
             same age, build, pose and framing, but a different face and hair. An animal becomes
             a DIFFERENT ANIMAL of similar size and appeal. Never change the category itself.
  text    -> different wording with the same intent and roughly the same length

Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:

{
  "genre":       "the category in 2-6 words, e.g. 'glam birthday celebration design'",
  "subject":     "the SAME kind of character but a different individual, 3-12 words, including
                  pose and framing so it matches the reference",
  "elements":    ["the SAME supporting motifs the reference actually has, 4-8 items, 1-3 words each —
                  never include the disc, badge, circle or panel they sit on"],
  "palette":     "the reference colours in 3-10 words",
  "technique":   "the reference rendering style in 4-14 words, stating its REALISM LEVEL plainly —
                  photographic, semi-realistic painted, stylised illustration or flat vector.
                  Garment prints are FLAT unless proven otherwise: if the reference has solid areas of
                  ink, visible outlines, limited colours or a screen-print/woodcut/distressed look, say
                  'flat spot-colour print, no shading' and do NOT use the words realism, realistic,
                  rendered, shaded or painted. Reserve those for a genuine photograph or painting",
  "typography":  "the reference lettering style in 3-12 words, or '' if it has no text",
  "text":        "your NEW wording, or '' if the reference has no text",
  "composition": "how the ARTWORK ITSELF is arranged, 6-16 words — where each thing sits and how big
                  it is. Never the shape behind it: if the reference sits on a disc, badge, panel or
                  blob, describe only what is printed ON it and drop the shape entirely. Never quote
                  or repeat the wording of the text here — say where the lettering sits, never what
                  it says; the words belong in the text field and nowhere else",
  "notes":       "one sentence naming the original character and the one you put in its place"
}

RULES
- The design floats on nothing. Never describe a backdrop shape, panel, badge, sticker shape,
  rounded blob, disc or circle behind the subject, even if the reference has one — describe only
  what is printed on top of it.
  **THIS RULE BEATS THE KEEP-FAITHFUL RULE.** Composition and elements are otherwise reproduced
  exactly, but a background shape is the one thing that is always dropped, no matter how central
  it looks. A badge design becomes the lettering and motifs alone, floating on nothing.
- Nothing in the design may be WHITE or near-white. White is the background and is cut away, so a
  white element would become a hole. This also rules out cream, ivory, beige, off-white and pale
  grey — they are near-white and are cut away too. Where the reference uses white or a very light
  colour, name a MID-TONE or DEEP version of the SAME hue: white -> deep charcoal or deep navy,
  pale pink -> rose, pale mint -> forest green, pale yellow -> mustard. Never use the words soft,
  pale, light or tinted to describe a colour.
- NEVER name the garment or the photo. The subject, elements and composition describe the PRINTED
  GRAPHIC only. Words like t-shirt, shirt, hoodie, apparel, mockup, hanger, model, "woman wearing"
  must never appear in any field. If the reference is a photo of someone wearing a print, describe
  the print as if it were a standalone artwork file.
- The subject swap stays inside its own category. Woman -> a different woman, not a cat.
  Cat -> dog, fox, bear. Ghost -> owl, pumpkin. Never a human turned into an animal, and never
  the same individual with a new adjective.
- MATCH THE REALISM LEVEL EXACTLY. If the reference is a photograph or a realistic painting, say
  so and never describe it as a cartoon, kawaii, chibi or vector. A realistic reference must
  produce a realistic result; a cartoon reference must produce a cartoon.
- Describe composition and elements as they REALLY ARE, in detail — this is the one thing the new
  design must reproduce faithfully.
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
          { type: "text", text: "Return the JSON spec. Keep the composition, elements, palette, typography and technique FAITHFUL to what you see — same design. Change ONLY the individual character (same category, different individual) and the wording. Match the realism level exactly. JSON only." },
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
// v51: the URL of the uploaded reference, added by the analyse step and round-tripped by the client so
// the generator can SEE the design. Not user content, never translated, never shown as a field.
const REF_KEY = "ref";
// `style` is a preset KEY chosen by a button, never free text — kept out of SPEC_KEYS so it is
// never sent to the translator and never treated as Hebrew content.
const STYLE_KEY_RE = /^[a-z]{2,12}$/;

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
  const style = String(src.style == null ? "" : src.style).trim().toLowerCase();
  out.style = STYLE_KEY_RE.test(style) ? style : "";

  return out;
}

/* The prompt is assembled from the spec ONLY. No reference image is passed to the generator,
   so the result is a new design in the same genre rather than a variation of the original. */
/* ---- v36: garment guard ----
   The output must be the PRINTED GRAPHIC, never the thing it is printed on. This runs in code,
   after the analysis and after any translation, so it catches a bad spec no matter where it came
   from — the model's description, the user's own typing, or a stale saved spec. */
const GARMENT_RE = new RegExp(
  "\\b(" +
    "t-?shirts?|tee shirts?|tees?|shirts?|sweatshirts?|hoodies?|hoody|jumpers?|sweaters?|" +
    "tank ?tops?|crewnecks?|apparel|garments?|clothing|jerseys?(?= mockup| template)?|" +
    "mock-?ups?|templates?|hangers?|mannequins?|models? wearing|person wearing|woman wearing|man wearing|" +
    "flat ?lay|product photo|fabric|folded" +
  ")\\b",
  "gi"
);

/* Removing the word alone leaves rubbish like "a white with bold lettering", which is worse than
   the original because it still steers the picture. So we drop the whole CLAUSE that mentioned a
   garment. If that empties the subject, the caller refuses the job instead of guessing. */
function scrubGarment(v) {
  return String(v || "")
    .split(",")
    .map(function (part) { return part.trim(); })
    .filter(function (part) {
      GARMENT_RE.lastIndex = 0;
      return part && !GARMENT_RE.test(part);
    })
    .join(", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* Returns the spec with every garment reference removed. `elements` entries that were ONLY a
   garment word disappear rather than becoming empty strings. */
function stripGarments(spec) {
  const out = Object.assign({}, spec);
  out.genre = scrubGarment(spec.genre);
  out.subject = scrubGarment(spec.subject);
  out.composition = scrubGarment(spec.composition);
  out.elements = (spec.elements || []).map(scrubGarment).filter(Boolean);
  // technique/palette/typography describe HOW it is drawn — a garment word there is harmless,
  // and scrubbing them risks destroying legitimate wording like "fabric texture" the user chose.
  return out;
}

/* ---- v35: style presets. The page sends a key; all wording lives here. ---- */
const STYLE_PRESETS = {
  flat: {
    label: "שטוח ונקי",
    render:
      "clean flat vector illustration, single-tone solid fills, no tonal variation, " +
      "even bold outlines, no shading, no gradients, no highlights, no texture, no depth",
    negative:
      ", 3d render, soft shading, cel shading, gradient, gradients, glossy, specular highlight, " +
      "drop shadow, ambient occlusion, painterly, airbrush, volumetric, depth, realistic fur",
  },
  rich: {
    label: "עשיר ומוצלל",
    render:
      "polished illustrated artwork, rich colour, smooth shading and soft highlights, " +
      "clean linework, high detail, crisp edges",
    negative: "",
  },
  bling: {
    label: "נצנוץ ואבנים",
    render:
      "glossy 3D rhinestone and metallic artwork, faceted gems, gold and chrome accents, " +
      "sparkles and glitter, deep saturated colour, high detail, crisp edges",
    negative: ", flat colour, matte, dull, washed out",
  },
  vintage: {
    label: "וינטג' רטרו",
    render:
      "retro screen-print look, muted faded palette, limited colour separations, " +
      "subtle halftone dots and light distress, bold simple shapes",
    negative: ", neon, glossy, 3d render, photorealistic, smooth gradient",
  },
  line: {
    label: "קו דק ומינימלי",
    render:
      "minimal single-weight line art, clean thin uniform strokes, mostly open space, " +
      "very few filled areas, no shading, no gradients",
    negative:
      ", heavy fill, solid blocks of colour, shading, gradient, 3d render, texture, busy detail",
  },
  real: {
    label: "מציאותי ומאויר",
    render:
      "semi-realistic digital painting, detailed realistic facial features and proportions, " +
      "smooth airbrushed skin with soft tonal shading, rich colour blending, fine ink linework, " +
      "expressive but natural eyes",
    negative:
      ", chibi, big oversized eyes, kawaii, cartoon mascot, flat vector, sticker art, " +
      "simplified doll face, childish proportions, uniform flat fill",
    painterly: true,
  },
  monodark: {
    label: "כיתוב שחור · לחולצה בהירה",
    render:
      "monochrome black artwork on white, solid black fills only, no grey tones, no shading, " +
      "no gradients, clean even outlines, high contrast",
    negative:
      ", colour, coloured, grey, gray, halftone, gradient, shading, 3d render, white fill, " +
      "pale tones, glossy",
  },
  monolight: {
    label: "כיתוב לבן · לחולצה כהה",
    // drawn in black, inverted to white after the cut-out (see `invert`)
    render:
      "monochrome black artwork on white, solid black fills only, no grey tones, no shading, " +
      "no gradients, clean even outlines, bold shapes that stay readable when reversed",
    negative:
      ", colour, coloured, grey, gray, halftone, gradient, shading, 3d render, white fill, " +
      "pale tones, glossy, thin hairline strokes",
    invert: true,
  },
  cute: {
    label: "חמוד וילדותי",
    render:
      "kawaii cartoon style, rounded soft shapes, big expressive eyes, " +
      "soft pastel palette, simple clean outlines, gentle flat shading",
    negative: ", gritty, horror, realistic, harsh contrast, complex detail",
  },
};

function presetFor(spec) {
  const key = String((spec && spec.style) || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STYLE_PRESETS, key) ? STYLE_PRESETS[key] : null;
}

function specToPrompt(spec) {
  const parts = [];
  if (spec.genre) parts.push(spec.genre);
  if (spec.subject) parts.push(`main focus: ${spec.subject}`);
  if (spec.elements && spec.elements.length) parts.push(`featuring ${spec.elements.join(", ")}`);
  const preset = presetFor(spec);
  // a chosen preset speaks for the rendering; the analysed technique would only contradict it
  if (preset) parts.push(`rendered as ${preset.render}`);
  else if (spec.technique) parts.push(`rendered as ${spec.technique}`);
  if (spec.palette) parts.push(`colour palette: ${spec.palette}`);
  if (spec.composition) parts.push(`composition: ${spec.composition}`);
  if (spec.text) {
    parts.push(`with the text "${spec.text}"${spec.typography ? ` set as ${spec.typography}` : ""}, spelled exactly, clearly legible`);
  } else if (spec.typography) {
    parts.push(`lettering style: ${spec.typography}`);
  } else {
    parts.push("no text and no lettering anywhere in the artwork, decoration only");
  }

  // "every shape filled solid" is a definition of FLAT vector art. Keeping it on a painterly brief
  // contradicts the brief in the same sentence, which is what forced cartoon output. Painterly work
  // still needs the no-hollow-lettering guarantee, so that half is kept and the fill clause dropped.
  const painterly = wantsPainterly(spec);
  const common =
    ", original t-shirt print artwork, one self-contained design, " +
    "isolated on a pure flat white #FFFFFF background with wide empty margins on all four sides, " +
    "nothing touching any edge, no mockup, no shirt, no person, no photo frame, no border" +
    // v19-v21: a coloured backdrop SHAPE is not a frame or a border, so those words never blocked
    // it — and birefnet then keeps the shape as the salient object instead of the artwork.
    ", the artwork floats freely on empty white, no coloured backdrop shape behind it, " +
    "no panel, no badge, no sticker shape, no rounded blob, no circle or oval behind the subject, " +
    // v24: white IS the background and gets cut away, which turns white areas into holes.
    // v42, restored: cream and pale grey ARE near-white and get cut away too. The substitute has
    // to be a MID-TONE or DEEP shade, which is what v24 said before v40 softened it.
    // v48: said out loud because flux was echoing the wording into every spot the spec mentioned
    (spec.text ? "the wording appears exactly ONCE in the whole design, never repeated elsewhere, " : "") +
    // v49: the leopard came back as a sliver hiding under its own caption
    (spec.text
      ? "the subject is drawn COMPLETE and fully visible, never hidden or cropped by the lettering — " +
        "the words and the subject occupy separate bands of the design, "
      : "") +
    // v49: four runs where the lettering obeyed the palette and the animal did not
    (paletteIsLimited(spec.palette)
      ? "EVERY element including the animal or main subject is printed in those inks only, flat and " +
        "stylised, never naturalistic colouring, "
      : "") +
    "nothing in the artwork is white or near-white — every colour is a mid-tone or deep shade with " +
    "strong contrast against white, no cream, no ivory, no beige, no pastel fills" +
    (painterly ? ", lettering filled solid, never hollow" : ", every shape and letter filled solid");

  // A flat brief must not be followed by "high detail" — that contradiction is what produced
  // shaded, glossy results when the user explicitly asked for flat vector art.
  return (
    parts.join(", ") +
    common +
    (preset
      ? ""                                   // the preset already stated the rendering
      : painterly
      ? ", rich detail, painterly finish"
      : wantsFlat(spec)
      ? ", clean flat vector illustration, solid uniform fills, even bold outlines, " +
        "no shading, no gradients, no highlights, no texture, no depth"
      : ", high detail, crisp edges")
  );
}

/* Detects a flat/vector brief anywhere the user could have expressed one. */
const FLAT_RE =
  /\b(flat|vector|minimal|minimalist|solid colou?rs?|no shading|no gradients?|2d|silhouette|line ?art|lineart|outline only|sticker|clip ?art|retro print|screen ?print|spot[- ]colou?r|block print|woodcut|linocut|hand[- ]drawn|distressed print|graphic simplification)\b/i;

/* A painterly brief: either the `real` preset, or wording the user typed themselves. */
const PAINTERLY_RE =
  /\b(semi-?realistic|realistic|photo-?realistic|painterly|digital painting|airbrush(ed)?|render(ed|ing)?|portrait|lifelike|shaded|soft shading|tonal|blend(ed|ing)?)\b/i;

function wantsPainterly(spec) {
  const p = presetFor(spec);
  if (p) return !!p.painterly;
  if (wantsFlat(spec)) return false;          // an explicit flat brief always wins
  return PAINTERLY_RE.test(
    [spec.technique, spec.genre, spec.composition].filter(Boolean).join(" ")
  );
}

function wantsFlat(spec) {
  return FLAT_RE.test(
    [spec.technique, spec.genre, spec.composition].filter(Boolean).join(" ")
  );
}

// v48: below this share of inked pixels there is no design on the canvas, only stray specks.
// A real print sits far above it; the empty run that triggered this scored essentially zero.
const EMPTY_LIMIT = 0.004;

const SPEC_NEGATIVE_BASE =
  "photograph of a person, model wearing a shirt, garment, mockup, hanger, watermark, signature, " +
  "cropped, cut off, full-bleed panel, coloured background, cream paper, texture, frame, border, " +
  "hollow outline text, misspelled text, blurry, low resolution, " +
  // v19-v21 backdrop shapes and v24 white artwork, restored into the active path
  "backdrop shape, background blob, rounded rectangle behind the subject, badge, sticker shape, " +
  "circle behind the subject, coloured panel, scene background, " +
  "white fills, white shapes, white bellies, pure white areas inside the artwork, " +
  // v42, restored: the near-whites that survive the word "white" and still vanish in the cut-out
  "cream, ivory, beige, off-white, pale pastel fills, washed out, low contrast, faded lettering, " +
  // v48: flux printed "WILD" twice and "FISH / CAT" three times when the words reached it from two fields
  "repeated text, duplicate lettering, the same word printed twice, echoed wording, extra captions, " +
  // v49
  "subject hidden behind the text, subject obscured by lettering, only part of the animal visible";

// v49: separate from SPEC_NEGATIVE_FLAT below, which is about RENDERING. This one is about staying
// inside the named inks — four runs had the lettering obey the palette while the animal ignored it.
const SPEC_NEGATIVE_PALETTE =
  ", naturalistic animal colouring, photo-realistic fur, full-colour rendering, " +
  "extra colours outside the stated palette";

const SPEC_NEGATIVE_FLAT =
  ", 3d render, soft shading, cel shading, gradient, gradients, glossy, specular highlight, " +
  "drop shadow, ambient occlusion, painterly, airbrush, volumetric, depth, realistic fur";

/* Blocks flux from filling decorative space with letter-shaped noise. Only ever added when the
   design is meant to be wordless — asking for text and banning it in one prompt would be the same
   self-contradiction that caused v34 and v38. */
const SPEC_NEGATIVE_NOTEXT =
  ", text, lettering, letters, words, writing, typography, caption, slogan, logo, watermark, " +
  "gibberish text, fake letters, garbled writing";

function negativeFor(spec) {
  const preset = presetFor(spec);
  const wordless = !String(spec.text || "").trim();
  const base = SPEC_NEGATIVE_BASE +
    (wordless ? SPEC_NEGATIVE_NOTEXT : "") +
    (paletteIsLimited(spec && spec.palette) ? SPEC_NEGATIVE_PALETTE : "");
  if (preset) return base + (preset.negative || "");
  return base + (wantsFlat(spec) ? SPEC_NEGATIVE_FLAT : "");
}

// kept so nothing else referencing the old name breaks
const SPEC_NEGATIVE = SPEC_NEGATIVE_BASE;

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

  // Hebrew in "text" would be DRAWN, and neither generator can draw Hebrew legibly. Drop it, don't
  // mangle it. This runs BEFORE the edit/flux split, so the edit path never sees Hebrew either.
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

  // the artwork is the print, never the thing it is printed on
  const before = spec.subject;
  spec = stripGarments(spec);
  if (before !== spec.subject) {
    console.log(`[reimagine] garment scrubbed from subject: "${before}" -> "${spec.subject}"`);
  }

  return { spec, notice };
}

/* flux draws short Latin lettering beautifully and weaves it into the design. It only fails on
   Hebrew (cannot draw it at all) and on long strings (misspells). Hand those two cases to the
   server and leave the rest alone — a plain caption underneath is worse than good integrated type. */
const SERVER_TEXT_MAX = 14;

function needsServerText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (HEBREW_RE.test(t)) return true;              // flux cannot draw Hebrew at all
  return t.replace(/\s+/g, "").length > SERVER_TEXT_MAX;
}

/* v53: everything the FLUX path needs done to the spec before it is drawn, in one place.
   This is exactly the v52 preparation, lifted out of the handler unchanged so it can be applied
   LAZILY — the edit path skips it entirely, and a failed edit still gets it on the way to flux.
   Returns { spec, wanted }, where `wanted` non-null means the server draws the caption. */
function prepareForFlux(spec) {
  const wanted = needsServerText(spec.text)
    ? { text: spec.text, colour: chosenTextColour(spec) }
    : null;

  if (wanted) {
    // typography must go with it. Leaving it behind put "lettering style: bold script" in the
    // prompt while the wordless negative banned every letter — and flux obeys the positive.
    return {
      spec: stripLettering(Object.assign({}, spec, { text: "", typography: "" })),
      wanted,
    };
  }

  if (spec.text) {
    // flux is drawing the words, so make sure no OTHER field asks for them a second time,
    // and that it does not bury the subject underneath them (v49)
    return { spec: unhideSubject(dedupeWording(spec)), wanted: null };
  }

  return { spec, wanted: null };
}

/* Dark by default: white lettering would be cut away with the background (see v24/v42). */
function chosenTextColour(spec) {
  const p = String(spec.palette || "").toLowerCase();
  /* v50: the moose palette said "dark charcoal outlines and lettering" and the caption still came out
     forest green, because the scan below matched a colour named for something else in the same string.
     An explicitly stated lettering colour wins. */
  const named = p.match(/\b([a-z ]{3,24}?)\s+(?:outlines? and )?lettering\b/);
  if (named) {
    const c = named[1].trim();
    if (/charcoal|black/.test(c)) return "#111111";
    if (/navy|deep blue/.test(c)) return "#152A4A";
    if (/maroon|burgundy|deep red/.test(c)) return "#5A1220";
    if (/forest|deep green/.test(c)) return "#12402A";
  }
  if (/\bnavy|deep blue\b/.test(p)) return "#152A4A";
  if (/\bmaroon|burgundy|deep red\b/.test(p)) return "#5A1220";
  if (/\bforest|deep green\b/.test(p)) return "#12402A";
  return "#111111";
}

async function generateFromSpec(spec) {
  const prompt = specToPrompt(spec);
  console.log("[reimagine] v26 prompt:", prompt.slice(0, 300));
  return await fal("fal-ai/flux/dev", {
    prompt,
    negative_prompt: negativeFor(spec),
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

/* Negates RGB and leaves alpha alone, so black artwork on transparency becomes WHITE artwork on
   transparency. Applied AFTER the cut-out — inverting first would turn the white background black
   and the removal would have nothing to key on. */
async function invertArtwork(buf) {
  return await sharp(buf).ensureAlpha().negate({ alpha: false }).png().toBuffer();
}

/* ---- v44: server-rendered lettering ----
   Drawn as an SVG and rasterised by sharp, so the spelling is exactly what the user asked for. */

function escapeXml(v) {
  return String(v || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* ---- v46: the lettering is drawn from REAL GLYPH OUTLINES ----
   v44 named fonts in the SVG ("DejaVu Sans, Liberation Sans, Arial") and trusted the host to have
   one of them. Vercel does not guarantee any, and a missing font renders tofu rather than nothing,
   so the blank-layer guard never fired and the caption arrived as faint illegible marks. The font
   now ships in node_modules and opentype.js turns the words into <path> data before sharp is
   involved, so no font lookup happens at all. DejaVu Sans Bold is the one bundled because it also
   covers Hebrew, which is half the reason this path exists. */

const FONT_REL = "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf";
let _font = null;
let _fontTried = false;

/* v47: module resolution is NOT enough on Vercel. The tracer only bundles files it can see being
   used, it does not follow require.resolve() through a variable, and the .ttf was pruned — the log
   said "Cannot find module". vercel.json force-includes it now, and this walks real paths so a
   change in how the lambda is laid out cannot silently kill the captions again. */
function fontCandidates() {
  const out = [];
  try {
    out.push(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"));
  } catch (e) {
    // not resolvable from the bundle - the explicit paths below are the ones that matter
  }
  out.push(path.join(process.cwd(), FONT_REL));      // /var/task on Vercel
  out.push(path.join("/var/task", FONT_REL));
  try {
    out.push(fileURLToPath(new URL("../" + FONT_REL, import.meta.url)));
  } catch (e) {
    // import.meta.url is always a file URL here, but never let path building throw
  }
  return out.filter((p, i) => p && out.indexOf(p) === i);
}

function loadFont() {
  if (_fontTried) return _font;
  _fontTried = true;

  const tried = [];
  for (const p of fontCandidates()) {
    tried.push(p);
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      _font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      console.log("[reimagine] font loaded from", p);
      return _font;
    } catch (e) {
      console.error("[reimagine] font at", p, "failed:", e.message);
    }
  }

  console.error("[reimagine] no usable font. tried:", tried.join(" | "));
  _font = null;
  return _font;
}

/* v47: when the SERVER draws the words, nothing else in the spec may ask for lettering. Blanking
   text and typography was not enough — the analyser writes things like "large cursive 'A Moose
   Destroys You' filling the lower third" into COMPOSITION, and that reaches flux verbatim. Scrubbed
   clause by clause, the same way stripGarments works: deleting single words leaves a fragment that
   still steers the picture.
   v53 note: this now runs ONLY on the flux path. On the edit path the lettering in the reference is
   the thing we are trying to keep, so scrubbing it would defeat the whole version. */
const LETTERING_RE = new RegExp(
  "\\b(text|lettering|letters|lettered|word|words|wordmark|writing|written|typography|" +
  "typographic|typeface|font|script|cursive|calligraphy|calligraphic|handwritten|headline|title|" +
  "subtitle|tagline|slogan|caption|quote|uppercase|lowercase|serif|sans-serif|arched|arcing|arc)\\b",
  "i"
);
const QUOTED_RE = /['"\u2018\u2019\u201C\u201D][^'"\u2018\u2019\u201C\u201D]{2,}['"\u2018\u2019\u201C\u201D]/g;

function scrubLetteringText(v) {
  return String(v || "")
    .replace(QUOTED_RE, " ")
    .split(/\s*[,;]\s*/)
    .filter((clause) => clause.trim() && !LETTERING_RE.test(clause))
    .join(", ")
    .trim();
}

/* v48: the wording also reaches flux through composition and elements when FLUX is the one drawing it.
   Nothing is removed about WHERE the lettering goes — only the words themselves, so the design still
   places its caption correctly but is asked for it exactly once. */
function dedupeWording(spec) {
  const words = String(spec.text || "")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length >= 3);
  if (!words.length) return spec;

  const out = Object.assign({}, spec);
  const scrub = (v) => {
    let s = String(v || "").replace(QUOTED_RE, " ");
    for (const w of words) {
      s = s.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
    }
    return s.replace(/\s*,\s*,/g, ",").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
  };

  const composition = scrub(out.composition);
  if (composition !== String(out.composition || "").trim()) {
    console.log(`[reimagine] wording removed from composition: "${out.composition}" -> "${composition}"`);
  }
  out.composition = composition || "single subject centred with wide empty margins on all sides";

  if (Array.isArray(out.elements)) {
    out.elements = out.elements.map(scrub).filter(Boolean);
  }
  return out;
}

/* v49: "overlapping behind the lettering" reads to flux as "hide it", and it hides it. The reference
   had the animal BELOW the word, so the placement is kept and only the occlusion is rewritten. */
const OCCLUSION_RE =
  /\b(?:overlapping\s+)?(?:tucked\s+|partially\s+|mostly\s+|fully\s+)?(?:behind|underneath|beneath|hidden\s+behind|obscured\s+by|covered\s+by|overlapped\s+by)\s+the\s+(?:lettering|letters|text|type|typography|words?|title|headline|caption)\b/gi;

function unhideSubject(spec) {
  const before = String(spec.composition || "");
  const after = before.replace(OCCLUSION_RE, "below the lettering");
  if (after === before) return spec;
  console.log(`[reimagine] occlusion rewritten: "${before}" -> "${after}"`);
  return Object.assign({}, spec, { composition: after });
}

/* v49: a palette this tight is a print instruction, not a mood. The subject has to obey it too. */
function paletteIsLimited(palette) {
  const p = String(palette || "").toLowerCase();
  if (!p) return false;
  if (/\b(single[- ]colou?r|one[- ]colou?r|monochrom\w*|two[- ]colou?r|duotone|1[- ]colou?r)\b/.test(p)) return true;
  // otherwise count the colour words actually named
  const named = p.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  return named.length > 0 && named.length <= 2;
}

function stripLettering(spec) {
  const out = Object.assign({}, spec);

  // v48: subject too. On a text-only reference the analyser writes subject = "bold white lettering",
  // which kept ordering flux to draw letters after text and typography were already blank.
  const subject = scrubLetteringText(out.subject);
  if (subject !== String(out.subject || "").trim()) {
    console.log(`[reimagine] lettering scrubbed from subject: "${out.subject}" -> "${subject}"`);
  }
  out.subject = subject;

  const composition = scrubLetteringText(out.composition);
  if (composition !== String(out.composition || "").trim()) {
    console.log(`[reimagine] lettering scrubbed from composition: "${out.composition}" -> "${composition}"`);
  }
  // never hand flux an empty composition - it would lose the framing rules with it
  out.composition = composition || "single subject centred with wide empty margins on all sides";

  if (Array.isArray(out.elements)) {
    const kept = out.elements.filter((el) => !LETTERING_RE.test(String(el)) && !QUOTED_RE.test(String(el)));
    if (kept.length !== out.elements.length) {
      console.log("[reimagine] lettering elements dropped:", out.elements.length - kept.length);
    }
    out.elements = kept;
  }

  return out;
}

/* opentype's own text pipeline throws on DejaVu's GSUB tables, so glyphs are placed by hand.
   Hebrew needs no contextual shaping — final forms are separate codepoints — so reversing the
   character order is enough to lay a Hebrew line out right-to-left. */
function glyphsFor(font, text) {
  const chars = Array.from(String(text));
  if (HEBREW_RE.test(text)) chars.reverse();
  return chars.map((c) => font.charToGlyph(c));
}

function runWidth(font, glyphs, size, tracking) {
  let w = 0;
  for (let i = 0; i < glyphs.length; i++) {
    w += (glyphs[i].advanceWidth / font.unitsPerEm) * size;
    if (i < glyphs.length - 1) {
      w += ((font.getKerningValue(glyphs[i], glyphs[i + 1]) || 0) / font.unitsPerEm) * size + tracking;
    }
  }
  return w;
}

function runPath(font, glyphs, x, y, size, tracking) {
  let cx = x;
  let d = "";
  for (let i = 0; i < glyphs.length; i++) {
    d += glyphs[i].getPath(cx, y, size).toPathData(2);
    cx += (glyphs[i].advanceWidth / font.unitsPerEm) * size;
    if (i < glyphs.length - 1) {
      cx += ((font.getKerningValue(glyphs[i], glyphs[i + 1]) || 0) / font.unitsPerEm) * size + tracking;
    }
  }
  return d;
}

const TEXT_LINE_H = 1.22;      // line box as a multiple of the font size
const TEXT_TRACK = 0.02;       // letter-spacing as a fraction of the font size
const TEXT_MAX_LINES = 3;
const TEXT_MIN_SIZE = 24;

/* Splits into n lines by character count with the word order preserved. The v44 version split any
   line over 18 characters into its individual words and then kept the first three, which silently
   threw away the rest of the caption. */
function splitInto(words, n) {
  if (n <= 1) return [words.join(" ")];
  const target = words.join(" ").length / n;
  const lines = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && lines.length < n - 1 && cur.concat(w).join(" ").length > target) {
      lines.push(cur.join(" "));
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length) lines.push(cur.join(" "));
  return lines;
}

/* Tries 1, 2 and 3 lines and keeps whichever fits the box at the largest size. Because the glyphs
   are measured for real, the answer is exact rather than the guessed 0.62-per-character of v44. */
function layoutText(font, text, boxW, boxH) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  let best = null;
  for (let n = 1; n <= Math.min(TEXT_MAX_LINES, words.length); n++) {
    const lines = splitInto(words, n);
    let byWidth = Infinity;
    for (const l of lines) {
      const unit = runWidth(font, glyphsFor(font, l), 1, TEXT_TRACK);
      byWidth = Math.min(byWidth, boxW / Math.max(unit, 0.001));
    }
    const byHeight = boxH / (lines.length * TEXT_LINE_H);
    const size = Math.floor(Math.min(byWidth, byHeight));
    if (!best || size > best.size) best = { lines, size };
  }
  return best && best.size >= TEXT_MIN_SIZE ? best : null;
}

function textSvg(font, layout, boxW, boxH, colour) {
  const { lines, size } = layout;
  const lineBox = size * TEXT_LINE_H;
  const top = (boxH - lines.length * lineBox) / 2;
  const ascent = (font.ascender / font.unitsPerEm) * size;

  let body = "";
  lines.forEach((l, i) => {
    const gs = glyphsFor(font, l);
    const w = runWidth(font, gs, size, size * TEXT_TRACK);
    const x = (boxW - w) / 2;
    const y = top + i * lineBox + ascent;
    body += `<path d="${runPath(font, gs, x, y, size, size * TEXT_TRACK)}" fill="${colour}"/>`;
  });

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">${body}</svg>`
  );
}

/* Returns a transparent PNG of the lettering, or null if it could not be drawn. Null is a supported
   answer, not an error: the caller then delivers the ordinary wordless print file. */
async function renderTextLayer(text, boxW, boxH, colour) {
  const font = loadFont();
  if (!font) return null;

  const layout = layoutText(font, text, boxW, boxH);
  if (!layout) return null;

  try {
    const png = await sharp(textSvg(font, layout, boxW, boxH, colour || "#111111"))
      .png()
      .toBuffer();
    // kept as a belt-and-braces check even though the outlines no longer depend on a font lookup
    const stats = await sharp(png).stats();
    const alpha = stats.channels[3];
    if (!alpha || alpha.max < 200) {
      console.error("[reimagine] text layer came back blank");
      return null;
    }
    return png;
  } catch (e) {
    console.error("[reimagine] text layer failed:", e.message);
    return null;
  }
}

/* Places the wordless artwork in the upper area and the lettering beneath it. */
async function composeWithText(artBuf, text, colour) {
  const TEXT_H = Math.round(CANVAS_H * 0.22);
  const ART_H = CANVAS_H - TEXT_H;

  const layer = await renderTextLayer(text, Math.round(CANVAS_W * SAFE), TEXT_H, colour);
  if (!layer) return null;                       // caller falls back to the wordless design

  const art = await sharp(artBuf)
    .ensureAlpha()
    .trim({ threshold: 12 })
    .resize(Math.round(CANVAS_W * SAFE), Math.round(ART_H * 0.94), {
      fit: "inside",
      kernel: "lanczos3",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const am = await sharp(art).metadata();

  return await sharp({
    create: {
      width: CANVAS_W, height: CANVAS_H, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: art, left: Math.round((CANVAS_W - am.width) / 2), top: Math.round((ART_H - am.height) / 2) },
      { input: layer, left: Math.round((CANVAS_W - Math.round(CANVAS_W * SAFE)) / 2), top: ART_H },
    ])
    .png({ compressionLevel: 6 })
    .withMetadata({ density: DPI })
    .toBuffer();
}

/* Everything after generation is shared with the legacy path: cut out, QC, print canvas, upload. */
/* v48: a pure-typography design. No generator call, no cut-out — the lettering fills the canvas. */
async function finishTextOnly(serverText, t0, preview) {
  const W = preview ? PREVIEW_W : CANVAS_W;
  const H = preview ? PREVIEW_H : CANVAS_H;

  const layer = await renderTextLayer(
    serverText.text, Math.round(W * SAFE), Math.round(H * 0.55), serverText.colour
  );
  if (!layer) throw new Error("לא הצלחנו לצייר את הכיתוב. נסו שוב או קצרו את הטקסט.");

  let canvas = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: layer,
        left: Math.round((W - Math.round(W * SAFE)) / 2),
        top: Math.round((H - Math.round(H * 0.55)) / 2),
      },
    ])
    .png({ compressionLevel: 6 })
    .withMetadata({ density: preview ? 72 : DPI })
    .toBuffer();

  if (!preview) canvas = await fitUploadSize(canvas);
  const imageUrl = await uploadCloudinary(canvas);
  console.log(`[reimagine] done (text only): ${Date.now() - t0}ms`);

  return {
    imageUrl,
    url: imageUrl,
    preview: !!preview,
    textDrawn: true,
    width: W,
    height: H,
    dpi: preview ? 72 : DPI,
    quality: { edge: 0, pale: 0, rim: 0, hole: 0 },
  };
}

async function finishArtwork(art, t0, preview, invert, serverText) {
  const elapsed = () => Date.now() - t0;

  let cutout = await fal("fal-ai/birefnet", { image_url: art });
  let qc = await inspect(cutout);
  console.log(`[reimagine] cutout+qc: ${elapsed()}ms`);

  /* v48: refuse to ship a blank print file. One run delivered an empty canvas with only the caption
     on it and nothing said why — an error he can read beats a PNG with nothing in it. */
  if (qc.empty) {
    console.error(`[reimagine] artwork came back EMPTY (ink=${qc.inkRatio.toFixed(4)}) - refusing to deliver`);
    throw new Error(
      "היצירה חזרה ריקה — ייתכן שהנושא נחסם או שהאיור היה בהיר מדי והוסר עם הרקע. " +
      "נסו שוב, או תארו את הנושא המרכזי בצבעים כהים יותר."
    );
  }

  let cutBuf = Buffer.from(await (await fetch(cutout)).arrayBuffer());
  if (qc.cropped) {
    console.log("[reimagine] edges still opaque after birefnet - running flood fill");
    try {
      cutBuf = await stripLeftoverBackground(cutBuf);
    } catch (e) {
      console.warn("flood fill failed, keeping birefnet output:", e.message);
    }
  }

  if (invert) {
    try {
      cutBuf = await invertArtwork(cutBuf);
      console.log("[reimagine] inverted to white artwork for dark garments");
    } catch (e) {
      console.error("invert failed, delivering the black version:", e);
    }
  }

  let canvas = null;
  let textDrawn = false;
  if (serverText && !preview) {
    canvas = await composeWithText(cutBuf, serverText.text, serverText.colour);
    textDrawn = !!canvas;
    if (!canvas) console.error("[reimagine] falling back to wordless artwork");
  }
  if (!canvas) canvas = preview ? await toPreviewCanvas(cutBuf) : await toPrintCanvas(cutBuf);
  if (!preview) canvas = await fitUploadSize(canvas);
  const imageUrl = await uploadCloudinary(canvas);
  console.log(`[reimagine] done${preview ? " (preview)" : ""}: ${elapsed()}ms`);

  return {
    imageUrl,
    url: imageUrl,
    preview: !!preview,
    textDrawn,
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

  /* ---- v26 step 2: draw from an edited spec ---- */
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

      /* v53: the reference is resolved BEFORE anything is decided about the wording, because the
         reference is what decides WHO draws the words. With one, the model keeps the design's own
         lettering; without one, the server still draws a caption as it has since v44.
         NB: read the RAW spec — normaliseSpec whitelists SPEC_KEYS and would strip `ref` first. */
      let reference = referenceFrom(body, body.spec);
      /* v52: nothing in the request? ask the account. Wrapped tightly: if the column does not exist
         yet this throws, and we simply carry on down the old path. */
      if (!reference) {
        try {
          const rows = await sbGet(
            "students?id=eq." + encodeURIComponent(student.id) + "&select=last_ref&limit=1"
          );
          if (rows && rows[0] && rows[0].last_ref) {
            reference = rows[0].last_ref;
            console.log("[reimagine] reference recalled from the account");
          }
        } catch (e) {
          console.error("[reimagine] could not recall the reference (run the SQL?):", e.message);
        }
      }

      let art = null;
      let wanted = null;                 // non-null => the SERVER draws the caption (flux path only)
      let specUsed = prepared.spec;
      let fluxPrepared = false;

      const prepareFluxOnce = () => {
        if (fluxPrepared) return;
        const fx = prepareForFlux(specUsed);
        specUsed = fx.spec;
        wanted = fx.wanted;
        fluxPrepared = true;
      };

      /* v54: decide per design who draws the words. Outside the window the edit path is fed
         exactly what v52 fed it — lettering scrubbed out, server caption composited afterwards. */
      if (reference) {
        const keep = editCanKeepLettering(prepared.spec);
        console.log(
          `[reimagine] lettering: ${keep ? "MODEL keeps the design's own type" : "SERVER draws it"}` +
          ` (text=${(prepared.spec.text || "").length} chars, typography="${prepared.spec.typography || ""}")`
        );
        if (!keep) prepareFluxOnce();

        // v55: strip the wearer BEFORE the edit model sees anything. Words never won this argument.
        reference = await cropReferenceToGraphic(reference);
      }

      if (reference) {
        try {
          art = await editFromSpec(specUsed, reference);
        } catch (e) {
          console.error("[reimagine] edit path failed, falling back to flux:", e.message);
        }
      } else {
        console.warn("[reimagine] no reference available - falling back to flux");
      }

      if (!art) {
        /* ---- flux path: the v52 preparation, applied here and nowhere else ---- */
        prepareFluxOnce();

        /* v48: if the subject scrubbed away to nothing, the reference was pure typography — the
           design IS the wording. There is no artwork to regenerate, and asking flux for one is what
           produced the black blob covered in gibberish. Skip the generator, deliver the lettering. */
        if (wanted && !specUsed.subject) {
          console.log("[reimagine] text-only reference: skipping the generator, lettering only");
          const out = await finishTextOnly(wanted, t0, isPreview);
          const left = owner
            ? { freeLeft: null, credits: null, owner: true }
            : await chargeRun(student, quota).catch((e) => {
                console.error("[reimagine] charge failed (design was delivered):", e);
                return { freeLeft: quota.freeLeft, credits: quota.credits };
              });
          return res.status(200).json(
            Object.assign(
              {
                spec: specUsed,
                notice: prepared.notice,
                freeLeft: left.freeLeft,
                credits: left.credits,
                owner: !!owner,
                forDark: false,
                textOnly: true,
              },
              out
            )
          );
        }

        if (!specUsed.subject && !specUsed.genre) {
          return res.status(400).json({
            error:
              "לא זוהה עיצוב בתמונה — נראה שהיא צילום של חולצה ולא העיצוב עצמו. " +
              "נסו להעלות את הגרפיקה בלבד, או מלאו ידנית את הנושא המרכזי.",
            needSubject: true,
          });
        }

        art = await generateFromSpec(specUsed);
      }

      const chosen = presetFor(specUsed);
      const out = await finishArtwork(
        art, t0, isPreview, !!(chosen && chosen.invert), wanted
      );

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
            spec: specUsed,
            notice: prepared.notice,
            freeLeft: left.freeLeft,
            credits: left.credits,
            owner: !!owner,
            forDark: !!(chosen && chosen.invert),
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
      /* v51: park the reference so step 3 can EDIT it instead of painting blind. Failing to upload is
         not fatal — the run simply falls back to the old draw-from-description path. */
      let ref = null;
      try {
        ref = await uploadCloudinary(Buffer.from(base64Data, "base64"));
        console.log("[reimagine] reference parked:", ref);
      } catch (e) {
        console.error("[reimagine] could not park the reference:", e.message);
      }
      /* v52: remember it against the account too, as a second route in case the theme stops sending
         the image. Best-effort on purpose — a missing column or a failed write must never break the
         analyse step. NOTE: the theme sends no token on THIS call, so studentFromToken usually
         returns null here and the write is skipped. That is expected, not a fault. */
      if (ref) {
        try {
          const who = await studentFromToken(
            body.token || req.headers["x-epai-token"] || req.query.token
          );
          if (who) {
            await sbPatch("students?id=eq." + encodeURIComponent(who.id), { last_ref: ref });
            console.log("[reimagine] reference remembered for the account");
          }
        } catch (e) {
          console.error("[reimagine] could not remember the reference (run the SQL?):", e.message);
        }
      }
      return res.status(200).json({ spec: Object.assign({}, spec, ref ? { [REF_KEY]: ref } : {}), ref });
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
