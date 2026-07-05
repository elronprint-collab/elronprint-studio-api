# ElronPrint Studio API — הוראות פריסה (5 דקות)

## מה זה
שני endpoints שמחברים את עמוד "סטודיו AI" בחנות ל-fal.ai:
- `POST /api/generate` — יצירת עיצוב (FLUX.1 dev, יחס 3:4)
- `POST /api/upscale` — אפסקייל x3 לרזולוציית דפוס

CORS כבר מוגדר ל: elronprint.co.il, www, *.myshopify.com, *.shopifypreview.com

## שלבי פריסה

1. הרשמה/כניסה ל-https://fal.ai → יצירת API Key (בעמוד Keys)
2. כניסה ל-https://vercel.com (אפשר עם GitHub)
3. פריסה — הדרך הקלה, בלי CLI:
   - Add New → Project → העלאת התיקייה הזו (או חיבור repo)
   - לפני Deploy: Environment Variables → הוספת `FAL_KEY` עם המפתח מ-fal
   - Deploy
4. העתקת הכתובת שמתקבלת, למשל: `https://elronprint-studio-api.vercel.app`
5. בשופיפיי: עורך התים → עמוד "סטודיו AI" → סקשן EPD AI Studio →
   בשדה "כתובת שרת (Vercel)" מדביקים את הכתובת **בלי** /api/generate בסוף.

## בדיקה
```
curl -X POST https://YOUR-URL.vercel.app/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"geometric lion, gold lines"}'
```
צריך לחזור JSON עם imageUrl.

## עלויות
fal.ai: בערך $0.03–0.05 לעיצוב (יצירה + אפסקייל). Vercel Hobby: חינם.
