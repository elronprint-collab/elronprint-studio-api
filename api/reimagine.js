// api/reimagine.js — "עיצוב מחדש" v81
// v81 change: ON THE TEXT-ONLY PATH, A WHITE PRINT CAME BACK BLACK.
// A dense white-on-black typographic reference was detected as light-on-dark correctly — v74's
// referenceIsLightOnDark did its job and set monolight — and the caption still arrived in black.
// 🔑 The decision was made and then dropped on the floor. `monolight` works by drawing in black and
// NEGATING afterwards, and that negation lives in `finishArtwork`. The text-only path does not go
// through finishArtwork at all: it has no generator call and no cut-out, so it never reached the
// inversion, and it reported `forDark: false` hardcoded on top of that — so the page could not even
// show it against the dark board.
// This is not a model failure and not a threshold to tune. It is a branch that was added later
// (v48, then v74) and never wired to a step that already existed, which is why it fails the same way
// every single time rather than intermittently.
// Two details worth keeping:
//   - the colour is forced to near-black BEFORE drawing when inverting. chosenTextColour can
//     legitimately return navy or maroon off the palette, and negating navy yields a cream — the v42
//     near-white trap, which prints washed out and gets eaten by any later cut-out. Black negates to
//     near-white, which is the only thing a light print should be.
//   - negating leaves the transparent ground transparent: alpha is untouched, and a clear pixel stays
//     clear whatever its RGB happens to say.
// Failing the inversion delivers the dark version rather than an error — a design in the wrong colour
// can be regenerated, an error cannot.
// NOT touched, deliberately, and he chose the order: a three-line caption still declines to the plain
// single-face layout, because v72's two-tier layout only solves for TWO lines. That is the next one.
//
import crypto from "crypto";
import { checkRateLimit } from "./_ratelimit.js";
// api/reimagine.js — "עיצוב מחדש" v80
// v80 change: TWO FIXES, both read off one bad pair rather than guessed.
//
// 1. A TEXT-ONLY REFERENCE WENT TO THE GENERATOR NO MATTER HOW LONG THE WORDING WAS.
//    "Modern Streetwear Stay Positive" -> asked for "Keep Feeling Focused" (18 characters) and came
//    back as "Keep Freenel FOCOTED" — two of the three words shredded. needsServerText() had already
//    routed that wording to the server, correctly; the v74 text-only branch then handed it straight
//    back to flux, because it tested only "is there a subject?" and never "can the generator spell
//    this?". So the one rule that exists to stop misspellings was cancelled by the branch below it.
//    `generatorCanSpell()` now gates that branch. Short Latin wording still goes to the generator —
//    that is what v74 was for, and ALWAYS RISE proved it works — while long wording and Hebrew stay
//    with the server fonts, which since v72/v75/v76 set real two-tier typography rather than a
//    file-name caption. ⚠️ HEBREW WAS ALSO AFFECTED and this may be the missing-Hebrew bug: on a
//    text-only Hebrew design the old branch handed the words to a model that cannot draw Hebrew.
//
// 2. THE INVENTED BACKDROP DISC — NINE SIGHTINGS — IS NOW MEASURED, NOT ASKED ABOUT.
//    The re-run of that same design (with the wording shortened to "Keep Focused", which did spell
//    correctly) came back on a huge coral disc, with a dog nobody asked for standing on it and white
//    stripes inside it that the cut-out tears into real holes. That disc has been banned in the
//    negative prompt in seven different wordings since v40 and the ban has never once held.
//    🔑 It is not disobedience. Streetwear and outdoor print art in the model's training almost
//    always carries a sun or a circle behind the subject, so it draws one by habit. An eighth wording
//    would not have helped either. `looksLikeDisc()` measures the cut-out geometrically and
//    `finishArtwork` regenerates ONCE when it fires — the same shape as every fix that has actually
//    held this month (forceSolidInk, dropEdgeStrays, sharedWording): make it survive by construction,
//    do not ask a model to behave.
//    The retry is kept ONLY if it comes back clean, so a false positive costs one generation and
//    about twenty seconds, never the design.
//
// api/reimagine.js — "עיצוב מחדש" v79
// v79 change: fal PRINTED THE ALLOWED LIST. Use it, and stop treating 422 as fatal.
// The v78 search walked one step and stopped. Two things came out of that run, both useful:
//   1. fal's validator answers with the WHOLE catalogue when the id is wrong:
//      "Input should be 'anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5',
//       'anthropic/claude-3.7-sonnet', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3-haiku',
//       'google/gemini-pro-1.5', 'google/gemini-flash-1.5', 'google/gemini-flash-1.5-8b' …"
//      So the candidate list is no longer a guess. It is copied from fal's own answer, newest first.
//   2. That answer came back as **422**, not 404 — and `looksLikeUnknownModel` only walked on for 404.
//      The guard did exactly what I wrote it to do and stopped, which was right in general and wrong
//      here: a 422 whose body is a `literal_error` on the `model` field is precisely an unknown id.
//      Narrowed to that shape, so a genuine validation error on any OTHER field still stops at once.
// ⚠️ Note for whoever reads this next: `anthropic/claude-3.5-sonnet` IS in fal's allowed list, yet the
// first attempt was rejected with "No endpoints found". A name can be valid and still be unavailable to
// this account — which is exactly why this searches rather than assuming, and why the winner is logged.
// api/reimagine.js — "עיצוב מחדש" v78
// v78 change: THE fal ENDPOINT IS RIGHT, THE MODEL NAME WAS NOT. Stop guessing it — try and remember.
// v77's first live call came back:
//   fal fal-ai/any-llm/vision failed: 400 {"detail":"Error code: 404 … 'No endpoints found for
//   anthropic/claude-3.5-sonnet, meta-llama/llama-3.2-11b-vision-instruct,
//   meta-llama/llama-3.2-90b-vision-instruct.'"}
// That is good news read carefully: the ENDPOINT exists and accepted the request, and the router even
// listed what it tried. Only the model id is wrong, and I cannot check fal's catalogue from the build
// environment — the network here does not reach it.
// So the fix is not another guess. `askFal` now walks a LIST of candidate ids, stops at the first one
// that answers, and REMEMBERS it for the rest of the lambda's life so the failures are paid for once,
// not on every call. The winner is logged by name, so after the first successful run the right id is
// known and can be pinned in `FAL_LLM_MODEL` if you want to skip the search entirely.
// It only walks on when the error is specifically "no endpoints found" / 404 — a real failure (bad key,
// rate limit, malformed request) still stops immediately instead of burning through the whole list.
// Text-only and vision keep separate lists and separate memories, because a model that reads images is
// not necessarily the same one that rewrites a slogan.
// api/reimagine.js — "עיצוב מחדש" v77
// v77 change: ONE BILL. Every language/vision call moves from the Anthropic API to fal.
// He ran out of Anthropic credit mid-session and asked to be charged by fal only. Two accounts, two
// balances, two ways to be stopped — and the stop looks identical to a bug from the outside, which is
// exactly how tonight went until the log said "credit balance is too low".
// Five call sites used the Anthropic Messages API directly: analyzeSpec (the spec), claudeVision (both
// copyright gates), translateSpec (Hebrew), rewordAway (auto rewording) and the dead legacy analyser.
// They all sent the same shape, so instead of editing five fetches this adds ONE provider layer and
// points all of them at it:
//   askLLM({ system, ask, image, mediaType, maxTokens }) -> plain text, or null on failure
// Routed by LLM_PROVIDER, which is an ENV VAR, not a constant: if fal's model turns out worse at
// reading designs, set LLM_PROVIDER=anthropic in Vercel and everything reverts with no code change and
// no redeploy of this file. That lever matters, because the analyser is the part of this tool that
// decides output quality — every deterministic fix built this week reads the fields it writes.
// ⚠️ TWO HONEST WARNINGS I GAVE HIM BEFORE BUILDING:
//   1. fal proxies models through `fal-ai/any-llm`. I could not verify its exact response shape from
//      here, so the reader accepts several plausible field names and LOGS THE RAW KEYS when none match.
//      The first live run will either work or print exactly what to fix — it will not fail silently.
//   2. If FAL_LLM_MODEL names a Claude model, the analysis is byte-for-byte the same model as before and
//      only the bill moves. If it names something else, the spec wording will change, and the spec is
//      what everything downstream depends on. Default is a Claude model for that reason.
// Nothing else moves: the gates, the spec prompts, the deterministic image passes and the paywall are
// untouched.
// api/reimagine.js — "עיצוב מחדש" v76
// v76 change: I CAPPED THE CAPTION'S WIDTH AND FORGOT ITS HEIGHT. My omission, one line short.
// v75 put the caption above the artwork and stopped it spanning the canvas — both worked on the first
// live run. But "ALWAYS ON / Eat Clean" came back with "Eat Clean" nearly a quarter of the canvas tall,
// towering over the fruit.
// Same mechanism I had just fixed on the other axis and did not follow through: the layout takes the
// LARGEST size at which the text still fits its box. Capping the WIDTH stops a long line sprawling, but
// a SHORT line simply grows until it hits the height instead. Two short words in a 22% band become
// enormous. The band is a container, and the code was treating it as a target.
// So the size is now capped against the CANVAS, not just the box: CAP_HEADLINE = 0.075 of the canvas
// height for the headline line. A long caption is unaffected — width already binds it first — and a
// short one simply stops growing at a sensible size and sits in its band with air around it, which is
// what the reference does.
// Applied in BOTH layout paths (the plain one and the two-tier one), because they solve for size
// separately and a cap in only one of them would show up as a caption that changes size depending on
// how many typefaces the analyser happened to name.
// api/reimagine.js — "עיצוב מחדש" v75
// v75 change: THE CAPTION WAS SET LIKE A FILE NAME UNDER A PHOTO. Three geometry fixes, no model asked.
// v72's typefaces landed and are proven — "ALWAYS FINISH" in sans caps over "Eat Complete" in script.
// He put his own design next to the reference and said his looked ugly, and he was right about WHY even
// though the fault was not the fonts:
//   - the reference sets "NEVER WASTE" small and letter-spaced ABOVE the apple, with "Stay Fresh" in
//     script running INTO the fruit. Lettering and artwork are one composition.
//   - ours takes a fixed band at the bottom, fills it edge to edge at the largest size that fits, and
//     centres it. Two heavy lines jammed against each other with no air. It reads like a heading typed
//     underneath a picture, because that is literally what the geometry does.
// Three things, all measurable, none of them a request to a model:
//   1. WIDTH. The caption box was 97% of the canvas — the same safe area as the artwork — so the type
//      always grew until it spanned the whole width. It is now 72%, which is what gives lettering its
//      proportion: a line that stops well short of the edges reads as designed, one that touches both
//      edges reads as stretched.
//   2. AIR. The layer filled its band completely and the two tiers sat on top of each other at the line
//      height. The band now renders into 76% of its own height (so there is space above and below), and
//      a real gap is inserted BETWEEN the headline and the accent line.
//   3. POSITION. The caption could only ever go underneath. When the analyser says the lettering sits
//      above the artwork — which is exactly what this reference does — it now goes above, and the
//      artwork moves down.
// ⚠️ WHAT THIS STILL CANNOT DO, said to him before building it: lettering woven INTO the artwork, like
// "Stay Fresh" running across the apple. Code does not know where the fruit ends or where there is room.
// Only the generator does that, and it does it well (STREET SOUL, the comic block caps). This narrows
// the gap; it does not close it.
// api/reimagine.js — "עיצוב מחדש" v74
// v74 change: ONE BUTTON. Upload a design, get a design — no form, no English fields, no chips.
// His words: "מערכת אוטומטית — מעלה עיצוב, הופך אותו לעיצוב דומה אבל שונה", and the same for a design
// with lettering and for a design that IS lettering. The form was built when the analyser could not be
// trusted; four clean runs this afternoon were produced without him touching a single field.
// `action: "auto"` analyses and generates in ONE request. It does not duplicate the generate path — it
// builds the spec, then falls through into exactly the same code, so the paywall, both gates, the
// cut-out, forceSolidInk, dropEdgeStrays and the print canvas all behave identically.
// Three decisions that used to be HIS now happen in code, because an automatic mode that still needs a
// human to notice them is not automatic:
//   1. LIGHT INK ON A DARK GROUND. The pipeline draws on white and cuts the white away, so white
//      lettering vanishes — the answer has always been the `monolight` preset (draw black, invert after
//      the cut-out), and until now he had to know that and press a chip. `referenceIsLightOnDark()`
//      measures the reference itself: mostly dark with a substantial light minority. That is exactly
//      the "OPEN YOUR EYES" design he was about to lose.
//   2. THE WORDING COLLISION. v68 stops the run when the new wording carries a phrase from the
//      reference and asks him to edit the field. In auto mode there is no field to edit, so
//      `rewordAway()` asks Claude once for different wording that avoids those words, and only if that
//      fails does it fall back to the 409.
//   3. TEXT-ONLY DESIGNS STOP FALLING TO THE SERVER FONT. v48 skipped the generator when the reference
//      was pure typography, which was right when the generator was blind and produced a black blob of
//      gibberish. Today flux draws brush lettering with real texture — proven this afternoon on STREET
//      SOUL and NOT YOUR GIRL — and the server font is the weakest thing the tool can produce on
//      precisely the designs where typography IS the design. `finishTextOnly` stays as the fallback.
// The form is NOT removed. `action: "analyze"` and `action: "generate"` behave exactly as before, so the
// page can keep an "edit it yourself" route, and every automatic choice is reported back in `auto` so
// the response says what was decided rather than deciding silently.
// api/reimagine.js — "עיצוב מחדש" v73
// v73 change: BACK TO THE 16 AUGUST BEHAVIOUR. His call, and he was specific about which one.
// He showed the afro-portrait tee and said that was the stage he liked and wants restored. That is the
// v41 era: the analyser writes a DETAILED spec (composition, elements, palette, technique, typography
// all kept faithfully) and **flux draws the design from that spec alone, never seeing the reference**.
// The edit path — nano-banana looking at the reference and redrawing it — arrived later, at v51 on
// 17 Aug, and everything since has been built on it.
// This is a ROUTING switch, not a rewrite, because the flux path was never removed: it has been sitting
// there the whole time as the fallback for when no reference reaches the server. So one flag moves the
// tool back, and one flag moves it forward again.
// WHAT COMES BACK WITH IT, and he should expect all three:
//   - The result is a NEW drawing of the same design rather than an edit of his image, so it is further
//     from the source. That is what made the portrait run good, and it is also a wider copyright margin.
//   - flux draws short Latin lettering INTO the design again (arched, textured, woven in) instead of the
//     server setting it underneath — v45's rule returns: the server takes over only for Hebrew or for
//     wording over 14 characters, where flux reliably misspells. **This reverses the choice he made at
//     08:00 today.** It is the honest reading of "restore that stage", it is why "MS JONES" came out
//     perfect back then, and it is one constant to undo if he prefers the guaranteed spelling.
//   - The additive habit goes away by construction: flux cannot leave the reference's coffee cup in the
//     picture, because it never sees the reference.
// WHAT STAYS, because none of it depends on the edit path and all of it is downstream of generation:
//   forceSolidInk (v61/v71), dropEdgeStrays (v69), the four typefaces (v72), the cut-out, the QC, the
//   print canvas, the paywall. GATE 1 still inspects the reference for protected material and still runs
//   the v68 wording collision check before a credit is spent.
// TO GO FORWARD AGAIN: USE_EDIT_PATH = true, and set the two lettering flags back the way v70 had them.
// api/reimagine.js — "עיצוב מחדש" v72
// v72 change: THE SERVER CAPTION GETS REAL TYPEFACES AND THE REFERENCE'S OWN TWO-TIER STRUCTURE.
// He sent a "ROOTED in faith" design the tool had produced and called it what it was: a bad design.
// He was right, and the fault was not that CODE draws the letters — v70 proved code draws them
// perfectly. It was that the code had exactly ONE typeface and ONE shape to put them in.
//   - one font: DejaVu Sans Bold, a generic UI sans, whatever the reference's own type looked like.
//   - one shape: a single band under the artwork, centred, every line the same size and face.
// The reference it was remixing sets "ROOTED" as large display serif caps with "in faith" in script
// beneath — two faces, two sizes, one over the other. Reproducing that is geometry and font choice,
// which is precisely what code is good at. So:
//   1. FOUR faces instead of one: display serif (Playfair Display), script (Dancing Script),
//      condensed sans (Oswald), and DejaVu Bold as before. All OFL, free for commercial use.
//   2. The face is CHOSEN FROM THE SPEC's typography field, which the analyser already fills with
//      exactly this ("large flowing cursive lower word, smaller upright accent phrase above").
//   3. A two-line caption is now set as PRIMARY + ACCENT — different faces, different sizes, and the
//      large one goes wherever the typography says it goes, above or below.
// ⚠️ HEBREW: of the four, ONLY DejaVu has Hebrew glyphs. `fontCovers()` checks every character before
// a face is used and falls back to DejaVu, so a Hebrew caption can never come back as empty boxes.
// This is separate from the open bug where a Hebrew caption does not reach the file at all — that one
// still needs the `lettering:` log line to settle, and v72 does not claim to fix it.
// ⚠️ DEPLOY NOTE: Vercel's tracer prunes .ttf files it cannot see being used — that is what killed the
// captions once already (v47). vercel.json must force-include the new fonts as well as DejaVu, and
// package.json needs the three new dependencies. If either is missing the code still runs: every face
// falls back to DejaVu and the caption is drawn exactly as in v71.
// api/reimagine.js — "עיצוב מחדש" v71
// v71 change: ON A ONE-INK DESIGN, A LIGHT FILL IS NOT A COLOUR — IT IS THE SHIRT.
// v70 is confirmed: "I love you" came back perfectly formed, every letter clean. That problem is closed.
// What the same run exposed is the third sighting of the cream fill. The palette said "black ink,
// single colour" and both cups came back filled beige. On a white shirt those bodies nearly vanish and
// only the outlines and the hearts print — a print defect, not a matter of taste.
// forceSolidInk could not help, and correctly so: v61 made it leave LARGE light regions alone, because
// flooding them with ink would turn an outlined cup into a black silhouette. That reasoning was right
// about what NOT to do and wrong about what to do instead. In a genuine one-ink print there are only
// two states — ink, or the garment showing through. A large pale field is the second one. So it should
// become TRANSPARENT, not beige and not black. The shirt then shows through exactly as it does in the
// reference, on a white shirt AND on a dark one.
// This is the third state the pass was missing, and it completes it:
//   small light pocket enclosed by ink  -> fill with ink   (erosion/speckle, v61)
//   anything else light                 -> make transparent (v71, the garment)
//   everything darker                   -> full-strength ink (v61)
// Scope is unchanged and still tight: monochrome palettes only, never on artwork that is actually
// multi-coloured, and never on a distressed/vintage/halftone brief. It runs BEFORE invertArtwork, so
// "white print on a dark shirt" still works. Reversible with CLEAR_LIGHT_FILLS.
// api/reimagine.js — "עיצוב מחדש" v70
// v70 change: THE SERVER DRAWS THE LETTERING AGAIN. His decision, taken with the trade-off in front
// of him, and it closes a failure the gate could not.
// The 07:46 run asked for "Always Need Tea" and the model drew "A", "N ed" and "Tea" — the first two
// words shredded. The artwork itself was excellent: solid black, clean heart, no fragments. And the
// gate passed it: no notice reached him, so the LETTERING check answered "ok" on lettering that is
// plainly broken. That is the THIRD time broken type has walked through that check (07:35 fragments,
// 00:27 duplicated word, now this), and it is why v70 does not tighten it again. A vision model
// verifying letterforms is not a reliable foundation, and no amount of rewording that question makes
// it one.
// The server path draws the caption with opentype.js from a real font file. Letters drawn from glyph
// outlines by code CANNOT come out malformed — not sometimes, not on a bad seed. The cost, which he
// accepted: the type is the server's font under the artwork, not the reference's brush script woven
// through it. On lettering-led designs like this one that trade is worth it; on illustration-led ones
// like the bear, the model's script was genuinely good and this is a loss.
// Two flags do it, and BOTH are needed — flipping only the first leaves short strings with the model,
// which is exactly the case that failed here ("Always Need Tea" is 13 characters, under SERVER_TEXT_MAX):
//   EDIT_LETTERING_ENABLED = false  -> the edit path stops keeping the design's own type
//   SERVER_DRAWS_ALL_LETTERING      -> needsServerText() is true for ANY wording, not just long or Hebrew
// TO GO BACK, or to make this per-design later: set SERVER_DRAWS_ALL_LETTERING to false and
// EDIT_LETTERING_ENABLED to true. Nothing else was touched, so that returns v69 exactly. SERVER_TEXT_MAX
// and the v54 rules are still in the file as the record of what was tried.
// api/reimagine.js — "עיצוב מחדש" v69
// v69 change: TORN BLACK FRAGMENTS IN THE CORNERS, AND THE ARTWORK SHRUNK TO NOTHING. One cause.
// The 07:35 "i love you" run delivered a file with a black blob cut off at the top-left corner and two
// black streaks cut off at the left and right edges — leftovers from a generation that filled its frame,
// which birefnet kept because they are large and solid. dropSpecks() could not touch them: it is
// deliberately timid (under 0.12% of the canvas AND under 2% of the main piece) so that a campfire or a
// tent is never deleted, and these fragments are far bigger than that.
// The second symptom has the same cause. toPrintCanvas() trims to the bounding box of everything that
// survived, so three fragments pinned to three different edges stretch that box across the whole frame
// and the real artwork gets scaled down to a small island in the middle with huge empty margins. Fix the
// fragments and the size fixes itself.
// dropEdgeStrays() adds a second rule alongside dropSpecks, and every condition is a safety catch:
//   - the piece must be DETACHED from the core (the main piece plus anything at least a tenth its size,
//     so a design made of several real parts keeps all of them)
//   - it must sit clear of the core by a real gap, not merely be a separate outline beside it
//   - it must be a minority of the main artwork
//   - and it must TOUCH THE CANVAS EDGE. That is the discriminating signal: a deliberate element sits
//     inside the composition, while a leftover from a full-bleed draw is cut off by the frame.
// A legitimately isolated element that does not run off the edge is therefore never dropped, and if the
// pass fails for any reason the artwork is kept exactly as it was.
// api/reimagine.js — "עיצוב מחדש" v68
// v68 change: STOP TUNING PROMPTS. THE ANALYSER AND THE GATE WERE WORKING AGAINST EACH OTHER.
// He said, fairly, that a thousand attempts is not funny any more. He is right, and the reason is not
// that the model is stubborn — it is that two parts of THIS file disagree, and I kept trying to fix the
// disagreement by rewording one of them.
// The analyser is TOLD to keep the design on the same shelf, so on "Go Outside / WORST CASE SCENARIO /
// A Bear Kills You" it keeps "Worst Case Scenario" — that phrase IS the joke format. GATE 2 then asks
// whether the artwork shows "any of the original wording, or wording that is clearly the same phrase",
// sees it, and refuses. Both are behaving exactly as specified. Every collision costs him a full
// generation, a 20-second wait and a message that does not say WHICH words were the problem — and every
// press of "analyse" reseeds the wording, so the trap re-arms itself.
// So the check moves to where it is cheap and fixable: BEFORE generating, in CODE.
// `sharedWording()` compares the reference's wording (GATE 1 already read it, before any credit is
// spent) against the wording the design is about to show. Shared content words and shared phrases are
// found deterministically — no model, no judgement, no variance. On a hit the request stops immediately
// with 409 and a Hebrew message that NAMES the offending words, so he edits one field and runs again,
// instead of paying for a generation that was doomed before it started.
// Deliberately NOT done: silently rewriting his words. They are his design decision; the tool's job is
// to tell him what will fail and why, not to overrule him.
// GATE 2 keeps its own check — it must, because the model can still draw the old words even when the
// spec is clean. This is a cheap early exit in front of it, not a replacement for it.
// api/reimagine.js — "עיצוב מחדש" v67
// v67 change: A LETTERING RETRY NO LONGER REDRAWS THE WHOLE DESIGN. One change.
// v66 worked exactly as intended — the widened LETTERING question caught a broken result, fired the
// retry it already owned, and told him instead of delivering in silence. But the 00:32 result showed
// what the retry itself costs: a clean raccoon with "Go Hiking" and NOTHING else. No pine trees, no
// tent, the campfire reduced to a few sticks. The first attempt had all of them.
// Cause, straight from the code rather than guessed: the retry called editFromSpec(specUsed, reference)
// — it goes back to the ORIGINAL REFERENCE and draws a completely new design from scratch, discarding
// a first attempt whose only fault was its words. Everything else in that attempt is collateral.
// So when the ONLY complaint is lettering (no copy verdict, no print defect), the retry now edits THE
// FIRST ATTEMPT instead of the reference, with an instruction that changes nothing but the words. The
// scenery survives by construction rather than by asking for it — the same reason forceSolidInk works
// where five versions of asking did not.
// The log also corrected something I had told him: at 00:19 I called the missing "You" a defect. It was
// not. His text field reads "Go Hiking / A Cougar Gets" with no "You" — the tool drew exactly what he
// asked. "You" bleeds in from the reference's own "A Bear Kills You", which is why the fix instruction
// here names the reference's wording (refWording was already threaded in for the hardened retry) and
// tells the model to remove those words specifically.
// Unchanged: the edit instruction, both gates, forceSolidInk, and the accept rule — a retry is still
// only kept when worth() says it is genuinely better, otherwise the first attempt stands.
// api/reimagine.js — "עיצוב מחדש" v66
// v66 change: THE LETTERING CHECK COULD NOT SEE THE THING THAT WAS WRONG. One change, in the GATE.
// v65 is confirmed: bear -> gray wolf, the first real subject swap on this reference. The clause stays.
// What that run exposed is a hole in GATE 2, not a new prompt problem. The artwork read
// "Go Hiking" arched across the top with "A Cougar Gets" crammed into the same arc and overlapping it,
// and "A You    You" along the bottom — the last word drawn TWICE and the middle phrase displaced.
// The gate's LETTERING question asks only whether "EVERY word is present and spelled exactly right".
// Every word WAS present and spelled right; there was simply an extra one, in the wrong place. So the
// check answered "ok", the retry it already owns never fired, and a broken design was delivered.
// The previous run had the mirror-image version of the same blind spot: the final word "You" MISSING
// and two orphan letters ("g", "ts") floating loose under the arc. Neither is a spelling fault either.
// So the LETTERING question now also reports: a word drawn more than once, letters or fragments not
// part of any word, and lettering that overlaps other lettering or the artwork badly enough to hurt
// legibility. All three feed the retry that already exists (worth() scores lettering at 2, above a
// print defect), and the existing behaviour on failure is unchanged: never a refusal, just the Hebrew
// notice telling him to run it again. The edit instruction is NOT touched, so this cannot move the copy
// verdict that cost five runs earlier tonight.
// api/reimagine.js — "עיצוב מחדש" v65
// v65 change: ONE CLAUSE BACK, and only one. This is the promised way of working after v61 shipped six
// at once and cost four rounds of guessing.
// First: the five refusals were never the code. The 00:19 run passed with the SAME v64 prompt, and the
// only thing he changed was the text field. The reference reads "Go Outside / WORST CASE SCENARIO /
// A Bear Kills You" and the analyser kept "Worst Case Scenario" verbatim in the new wording, because
// that phrase IS the joke format. GATE 2 asks whether the artwork shows "any of the original wording,
// or wording that is clearly the same phrase" — so it answered yes, correctly by its own definition and
// wrongly for what he wants. Changing the wording to "Go Hiking / A Cougar Gets You" passed first try.
// The defect this version addresses is the worst one in that passing result: the caption says A COUGAR
// and the animal is still the reference's grizzly, same upright pose, same beer bottle. The subject
// swap simply did not happen — the same additive/no-op habit that left the coffee cup beside its
// replacement. v60's subject line ends with "Same size, same pose, same position in the layout", which
// is three preservation demands and nothing at all insisting the original animal LEAVE.
// So the one clause returning is the REPLACEMENT clause, and it is chosen deliberately: it is about
// what must CHANGE, not what must be kept, so it cannot push the result toward the copy verdict that
// GATE 2 refuses. Every other v61 clause stays out until this one is judged.
// NOT touched, and next in line once this is judged: the sunset disc (sighting six, now with white
// stripes inside it that the cut-out will tear into holes), the dropped final word "You" with two
// orphan letters left floating, and the gate's shared-phrase false positive — the refusal message could
// name the offending words instead of leaving him to guess, which would have saved five runs tonight.
// api/reimagine.js — "עיצוב מחדש" v64
// v64 change: I UNDO MY OWN PROMPT WORK. FOUR REFUSALS, NOTHING DELIVERED.
// v60 delivered. v61, v62 and v63 each refused, and the fourth refusal came on an ILLUSTRATION-led
// reference (the bear), which kills the theory that this was about text-heavy designs.
// Counting what my own edits did to editInstruction, the answer is plain. v61 added: the palette
// verbatim, a one-ink clause, the technique verbatim, a layout lock, "same size, same pose, same
// position" on the subject, and "the SAME STROKE WEIGHT as the reference" on the lettering. v63 added
// "exactly as many separate pieces of lettering as the reference has, in the same places". Stacked on
// clauses that already said keep the typeface, weight, curve, size, colour and position, and KEEP ALL
// of the elements in the same place at the same size, the prompt now says: keep the colours, keep the
// technique, keep the arrangement, keep every element, keep the typography — change the character and
// the letters. That is a description of a copy, and the gate is right to call it one.
// v62 softened ONE of those clauses and left five in place, which is why it did not help.
// So the prompt goes back to exactly what it was in v60, which is the last version known to deliver:
//   - the whole v61 style-lock block is gone (palette, one-ink, technique, layout)
//   - the subject clause goes back to the v60 wording
//   - the lettering clause goes back to the v60 wording (no stroke-weight demand, no word ban, no
//     lettering-count clause)
// KEPT, because neither can make a result MORE like the original:
//   - forceSolidInk(), the deterministic full-strength ink pass. This is the one thing that actually
//     answers "הכיתוב חסר צבע", and it runs after the gate has already passed, so it can never cause a
//     refusal. It has still never run: every attempt since it shipped was refused before delivery.
//   - the hardened RETRY quoting the original wording (v63), which only fires after the gate has
//     already caught a copy.
// WHAT THIS COSTS, said plainly rather than hidden: the palette and technique are no longer stated to
// the model, so the grey-shaded-cup complaint is back to being asked for rather than enforced, and
// thin strokes stay thin. forceSolidInk still fixes the colour strength and the eroded holes on
// single-ink designs.
// HOW TO ADD ANY OF IT BACK: one clause at a time, testing after each. That is the only way to learn
// which one trips the gate, and it is what I should have done instead of shipping six clauses at once.
// api/reimagine.js — "עיצוב מחדש" v63
// v63 change: THE OLD WORDS WERE NEVER NAMED TO THE MODEL. Read off a real log, not guessed.
// Three refusals in a row on the "But First Coffee" reference. The 23:54 log settles what happened:
//     artwork gate: reused=true protected="" lettering="" defects=""
//     one hardened retry - artwork came back as a copy
//     retry no better - keeping the first attempt
//     REFUSED - output is a copy: original wording reused
// `lettering=""` means the NEW wording was present and spelled correctly. `reused=true` means the OLD
// wording was on the canvas as well. So the design carried BOTH — and that is not a spelling problem
// or a style problem, it is the SAME additive behaviour already seen when the reference's coffee cup
// survived beside its replacement: an edit model ADDS rather than SUBSTITUTES.
// And here is what every version from v51 to v62 missed: the prompt has never told the model WHAT the
// old words are. v62 says "NONE of the reference's original words may appear" — an abstract ban on a
// string the model was never handed. The server has known that string all along: GATE 1 reads it into
// `refWording` before a credit is spent, and it was used ONLY to judge the result afterwards, never to
// prevent it. v58 proved the principle in the other direction — naming the pine trees got them drawn.
// So:
//   1. `refWording` is now passed into editInstruction and the old words are QUOTED in the prompt, next
//      to the new ones, as the thing being replaced.
//   2. The hardened retry quotes them too, instead of saying "any of the original wording".
//   3. One more clause against the additive habit: the number of separate lettering elements stays the
//      same as the reference — the letters inside them change, no new block of lettering is added.
// Nothing else moves. The v61 palette/technique lock and forceSolidInk are untouched, and so is the
// gate: if this fails, the run is still refused rather than delivered.
// api/reimagine.js — "עיצוב מחדש" v62
// v62 change: v61's LAYOUT LOCK PUSHED THE RESULT INTO THE COPYRIGHT GATE. My regression, found in two
// runs on the same reference within minutes of shipping it.
// v61 added "Keep the existing layout exactly: the same overall shape and proportions, each thing in
// the same place and at the same relative size, and the same margins" — on top of a lettering clause
// already saying to keep the typeface, weight, curve, size, colour and position. Read together, that is
// an instruction to preserve almost everything, and an edit model told to preserve almost everything
// preserves the WORDS too. Both runs came back carrying the reference's own wording, GATE 2 caught them
// and refused delivery. The gate did exactly its job; the prompt was the problem.
// The lesson is the one this file keeps relearning, now for the seventh time (v34, v38, v39, v40, v42,
// v43, and this): a new rule does not land in isolation. It lands ON TOP of every rule already there,
// and the sum can say something none of them says alone. Before adding a preservation instruction,
// read the preservation instructions already in the prompt as one paragraph.
// So the layout clause now says what it was meant to say — keep the ARRANGEMENT — and every clause that
// asks to preserve something now carries the counterweight: the character and the words are what
// CHANGE, and the reference's wording may never appear in the output. Everything else from v61 stands.
// The palette/technique lock is untouched (it is about style, not content, and cannot cause a copy),
// and forceSolidInk is post-processing that runs after the gate, so it is untouched too.
// api/reimagine.js — "עיצוב מחדש" v61
// v61 change: THE SINGLE-INK DESIGNS COME BACK WEAK, AND ASKING NICELY HAS NOT FIXED IT.
// Reviewed pair, 19 Aug: a pure-black "But First Coffee" reference came back with a grey-green shaded
// cup, a distressed serif eroded with white speckle inside the strokes, and script noticeably thinner
// than the source. His words: "הכיתוב לא חזק כמו המקור חסר צבע".
// The spec was RIGHT on every field — palette "single colour", technique "no shading; clean outlines,
// solid fill areas", composition "lettering dominates lower two-thirds". The analyser is not the
// problem and there is no rule collision here. The edit instruction simply says "the same colours,
// the same drawing style" and the model draws in its own house style anyway.
// So this version does two different things, and the difference matters:
//   1. A STYLE LOCK in editInstruction — the palette and the technique are now stated VERBATIM instead
//      of gestured at, the layout is named as something to preserve, the replaced character must LEAVE
//      the canvas rather than sit beside its replacement, and the lettering is asked for at the
//      reference's own stroke weight, filled solid. This raises the odds. It guarantees nothing —
//      the backdrop disc has been banned in six wordings across five versions and still appears.
//   2. forceSolidInk() — CODE, not a request, and the reason this version is worth deploying. When the
//      palette says the design is a single ink, every ink pixel is snapped to full strength and the
//      white speckle eroded inside strokes is filled. Grey, washed strokes and distress holes cannot
//      survive it, because nothing is being asked of a model.
// What it deliberately does NOT do, so the next person does not "improve" it into a disaster:
//   - It runs ONLY on a genuinely monochrome palette (paletteIsMonochrome, which is STRICTER than
//     paletteIsLimited — two-colour and duotone are excluded, since collapsing two inks onto one
//     destroys the design).
//   - It refuses on any artwork that is actually multi-coloured, whatever the palette claims.
//   - It leaves LARGE light regions alone. A pale cup body is an unfilled shape, and flooding it with
//     ink would turn an outlined drawing into a silhouette. Only small enclosed pockets are filled.
//   - It deepens the ink colour only when the palette NAMES a black/charcoal ink. A single-colour
//     design in dusty rose stays dusty rose.
//   - It runs BEFORE the monolight inversion, so "white print on a dark shirt" still works.
// v60 change: THE MODEL DRAWS THE LETTERING NOW. His call, and the right one.
// On these references the lettering IS the design — "LOVE" in outlined pink caps beside the bear,
// "you" handwritten across it, "FOR NO REASON" below. Replacing all of that with black DejaVu Sans in
// a band under the artwork produces something that reads as an illustration with a label stuck on,
// never as a shirt, and he said plainly he cannot sell it. That server caption has been the ceiling on
// this whole tool since v44, and no amount of fixing around it raises the ceiling.
// The v54 window (14 characters, no script faces) was fitted to ONE good example and was sending work
// to the server that the model actually handles: "Add Your Art Here" came back as clean filled script
// at 16 characters, and "CRAZY about YOU for every REASON" was never even attempted. So the window is
// gone — with a reference, the model always draws the words.
// What makes that safe is that the v57 output gate now READS THE RESULT: every word present, every
// word spelled right. Wrong spelling earns one hardened retry, and if it is still wrong the design is
// delivered with a Hebrew notice telling him to run it again — never a silent shipment of gibberish,
// and never a refusal, because the artwork may still be exactly what he wants.
// Hebrew is the one hard exception and stays with the server: no image model draws it legibly.
// EDIT_TEXT_MAX and FRAGILE_TYPE_RE are kept, unused, as the record of what v54 assumed.
// v59 change: the last three defects on the list, then the tool goes to work.
// 1. EVERY ANIMAL BECAME A MOOSE. Not a model failure — the analyser was told to pick "a DIFFERENT
//    ANIMAL of similar size and appeal", and for a North American campfire scene that lands on the
//    same two or three every time. It is now told the animal only has to fit the pose and the setting,
//    given concrete less-obvious options, and asked for the choice a designer would reach for THIRD.
// 2. WHITE FILLS TEAR HOLES. A variation drew the retro sunburst with WHITE stripes; white is the
//    background here, so the cut-out opened gaps straight through the trees and the campfire. The
//    edit instruction now says where the reference uses white, use a light tint of the design’s own
//    colours — and says it covers stripes, rays and highlights, not just fills.
// 3. THE BACKDROP DISC, SIGHTING FIVE. Banned in the negative since v19 and in the edit instruction
//    since v51, and a striped sunburst appeared behind the moose anyway. Naming the exact shapes that
//    keep turning up beats the category word, so disc/circle/sun/sunburst/striped semicircle/halo are
//    now all named.
// AND, because prompts alone have not held on 2 and 3 for five versions, the v57 output gate now also
// reports these two as DEFECTS and fires the retry it already had. A defect is a quality problem, not
// a legal one, so it is worth one retry and NEVER a refusal: if the second attempt is no better, the
// first is delivered exactly as before. The gate costs nothing extra — it is the same single call.
// v58 change: three defects from the two moose runs of 19 Aug, all read off real output.
// 1. NAMED ELEMENTS WERE NOT DRAWN — fourth sighting. The spec listed "pine trees, camping tent,
//    campfire, wilderness ground line" and the result was the animal alone on an empty canvas. The
//    only thing asking for them was "keeps the same surrounding elements" in the edit instruction —
//    implied, never named. editInstruction now lists them explicitly and says none may be dropped.
// 2. THE CAPTION LOST ITS SHAPE. These jokes are written "Go Hiking / Worst Case Scenario / A Moose
//    Stomps You" and the source sets them as three lines; v56 treated "/" as an ordinary word and ran
//    them into one sentence. A "/" is the author’s own line break, so it now decides the lines
//    whenever the result still fits and stays legible.
// 3. A STRAY BROWN FRAGMENT floated beside the animal’s leg in both runs — a piece of an element the
//    model began and abandoned, which prints as an unexplained smudge. dropSpecks() removes
//    disconnected fragments, and is deliberately timid: a design legitimately contains separate pieces
//    (a campfire, a tent, stars), and deleting one of those is far worse than leaving a smudge, so a
//    fragment goes only when it is tiny in absolute terms AND negligible against the main artwork.
// v57 change: TWO GATES — ON THE REFERENCE, AND ON THE RESULT.
// A run on 18 Aug returned the source design essentially untouched: the same arched "Go Outside", the
// same "WORST CASE SCENARIO", the same bear, the same "A Bear Kills You" — a print-ready 300 DPI copy
// of another shop’s product with our new caption pasted underneath. Minutes earlier the SAME reference
// had produced a good, original result. That is the nature of an edit model told to keep everything and
// change a little: sometimes it changes nothing, and no prompt wording makes that impossible.
// Every other defect in this file is a quality problem. This one is a file he cannot legally hold, so
// it is the only one enforced in code rather than asked for in a prompt:
//   GATE 1, on the reference, before a single fal credit is spent — one vision call now answers all
//   three questions at once (graphic box, the wording it carries, whether it is someone else’s
//   property), so it costs no more than the box call v55 already made. Brand marks, real book/film
//   titles, copyrighted characters, artist signatures and photos of identifiable people are refused.
//   GATE 2, on the produced artwork, before it is delivered — does it still carry the original wording,
//   or any logo or signature? One hardened retry, and if it is still a copy the run is refused and NOT
//   charged. A refusal he can read beats a print-ready copy of someone else’s product.
// Both gates FAIL OPEN: an unreadable answer, a 500 or a network error never blocks a legitimate run.
// v56 change: THE CAPTION BUG, FOUND AND FIXED AT ITS ROOT. It was never the line layout.
// opentype.js rounds path coordinates with string arithmetic:
//     roundDecimal(f, p) => +(Math.round(f + "e+" + p) + "e-" + p)
// so any coordinate whose String() is exponential — anything under 1e-6, which is what a
// floating-point "zero" looks like — becomes "3.55e-15e+2", and Math.round of that is NaN. librsvg
// then silently abandons the REST of that <path>, so the words after it disappear at raster time.
// That is why only LONG captions broke: a long line is nearly as wide as its box, centring puts its x
// at almost exactly 0, and the near-zero coordinates that follow are the ones that serialise in
// exponential form. Short captions never come near it, which is why this looked like a length problem
// for four versions. Measured on the bear caption: 287598 ink px before, 577822 after — the second
// line was simply not being drawn. Glyph outlines are now serialised by pathDataOf()/num() here,
// using toFixed, and renderTextLayer refuses to ship a caption whose path data is not finite.
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
/* ---- v73: WHICH ENGINE DRAWS THE DESIGN ----
   false = the 16 August behaviour he asked to have back: flux draws from the spec and never sees his
   image. true = the v51..v72 edit path, where nano-banana redraws his actual reference.
   The flux path has always been present as the fallback, so this genuinely is one switch. */
