# ElronPrint — אפליקציית מובייל

אפליקציית iOS/Android לחנות elronprint.co.il — בנויה עם Expo (React Native).

## מה יש בגרסה הזאת (שלד — שבוע 1)
- 5 טאבים: בית, סטודיו, חנות, עגלה, חשבון — עברית RTL, עיצוב כהה #141414 + ירוק #00fc25
- סטודיו עיצוב v1: בחירת צבע חולצה, מידה, העלאת תמונה מהגלריה ישירות ל-Cloudinary (preset elronprint) עם תצוגה מקדימה
- חנות: מחוברת ל-Shopify Storefront API (ממתין לטוקן)
- עגלה + checkout: קוד Cart API מוכן ב-lib/shopify.ts

## הפעלה לבדיקה בטלפון
1. npm install
2. npx expo start
3. סורקים את ה-QR עם אפליקציית Expo Go

## חיבור החנות
ב-Shopify Admin: Settings → Apps → Develop apps → יצירת אפליקציה עם הרשאות
Storefront API (unauthenticated_read_product_listings, unauthenticated_write_checkouts)
ואת הטוקן מדביקים ב-app.json תחת extra.SHOPIFY_STOREFRONT_TOKEN

## מבנה
- app/ — המסכים (expo-router)
- lib/theme.ts — צבעי המותג
- lib/shopify.ts — מוצרים + עגלה
- lib/cloudinary.ts — העלאת עיצובים
