{{ 'https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@400;500;700&family=Heebo:wght@300;400;500;600&display=swap' | stylesheet_tag }}
<style>
  .edr { --edr-ink:#101012; --edr-gray:#86868B; --edr-line:#E8E8ED; --edr-blue:#0071E3; background:#fff; color:var(--edr-ink); font-family:'Heebo',system-ui,sans-serif; line-height:1.6; direction:rtl; }
  .edr *{box-sizing:border-box;margin:0;padding:0}
  .edr-wrap{max-width:680px;margin:0 auto;padding:0 24px}
  .edr-hero{padding:80px 0 56px;text-align:center}
  .edr-hero h1{font-family:'Frank Ruhl Libre',serif;font-weight:500;font-size:clamp(34px,6vw,52px);line-height:1.15;letter-spacing:-.01em;color:var(--edr-ink)}
  .edr-hero p{margin-top:18px;font-size:17px;font-weight:300;color:var(--edr-gray);max-width:48ch;margin-inline:auto}
  .edr-section{padding-bottom:64px}
  .edr-upload{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:16px;padding:28px;border:1.5px dashed var(--edr-line);border-radius:14px;flex-wrap:wrap;cursor:pointer;transition:border-color .15s,background .15s}
  .edr-upload.drag{border-color:var(--edr-blue);background:#F5F9FF}
  .edr-upload-thumb{width:64px;height:64px;border-radius:10px;object-fit:cover;border:1px solid var(--edr-line)}
  .edr-upload-text b{display:block;font-size:15px;color:var(--edr-ink)}
  .edr-upload-text span{font-size:13px;color:var(--edr-gray)}
  .edr-btn{border:0;background:var(--edr-blue);color:#fff;font:inherit;font-size:15px;font-weight:500;padding:14px 26px;border-radius:10px;cursor:pointer;transition:background .15s;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;width:100%;margin-top:18px}
  .edr-btn:hover{background:#0077ED}
  .edr-btn:disabled{background:#B8B8BD;cursor:default}
  .edr-btn-ghost{background:transparent;color:var(--edr-blue);border:1px solid var(--edr-line);width:auto}
  .edr-btn-ghost:hover{background:#F5F5F7}
  .edr-hint{margin-top:10px;font-size:13px;color:var(--edr-gray);text-align:center}
  .edr-tip{margin-top:14px;font-size:13.5px;color:#4A4A4F;text-align:center;background:#F5F5F7;border-radius:10px;padding:12px 16px;line-height:1.7}
  .edr-tip b{color:var(--edr-ink);font-weight:600}
  .edr-error{margin-top:18px;font-size:14px;color:#C0392B;text-align:center}
  .edr-proof{padding-bottom:100px}
  .edr-frame{position:relative;padding:26px}
  .edr-canvas{aspect-ratio:3/4;background:repeating-conic-gradient(#FAFAFC 0% 25%,#F2F2F5 0% 50%) 0 0/24px 24px;border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
  .edr-canvas img{width:100%;height:100%;object-fit:contain;display:block}
  .edr-empty{color:var(--edr-gray);font-size:14px;font-weight:300;text-align:center;padding:0 32px}
  .edr-spec{display:flex;justify-content:space-between;gap:12px;margin-top:14px;padding-top:14px;border-top:1px solid var(--edr-line);font-size:11.5px;color:var(--edr-gray);letter-spacing:.05em;flex-wrap:wrap}
  .edr-spec b{color:var(--edr-ink);font-weight:500}
  .edr-actions{display:flex;justify-content:center;margin-top:28px;gap:12px;flex-wrap:wrap}
  .edr-actions .edr-btn{width:auto;margin-top:0}
  .edr-loader{position:absolute;inset:0;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;background:rgba(255,255,255,.75);backdrop-filter:blur(2px);z-index:5}
  .edr-spinner{width:28px;height:28px;border:2px solid var(--edr-line);border-top-color:var(--edr-blue);border-radius:50%;animation:edrspin .8s linear infinite}
  @keyframes edrspin{to{transform:rotate(360deg)}}
  .edr-loader small{color:var(--edr-gray);font-size:13px}
  .edr [hidden]{display:none!important}
  @media (max-width:480px){.edr-hero{padding:56px 0 40px}}
</style>

<div class="edr">
  <section class="edr-hero">
    <div class="edr-wrap">
      <h1>{{ section.settings.heading | default: 'העלו עיצוב, קבלו השראה חדשה' }}</h1>
      <p>{{ section.settings.subheading | default: 'צלמו או העלו תמונה של חולצה עם עיצוב שאהבתם. המערכת תבין את הרעיון והסגנון, ותיצור עבורכם עיצוב חדש ושונה — לא העתקה — מוכן להדפסה.' }}</p>
    </div>
  </section>

  <section class="edr-section">
    <div class="edr-wrap">
      <div class="edr-upload" id="edr-upload">
        <input type="file" id="edr-file" accept="image/png,image/jpeg,image/webp" hidden>
        <img id="edr-file-thumb" class="edr-upload-thumb" hidden alt="">
        <div class="edr-upload-text">
          <b id="edr-upload-title">גררו לכאן תמונה, או לחצו לבחירה</b>
          <span id="edr-upload-sub">חולצה עם עיצוב מודפס — JPG / PNG</span>
        </div>
      </div>

      <button id="edr-generate" class="edr-btn" disabled>צרו לי עיצוב חדש בהשראת זה</button>
      <p class="edr-hint">התוצאה היא עיצוב חדש שנוצר מחדש — לא קובץ מקורי מוגן בזכויות. מומלץ לוודא שיש לכם זכות שימוש בהשראה המקורית.</p>
      <p class="edr-tip">💡 <b>איך זה עובד:</b> המערכת מזהה נושא, סגנון וצבעים בעיצוב שהעליתם, ואז מייצרת גרסה חדשה באותה רוח — עם חופש ליצירתיות (דמות ופרטים משתנים). התהליך אורך כ-20–30 שניות.</p>
      <p id="edr-error" class="edr-error" hidden></p>
    </div>
  </section>

  <section class="edr-proof">
    <div class="edr-wrap">
      <div class="edr-frame">
        <div class="edr-canvas">
          <p class="edr-empty" id="edr-empty">גיליון ההגהה ריק. העלו תמונה כדי להתחיל.</p>
          <img id="edr-result" alt="" hidden>
          <div class="edr-loader" id="edr-loader" hidden>
            <div class="edr-spinner" role="status" aria-label="יוצר עיצוב"></div>
            <small id="edr-status">מנתח את העיצוב…</small>
          </div>
        </div>
        <div class="edr-spec">
          <span>מידות: <b>4500 × 5400 px</b></span>
          <span>רזולוציה: <b>300 DPI</b></span>
          <span>פרופיל: <b>sRGB · PNG שקוף</b></span>
        </div>
      </div>
      <div class="edr-actions" id="edr-actions" hidden>
        <a class="edr-btn" href="{{ section.settings.order_url | default: '/pages/designer' }}">🛒 הזמינו חולצה עם העיצוב</a>
        <a id="edr-download" class="edr-btn edr-btn-ghost" download="elronprint--design.png" target="_blank" rel="noopener">הורדת קובץ לדפוס</a>
        <button id="edr-again" class="edr-btn edr-btn-ghost">נסו וריאציה נוספת</button>
      </div>
      <p class="edr-hint" id="edr-order-hint" hidden>במעצב החולצות: הורידו כאן את הקובץ והעלו אותו בשלב העיצוב.</p>
    </div>
  </section>
</div>

<script>
(function(){
  var API_BASE = ({{ section.settings.api_endpoint | json }} || '').replace(/\/+$/,'').replace(/\/api\/generate$/,'');
  var $ = function(id){ return document.getElementById(id); };
  var uploadBox=$('edr-upload'), fileInput=$('edr-file'), fileThumb=$('edr-file-thumb'),
      uploadTitle=$('edr-upload-title'), uploadSub=$('edr-upload-sub'),
      btn=$('edr-generate'), loader=$('edr-loader'),
      result=$('edr-result'), emptyMsg=$('edr-empty'), actions=$('edr-actions'),
      errorEl=$('edr-error'), download=$('edr-download'), statusEl=$('edr-status'),
      orderHint=$('edr-order-hint');

  var uploadedDataUrl = null;
  var statusTimers = [];

  function readFile(f){
    if(!f) return;
    var img = new Image();
    var reader = new FileReader();
    reader.onload = function(){ img.src = reader.result; };
    img.onload = function(){
      var max = 1280, w = img.width, h = img.height;
      if(w > max || h > max){
        if(w >= h){ h = Math.round(h * max / w); w = max; }
        else { w = Math.round(w * max / h); h = max; }
      }
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      uploadedDataUrl = c.toDataURL('image/jpeg', 0.9);
      fileThumb.src = uploadedDataUrl;
      fileThumb.hidden = false;
      uploadTitle.textContent = 'התמונה נבחרה — אפשר ללחוץ כדי להחליף';
      uploadSub.textContent = f.name;
      btn.disabled = false;
    };
    img.onerror = function(){ uploadSub.textContent = 'התמונה לא נקראה — נסו קובץ אחר'; };
    reader.readAsDataURL(f);
  }

  uploadBox.addEventListener('click', function(){ fileInput.click(); });
  fileInput.addEventListener('change', function(){ readFile(fileInput.files && fileInput.files[0]); });
  ['dragenter','dragover'].forEach(function(ev){
    uploadBox.addEventListener(ev, function(e){ e.preventDefault(); uploadBox.classList.add('drag'); });
  });
  ['dragleave','drop'].forEach(function(ev){
    uploadBox.addEventListener(ev, function(e){ e.preventDefault(); uploadBox.classList.remove('drag'); });
  });
  uploadBox.addEventListener('drop', function(e){
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    readFile(f);
  });

  function post(path, payload){
    return fetch(API_BASE + path, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    }).then(function(res){
      if(!res.ok){ var e = new Error('HTTP '+res.status); e.status = res.status; throw e; }
      return res.json();
    });
  }

  function clearTimers(){
    statusTimers.forEach(clearTimeout);
    statusTimers = [];
  }

  function fail(msg){
    clearTimers();
    loader.hidden=true;
    if(!result.src){ emptyMsg.hidden=false; }
    errorEl.textContent=msg; errorEl.hidden=false; btn.disabled=false;
  }

  function generate(){
    if(!uploadedDataUrl){ uploadBox.click(); return; }
    if(!API_BASE){
      fail('כתובת השרת עדיין לא הוגדרה בהגדרות הסקשן בעורך התים.');
      return;
    }
    btn.disabled=true; errorEl.hidden=true; actions.hidden=true; orderHint.hidden=true;
    result.hidden=true; emptyMsg.hidden=true; loader.hidden=false;
    statusEl.textContent='מנתח את העיצוב…';

    clearTimers();
    statusTimers.push(setTimeout(function(){ statusEl.textContent='מייצר עיצוב חדש…'; }, 5000));
    statusTimers.push(setTimeout(function(){ statusEl.textContent='מסיר רקע ומכין לדפוס…'; }, 14000));
    statusTimers.push(setTimeout(function(){ statusEl.textContent='כמעט שם…'; }, 24000));

    post('/api/reimagine', { image: uploadedDataUrl })
    .then(function(data){
      clearTimers();
      statusEl.textContent='טוען תצוגה…';
      result.src = data.imageUrl;
      result.alt = 'עיצוב חדש בהשראת התמונה שהועלתה';
      result.onload = function(){
        result.hidden=false; loader.hidden=true;
        download.href = data.imageUrl;
        actions.hidden=false; orderHint.hidden=false; btn.disabled=false;
      };
      result.onerror = function(){ fail('התמונה לא נטענה. נסו שוב.'); };
    })
    .catch(function(err){
      if(err && err.status === 429){
        fail('נוצרו יותר מדי עיצובים בזמן קצר. המתינו כמה דקות ונסו שוב.');
      } else if(err && err.status === 404){
        fail('הפיצ׳ר הזה עדיין לא הופעל בשרת — יש להוסיף את /api/reimagine.');
      } else {
        fail('היצירה נכשלה. נסו שוב בעוד רגע.');
      }
    });
  }

  btn.addEventListener('click', generate);
  $('edr-again').addEventListener('click', function(){ generate(); });
})();
</script>

{% schema %}
{
  "name": "EPD Design ",
  "settings": [
    { "type": "text", "id": "heading", "label": "כותרת", "default": "העלו עיצוב, קבלו השראה חדשה" },
    { "type": "textarea", "id": "subheading", "label": "תת-כותרת", "default": "צלמו או העלו תמונה של חולצה עם עיצוב שאהבתם. המערכת תבין את הרעיון והסגנון, ותיצור עבורכם עיצוב חדש ושונה — לא העתקה — מוכן להדפסה." },
    { "type": "text", "id": "api_endpoint", "label": "כתובת שרת (Vercel)", "info": "רק הבסיס, למשל: https://elronprint-studio-api.vercel.app" },
    { "type": "text", "id": "order_url", "label": "קישור כפתור ההזמנה", "info": "ברירת מחדל: /pages/designer (מעצב החולצות)" }
  ],
  "presets": [{ "name": "EPD Design " }]
}
{% endschema %}