const USE_EDIT_PATH = false;

/* v73: with flux drawing again, v45's lettering rule is the right one — flux weaves short Latin
   lettering into the design far better than a caption set underneath, and only loses on Hebrew (which
   it cannot draw at all) and on long strings (which it misspells). Setting BOTH of these the other way
   (false / true) restores v70's "the server draws every caption". */
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

/* v60: THE WINDOW IS OPEN. His call, and the right one: the server caption is a hard ceiling on the
   whole tool. On these references the lettering IS the design — "LOVE" in outlined pink caps beside
   the bear, "you" handwritten across it, "FOR NO REASON" below — and replacing all of that with black
   DejaVu Sans under the artwork produces something that reads as an illustration with a label stuck
   on, never as a shirt. He said plainly he cannot sell that.
   The v54 rules (14 characters, no script faces) were fitted to ONE successful example and they were
   sending work to the server that the model handles well: "Add Your Art Here" came back as clean
   filled script at 16 characters, and "CRAZY about YOU for every REASON" was never even attempted.
   So on the edit path the model now always draws the lettering. What makes that safe is that the v57
   output gate reads the result: if the words come back misspelled or missing, one hardened retry, and
   the run is delivered with a notice rather than silently shipping gibberish.
   Hebrew is the one hard exception — no image model draws it legibly, so it stays with the server.
   EDIT_TEXT_MAX and FRAGILE_TYPE_RE are kept, unused, as the record of what v54 assumed. */
