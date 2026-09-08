// api/_print.js — הכנת קובץ הדפסה, משותפת לכל הכלים
// ------------------------------------------------------------------
// אותה לוגיקה שכבר עובדת ב-extract.js / separate.js / reimagine.js:
// חיתוך שוליים שקופים -> הקטנה לשוליים בטוחים -> מרכוז על קנבס שקוף
// 4500x5400 -> כתיבת density 300 -> העלאה לקלאודינרי -> החזרת קישור.
//
// קובץ שמתחיל ב-_ אינו נחשב פונקציה בוורסל אלא ספרייה פנימית,
// ולכן הוא לא מוסיף פונקציה למכסה של תוכנית ה-Hobby.
// ------------------------------------------------------------------
import sharp from "sharp";

export const CANVAS_W = 4500, CANVAS_H = 5400, SAFE = 0.97, DPI = 300;

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "dztd5g0p8";
const CLOUD_PRESET = process.env.CLOUDINARY_PRESET || "elronprint";

export async function toPrintCanvas(buf) {
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
  console.log(`[print] artwork ${m.width}x${m.height} centred on ${CANVAS_W}x${CANVAS_H}`);

  return sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: inner, left: Math.round((CANVAS_W - m.width) / 2), top: Math.round((CANVAS_H - m.height) / 2) }])
    .withMetadata({ density: DPI })
    .png({ compressionLevel: 3, effort: 1 })
    .toBuffer();
}

export async function fitUploadSize(buffer) {
  const MAX = 9.5 * 1024 * 1024;
  if (buffer.length <= MAX) return buffer;
  console.warn(`[print] png ${(buffer.length / 1048576).toFixed(1)}MB - re-encoding as palette`);
  return sharp(buffer)
    .png({ compressionLevel: 9, palette: true, colours: 256, dither: 1 })
    .withMetadata({ density: DPI })
    .toBuffer();
}

export async function uploadCloudinary(buffer, name = "print-4500x5400.png") {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), name);
  form.append("upload_preset", CLOUD_PRESET);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: "POST", body: form });
  const text = await r.text();
  if (!r.ok) {
    console.error("[print] cloudinary failed:", r.status, text.slice(0, 300));
    throw new Error("Upload failed");
  }
  const d = JSON.parse(text);
  if (!d.secure_url) throw new Error("Upload failed");
  return d.secure_url;
}

/* הקלט: כתובת של תמונה שקופה. הפלט: כתובת קובץ הדפסה 4500x5400, 300 DPI. */
export async function makePrintFile(imageUrl) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error("fetch failed " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const png = await fitUploadSize(await toPrintCanvas(buf));
  return uploadCloudinary(png);
}