function editCanKeepLettering(spec) {
  const t = String(spec.text || "").trim();
  if (!t) return true;                                   // nothing to draw either way
  /* v70: order matters — a WORDLESS design must answer true here and skip the flux preparation
     entirely, exactly as it did before. The switch only governs designs that actually carry words. */
  if (!EDIT_LETTERING_ENABLED) return false;
  if (HEBREW_RE.test(t)) return false;                   // no image model draws Hebrew legibly
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

/* ---------------- v77: one provider layer for every language/vision call ----------------
   Every LLM call in this file asked Anthropic directly and each one had its own copy of the request.
   They now go through here, so the provider is one decision in one place.
   `LLM_PROVIDER` is read from the environment on purpose — flipping it back to "anthropic" in Vercel
   is a settings change, not a deploy. */
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "fal").toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
/* v78: fal's router rejected the id I guessed and named what it had tried, so the id is discovered
   rather than assumed. Set FAL_LLM_MODEL to pin one and skip the search. */
const FAL_MODEL_PIN = process.env.FAL_LLM_MODEL || "";

/* Ordered by preference: the same model family as before first, so a success keeps the analysis
   identical and only moves the bill; capable general vision models after that. */
/* v79: copied from fal's own validation error, which lists every id it accepts. Newest Claude first —
   a success there keeps the analysis closest to what has been proven all week — then the older Claudes,
   then Gemini. Note that a listed id can still be unavailable to this account (3.5-sonnet was), which
   is why this is a search and not a single value. */
const FAL_VISION_CANDIDATES = [
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-pro-1.5",
  "google/gemini-flash-1.5",
  "anthropic/claude-haiku-4.5",
];
/* Rewording and translating are cheap text jobs — the small fast models are the right default here,
   and the big ones are only the fallback. */
const FAL_TEXT_CANDIDATES = [
  "anthropic/claude-haiku-4.5",
  "google/gemini-flash-1.5",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-pro-1.5",
];

/* Remembered per lambda: the search runs once, not on every call. */
let _falVisionModel = null;
let _falTextModel = null;

/* Only an unknown-model answer is worth trying the next candidate for. A bad key, a rate limit or a
   malformed request means every candidate will fail the same way, and walking the list would just turn
   one clear error into six. */
function looksLikeUnknownModel(status, body) {
  const b = body || "";
  if (status === 404 || /no endpoints found|model not found|unknown model/i.test(b)) return true;
  /* v79: fal rejects a bad model id with 422 and a literal_error on the "model" field, and lists the
     ids it accepts. That IS an unknown model, so walk on. A 422 about any other field is a real
     validation failure and must still stop — hence both conditions, not just the status. */
  if (status === 422 && /literal_error/i.test(b) && /"model"/.test(b)) return true;
  return false;
}

async function askAnthropic({ system, ask, image, mediaType, maxTokens }) {
  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: mediaType, data: image } },
       { type: "text", text: ask }]
    : [{ type: "text", text: ask }];

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens || 200,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) {
    console.error("[reimagine] anthropic call failed:", r.status, (await r.text()).slice(0, 400));
    return null;
  }
  const d = await r.json();
  return (d?.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
}

/* fal returns a different envelope for every model family, and I could not confirm this one's shape
   from the build environment. So read the field if it is one of the obvious ones, and if it is not,
   print the keys that DID come back — the first real run then tells us exactly what to read instead of
   failing with nothing to go on. */
function readFalText(d) {
  const cand = d?.output ?? d?.text ?? d?.response ?? d?.content ?? d?.message ?? d?.completion;
  if (typeof cand === "string" && cand.trim()) return cand.trim();
  if (Array.isArray(cand)) {
    const joined = cand
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .filter(Boolean).join(" ").trim();
    if (joined) return joined;
  }
  const choice = d?.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice.trim();
  console.error(
    "[reimagine] fal LLM: could not find the text in the response. Top-level keys were:",
    JSON.stringify(Object.keys(d || {}))
  );
  return null;
}

async function askFal({ system, ask, image, mediaType, maxTokens }) {
  const endpoint = image ? "fal-ai/any-llm/vision" : "fal-ai/any-llm";
  const remembered = image ? _falVisionModel : _falTextModel;
  const list = FAL_MODEL_PIN
    ? [FAL_MODEL_PIN]
    : remembered
      ? [remembered]
      : (image ? FAL_VISION_CANDIDATES : FAL_TEXT_CANDIDATES);

  let lastBody = "";
  for (const model of list) {
    const input = { model, prompt: ask, system_prompt: system, max_tokens: maxTokens || 200 };
    if (image) input.image_url = `data:${mediaType};base64,${image}`;

    const r = await fetch(`https://fal.run/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (r.ok) {
      const text = readFalText(await r.json());
      if (text) {
        if (!remembered && !FAL_MODEL_PIN) {
          if (image) _falVisionModel = model; else _falTextModel = model;
          console.log(`[reimagine] fal ${endpoint}: using "${model}" (pin it in FAL_LLM_MODEL to skip the search)`);
        }
        return text;
      }
      lastBody = "answered but no readable text";
      continue;                                   // shape problem, not a model problem - readFalText logged the keys
    }

    lastBody = (await r.text()).slice(0, 400);
    if (!looksLikeUnknownModel(r.status, lastBody)) {
      console.error(`[reimagine] fal ${endpoint} failed on "${model}":`, r.status, lastBody);
      return null;                                // a real failure - do not burn the rest of the list
    }
    console.warn(`[reimagine] fal ${endpoint}: "${model}" is not available here, trying the next one`);
  }

  console.error(`[reimagine] fal ${endpoint}: no candidate model worked. Last response:`, lastBody);
  return null;
}

/* The single entry point. Returns trimmed text, or null - every caller already handles null. */
async function askLLM(opts) {
  try {
    return LLM_PROVIDER === "anthropic" ? await askAnthropic(opts) : await askFal(opts);
  } catch (e) {
    console.error(`[reimagine] ${LLM_PROVIDER} call threw:`, e.message);
    return null;
  }
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
  /* v77: the legacy one-shot route goes through the provider layer too, so no path in this file
     can still bill Anthropic. Its instruction text is unchanged. */
  const raw = await askLLM({
    system: ANALYSIS_SYSTEM_PROMPT,
    ask: "If this is a photo of someone wearing a shirt, describe ONLY the graphic printed on the shirt and ignore the wearer entirely. Same subject category and rendering technique as that graphic - and if the graphic has several elements, carry across the MAIN figure (the creature or person), not the object it sits on - but a different pose and different details. Keep the reference's colour palette: if the graphic is one-colour ink, yours is that same single colour, lettering included - EXCEPT that nothing may be white or pale, because the background is white and would swallow it, so a white-on-black reference becomes deep dark ink on white. Every letter and shape is filled solid, never a hollow outline. Subject alone, no objects beside it, and absolutely no outline or stroke tracing the artwork. The reference is probably a full-bleed panel filled edge to edge - do NOT copy that shape; your design is one isolated subject floating on empty white with wide margins on every side, nothing touching an edge. Copy the drawing technique but NOT the surface it is drawn on — even if the reference sits on cream or textured stock, your design sits on pure white #FFFFFF and nothing else. Remember the STYLE: line first.",
    image: base64Data,
    mediaType,
    maxTokens: 450,
  });
  if (!raw) throw new Error("Analysis failed");

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
    parts.push(
      `Replace the main character with: ${spec.subject}. Same size, same pose, same position in the layout. ` +
      /* v65: the one clause returning from v61. It is about what CHANGES, so it cannot push the result
         toward the copy verdict. The 00:19 run captioned a COUGAR and drew the reference's grizzly. */
      `This is a REPLACEMENT and not an addition: the original character is gone from the design ` +
      `completely and appears nowhere in it, not beside the new one and not behind it. What stands ` +
      `there now is ${spec.subject} — a different creature, not the original one redrawn. If someone ` +
      `who knows the reference would still call it the same character, the change has not been made.`
    );
  }
  /* v58: NAME the supporting elements. "keep the same surrounding elements" was the only thing asking
     for them, and four reviewed runs came back with the main character alone on an empty canvas — the
     pine trees, tent and campfire simply not drawn. The spec already lists them, so say them out loud;
     a named thing is drawn far more reliably than an implied one. */
  if (spec.elements && spec.elements.length) {
    parts.push(
      `KEEP ALL OF THESE, drawn in the same place and at the same size as in the reference: ` +
      `${spec.elements.join(", ")}. Every one of them must appear in the new design. Do not drop any ` +
      `of them and do not leave the character alone on an empty background.`
    );
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
    "an edge. Nothing in the artwork may be white or near-white — white is cut away and leaves holes " +
    "in the print, so where the reference uses white, use a light tint of the design's own colours " +
    "instead. This applies to stripes, rays and highlights as much as to fills. " +
    /* v59: sighting five. The ban has been in the negative since v19 and in this instruction since
       v51, and a retro sunburst still appeared behind the moose. Naming the exact shapes that keep
       turning up works better than the category word alone. */
    "DRAW NO SHAPE BEHIND THE SUBJECT: no disc, no circle, no sun, no sunburst, no striped " +
    "semicircle, no halo, no badge, no panel, no rounded blob, no frame. Even if the reference has " +
    "one, leave it out — the elements float freely on an empty background."
  );
  return parts.join(" ");
}

/* v67: the lettering-only retry. Edits the FIRST ATTEMPT, not the reference, so the artwork that was
   already right cannot be lost while fixing the words. Used only when lettering is the sole complaint —
   a copy verdict or a print defect still needs a full redraw from the reference. */
async function fixLettering(attempt, spec, letteringNote, refWording) {
  const prompt =
    "This design is finished and correct EXCEPT for its lettering. " +
    "Change NOTHING else: every character, animal, object, tree, colour, position and size stays exactly " +
    "as it is. Do not redraw the scene, do not move anything, do not add or remove any element. " +
    `The lettering is the only thing you touch. The problem with it: ${letteringNote}. ` +
    `Redraw the wording so it reads EXACTLY "${spec.text}" — those words and no others, each word drawn ` +
    "once, every letter fully formed and filled solid, no loose letters left over. " +
    (refWording
      ? `Words from the original design keep creeping in: ${JSON.stringify(refWording)}. None of those ` +
        "words belong here — remove every one of them from the canvas. "
      : "") +
    "Keep the lettering in the same style and the same place as it is now, and give each line its own " +
    "space so no line overlaps another line or the artwork.";
  console.log(`[reimagine] lettering-only retry on the first attempt: ${letteringNote}`);
  return await fal("fal-ai/nano-banana/edit", {
    prompt,
    image_urls: [attempt],
    num_images: 1,
    output_format: "png",
  });
}

async function editFromSpec(spec, reference, harden, defectNote, letteringNote, refWording) {
  let prompt = editInstruction(spec);
  if (harden) {
    prompt +=
      " IMPORTANT: the previous attempt reproduced the original design almost unchanged. This is a NEW " +
      "design, not a copy. " +
      /* v63: name them. "any of the original wording" was abstract and two hardened retries failed. */
      (refWording
        ? `The words ${JSON.stringify(refWording)} appeared in the previous attempt. Remove them ` +
          `completely — every one of those words, everywhere on the canvas. `
        : "Do not reproduce ANY of the original wording. ") +
      "Do not draw any logo, brand name, signature or watermark. The main character must visibly " +
      "differ from the original.";
  }
  if (letteringNote) {
    prompt +=
      ` FIX THE LETTERING: the previous attempt had ${letteringNote}. Draw the words again, larger and ` +
      `cleaner, reading EXACTLY "${spec.text}" — every word present, every letter a real letter, ` +
      "fully formed and filled solid. " +
      /* v66: the three faults the gate can now see all need saying, not just spelling. */
      "The whole wording appears ONCE and once only: no word is drawn twice, and there are no loose " +
      "letters left over from another word. Give each line its own space — no line may sit on top of " +
      "another line or run into the artwork. " +
      "Keep the same lettering style and the same placement as the reference. Legibility matters more " +
      "than decoration: if a flourish makes a letter ambiguous, drop the flourish.";
  }
  if (defectNote) {
    prompt +=
      ` FIX THIS: the previous attempt had ${defectNote}. Draw NO shape behind the subject — no disc, ` +
      "no circle, no sun, no sunburst, no striped semicircle, no badge, no panel. The elements float " +
      "freely on empty background. And nothing in the artwork may be white or near-white: white is cut " +
      "away and leaves holes, so where you would use white, use a light tint of the design's own " +
      "colours instead.";
  }
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
const REF_INSPECT_SYSTEM = `You inspect a t-shirt design before it is remixed. Answer three questions.

The image is either a standalone artwork file, or a photo/mockup of someone WEARING a printed garment.

1. GRAPHIC — where is the printed artwork?
   If a garment or wearer is present, give the bounding box of the PRINTED GRAPHIC ONLY: not the shirt,
   not the person, not their hands, hair, jewellery or jeans, not the room. Draw it tightly around the
   artwork, including all of its lettering. If the image is already just the artwork, answer: full

2. WORDING — every word visible in the artwork, exactly as printed, separated by " | ".
   If there is no lettering, answer: none

3. PROTECTED — is any part of this artwork someone else's property? Answer with the specific reason, or
   the single word: none
   Say yes for: a company logo, brand name or wordmark (Nike, adidas, Puma, Disney, a swoosh, a trefoil);
   the title or author of a real published book, film, song or band; a recognisable copyrighted character;
   an artist's signature, watermark or studio mark; a photograph of a real identifiable person.
   Say none for: generic animals, objects, scenery, ordinary slogans and made-up phrases.

Answer with ONLY a JSON object, no prose, no markdown fences:
{"graphic":"x0,y0,x1,y1" or "full","wording":"..." or "none","protected":"..." or "none"}

where the box values are whole numbers 0-100, percentages of the image width or height, x0,y0 top-left
and x1,y1 bottom-right.`;

async function claudeVision(system, base64Data, mediaType, ask, maxTokens) {
  /* v77: kept its name and signature so the two gates are untouched; the provider decision lives in
     askLLM now. */
  return await askLLM({ system, ask, image: base64Data, mediaType, maxTokens: maxTokens || 200 });
}

function parseJsonish(raw) {
  if (!raw) return null;
  const s = raw.replace(/```json/gi, "").replace(/```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function parseBox(v) {
  if (!v || /^full$/i.test(String(v).trim())) return null;
  const nums = String(v).match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (!nums) return null;
  const [x0, y0, x1, y1] = nums.slice(1, 5).map(Number);
  if (!(x1 > x0 && y1 > y0 && x1 <= 100 && y1 <= 100)) return null;
  return { x0, y0, x1, y1 };
}

const NONE_RE = /^\s*(none|no|n\/a|-)\s*$/i;

/* v57: ONE call on the reference answers all three questions, so this costs no more than the single
   box call v55 already made. Returns {box, wording, protected} and never throws — on any failure the
   run proceeds exactly as it would have before, with no crop and no gate. */
async function inspectReference(dataUri) {
  const m = String(dataUri || "").match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return { box: null, wording: "", protected: "" };
  try {
    const raw = await claudeVision(REF_INSPECT_SYSTEM, m[2], m[1], "Inspect this design. JSON only.", 300);
    const j = parseJsonish(raw);
    if (!j) {
      console.warn("[reimagine] reference inspect unreadable, continuing without it:", String(raw).slice(0, 90));
      return { box: null, wording: "", protected: "" };
    }
    const box = parseBox(j.graphic);
    const wording = NONE_RE.test(String(j.wording || "")) ? "" : String(j.wording || "").trim();
    const prot = NONE_RE.test(String(j.protected || "")) ? "" : String(j.protected || "").trim();
    console.log(
      `[reimagine] reference: box=${box ? `${box.x0},${box.y0},${box.x1},${box.y1}` : "full"}` +
      ` wording=${JSON.stringify(wording.slice(0, 70))} protected=${JSON.stringify(prot.slice(0, 70))}`
    );
    return { box, wording, protected: prot };
  } catch (e) {
    console.warn("[reimagine] reference inspect failed, continuing without it:", e.message);
    return { box: null, wording: "", protected: "" };
  }
}

/* Crops the wearer away. Never throws: on any failure the original reference is returned. */
async function cropReferenceToGraphic(reference, box) {
  if (!box) return reference;
  if (!/^data:image\//.test(String(reference || ""))) return reference;
  try {
    return await cropToGraphic(reference, box);
  } catch (e) {
    console.warn("[reimagine] graphic crop failed, using the full reference:", e.message);
    return reference;
  }
}

/* ---- v57: THE OUTPUT GATE ----
   A run on 18 Aug returned the reference design essentially unchanged: the same arched "Go Outside",
   the same "WORST CASE SCENARIO", the same bear, the same "A Bear Kills You" — a print-ready 300 DPI
   copy of another shop's product, with our new caption pasted underneath it. Every other defect in
   this file is a quality problem; that one is a file he cannot legally hold, and it came from the same
   reference that had produced a good result minutes earlier. An edit model asked to "keep everything
   and change a little" will sometimes change nothing, and no prompt wording makes that impossible.
   So the OUTPUT is checked before it is delivered, not just the input. */
const ART_INSPECT_SYSTEM = `You are checking a newly generated t-shirt artwork before it is delivered.

You will be told which words appeared on the ORIGINAL design this was derived from.

Answer two questions about the artwork you are shown:

1. REUSED — does it display any of the original wording, or wording that is clearly the same phrase?
   Answer yes or no. Ignore small differences in case or punctuation.
2. PROTECTED — does it display a company logo, brand name or wordmark, the title or author of a real
   published work, a recognisable copyrighted character, or an artist's signature or watermark?
   Answer with the specific reason, or the single word: none
3. LETTERING — you will be told the wording this design is supposed to show.
   If it is supposed to show wording, answer "ok" only when ALL of these are true:
   - every word is present and spelled exactly right
   - NO word is drawn more than once anywhere on the canvas
   - there are no loose letters or fragments that are not part of one of those words
   - no piece of lettering overlaps other lettering, or the artwork, badly enough to be hard to read
   Answer with the specific problem otherwise, naming the word: a misspelling, a missing word, a word
   repeated twice, stray letters, or lettering that collides with other lettering.
   If the design is supposed to have no wording and has none, answer: ok
4. DEFECTS — this artwork will be printed on fabric, and anything white is cut away and becomes a hole.
   Report either of these, or the single word: none
   - a solid shape sitting BEHIND the subject: a disc, circle, sun, badge, panel or rounded blob,
     including a retro sunburst or striped semicircle
   - white or near-white areas INSIDE the artwork: white stripes, white rays, white fills, white gaps
   Do not report the empty background around the artwork — only shapes and fills within the design.

Answer with ONLY a JSON object, no prose, no markdown fences:
{"reused":"yes" or "no","protected":"..." or "none","lettering":"ok" or "...","defects":"..." or "none"}`;

async function inspectArtwork(artUrl, originalWording, wantedWording) {
  try {
    const buf = Buffer.from(await (await fetch(artUrl)).arrayBuffer());
    // downscale before sending: the check is about words and marks, not fine detail
    const small = await sharp(buf).flatten({ background: "#ffffff" })
      .resize(768, 768, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
    const ask =
      "The original design displayed this wording: " +
      (originalWording ? JSON.stringify(originalWording) : "(no lettering)") +
      ". This new design is supposed to show this wording: " +
      (wantedWording ? JSON.stringify(wantedWording) : "(no wording at all)") +
      ". Check the artwork. JSON only.";
    const j = parseJsonish(await claudeVision(ART_INSPECT_SYSTEM, small.toString("base64"), "image/jpeg", ask, 200));
    if (!j) return { reused: false, protected: "", defects: "", lettering: "" };
    const reused = /^yes$/i.test(String(j.reused || "").trim());
    const prot = NONE_RE.test(String(j.protected || "")) ? "" : String(j.protected || "").trim();
    const defects = NONE_RE.test(String(j.defects || "")) ? "" : String(j.defects || "").trim();
    const lv = String(j.lettering || "ok").trim();
    const lettering = /^(ok|none|fine|correct)$/i.test(lv) ? "" : lv;
    console.log(
      `[reimagine] artwork gate: reused=${reused} protected=${JSON.stringify(prot.slice(0, 70))}` +
      ` lettering=${JSON.stringify(lettering.slice(0, 70))} defects=${JSON.stringify(defects.slice(0, 70))}`
    );
    return { reused, protected: prot, defects, lettering };
  } catch (e) {
    // a failed check must not block a legitimate design
    console.warn("[reimagine] artwork gate failed, delivering anyway:", e.message);
    return { reused: false, protected: "", defects: "", lettering: "" };
  }
}

const IP_ERROR =
  "העיצוב שהועלה כולל סימן מסחרי, לוגו, דמות מוגנת או חתימת אמן. " +
  "הכלי לא מייצר עיצובים על בסיס חומר כזה — נסו עיצוב מקור אחר.";

/* ---- v68: the collision the analyser and the gate could never see between them ----
   Deterministic on purpose. A model deciding "is this too close" is what we already have downstream and
   it costs a generation to ask; this costs nothing and always gives the same answer.
   Stop words are excluded because "a", "the" and "is" are shared by half of all English slogans and
   mean nothing; what matters is a content word carried over, or any two-word phrase carried over. */
const WORDING_STOP = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "is", "it",
  "my", "your", "you", "i", "me", "we", "be", "am", "are", "was", "so", "if", "no", "not", "do",
]);

function wordingWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/* Returns the words and phrases the new wording carries over from the reference.
   Phrases are built as MAXIMAL RUNS in the order the new wording actually reads, so a three-word slogan
   comes back as "worst case scenario" and not as two overlapping pairs. */
function sharedWording(refWording, newWording) {
  const ref = wordingWords(refWording);
  const now = wordingWords(newWording);
  if (ref.length < 2 || !now.length) {
    if (!ref.length || !now.length) return { phrases: [], words: [] };
  }

  const refPairs = new Set();
  for (let i = 0; i < ref.length - 1; i++) refPairs.add(`${ref[i]} ${ref[i + 1]}`);

  // mark every position that takes part in a shared adjacent pair, then read off the runs
  const inPhrase = new Array(now.length).fill(false);
  for (let i = 0; i < now.length - 1; i++) {
    if (refPairs.has(`${now[i]} ${now[i + 1]}`)) { inPhrase[i] = true; inPhrase[i + 1] = true; }
  }
  const phrases = [];
  for (let i = 0; i < now.length; i++) {
    if (!inPhrase[i]) continue;
    let j = i;
    while (j + 1 < now.length && inPhrase[j + 1]) j++;
    /* trim stop words off the ENDS so the message reads "worst case scenario" and not
       "worst case scenario a" — the run is right, the trailing "a" is just noise to him. */
    let a = i, b = j;
    while (a < b && WORDING_STOP.has(now[a])) a++;
    while (b > a && WORDING_STOP.has(now[b])) b--;
    phrases.push(now.slice(a, b + 1).join(" "));
    i = j;
  }

  const refSet = new Set(ref.filter((w) => w.length > 2 && !WORDING_STOP.has(w)));
  const words = [...new Set(now.filter((w, i) => !inPhrase[i] && refSet.has(w)))];

  return { phrases, words };
}

function sharedWordingError(hit) {
  const list = [...hit.phrases, ...hit.words].map((w) => `"${w}"`).join(", ");
  return (
    `הטקסט שביקשתם מכיל ניסוח שמופיע גם בעיצוב המקור: ${list}. ` +
    "בדיקת ההעתקה תחסום את התוצאה בגלל זה, אז עצרנו לפני היצירה ולא נוצל קרדיט. " +
    "שנו את המילים האלה בשדה הטקסט ולחצו שוב על יצירה."
  );
}

const COPY_ERROR =
  "התוצאה יצאה קרובה מדי לעיצוב המקור וכללה את הניסוח המקורי, ולכן היא לא נמסרה. " +
  "נסו שוב, או שנו את הנושא והטקסט בטופס כדי להרחיק את התוצאה מהמקור.";

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

/* ---- v58: STRAY FRAGMENTS ----
   Two runs came back with a small brown blob floating beside the animal's leg — a piece of an element
   the model started and abandoned. On a transparent print file that prints as an unexplained smudge.
   This drops disconnected fragments, and it is deliberately TIMID: a design legitimately contains
   separate pieces (a campfire, a tent, stars, hatching), and deleting one of those would be far worse
   than leaving a smudge. So a fragment goes only when it is tiny in absolute terms AND negligible
   against the main artwork. Anything close to the line is kept. */
const SPECK_MAX_FRAC_OF_CANVAS = 0.0012;   // under ~0.12% of the frame
const SPECK_MAX_FRAC_OF_MAIN  = 0.02;      // and under 2% of the largest piece

async function dropSpecks(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const n = w * h;

  const on = new Uint8Array(n);
  for (let p = 0, i = 3; p < n; p++, i += ch) on[p] = data[i] > 128 ? 1 : 0;

  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes = [];
  for (let s = 0; s < n; s++) {
    if (!on[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let sp = 0, count = 0;
    label[s] = id; stack[sp++] = s;
    while (sp > 0) {
      const q = stack[--sp];
      count++;
      const x = q % w, y = (q / w) | 0;
      if (x > 0     && on[q - 1] && label[q - 1] === -1) { label[q - 1] = id; stack[sp++] = q - 1; }
      if (x < w - 1 && on[q + 1] && label[q + 1] === -1) { label[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0     && on[q - w] && label[q - w] === -1) { label[q - w] = id; stack[sp++] = q - w; }
      if (y < h - 1 && on[q + w] && label[q + w] === -1) { label[q + w] = id; stack[sp++] = q + w; }
    }
    sizes.push(count);
  }
  if (sizes.length < 2) return buf;

  const main = Math.max(...sizes);
  const limit = Math.min(n * SPECK_MAX_FRAC_OF_CANVAS, main * SPECK_MAX_FRAC_OF_MAIN);
  const doomed = sizes.map((c) => c < limit);
  const dropped = doomed.reduce((a, d, i) => a + (d ? sizes[i] : 0), 0);
  const count = doomed.filter(Boolean).length;
  if (!count) {
    console.log(`[reimagine] specks: ${sizes.length} pieces, none small enough to drop`);
    return buf;
  }

  for (let p = 0; p < n; p++) if (label[p] >= 0 && doomed[label[p]]) data[p * ch + 3] = 0;
  console.log(
    `[reimagine] specks: dropped ${count} of ${sizes.length} pieces (${dropped}px, ` +
    `${((dropped / main) * 100).toFixed(2)}% of the main artwork)`
  );
  return sharp(data, { raw: { width: w, height: h, channels: ch } }).png({ compressionLevel: 1 }).toBuffer();
}

/* ---- v69: EDGE STRAYS ----
   dropSpecks handles the small abandoned smudge. This handles the other kind: a big solid fragment
   left over from a generation that filled its frame, cut off by the canvas edge. Those are too large
   for the speck rule by design, and they wreck the print canvas twice over — they print, and they
   stretch the trim box so the real artwork is scaled down to an island in the middle. */
const STRAY_CORE_FRAC     = 0.10;  // a piece at least a tenth of the main one is part of the design
const STRAY_MAX_FRAC_MAIN = 0.40;  // never drop anything approaching the size of the main artwork
const STRAY_GAP_FRAC      = 0.03;  // it must clear the core by this share of the longest side

async function dropEdgeStrays(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const n = w * h;

  const on = new Uint8Array(n);
  for (let p = 0, i = 3; p < n; p++, i += ch) on[p] = data[i] > 128 ? 1 : 0;

  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes = [];
  const box = [];        // x0,y0,x1,y1 per component
  const touches = [];    // does it run off the canvas edge
  for (let s = 0; s < n; s++) {
    if (!on[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let sp = 0, count = 0, edge = false;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    label[s] = id; stack[sp++] = s;
    while (sp > 0) {
      const q = stack[--sp];
      count++;
      const x = q % w, y = (q / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0     && on[q - 1] && label[q - 1] === -1) { label[q - 1] = id; stack[sp++] = q - 1; }
      if (x < w - 1 && on[q + 1] && label[q + 1] === -1) { label[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0     && on[q - w] && label[q - w] === -1) { label[q - w] = id; stack[sp++] = q - w; }
      if (y < h - 1 && on[q + w] && label[q + w] === -1) { label[q + w] = id; stack[sp++] = q + w; }
    }
    sizes.push(count); box.push([x0, y0, x1, y1]); touches.push(edge);
  }
  if (sizes.length < 2) return buf;

  const main = Math.max(...sizes);
  /* The core is the main piece plus everything substantial that sits INSIDE the frame. An edge-touching
     piece never defines the core, however big it is — otherwise three fragments pinned to three edges
     define a core spanning the whole canvas and nothing can ever be recognised as a stray. */
  const mainIdx = sizes.indexOf(main);
  let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1;
  sizes.forEach((c, i) => {
    if (i !== mainIdx && (touches[i] || c < main * STRAY_CORE_FRAC)) return;
    const b = box[i];
    if (b[0] < cx0) cx0 = b[0]; if (b[1] < cy0) cy0 = b[1];
    if (b[2] > cx1) cx1 = b[2]; if (b[3] > cy1) cy1 = b[3];
  });
  const gap = Math.round(Math.max(w, h) * STRAY_GAP_FRAC);

  const doomed = sizes.map((c, i) => {
    if (i === mainIdx) return false;                    // never the main artwork
    if (!touches[i] && c >= main * STRAY_CORE_FRAC) return false;  // a real part of the design
    if (c >= main * STRAY_MAX_FRAC_MAIN) return false;  // too big to gamble on
    if (!touches[i]) return false;                      // not cut off by the frame -> deliberate
    const b = box[i];
    const clear = b[2] < cx0 - gap || b[0] > cx1 + gap || b[3] < cy0 - gap || b[1] > cy1 + gap;
    return clear;                                       // detached AND clear of the core
  });

  const count = doomed.filter(Boolean).length;
  if (!count) {
    console.log(`[reimagine] edge strays: ${sizes.length} pieces, none matched`);
    return buf;
  }
  const dropped = doomed.reduce((a, d, i) => a + (d ? sizes[i] : 0), 0);
  for (let p = 0; p < n; p++) if (label[p] >= 0 && doomed[label[p]]) data[p * ch + 3] = 0;
  console.log(
    `[reimagine] edge strays: dropped ${count} of ${sizes.length} pieces (${dropped}px, ` +
    `${((dropped / main) * 100).toFixed(1)}% of the main artwork) - the trim box shrinks with them`
  );
  return sharp(data, { raw: { width: w, height: h, channels: ch } }).png({ compressionLevel: 1 }).toBuffer();
}

/* ---------------- v80: the invented backdrop disc ----------------
   Nine sightings since v40, banned in the negative prompt in seven different wordings, and the ban
   has never held. It is not disobedience: streetwear and outdoor print art in the model's training
   almost always carries a sun or a circle behind the subject, so it draws one by habit. An eighth
   wording would not fix that either. This measures the cut-out instead.

   🔑 THE SHAPE OF THE TEST, and why the obvious version does not work. My first attempt compared the
   artwork with an ideal ellipse inscribed in its BOUNDING BOX. It caught a bare disc and missed the
   real case outright, because in the live result the script word ran well below and past the disc:
   the bounding box grew to take the lettering in, and the ideal circle drawn inside that box no
   longer matched the disc at all. The bounding box is a property of everything drawn, so it cannot
   be the reference for finding one thing among them.
   So the disc is found DIRECTLY, as the largest circle that fits inside the artwork — a distance
   transform, whose maximum is the centre of that circle and whose value there is its radius. That is
   immune to anything sticking out of it, which is the whole difficulty.

   Three measurements then decide, and each rejects a specific thing that is NOT this defect:
     1. `circleFrac` — the circle must cover a real share of the canvas. Rejects thin artwork
        (lettering has no room for a circle at all) and a small round badge inside a composition.
     2. `agreement` — inside that circle's own square box, the artwork and the ideal circle must
        agree pixel for pixel. Rejects a solid RECTANGLE, which contains just as big a circle but
        disagrees at all four corners. That is a different defect and not one to regenerate over.
     3. `insideShare` — the circle must account for most of the ink. Rejects a real design that
        merely contains a dense round area.

   Returns the measurements when it fires, so a wrong call can be argued with from the log, or null.
   Read at 320px: only the shape matters, which keeps this to a few milliseconds. */
/* A second drawing plus its cut-out costs roughly twenty-five seconds, and vercel.json gives these
   functions sixty. Past this point the retry would risk the whole run timing out — and losing a
   design he would otherwise have received, to avoid a defect he can simply generate away. A disc is
   worth a retry; it is not worth the design. Same reasoning as the v66 hardened retry's own clock. */
const DISC_RETRY_BUDGET = 30000;

const DISC_MIN_CIRCLE_FRAC = 0.30;   // inscribed circle vs the whole canvas
const DISC_AGREE_MIN       = 0.88;   // circle vs artwork inside the circle's box
const DISC_INSIDE_MIN      = 0.55;   // share of the artwork that lies inside the circle

async function looksLikeDisc(buf) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .resize(320, 320, { fit: "inside", kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const n = w * h;

  const on = new Uint8Array(n);
  for (let p = 0, i = 3; p < n; p++, i += ch) on[p] = data[i] > 128 ? 1 : 0;

  /* The disc is the biggest connected thing on the canvas: whatever is drawn on top of it is joined
     to it, so they are one component. Same flood fill dropEdgeStrays uses. */
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let best = null;
  for (let s = 0; s < n; s++) {
    if (!on[s] || label[s] !== -1) continue;
    let sp = 0, count = 0;
    label[s] = s; stack[sp++] = s;
    while (sp > 0) {
      const q = stack[--sp];
      count++;
      const x = q % w, y = (q / w) | 0;
      if (x > 0     && on[q - 1] && label[q - 1] === -1) { label[q - 1] = s; stack[sp++] = q - 1; }
      if (x < w - 1 && on[q + 1] && label[q + 1] === -1) { label[q + 1] = s; stack[sp++] = q + 1; }
      if (y > 0     && on[q - w] && label[q - w] === -1) { label[q - w] = s; stack[sp++] = q - w; }
      if (y < h - 1 && on[q + w] && label[q + w] === -1) { label[q + w] = s; stack[sp++] = q + w; }
    }
    if (!best || count > best.count) best = { id: s, count };
  }
  if (!best) return null;

  /* Chamfer 3-4 distance transform over that component. Neighbours outside the canvas are simply
     skipped rather than counted as background, so a disc running off the edge still measures as the
     circle it is instead of being cut in half by the frame. */
  const D = new Float32Array(n);
  for (let p = 0; p < n; p++) D[p] = label[p] === best.id ? 1e9 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (D[p] === 0) continue;
      let d = D[p];
      if (y > 0)                d = Math.min(d, D[p - w] + 3);
      if (x > 0)                d = Math.min(d, D[p - 1] + 3);
      if (y > 0 && x > 0)       d = Math.min(d, D[p - w - 1] + 4);
      if (y > 0 && x < w - 1)   d = Math.min(d, D[p - w + 1] + 4);
      D[p] = d;
    }
  }
  let maxD = 0, centre = 0;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (D[p] === 0) continue;
      let d = D[p];
      if (y < h - 1)              d = Math.min(d, D[p + w] + 3);
      if (x < w - 1)              d = Math.min(d, D[p + 1] + 3);
      if (y < h - 1 && x < w - 1) d = Math.min(d, D[p + w + 1] + 4);
      if (y < h - 1 && x > 0)     d = Math.min(d, D[p + w - 1] + 4);
      D[p] = d;
      if (d > maxD) { maxD = d; centre = p; }
    }
  }

  const R = maxD / 3;                     // chamfer counts a straight step as 3
  const circleFrac = (Math.PI * R * R) / n;
  if (circleFrac < DISC_MIN_CIRCLE_FRAC) return null;

  const cx = centre % w, cy = (centre / w) | 0;
  let boxPx = 0, agree = 0, litInside = 0;
  const x0 = Math.round(cx - R), x1 = Math.round(cx + R);
  const y0 = Math.round(cy - R), y1 = Math.round(cy + R);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      boxPx++;
      const within = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
      const lit = label[y * w + x] === best.id;
      if (within && lit) litInside++;
      if (within === lit) agree++;
    }
  }
  const agreement = agree / Math.max(1, boxPx);
  const insideShare = litInside / Math.max(1, best.count);
  if (agreement < DISC_AGREE_MIN || insideShare < DISC_INSIDE_MIN) return null;

  return {
    radius: Math.round(R),
    circleFrac: +circleFrac.toFixed(3),
    agreement: +agreement.toFixed(3),
    insideShare: +insideShare.toFixed(3),
  };
}

/* ---------------- print canvas ---------------- */
async function toPrintCanvas(buf) {
  const stats = await sharp(buf).ensureAlpha().stats();
  if (stats.isOpaque) console.warn("[reimagine] WARNING: image has no transparency");

  try {
    buf = await dropSpecks(buf);
  } catch (e) {
    console.warn("[reimagine] speck removal failed, keeping the artwork as it is:", e.message);
  }

  /* v69: and the big frame-edge leftovers the speck rule is deliberately too timid to touch. */
  try {
    buf = await dropEdgeStrays(buf);
  } catch (e) {
    console.warn("[reimagine] stray removal failed, keeping the artwork as it is:", e.message);
  }

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
             a DIFFERENT ANIMAL that fits the same scene and pose. Never change the category itself.
             PICK SOMETHING LESS OBVIOUS. "Similar size and appeal" sends every North American
             wilderness scene to the same two or three animals — a grizzly becomes a moose, then a
             moose, then a moose. The animal only has to work in that pose and that setting, and it
             does not have to be the same size: a fox, a raccoon, a wolf, a badger, a beaver, a goat,
             an owl or a porcupine all stand in a campfire scene perfectly well. Choose the animal a
             designer would reach for THIRD, not first, and never the most predictable substitute.
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
  const raw0 = await askLLM({
    system: SPEC_SYSTEM_PROMPT,
    ask: "Return the JSON spec. Keep the composition, elements, palette, typography and technique FAITHFUL to what you see — same design. Change ONLY the individual character (same category, different individual) and the wording. Match the realism level exactly. JSON only.",
    image: base64Data,
    mediaType,
    maxTokens: 700,
  });
  if (!raw0) {
    console.error("[reimagine] spec analysis returned nothing");
    throw new Error("Analysis failed");
  }
  let raw = raw0.replace(/```json/gi, "").replace(/```/g, "").trim();
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

/* ---- v74: does this reference print LIGHT ink on a DARK garment? ----
   Measured, not asked. The pipeline draws on white and removes the white, so light artwork is cut away
   with the background; the `monolight` preset exists for exactly this and draws in black, then inverts
   after the cut-out. Until now he had to know that and press a chip.
   A design is light-on-dark when most of it is dark AND a substantial minority is light — that is a
   dark ground carrying pale ink. An ordinary design on white fails the first half; a dark solid shape
   on white fails the second. */
const LIGHT_ON_DARK_GROUND = 0.55;   // this much of the image below DARK_MAX
/* 3%, not 5%: this runs on the WHOLE upload, before cropToGraphic, so a chest print on a photo of a
   black shirt is diluted by the shirt around it. A small white logo on a black tee is a real case and
   4% of the frame. The cost of going lower is a dark photograph with bright highlights being read as
   light ink — LOD_LIGHT_MIN is high enough that ordinary shading does not reach it. */
const LIGHT_ON_DARK_INK    = 0.03;
const LOD_DARK_MAX = 0.30;
const LOD_LIGHT_MIN = 0.72;

async function referenceIsLightOnDark(buf) {
  const { data, info } = await sharp(buf)
    .resize(160, 160, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  if (!px) return false;
  let dark = 0, light = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const l = inkLum(data[i], data[i + 1], data[i + 2]);
    if (l <= LOD_DARK_MAX) dark++;
    else if (l >= LOD_LIGHT_MIN) light++;
  }
  const darkFrac = dark / px, lightFrac = light / px;
  const verdict = darkFrac >= LIGHT_ON_DARK_GROUND && lightFrac >= LIGHT_ON_DARK_INK;
  console.log(
    `[reimagine] reference tone: dark=${darkFrac.toFixed(2)} light=${lightFrac.toFixed(2)}` +
    ` -> ${verdict ? "LIGHT ink on a dark ground (monolight)" : "ordinary dark ink"}`
  );
  return verdict;
}

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

  const out = await askLLM({                                   // v77
    system:
      "You translate t-shirt design specs into English for an image generator.\n" +
      "Return ONLY the same JSON object with the same keys, every value translated to natural " +
      "English design vocabulary. Keep values short. 'elements' stays an array. Values already in " +
      "English pass through unchanged. No prose, no markdown fences.",
    ask: JSON.stringify(payload),
    maxTokens: 600,
  });
  if (!out) return spec;                                       // never block a generation over translation

  let raw = out.replace(/```json/gi, "").replace(/```/g, "").trim();

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
/* ---- v74: reword away from the reference's own slogan ----
   v68 stops the run when the new wording carries a phrase from the reference and tells him which words
   to change. In automatic mode there is no field for him to change, so ask once for different wording.
   Fails open: any error returns null and the caller falls back to the 409, which is still correct
   behaviour — better a clear message than a design the copy gate will refuse anyway. */
async function rewordAway(text, banned, genre) {
  const out = await askLLM({                                   // v77
    system:
      "You write short slogans for printed t-shirts.\n" +
      "Given a slogan and a list of forbidden words or phrases, return ONE new slogan with the " +
      "same feel, the same tone and roughly the same length, that uses NONE of the forbidden " +
      "words. Keep the same line breaks if there are any. Reply with the slogan alone - no " +
      "quotes, no explanation, no markdown.",
    ask:
      `Design type: ${genre || "t-shirt slogan"}\n` +
      `Slogan: ${text}\n` +
      `Forbidden: ${banned.join(", ")}`,
    maxTokens: 100,
  });
  if (!out) return null;
  return out.replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 120) || null;
}

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

/* v70: the second half of his decision. Turning EDIT_LETTERING_ENABLED off is NOT enough on its own —
   the caption only moves to the server when needsServerText() says so, and under the old rule a short
   Latin string stayed with the model. "Always Need Tea" is 13 characters, so the very run that failed
   would have gone straight back to the model. With this on, any wording at all is drawn by the server. */
const SERVER_DRAWS_ALL_LETTERING = false;   // v73: back to Hebrew-or-long-string only

/* v74: a pure-typography reference is drawn by the GENERATOR now, not set in the server font.
   Set to false to restore v48's skip-the-generator behaviour. */
const TEXT_ONLY_USES_GENERATOR = true;

function needsServerText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SERVER_DRAWS_ALL_LETTERING) return true;     // v70: every caption, not just the hard cases
  if (HEBREW_RE.test(t)) return true;              // flux cannot draw Hebrew at all
  return t.replace(/\s+/g, "").length > SERVER_TEXT_MAX;
}

/* v80: the missing half of the v74 text-only rule. That rule says a pure-typography reference is
   better drawn by the generator than set in a font — true, and STREET SOUL, AW YEAH! and ALWAYS RISE
   all prove it. But it was applied to ANY wording, so an 18-character slogan that needsServerText()
   had already routed away came straight back to flux and was misspelled ("Keep Freenel FOCOTED").
   The generator gets the wording only when it can be trusted to spell it: Latin, and short.
   Deliberately the mirror of needsServerText rather than a second opinion — if SERVER_DRAWS_ALL_LETTERING
   is ever turned back on, text-only designs follow it too instead of quietly opting out. */
function generatorCanSpell(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SERVER_DRAWS_ALL_LETTERING) return false;    // the server owns every caption in that mode
  if (HEBREW_RE.test(t)) return false;             // flux cannot draw Hebrew at all
  return t.replace(/\s+/g, "").length <= SERVER_TEXT_MAX;
}

/* v53: everything the FLUX path needs done to the spec before it is drawn, in one place.
   This is exactly the v52 preparation, lifted out of the handler unchanged so it can be applied
   LAZILY — the edit path skips it entirely, and a failed edit still gets it on the way to flux.
   Returns { spec, wanted }, where `wanted` non-null means the server draws the caption. */
function prepareForFlux(spec) {
  const wanted = needsServerText(spec.text)
    /* v72: the typography sentence travels with the caption - it is what chooses the faces. */
    ? {
        text: spec.text,
        colour: chosenTextColour(spec),
        typography: spec.typography || "",
        above: captionGoesAbove(spec),        // v75: which side of the artwork it belongs on
      }
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

/* ---- v61: FULL-STRENGTH INK ON SINGLE-COLOUR DESIGNS ----
   This is the deterministic half of v61. The prompt half above ASKS for a solid one-ink print; this
   part MAKES it one, because five versions of asking have not held.

   It is gated three ways on purpose, and every gate is there because removing it would destroy a
   legitimate design:
     - paletteIsMonochrome only. Two-colour and duotone briefs are excluded: collapsing two inks onto
       one is not a fix, it is vandalism.
     - the artwork itself must actually be monochrome. A palette can claim "single colour" over a
       result that plainly is not, and the claim never wins over the pixels.
     - large light regions are left alone. In a one-ink print an unfilled shape IS the garment showing
       through; flooding it would turn an outlined cup into a black silhouette. Only pockets small
       enough to be erosion or distress are filled.
   Runs after the cut-out (it needs the real alpha) and BEFORE invertArtwork, so monolight still ends
   up with genuinely white artwork. */

const INK_DARK = 0.55;        // at or below this luminance the pixel is ink
const INK_LIGHT = 0.80;       // at or above it the pixel is a gap, not ink
/* v71: and a gap in a one-ink print is the garment, so it is cleared rather than left pale.
   Set to false to go back to v70 exactly (light fills stay as the model drew them). */
const CLEAR_LIGHT_FILLS = true;
const INK_FOREIGN_MAX = 0.12; // more saturated off-hue pixels than this and the artwork is not monochrome
const POCKET_MAX_FRAC = 0.004;// an enclosed light pocket up to this share of the ink is erosion
const INK_TARGET_LUM = 0.12;
const POCKET_COUNT_MAX = 300; // more separate pockets than this is a TEXTURE, not erosion

/* A distressed/vintage/halftone print is SUPPOSED to have holes in its strokes — that is the design,
   and the v35 vintage preset asks for it deliberately. Filling them would be the same class of error
   as flooding an outlined shape, so a brief that says so is left alone entirely. */
const INK_TEXTURE_RE = /\b(distress\w*|vintage|retro|worn|weathered|halftone|grain\w*|grunge|rough\s+texture|textured|stipple\w*|cross[- ]?hatch\w*|screen[- ]?print\s+texture)\b/i;

function inkTextureWanted(spec) {
  return INK_TEXTURE_RE.test(
    [spec && spec.technique, spec && spec.genre, spec && spec.palette].filter(Boolean).join(" ")
  );
}

/* STRICTER than paletteIsLimited, deliberately: that one is about binding the subject to a tight
   palette, this one is about collapsing everything onto one ink, which two-colour must never do. */
function paletteIsMonochrome(palette) {
  const p = String(palette || "").toLowerCase();
  if (!p) return false;
  if (/\b(two[- ]colou?r|duotone|2[- ]colou?r|three[- ]colou?r|tri[- ]colou?r)\b/.test(p)) return false;
  return /\b(single[- ]colou?r|one[- ]colou?r|1[- ]colou?r|monochrom\w*|mono[- ]?tone|black\s+only|one\s+ink|single\s+ink)\b/.test(p);
}

/* Only a palette that NAMES a black/charcoal ink licenses deepening the colour. A single-colour design
   in dusty rose is supposed to stay dusty rose; a black one that came back grey is not. */
function darkInkNamed(palette) {
  return /\b(black|charcoal|jet|noir|dark ink|ink black)\b/i.test(String(palette || ""));
}

function inkLum(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function inkHueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return { h: 0, s: 0 };
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: d / mx };
}

function inkHueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

async function forceSolidInk(buf, palette) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H;
  const Lq = new Uint8Array(N);
  const opaque = new Uint8Array(N);
  const hist = new Uint32Array(256);
  let inkCount = 0;

  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    opaque[i] = 1;
    inkCount++;
    const q = Math.min(255, Math.round(inkLum(data[o], data[o + 1], data[o + 2]) * 255));
    Lq[i] = q;
    hist[q]++;
  }
  if (!inkCount) return { buf, skipped: "nothing opaque" };

  /* The ink colour is the average of the pixels that ARE ink — everything at or below INK_DARK.
     v71 fix: this used to take the darkest fifth of all opaque pixels, which breaks on exactly the
     designs this pass exists for. An outlined cup with a big pale body is less than a fifth ink, so
     the "darkest fifth" reached up into the cream, the ink came out desaturated, and the hue guard
     then read every real ink pixel as foreign and refused the whole pass. Defining ink by luminance
     instead of by rank has no such blind spot, and `hist` stays for the log. */
  let ir = 0, ig = 0, ib = 0, n = 0;
  const darkCut = Math.round(INK_DARK * 255);
  for (let i = 0; i < N; i++) {
    if (!opaque[i] || Lq[i] > darkCut) continue;
    const o = i * 4; ir += data[o]; ig += data[o + 1]; ib += data[o + 2]; n++;
  }
  if (!n) return { buf, skipped: "no ink pixels" };
  let ink = [Math.round(ir / n), Math.round(ig / n), Math.round(ib / n)];
  const hue = inkHueOf(ink[0], ink[1], ink[2]);

  /* The ink itself can come back washed out — the whole design drawn in grey where the reference is
     solid black. Deepen it, keeping its hue, but only when the palette actually named a black ink. */
  let deepened = null;
  if (darkInkNamed(palette)) {
    const l = inkLum(ink[0], ink[1], ink[2]);
    if (l > INK_TARGET_LUM) {
      const k = INK_TARGET_LUM / Math.max(l, 0.001);
      deepened = ink.slice();
      ink = ink.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));
    }
  }

  // the pixels decide, not the palette
  let foreign = 0;
  for (let i = 0; i < N; i++) {
    if (!opaque[i]) continue;
    const o = i * 4;
    const c = inkHueOf(data[o], data[o + 1], data[o + 2]);
    if (c.s < 0.35) continue;
    if (hue.s < 0.2 || inkHueGap(c.h, hue.h) > 60) foreign++;
  }
  const foreignRatio = foreign / inkCount;
  if (foreignRatio > INK_FOREIGN_MAX) {
    return { buf, skipped: `artwork is multi-coloured (${foreignRatio.toFixed(3)})` };
  }

  // pass 1 — every ink pixel to full strength; mid tones keep their coverage as alpha, so edges stay soft
  let snapped = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    const l = inkLum(data[o], data[o + 1], data[o + 2]);
    if (l >= INK_LIGHT) continue;
    const cover = l <= INK_DARK ? 1 : (INK_LIGHT - l) / (INK_LIGHT - INK_DARK);
    data[o] = ink[0]; data[o + 1] = ink[1]; data[o + 2] = ink[2];
    data[o + 3] = Math.round(data[o + 3] * cover);
    snapped++;
  }

  // pass 2 — light pockets enclosed by ink are erosion or distress. Fill the small ones only.
  const gap = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    gap[i] = data[o + 3] < 128 || inkLum(data[o], data[o + 1], data[o + 2]) >= INK_LIGHT ? 1 : 0;
  }
  const outside = new Uint8Array(N);
  const stack = [];
  const push = (i) => { if (gap[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }

  const maxPocket = Math.max(4, Math.round(inkCount * POCKET_MAX_FRAC));
  const seenP = new Uint8Array(N);
  const comps = [];
  let filled = 0;
  for (let i = 0; i < N; i++) {
    if (!gap[i] || outside[i] || seenP[i]) continue;
    const comp = [];
    const q = [i];
    seenP[i] = 1;
    while (q.length) {
      const j = q.pop();
      comp.push(j);
      const x = j % W, y = (j / W) | 0;
      if (x > 0 && gap[j - 1] && !outside[j - 1] && !seenP[j - 1]) { seenP[j - 1] = 1; q.push(j - 1); }
      if (x < W - 1 && gap[j + 1] && !outside[j + 1] && !seenP[j + 1]) { seenP[j + 1] = 1; q.push(j + 1); }
      if (y > 0 && gap[j - W] && !outside[j - W] && !seenP[j - W]) { seenP[j - W] = 1; q.push(j - W); }
      if (y < H - 1 && gap[j + W] && !outside[j + W] && !seenP[j + W]) { seenP[j + W] = 1; q.push(j + W); }
    }
    if (comp.length > maxPocket) continue;
    comps.push(comp);
    if (comps.length > POCKET_COUNT_MAX) break;
  }

  /* Hundreds of small holes spread through the strokes are not erosion — that is a halftone or a
     distressed print, and filling them would flatten the design's whole character. Second guard on
     top of inkTextureWanted(), because a texture can arrive without any word announcing it. */
  const texture = comps.length > POCKET_COUNT_MAX;
  if (!texture) {
    for (const comp of comps) {
      for (const j of comp) {
        const o = j * 4;
        data[o] = ink[0]; data[o + 1] = ink[1]; data[o + 2] = ink[2]; data[o + 3] = 255;
        filled++;
      }
    }
  }

  /* pass 3 (v71) — everything still light is the garment showing through, not a pale ink. Runs LAST so
     the pockets pass 2 just filled are already ink and are not cleared again. */
  let cleared = 0;
  if (CLEAR_LIGHT_FILLS) {
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (data[o + 3] === 0) continue;
      if (inkLum(data[o], data[o + 1], data[o + 2]) < INK_LIGHT) continue;
      data[o + 3] = 0;
      cleared++;
    }
  }

  const out = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { buf: out, ink, deepened, snapped, pockets: texture ? 0 : comps.length, filled, cleared, foreignRatio, texture };
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

/* v72: four faces, chosen from the spec's own typography wording. `sans` is DejaVu and stays the
   fallback for everything — it is the only one of the four with Hebrew glyphs, and the only one
   already proven to survive the Vercel bundle. */
const FONT_FILES = {
  sans:      FONT_REL,
  serif:     "node_modules/@expo-google-fonts/playfair-display/700Bold/PlayfairDisplay_700Bold.ttf",
  script:    "node_modules/@expo-google-fonts/dancing-script/700Bold/DancingScript_700Bold.ttf",
  condensed: "node_modules/@expo-google-fonts/oswald/700Bold/Oswald_700Bold.ttf",
};

const _fonts = {};      // key -> parsed font or null
let _font = null;       // the sans face, kept under its old name so nothing else has to change
let _fontTried = false;

/* v47: module resolution is NOT enough on Vercel. The tracer only bundles files it can see being
   used, it does not follow require.resolve() through a variable, and the .ttf was pruned — the log
   said "Cannot find module". vercel.json force-includes it now, and this walks real paths so a
   change in how the lambda is laid out cannot silently kill the captions again. */
function fontCandidates(rel) {
  const out = [];
  const spec = String(rel).replace(/^node_modules\//, "");
  try {
    out.push(createRequire(import.meta.url).resolve(spec));
  } catch (e) {
    // not resolvable from the bundle - the explicit paths below are the ones that matter
  }
  out.push(path.join(process.cwd(), rel));           // /var/task on Vercel
  out.push(path.join("/var/task", rel));
  try {
    out.push(fileURLToPath(new URL("../" + rel, import.meta.url)));
  } catch (e) {
    // import.meta.url is always a file URL here, but never let path building throw
  }
  return out.filter((p, i) => p && out.indexOf(p) === i);
}

/* v72: load any of the four by key. A face that will not load is remembered as null and silently
   replaced by the sans everywhere, so a missing .ttf costs typography and never a caption. */
function loadFontKey(key) {
  if (key in _fonts) return _fonts[key];
  const rel = FONT_FILES[key];
  if (!rel) { _fonts[key] = null; return null; }

  for (const p of fontCandidates(rel)) {
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      _fonts[key] = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      console.log(`[reimagine] font "${key}" loaded from ${p}`);
      return _fonts[key];
    } catch (e) {
      console.error(`[reimagine] font "${key}" at ${p} failed:`, e.message);
    }
  }
  console.warn(`[reimagine] font "${key}" unavailable - falling back to the sans face`);
  _fonts[key] = null;
  return null;
}

/* Every character must exist in the face, or the caption prints as empty boxes. Only DejaVu carries
   Hebrew, so this is what keeps a Hebrew caption safe when a decorative face was chosen. */
function fontCovers(font, text) {
  if (!font) return false;
  for (const ch of String(text || "")) {
    if (ch === " ") continue;
    if (!font.charToGlyphIndex(ch)) return false;
  }
  return true;
}

/* Picks the face for a line: the requested one when it exists AND covers the words, sans otherwise. */
function faceFor(key, text) {
  const f = loadFontKey(key);
  if (f && fontCovers(f, text)) return { font: f, key };
  const sans = loadFontKey("sans");
  if (f && !fontCovers(f, text)) {
    console.log(`[reimagine] face "${key}" does not cover this wording - using sans`);
  }
  return { font: sans, key: "sans" };
}

const SCRIPT_RE    = /\b(script|cursive|calligraph\w*|handwritten|hand[- ]lettered|brush|signature|flowing)\b/i;
const SERIF_RE     = /\b(serif|display\s+serif|elegant|classic|editorial|roman)\b/i;
/* "tall" was in here and it broke "tall display serif headline" — the analyser uses tall to describe a
   display SERIF far more often than a condensed sans. Keywords have to be unambiguous to be useful. */
const CONDENSED_RE = /\b(condensed|narrow|compressed|athletic|varsity|block\s+caps)\b/i;
/* v75: sans is the default FACE but it still has to be findable for the ordering above. */
const SANS_RE = /\b(sans[- ]serif|sans|grotesque|upright\s+caps|geometric)\b/i;
const LOWER_BIG_RE = /\b(large|big|bold|main|dominant)\b[^,;]{0,40}\b(lower|bottom|below|beneath|under)\b|\b(lower|bottom)\b[^,;]{0,40}\b(large|big|dominant)\b/i;

/* v72: reads the analyser's own typography sentence and returns how to set the caption.
   `primaryLast` matters because references disagree: "ROOTED in faith" is big-on-top, while
   "But First Coffee" is small-on-top with the big script beneath. */
function readTypography(typography) {
  const t = String(typography || "");
  const hasScript = SCRIPT_RE.test(t);
  const hasSerif = SERIF_RE.test(t) && !/sans[- ]serif/i.test(t);
  const hasCondensed = CONDENSED_RE.test(t);

  /* Which of the two named faces is the HEADLINE is decided by ORDER, not by a ranking of my own.
     The analyser writes the headline first and the accent second — "tall display serif headline,
     flowing script accent below", "bold brush script for the main word, smaller upright sans for the
     accent phrase". Ranking script above serif got "ROOTED in faith" backwards, setting the headline
     in the accent face. */
  /* v75: SANS has to take part in the ORDERING even though it is the default face. Without it,
     "small sans caps headline, flowing script accent below" named only the script, so the script became
     the headline and the pair came out upside down — the accent face set large on top. Order is only
     meaningful if every face that is mentioned is in the list. */
  const hasSans = SANS_RE.test(t);
  const at = (re, on) => (on ? t.search(re) : -1);
  const named = [
    { key: "script", i: at(SCRIPT_RE, hasScript) },
    { key: "serif", i: at(SERIF_RE, hasSerif) },
    { key: "condensed", i: at(CONDENSED_RE, hasCondensed) },
    { key: "sans", i: at(SANS_RE, hasSans) },
  ].filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);

  const primary = named.length ? named[0].key : "sans";
  const accent = named.length > 1 ? named[1].key : "sans";

  return { primary, accent, primaryLast: LOWER_BIG_RE.test(t) };
}

function loadFont() {
  if (_fontTried) return _font;
  _fontTried = true;

  const tried = [];
  for (const p of fontCandidates(FONT_REL)) {
    tried.push(p);
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      _font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      _fonts.sans = _font;                       // v72: the registry and the old name share one parse
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

/* ---- v56: WE SERIALISE THE GLYPH OUTLINES OURSELVES ----
   opentype.js's toPathData(places) rounds with this helper:
       roundDecimal(f, p) => +(Math.round(f + "e+" + p) + "e-" + p)
   It is string arithmetic, so it depends on how JavaScript prints the number. Any coordinate whose
   String() is exponential — that is, any |v| below 1e-6, which is what a floating-point "zero" looks
   like — becomes "3.55e-15e+2", and Math.round of that is NaN. ONE NaN coordinate makes librsvg
   silently abandon the rest of that <path>, so everything after it vanishes at raster time.
   That is the whole caption bug, and it explains why only LONG captions broke: a long line is nearly
   as wide as the box, so centring puts its x at almost exactly 0, and the near-zero coordinates that
   follow are the ones that serialise in exponential form. Short captions never get near it.
   num() uses toFixed, which never produces exponential notation at these magnitudes. */
function num(v) {
  if (!Number.isFinite(v)) return "0";
  // toFixed switches to exponential notation past 1e21, which is the very thing we are avoiding.
  // Nothing on a 4500x5400 canvas can legitimately be that large, so clamp rather than emit it.
  if (v > 1e6) v = 1e6;
  else if (v < -1e6) v = -1e6;
  let s = v.toFixed(2);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function pathDataOf(p) {
  let d = "";
  for (const c of p.commands) {
    switch (c.type) {
      case "M": d += `M${num(c.x)} ${num(c.y)}`; break;
      case "L": d += `L${num(c.x)} ${num(c.y)}`; break;
      case "C": d += `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`; break;
      case "Q": d += `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`; break;
      case "Z": d += "Z"; break;
      default: break;
    }
  }
  return d;
}

function runPath(font, glyphs, x, y, size, tracking) {
  let cx = x;
  let d = "";
  for (let i = 0; i < glyphs.length; i++) {
    d += pathDataOf(glyphs[i].getPath(cx, y, size));
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

/* ---- v75: caption proportion ----
   The caption box is deliberately NARROWER than the artwork's safe area. Type that stops short of the
   edges reads as designed; type that touches both edges reads as stretched to fit, which is exactly
   what his side-by-side showed. */
/* v75: the reference decides which side the caption goes. "NEVER WASTE" sits ABOVE the apple; until
   now the caption could only ever be bolted underneath. Read from the analyser's own composition and
   typography wording, and deliberately narrow — an unclear description keeps the old behaviour. */
const CAPTION_ABOVE_RE = new RegExp(
  "\\b(lettering|wording|text|type|typography|headline|caption|title|words)\\b[^.;]{0,50}" +
  "\\b(above|over|atop|top of|upper)\\b" +
  "|\\b(above|across the top|along the top|upper)\\b[^.;]{0,50}" +
  "\\b(artwork|illustration|image|graphic|subject|apple|fruit|figure|animal)\\b",
  "i"
);

function captionGoesAbove(spec) {
  const t = [spec && spec.composition, spec && spec.typography].filter(Boolean).join(" ");
  if (!t) return false;
  /* a description that says BOTH keeps the safe default - it is a two-part design and the code cannot
     tell which half it is being told about */
  if (/\b(below|beneath|under|underneath|lower)\b/i.test(t) && CAPTION_ABOVE_RE.test(t)) return false;
  return CAPTION_ABOVE_RE.test(t);
}

const CAPTION_W    = 0.72;   // caption box width as a fraction of the canvas (artwork still uses SAFE)
const CAPTION_FILL = 0.76;   // how much of its own band the type may occupy, leaving air above/below
const TIER_GAP     = 0.20;   // gap between the headline and the accent line, in font sizes

/* v76: a ceiling on the TYPE ITSELF, measured against the canvas rather than against the band.
   Without it a short caption grows until it fills the band's height — "Eat Clean" came back a quarter
   of the canvas tall. Long captions never reach this cap because the width binds them first, so this
   only ever restrains the short ones, which are exactly the ones that were coming out oversized. */
/* Expressed against the BAND, not the canvas. The band is already a fixed share of whichever canvas is
   in play, so this scales to the watermarked preview for free — whereas a constant tied to CANVAS_H
   would have to be corrected for it, and my first attempt "corrected" it with a term that always
   evaluated to 1. On the print canvas this works out to ~405px, about 7.5% of the height. */
const CAP_HEADLINE = 0.45;   // tallest a headline line may be, as a fraction of its own band

function capSize(size, boxH) {
  return Math.min(size, Math.floor(boxH * CAP_HEADLINE));
}

/* Splits into n lines by character count with the word order preserved. The v44 version split any
   line over 18 characters into its individual words and then kept the first three, which silently
   threw away the rest of the caption. */
/* v58: a "/" in the wording is the author's own line break — these captions read
   "Go Hiking / Worst Case Scenario / A Moose Stomps You" and the source design sets them as three
   separate lines. v56 treated "/" as just another word, so the caption ran them together into one
   sentence and the joke lost its shape. When slashes are present they decide the lines. */
function splitOnSlashes(text) {
  const parts = String(text || "")
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return parts.length > 1 ? parts : null;
}

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

  // v58: explicit "/" breaks win, as long as they fit and stay legible
  const explicit = splitOnSlashes(text);
  if (explicit && explicit.length <= TEXT_MAX_LINES) {
    let byWidth = Infinity;
    for (const l of explicit) {
      const unit = runWidth(font, glyphsFor(font, l), 1, TEXT_TRACK);
      byWidth = Math.min(byWidth, boxW / Math.max(unit, 0.001));
    }
    const size = capSize(
      Math.floor(Math.min(byWidth, boxH / (explicit.length * TEXT_LINE_H))), boxH
    );  // v76: the slash-separated branch solves for size on its own and needs the same ceiling
    if (size >= TEXT_MIN_SIZE) {
      console.log(`[reimagine] caption: honouring ${explicit.length} slash-separated lines`);
      return { lines: explicit, size };
    }
  }

  let best = null;
  for (let n = 1; n <= Math.min(TEXT_MAX_LINES, words.length); n++) {
    const lines = splitInto(words, n);
    let byWidth = Infinity;
    for (const l of lines) {
      const unit = runWidth(font, glyphsFor(font, l), 1, TEXT_TRACK);
      byWidth = Math.min(byWidth, boxW / Math.max(unit, 0.001));
    }
    const byHeight = boxH / (lines.length * TEXT_LINE_H);
    const size = capSize(Math.floor(Math.min(byWidth, byHeight)), boxH);  // v76
    if (!best || size > best.size) best = { lines, size };
  }
  return best && best.size >= TEXT_MIN_SIZE ? best : null;
}

/* ---- v72: two-tier caption ----
   The reference sets a headline and a quieter accent line — two faces, two sizes, one above the other.
   `layoutStyled` solves for the single largest base size at which every line still fits its own face
   and scale, so nothing is guessed and nothing overflows. */
const ACCENT_SCALE = 0.52;   // the accent line relative to the headline

function layoutStyled(lines, boxW, boxH, typography) {
  if (lines.length !== 2) return null;                       // one tier only for 1 or 3+ lines
  const style = readTypography(typography);
  if (style.primary === style.accent) return null;           // nothing to gain over the plain path

  const primaryIdx = style.primaryLast ? 1 : 0;
  const parts = lines.map((text, i) => {
    const isPrimary = i === primaryIdx;
    const face = faceFor(isPrimary ? style.primary : style.accent, text);
    return { text, face, scale: isPrimary ? 1 : ACCENT_SCALE };
  });
  if (parts.every((p) => p.face.key === "sans")) return null; // both fell back - use the plain path

  let size = Infinity;
  for (const p of parts) {
    const unit = runWidth(p.face.font, glyphsFor(p.face.font, p.text), 1, TEXT_TRACK);
    size = Math.min(size, boxW / Math.max(unit * p.scale, 0.001));
  }
  /* v75: TIER_GAP is part of the height now, so solve for it here too — otherwise the block overflows
     the band by exactly the gap and the accent line gets clipped. */
  const totalH = parts.reduce((a, p) => a + p.scale * TEXT_LINE_H, 0) + TIER_GAP * (parts.length - 1);
  size = Math.floor(Math.min(size, boxH / totalH));
  size = capSize(size, boxH);            // v76: and never taller than the canvas allows
  if (!(size >= TEXT_MIN_SIZE)) return null;

  console.log(
    `[reimagine] caption set in two tiers: ${parts.map((p) => `${p.face.key}@${(p.scale * size).toFixed(0)}`).join(" + ")}` +
    ` (headline ${style.primaryLast ? "below" : "above"})`
  );
  return { parts, size };
}

function styledSvg(layout, boxW, boxH, colour) {
  const { parts, size } = layout;
  /* v75: the two tiers used to sit directly on top of each other at the line height, which is what made
     the pair look jammed together. A real gap goes between them — and it is counted in the total so the
     block still centres correctly. */
  const gap = size * TIER_GAP;
  const totalH = parts.reduce((a, p) => a + p.scale * size * TEXT_LINE_H, 0) + gap * (parts.length - 1);
  let y = (boxH - totalH) / 2;

  let body = "";
  parts.forEach((p, i) => {
    const s = p.scale * size;
    const gs = glyphsFor(p.face.font, p.text);
    const w = runWidth(p.face.font, gs, s, s * TEXT_TRACK);
    const baseline = y + (p.face.font.ascender / p.face.font.unitsPerEm) * s;
    body += `<path d="${runPath(p.face.font, gs, (boxW - w) / 2, baseline, s, s * TEXT_TRACK)}" fill="${colour}"/>`;
    y += s * TEXT_LINE_H + (i < parts.length - 1 ? gap : 0);
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">${body}</svg>`
  );
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
async function renderTextLayer(text, boxW, boxH, colour, typography) {
  const font = loadFont();
  if (!font) return null;

  const layout = layoutText(font, text, boxW, boxH);
  if (!layout) return null;

  /* v72: when the caption is two lines and the typography asks for two faces, set it that way.
     Any reason to decline (one line, one face, would not fit) falls straight back to the v71 path. */
  let styled = null;
  try {
    styled = layoutStyled(layout.lines, boxW, boxH, typography);
  } catch (e) {
    console.warn("[reimagine] two-tier caption failed, using the plain one:", e.message);
  }

  try {
    const svg = styled
      ? styledSvg(styled, boxW, boxH, colour || "#111111")
      : textSvg(font, layout, boxW, boxH, colour || "#111111");
    /* v56 belt and braces: a single non-finite coordinate makes librsvg abandon the rest of a
       <path>, and the result is a caption missing half its words — which ships silently and looks
       like a design decision. If one ever appears again, drop the caption and say so in the log. */
    if (/NaN|Infinity/.test(svg.toString())) {
      console.error("[reimagine] caption path data is not finite - refusing to draw a partial caption");
      return null;
    }
    const png = await sharp(svg).png().toBuffer();
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
async function composeWithText(artBuf, text, colour, typography, above) {
  const TEXT_H = Math.round(CANVAS_H * 0.22);
  const ART_H = CANVAS_H - TEXT_H;

  /* v75: the caption box is NARROWER than the artwork and shorter than its own band, so the type stops
     short of the edges and has air above and below it instead of filling the strip. */
  const capW = Math.round(CANVAS_W * CAPTION_W);
  const capH = Math.round(TEXT_H * CAPTION_FILL);

  const layer = await renderTextLayer(text, capW, capH, colour, typography);
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

  /* v75: above or below. The bands simply swap — the artwork keeps its own band either way, so nothing
     is squeezed and the print canvas is unchanged. */
  const artTop = above
    ? TEXT_H + Math.round((ART_H - am.height) / 2)
    : Math.round((ART_H - am.height) / 2);
  const capTop = above
    ? Math.round((TEXT_H - capH) / 2)
    : ART_H + Math.round((TEXT_H - capH) / 2);
  console.log(`[reimagine] caption placed ${above ? "ABOVE" : "below"} the artwork`);

  return await sharp({
    create: {
      width: CANVAS_W, height: CANVAS_H, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: art, left: Math.round((CANVAS_W - am.width) / 2), top: artTop },
      { input: layer, left: Math.round((CANVAS_W - capW) / 2), top: capTop },
    ])
    .png({ compressionLevel: 6 })
    .withMetadata({ density: DPI })
    .toBuffer();
}

/* Everything after generation is shared with the legacy path: cut out, QC, print canvas, upload. */
/* v48: a pure-typography design. No generator call, no cut-out — the lettering fills the canvas. */
async function finishTextOnly(serverText, t0, preview, invert) {
  const W = preview ? PREVIEW_W : CANVAS_W;
  const H = preview ? PREVIEW_H : CANVAS_H;

  /* v81: a monolight design is drawn in BLACK and negated afterwards, exactly as the artwork path
     does — never asked for as pale ink, which v42 proved gets cut away or prints washed out.
     The colour is forced to near-black first: chosenTextColour may legitimately return navy or
     maroon off the palette, and negating navy gives a cream, which is the near-white trap all over
     again. Black negates to near-white, which is the only thing a light print should ever be. */
  const colour = invert ? "#111111" : serverText.colour;

  const layer = await renderTextLayer(
    serverText.text, Math.round(W * SAFE), Math.round(H * 0.55), colour,
    serverText.typography
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

  /* Negating leaves the transparent ground transparent — alpha is untouched, and a fully clear pixel
     stays clear whatever its RGB says. Failing here delivers the dark version rather than nothing:
     a design in the wrong colour can still be regenerated, an error cannot. */
  if (invert) {
    try {
      canvas = await sharp(await invertArtwork(canvas))
        .png({ compressionLevel: 6 })
        .withMetadata({ density: preview ? 72 : DPI })
        .toBuffer();
      console.log("[reimagine] text-only: inverted to white lettering for dark garments");
    } catch (e) {
      console.error("[reimagine] text-only invert failed, delivering the dark version:", e.message);
      invert = false;
    }
  }

  if (!preview) canvas = await fitUploadSize(canvas);
  const imageUrl = await uploadCloudinary(canvas);
  console.log(`[reimagine] done (text only): ${Date.now() - t0}ms`);

  return {
    imageUrl,
    url: imageUrl,
    preview: !!preview,
    textDrawn: true,
    forDark: !!invert,
    width: W,
    height: H,
    dpi: preview ? 72 : DPI,
    quality: { edge: 0, pale: 0, rim: 0, hole: 0 },
  };
}

async function finishArtwork(art, t0, preview, invert, serverText, solidInkPalette, regenerate) {
  const elapsed = () => Date.now() - t0;

  /* Everything between the generator and the ink passes, in one place so the v80 disc retry can run
     it a second time on a fresh drawing without duplicating any of it. */
  const cutAndCheck = async (artUrl) => {
    const cutout = await fal("fal-ai/birefnet", { image_url: artUrl });
    const qc = await inspect(cutout);
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

    let buf = Buffer.from(await (await fetch(cutout)).arrayBuffer());
    if (qc.cropped) {
      console.log("[reimagine] edges still opaque after birefnet - running flood fill");
      try {
        buf = await stripLeftoverBackground(buf);
      } catch (e) {
        console.warn("flood fill failed, keeping birefnet output:", e.message);
      }
    }
    return { qc, buf };
  };

  let { qc, buf: cutBuf } = await cutAndCheck(art);

  /* v80: the invented backdrop disc, regenerated rather than argued with.
     Every guard here is about never making a run WORSE than it already was: the check itself cannot
     throw, the retry is only taken when it comes back clean, and any failure along the way delivers
     the drawing we already have. A false positive therefore costs one generation and about twenty
     seconds — never the design. Skipped on previews, which are not the file he prints. */
  if (typeof regenerate === "function" && !preview && elapsed() < DISC_RETRY_BUDGET) {
    let disc = null;
    try {
      disc = await looksLikeDisc(cutBuf);
    } catch (e) {
      console.warn("[reimagine] disc check failed, keeping the artwork as it is:", e.message);
    }
    if (disc) {
      console.warn(
        `[reimagine] backdrop disc detected (radius=${disc.radius} circle=${disc.circleFrac} ` +
        `agreement=${disc.agreement} inside=${disc.insideShare}) - drawing it once more`
      );
      try {
        const again = await regenerate();
        if (!again) throw new Error("the generator returned nothing");
        const second = await cutAndCheck(again);
        const stillDisc = await looksLikeDisc(second.buf).catch(() => null);
        if (stillDisc) {
          /* Neither attempt is clean, and swapping one disc for another buys nothing — keep the one
             already measured rather than adding variance for its own sake. */
          console.warn("[reimagine] the disc came back on the retry too - delivering the first attempt");
        } else {
          console.log("[reimagine] retry came back clean - using it");
          qc = second.qc;
          cutBuf = second.buf;
        }
      } catch (e) {
        console.warn("[reimagine] disc retry failed, delivering the first attempt:", e.message);
      }
    }
  }

  /* v61: full-strength ink, before the inversion so monolight still yields white artwork.
     Every failure keeps the artwork exactly as it was — this must never cost him a design. */
  if (solidInkPalette) {
    try {
      const r = await forceSolidInk(cutBuf, solidInkPalette);
      if (r.skipped) {
        console.log(`[reimagine] solid ink skipped: ${r.skipped}`);
      } else {
        cutBuf = r.buf;
        console.log(
          `[reimagine] solid ink: ink=${r.ink.join(",")}` +
          `${r.deepened ? ` (deepened from ${r.deepened.join(",")})` : ""}` +
          ` snapped=${r.snapped} pockets=${r.pockets} filled=${r.filled} cleared=${r.cleared}` +
          `${r.texture ? " (texture detected - holes left alone)" : ""}`
        );
      }
    } catch (e) {
      console.warn("[reimagine] solid ink failed, keeping the artwork as it is:", e.message);
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
    canvas = await composeWithText(
      cutBuf, serverText.text, serverText.colour, serverText.typography, !!serverText.above
    );
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
  let action = String(body.action || "").toLowerCase();

  /* ---- v74: ONE BUTTON ----
     Analyse and generate in a single request. Everything decided automatically is recorded in
     `autoNotes` and returned to the page, so the response says what was chosen rather than choosing
     silently. Deliberately NOT a separate pipeline: it builds the spec and then falls through into the
     generate branch below, which keeps the paywall, both gates and every image step identical. */
  const isAuto = action === "auto";
  const autoNotes = {};
  if (isAuto) {
    try {
      const img = typeof body.image === "string" ? body.image : "";
      /* Parsed exactly as the analyze branch does further down — same regex, same failure message
         shape. `splitDataUrl` does not exist in this file; writing it as though it did is the v33
         mistake (a symbol that passes `node --check` and throws at runtime). */
      const m = img.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!m) {
        return res.status(400).json({ error: "לא התקבלה תמונה תקינה — נסו להעלות שוב." });
      }
      const mt = m[1], b64 = m[2];
      const spec = await analyzeSpec(b64, mt);
      console.log("[reimagine] auto spec:", JSON.stringify(spec).slice(0, 300));

      /* Light ink on a dark ground has to be spotted BEFORE anything is drawn, or the artwork is cut
         away with the white background. This is the chip he used to have to know about. */
      try {
        if (await referenceIsLightOnDark(Buffer.from(b64, "base64"))) {
          spec.style = "monolight";
          autoNotes.style = "monolight";
        }
      } catch (e) {
        console.warn("[reimagine] tone check failed, continuing without it:", e.message);
      }

      let ref = null;
      try {
        ref = await uploadCloudinary(Buffer.from(b64, "base64"));
      } catch (e) {
        console.error("[reimagine] could not park the reference:", e.message);
      }
      body.spec = Object.assign({}, spec, ref ? { [REF_KEY]: ref } : {});
      autoNotes.spec = spec;
      action = "generate";
    } catch (err) {
      console.error("[reimagine] auto analyse failed:", err);
      return res.status(502).json({ error: "לא הצלחנו לנתח את העיצוב. נסו שוב." });
    }
  }

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
      let regenerate = null;             // v80: how to redraw, if the disc check asks for one
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

      /* v57: ONE inspection of the reference — box, its wording, and whether it is someone else's
         property. Runs before a single fal credit is spent. */
      let refWording = "";
      let letteringNotice = "";
      if (reference) {
        const info = await inspectReference(reference);
        if (info.protected) {
          console.warn("[reimagine] REFUSED - protected material in the reference:", info.protected);
          return res.status(422).json({ error: IP_ERROR, blocked: "ip", reason: info.protected });
        }
        refWording = info.wording;

        /* v68: catch the collision here, where it costs nothing, instead of after a full generation. */
        let shared = sharedWording(refWording, prepared.spec.text);
        if (shared.phrases.length || shared.words.length) {
          const banned = [...shared.phrases, ...shared.words];
          console.warn(
            `[reimagine] wording shared with the reference:`,
            JSON.stringify(shared), `| reference wording: ${JSON.stringify(refWording)}`
          );

          /* v74: in automatic mode there is no field for him to edit, so reword it here and check the
             new wording the same way. One attempt only — a second would be guesswork on a guess. */
          if (isAuto) {
            const fresh = await rewordAway(prepared.spec.text, banned, prepared.spec.genre);
            const still = fresh ? sharedWording(refWording, fresh) : null;
            if (fresh && still && !still.phrases.length && !still.words.length) {
              console.log(`[reimagine] reworded automatically: ${JSON.stringify(prepared.spec.text)} -> ${JSON.stringify(fresh)}`);
              autoNotes.reworded = { from: prepared.spec.text, to: fresh, avoided: banned };
              prepared.spec.text = fresh;
              shared = { phrases: [], words: [] };
            } else {
              console.warn("[reimagine] automatic rewording did not clear the collision");
            }
          }

          if (shared.phrases.length || shared.words.length) {
            return res.status(409).json({
              error: sharedWordingError(shared),
              blocked: "wording",
              shared: banned,
            });
          }
        }

        const keep = editCanKeepLettering(prepared.spec);
        console.log(
          `[reimagine] lettering: ${keep ? "MODEL keeps the design's own type" : "SERVER draws it"}` +
          ` (text=${(prepared.spec.text || "").length} chars, typography="${prepared.spec.typography || ""}")`
        );
        if (!keep) prepareFluxOnce();

        // v55: strip the wearer BEFORE the edit model sees anything. Words never won this argument.
        reference = await cropReferenceToGraphic(reference, info.box);
      }

      if (reference && USE_EDIT_PATH) {
        try {
          art = await editFromSpec(specUsed, reference, false, "", "", refWording);
        } catch (e) {
          console.error("[reimagine] edit path failed, falling back to flux:", e.message);
        }

        /* v57: THE OUTPUT GATE. An edit model asked to keep everything and change a little will
           sometimes change nothing, and hand back the source design intact. One retry with the
           instruction hardened; if it comes back a copy again, nothing is delivered and nothing is
           charged. A refusal he can read beats a print-ready copy of someone else's product. */
        if (art) {
          // what the model was ASKED to letter — empty when the server owns the caption
          const askedWording = wanted ? "" : (specUsed.text || "");
          let verdict = await inspectArtwork(art, refWording, askedWording);
          const isCopy = (v) => !!(v.reused || v.protected);
          /* v60: bad lettering is now worth a retry too, and ranks above a backdrop shape — the type
             is the design on these references, so a misspelling costs more than a stray disc. */
          const worth = (v) =>
            (v.reused ? 4 : 0) + (v.protected ? 4 : 0) + (v.lettering ? 2 : 0) + (v.defects ? 1 : 0);
          /* v59: the retry now also fires on PRINT DEFECTS — a backdrop disc, or white fills that the
             cut-out turns into holes. Both were seen on 19 Aug: a retro sunburst behind the moose, and
             a variation whose white sunburst stripes tore holes through the trees and the campfire.
             A defect is a quality problem, not a legal one, so it is worth one retry and never a
             refusal: if the second attempt is no better, the first is delivered as before. */
          if (worth(verdict) > 0 && Date.now() - t0 < 32000) {
            console.warn(
              "[reimagine] one hardened retry -",
              isCopy(verdict) ? "artwork came back as a copy"
                : verdict.lettering ? `lettering: ${verdict.lettering}`
                : `print defect: ${verdict.defects}`
            );
            try {
              /* v67: lettering alone -> repair the attempt we already have. Anything else still
                 needs a fresh draw from the reference. */
              const letteringOnly = !isCopy(verdict) && !!verdict.lettering && !verdict.defects;
              const art2 = letteringOnly
                ? await fixLettering(art, specUsed, verdict.lettering, refWording)
                : await editFromSpec(
                    specUsed, reference, isCopy(verdict), verdict.defects, verdict.lettering, refWording
                  );
              const v2 = await inspectArtwork(art2, refWording, askedWording);
              if (worth(v2) < worth(verdict)) { art = art2; verdict = v2; console.log("[reimagine] retry accepted"); }
              else console.log("[reimagine] retry no better - keeping the first attempt");
            } catch (e) {
              console.error("[reimagine] hardened retry failed:", e.message);
            }
          }
          if (verdict.lettering) {
            /* Never a refusal: the artwork may still be exactly what he wants, and he is the one who
               decides. Say so plainly instead of shipping broken type as though it were intended. */
            console.warn("[reimagine] lettering still wrong after the retry:", verdict.lettering);
            letteringNotice =
              "הכיתוב בעיצוב לא יצא מדויק. נסו ליצור שוב — בכל הרצה המנוע מצייר את האותיות מחדש.";
          }
          if (verdict.reused || verdict.protected) {
            console.warn("[reimagine] REFUSED - output is a copy:", verdict.protected || "original wording reused");
            return res.status(422).json({
              error: verdict.protected ? IP_ERROR : COPY_ERROR,
              blocked: verdict.protected ? "ip" : "copy",
              reason: verdict.protected || "original wording reused",
            });
          }
        }
      } else if (!USE_EDIT_PATH) {
        console.log("[reimagine] drawing from the spec with flux (edit path off - v73)");
      } else {
        console.warn("[reimagine] no reference available - falling back to flux");
      }

      if (!art) {
        /* ---- flux path: the v52 preparation, applied here and nowhere else ---- */
        prepareFluxOnce();

        /* v48: if the subject scrubbed away to nothing, the reference was pure typography — the
           design IS the wording. There is no artwork to regenerate, and asking flux for one is what
           produced the black blob covered in gibberish. Skip the generator, deliver the lettering. */
        /* v74: a text-only reference used to skip the generator entirely (v48), which was right when
           the generator was blind and returned a black blob of gibberish. flux now draws brush
           lettering with real texture, and the server font is the weakest thing this tool produces on
           exactly the designs where the typography IS the design. So try the generator first and keep
           finishTextOnly as the fallback. */
        /* v80: ...but only when it can spell the wording. Without this gate the branch cancelled
           needsServerText() outright and every long text-only slogan came back mangled. */
        if (wanted && !specUsed.subject && TEXT_ONLY_USES_GENERATOR && generatorCanSpell(wanted.text)) {
          console.log("[reimagine] text-only reference: letting the generator draw the lettering");
          specUsed.text = wanted.text;
          specUsed.typography = wanted.typography || specUsed.typography || "";
          if (!specUsed.subject) specUsed.subject = "";
          wanted = null;
        }

        if (wanted && !specUsed.subject) {
          console.log(
            "[reimagine] text-only reference: skipping the generator, lettering only" +
            ` (${HEBREW_RE.test(wanted.text) ? "Hebrew" : `${wanted.text.replace(/\s+/g, "").length} chars`}` +
            ` - the generator cannot spell it reliably)`
          );
          /* v81: the dark-garment decision reaches this path too. It was made — by the chip or by
             v74's automatic detection — and then thrown away here, because forDark was hardcoded
             false and the inversion lives in finishArtwork, which this path never enters. */
          const textPreset = presetFor(specUsed);
          const out = await finishTextOnly(wanted, t0, isPreview, !!(textPreset && textPreset.invert));
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
                auto: isAuto ? autoNotes : undefined,
                notice: prepared.notice,
                freeLeft: left.freeLeft,
                credits: left.credits,
                owner: !!owner,
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
        /* v80: only the flux path can be redrawn from the spec alone. If the edit path produced this
           artwork, regenerating with flux would swap engines mid-run, so it is left without one. */
        regenerate = () => generateFromSpec(specUsed);
      }

      const chosen = presetFor(specUsed);
      const out = await finishArtwork(
        art, t0, isPreview, !!(chosen && chosen.invert), wanted,
        paletteIsMonochrome(specUsed.palette) && !inkTextureWanted(specUsed) ? specUsed.palette : null,
        regenerate
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
            notice: [prepared.notice, letteringNotice].filter(Boolean).join(" "),
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
