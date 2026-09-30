// quick-sign - חתימה על מסמך בדפדפן, בלי שרת ובלי תוכנת החתמה חיצונית.
// הכל קורה במכשיר של החותם: pdf-lib מטמיע את החתימה ב-PDF, ואז שיתוף/צפייה/הורדה.
// הגיאומטריה של השדות מגיעה מ-meta (נכתב ע"י publish.py) - לא מנחשים כאן.
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const $ = id => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hide', !on);

function fail(msg) {
  show($('loading'), false);
  show($('app'), false);
  const e = $('err');
  e.textContent = msg;
  show(e, true);
}

const slug = new URLSearchParams(location.search).get('d');
// המפתח יושב ב-fragment של הכתובת (#k=...) ולכן לא נשלח לשרת ולא נשמר בשום לוג.
// הקבצים ב-repo מוצפנים: ה-repo ציבורי (GitHub Pages), והמסמכים מכילים ת.ז וכתובות.
const keyB64 = new URLSearchParams(location.hash.slice(1)).get('k');
if (!slug || !/^[a-z0-9-]{3,64}$/.test(slug)) {
  fail('חסר מזהה מסמך בכתובת. בקשו את הלינק המלא מיוסי.');
  throw new Error('bad slug');
}
if (!keyB64) {
  fail('הלינק חסר את המפתח לפתיחת המסמך. כנראה נחתך בהעברה - בקשו את הלינק המלא מיוסי.');
  throw new Error('no key');
}

const b64ToBytes = s => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};

let meta, pdfBytes, signedBytes = null, signedUrl = null;
let fields = [], pageEls = [];

try {
  const key = await crypto.subtle.importKey('raw', b64ToBytes(keyB64), 'AES-GCM', false, ['decrypt']);
  const base = `docs/${slug}/`;
  const grab = async name => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(name + ' ' + r.status);
    const raw = new Uint8Array(await r.arrayBuffer());
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  };
  const [m, p] = await Promise.all([grab('meta.enc'), grab('doc.enc')]);
  meta = JSON.parse(new TextDecoder().decode(m));
  pdfBytes = p;

  // תאימות לאחור: מסמכים שפורסמו לפני שהיו שדות מרובים.
  if (!meta.fields) {
    meta.fields = [{ type: 'sig', page: meta.page || 1, rect: meta.sig_rect_topleft }];
    meta.page_count = 1;
    meta.page_sizes = [meta.page_size];
  }
  fields = meta.fields;

  $('docTitle').textContent = meta.title || 'מסמך לחתימה';
  $('docSub').textContent = [meta.signer ? 'לחתימת ' + meta.signer : '', meta.subtitle]
    .filter(Boolean).join(' · ');
  document.title = meta.title || document.title;

  // כל העמודים, כדי שאפשר יהיה לקרוא את מה שחותמים עליו. מסמך ישן = עמוד אחד בלבד.
  const holder = $('docScroll');
  const legacyPrev = meta.page_count ? null : await grab('preview.enc');
  for (let n = 1; n <= (meta.page_count || 1); n++) {
    const bytes = legacyPrev || await grab(`page-${n}.enc`);
    const wrap = document.createElement('div');
    wrap.className = 'pg';
    const img = document.createElement('img');
    img.alt = `עמוד ${n}`;
    img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    const tag = document.createElement('div');
    tag.className = 'pgNum';
    tag.textContent = `${n} / ${meta.page_count || 1}`;
    wrap.append(img, cv, tag);
    holder.append(wrap);
    pageEls[n] = { wrap, img, cv };
    img.addEventListener('load', () => { paintPage(n); sizeAllPads(); });
  }
  show($('loading'), false);
  show($('app'), true);
} catch (e) {
  fail('לא הצלחנו לפתוח את המסמך. ייתכן שהלינק לא הועבר במלואו, או שהמסמך הוסר. (' +
       (e && e.message ? e.message : e) + ')');
  throw e;
}

const has = t => fields.some(f => f.type === t);
const nOf = t => fields.filter(f => f.type === t).length;

/* ---------- מה נדרש מהחותם, כתוב מראש ---------- */
{
  const items = [];
  if (has('sig')) items.push(['חתימה', nOf('sig') === 1 ? 'במקום אחד' : `ב-${nOf('sig')} מקומות`]);
  if (has('initials')) items.push(['ראשי תיבות', `בתחתית ${nOf('initials')} עמודים`]);
  if (has('date')) items.push(['תאריך', nOf('date') === 1 ? 'במקום אחד' : `ב-${nOf('date')} מקומות`]);
  $('todo').innerHTML = items.map(([a, b]) => `<li>✍️ <span><b>${a}</b> – ${b}</span></li>`).join('');
  $('docHint').textContent = (meta.page_count || 1) > 1
    ? 'גוללים בתוך המסגרת כדי לעבור על כל העמודים. המקומות שממתינים לכם מסומנים בירוק.'
    : 'גוללים בתוך המסגרת כדי לקרוא הכל. המקום שממתין לכם מסומן בירוק.';
}

/* ---------- ציור סימוני השדות / התוצאה על העמודים ---------- */
const LABEL = { sig: 'חתימה', initials: 'ר״ת', date: 'תאריך' };

function paintPage(n) {
  const pe = pageEls[n];
  if (!pe) return;
  const r = pe.img.getBoundingClientRect();
  if (r.width < 10) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  pe.cv.width = Math.round(r.width * dpr);
  pe.cv.height = Math.round(r.height * dpr);
  const g = pe.cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  const [pw, ph] = meta.page_sizes[n - 1];
  const sx = r.width / pw, sy = r.height / ph;

  for (const f of fields.filter(f => f.page === n)) {
    const [x0, y0, x1, y1] = f.rect;
    const bx = x0 * sx, by = y0 * sy, bw = (x1 - x0) * sx, bh = (y1 - y0) * sy;
    const art = filled[f.type];
    if (art) {
      if (f.type === 'date') {
        drawDateOnCanvas(g, art, { x: bx, y: by, w: bw, h: bh });
      } else {
        const fit2 = fit(f.rect, art.w, art.h);
        g.drawImage(art.canvas, fit2.x * sx, fit2.yTop * sy, fit2.w * sx, fit2.h * sy);
      }
    } else {
      g.save();
      g.strokeStyle = '#0b6b3a';
      g.fillStyle = 'rgba(11,107,58,.10)';
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.fillRect(bx, by, bw, bh);
      g.strokeRect(bx, by, bw, bh);
      g.restore();
      if (bh > 13 && bw > 26) {
        g.save();
        g.fillStyle = '#0b6b3a';
        g.font = `600 ${Math.min(11, bh * 0.5).toFixed(0)}px -apple-system,"Segoe UI",Arial`;
        g.textBaseline = 'middle';
        const t = LABEL[f.type];
        g.fillText(t, bx + bw / 2 - g.measureText(t).width / 2, by + bh / 2);
        g.restore();
      }
    }
  }
}
function paintAll() { for (let n = 1; n <= (meta.page_count || 1); n++) paintPage(n); }
addEventListener('resize', paintAll);
addEventListener('orientationchange', paintAll);

function drawDateOnCanvas(g, art, box) {
  g.save();
  g.fillStyle = '#10233f';
  const size = Math.min(box.h * 0.72, 15);
  g.font = `${size.toFixed(1)}px "Segoe UI",Arial,sans-serif`;
  g.textBaseline = 'alphabetic';
  g.fillText(art.text, box.x + 3, box.y + box.h - size * 0.28);
  g.restore();
}

/* ---------- לוחות הכתיבה ---------- */
const filled = { sig: null, initials: null, date: null };
const pads = [];

// הדיו נשמר כקווים (נקודות ביחידות CSS של הלוח), לא רק כפיקסלים על הקנבס. אצבע שגולשת
// מעבר לשפת הלוח ממשיכה להירשם (pointer capture), והחתימה שנכנסת למסמך נבנית מחדש מכל
// הנקודות - כולל מה שמחוץ למסגרת - ואז מוקטנת למלבן במסמך (fit). 30/09/2026: החתימה של
// נירית על טופסי 8879 יצאה חתוכה למעלה ולמטה, כי הקנבס שמר רק את מה שבתוך המסגרת.
const INK = '#1f3a93', INK_W = 2.0;
const OUT_SCALE = 3;        // רזולוציית החתימה שנכנסת ל-PDF, לא תלויה במסך של החותם
const OUT_MAX_PX = 4000;    // תקרה - אצבע שנגררה על כל המסך לא תייצר תמונה ענקית

function inkStyle(g) { g.lineCap = g.lineJoin = 'round'; g.strokeStyle = INK; g.lineWidth = INK_W; }
function paintStroke(g, s) {
  g.beginPath(); g.moveTo(s[0].x, s[0].y);
  if (s.length === 1) g.lineTo(s[0].x + 0.1, s[0].y);   // נקודה בודדת (נקודה על i)
  for (let i = 1; i < s.length; i++) g.lineTo(s[i].x, s[i].y);
  g.stroke();
}

function makePad(canvas, aspect) {
  const ctx = canvas.getContext('2d');
  canvas.style.aspectRatio = aspect;
  let drawing = false, cur = null, baseW = 0;
  const strokes = [];

  function redraw() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
    for (const s of strokes) paintStroke(ctx, s);
  }

  // חייב לרוץ מחדש בכל שינוי פריסה: אם מודדים את הקנבס לפני שהפריסה התייצבה (טאב
  // מוסתר, סיבוב מסך, תמונה שנטענת) הוא נשאר בגודל אפסי והחתימה יוצאת מרוחה.
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = canvas.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w === canvas.width && h === canvas.height) return;
    // הלוח שינה גודל (סיבוב מסך): הנקודות גדלות/קטנות איתו, בלי מתיחת פיקסלים
    if (baseW && strokes.length) {
      const k = r.width / baseW;
      for (const s of strokes) for (const p of s) { p.x *= k; p.y *= k; }
    }
    baseW = r.width;
    canvas.width = w; canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkStyle(ctx);
    redraw();
  }
  size();
  if (window.ResizeObserver) new ResizeObserver(size).observe(canvas);

  const pt = ev => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    canvas.setPointerCapture?.(ev.pointerId);
    drawing = true; cur = [pt(ev)]; strokes.push(cur);
    paintStroke(ctx, cur);
    canvas.classList.add('has'); refreshReady();
  });
  canvas.addEventListener('pointermove', ev => {
    if (!drawing) return;
    ev.preventDefault();
    const p = pt(ev), last = cur[cur.length - 1];
    cur.push(p);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
  });
  const end = () => { drawing = false; cur = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // יציאה מהמסגרת לא עוצרת את הקו כל עוד האצבע על המסך (capture) - זה כל הרעיון
  canvas.addEventListener('pointerleave', ev => {
    if (!canvas.hasPointerCapture?.(ev.pointerId)) end();
  });

  const api = {
    size,
    get hasInk() { return strokes.length > 0; },
    clear() {
      strokes.length = 0; end(); redraw();
      canvas.classList.remove('has'); refreshReady();
    },
    /* החתימה במלבן הדיו בפועל (כולל מה שמחוץ ללוח) - כדי שהכתב לא ייראה זעיר בתוך
       מסגרת ריקה ולא ייחתך בשפה */
    trimmed() {
      if (!strokes.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of strokes) for (const p of s) {
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      const m = INK_W + Math.max(x1 - x0, y1 - y0) * 0.02;
      x0 -= m; y0 -= m; x1 += m; y1 += m;
      const k = Math.min(OUT_SCALE, OUT_MAX_PX / Math.max(x1 - x0, y1 - y0));
      const cw = Math.max(1, Math.ceil((x1 - x0) * k)), ch = Math.max(1, Math.ceil((y1 - y0) * k));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const g = c.getContext('2d');
      g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
      inkStyle(g);
      for (const s of strokes) paintStroke(g, s);
      return { canvas: c, w: cw, h: ch };
    },
  };
  pads.push(api);
  return api;
}
function sizeAllPads() { for (const p of pads) p.size(); }
addEventListener('load', sizeAllPads);

// הלוח מקבל פרופורציה נוחה לכתיבה ביד ולא את זו של המלבן במסמך: מלבן חתימה על קו
// הוא שטוח קיצוני (6:1), ולוח כזה בנייד הוא רצועה שאי אפשר לחתום בה. החיתוך למלבן
// הדיו + contain-fit מחזירים ממילא את הפרופורציה הטבעית של הכתב.
const sigPad = has('sig') ? makePad($('pad'), 2.2) : null;   // היה 3 - לוח נמוך מדי בנייד (30/09)
const iniPad = has('initials') ? makePad($('iniPad'), 2.2) : null;
show($('sigBox'), has('sig'));
show($('iniBox'), has('initials'));
show($('dateBox'), has('date'));
if (iniPad) $('iniHint').textContent =
  `ראשי תיבות בלבד - הם ייפלו בתחתית כל אחד מ-${nOf('initials')} העמודים.`;
$('clearBtn')?.addEventListener('click', () => sigPad.clear());
$('iniClearBtn')?.addEventListener('click', () => iniPad.clear());

/* ---------- תאריך ---------- */
const dateInput = $('dateInput');
if (has('date')) {
  const d = new Date();
  const p2 = v => String(v).padStart(2, '0');
  const fmt = meta.date_format || '%d/%m/%Y';
  dateInput.value = fmt
    .replace('%d', p2(d.getDate())).replace('%m', p2(d.getMonth() + 1))
    .replace('%Y', d.getFullYear());
  dateInput.placeholder = fmt.replace('%d', 'DD').replace('%m', 'MM').replace('%Y', 'YYYY');
  dateInput.addEventListener('input', refreshReady);
}

function refreshReady() {
  const ok = (!has('sig') || sigPad.hasInk)
          && (!has('initials') || iniPad.hasInk)
          && (!has('date') || dateInput.value.trim().length >= 4);
  $('signBtn').disabled = !ok;
  const missing = [];
  if (has('sig') && !sigPad.hasInk) missing.push('חתימה');
  if (has('initials') && !iniPad.hasInk) missing.push('ראשי תיבות');
  if (has('date') && dateInput.value.trim().length < 4) missing.push('תאריך');
  $('signHint').textContent = missing.length ? 'עוד חסר: ' + missing.join(', ') : '';
}
refreshReady();

/* התאמה "contain" של הכתב לתוך המלבן שהוגדר במסמך */
function fit(box, iw, ih) {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const s = Math.min(bw / iw, bh / ih);
  const w = iw * s, h = ih * s;
  return { x: box[0] + (bw - w) / 2, yTop: box[3] - h, w, h };
}

/* ---------- הטמעה ב-PDF ---------- */
$('signBtn').addEventListener('click', async () => {
  const btn = $('signBtn');
  btn.disabled = true; btn.textContent = 'רגע...';
  try {
    const sigImg = has('sig') ? sigPad.trimmed() : null;
    const iniImg = has('initials') ? iniPad.trimmed() : null;
    if (has('sig') && !sigImg) throw new Error('לא זוהתה חתימה');
    if (has('initials') && !iniImg) throw new Error('לא זוהו ראשי תיבות');
    const dateText = has('date') ? dateInput.value.trim() : '';

    const doc = await PDFDocument.load(pdfBytes);
    const font = has('date') ? await doc.embedFont(StandardFonts.Helvetica) : null;
    const pngs = {};
    if (sigImg) pngs.sig = await doc.embedPng(sigImg.canvas.toDataURL('image/png'));
    if (iniImg) pngs.initials = await doc.embedPng(iniImg.canvas.toDataURL('image/png'));

    for (const f of fields) {
      const page = doc.getPage(f.page - 1);
      const H = page.getHeight();
      const [x0, y0, x1, y1] = f.rect;
      if (f.type === 'date') {
        // גודל שמתאים לגובה המלבן, ואם הטקסט רחב מדי - מצטמצם כדי לא לגלוש החוצה.
        let size = Math.min((y1 - y0) * 0.72, 12);
        const maxW = (x1 - x0) - 4;
        while (size > 5 && font.widthOfTextAtSize(dateText, size) > maxW) size -= 0.5;
        // pdf-lib מודד y מלמטה; ה-rect שלנו הוא מקור שמאל-עליון.
        page.drawText(dateText, {
          x: x0 + 3, y: H - y1 + size * 0.28, size, font, color: rgb(0.122, 0.227, 0.576),
        });
      } else {
        const img = f.type === 'sig' ? sigImg : iniImg;
        const f2 = fit(f.rect, img.w, img.h);
        page.drawImage(pngs[f.type], {
          x: f2.x, y: H - f2.yTop - f2.h, width: f2.w, height: f2.h,
        });
      }
    }

    signedBytes = await doc.save();
    if (signedUrl) URL.revokeObjectURL(signedUrl);
    signedUrl = URL.createObjectURL(new Blob([signedBytes], { type: 'application/pdf' }));

    // הצגת התוצאה על התצוגה המקדימה, כדי שהחותם יראה מיד שהכל נפל במקום
    filled.sig = sigImg;
    filled.initials = iniImg;
    filled.date = dateText ? { text: dateText } : null;
    paintAll();

    const parts = [];
    if (has('sig')) parts.push(nOf('sig') === 1 ? 'החתימה' : `${nOf('sig')} החתימות`);
    if (has('initials')) parts.push(`ראשי התיבות ב-${nOf('initials')} עמודים`);
    if (has('date')) parts.push('התאריך');
    $('doneMsg').textContent =
      // ו' החיבור נדבקת למילה, בלי הרווח שנשאר מה-join (יצא "ו התאריך")
      parts.join(', ').replace(/,\s*([^,]*)$/, ' ו$1') + ' נוספו למסמך. נשאר רק לשלוח אותו חזרה.';

    show($('fillStep'), false);
    show($('doneStep'), true);
    setupDone();
    $('doneStep').scrollIntoView({ behavior: 'smooth', block: 'center' });
    // hook לאימות אוטומטי (לא בשימוש ה-UI): מאפשר להוציא את התוצר ולהסתכל עליו,
    // במקום להסתמך על "החתימה הוטמעה" כטענה לא מאומתת.
    window.__signed = { bytes: signedBytes.length,
                        head: new TextDecoder().decode(signedBytes.slice(0, 5)),
                        fields: fields.length, raw: signedBytes };
  } catch (e) {
    alert('משהו נתקע בהחתמת המסמך: ' + e.message);
    btn.disabled = false; btn.textContent = 'אישור והחתמת המסמך';
  }
});

/* ---------- צפייה / שיתוף / הורדה ---------- */
function fileName() {
  return meta.file_name || ((meta.title || 'מסמך') + ' - חתום.pdf');
}
function signedFile() {
  return new File([new Blob([signedBytes], { type: 'application/pdf' })], fileName(),
                  { type: 'application/pdf' });
}
function canShareFiles() {
  try {
    const probe = new File([new Blob(['x'], { type: 'application/pdf' })], 'a.pdf',
                           { type: 'application/pdf' });
    return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch { return false; }
}

function setupDone() {
  // המטרה: שגם מי שלא טכנולוגי יסיים לבד. לכן "שליחה חזרה" הוא הכפתור הגדול והראשון,
  // וצפייה/שמירה משניים. אם השיתוף לא נתמך (בעיקר במחשב) - שמירה הופכת לראשית.
  const share = canShareFiles();
  show($('shareBtn'), share);
  const to = meta.share_email || '';
  if (to) {
    $('mailBtn').href = 'mailto:' + to +
      '?subject=' + encodeURIComponent(fileName()) +
      '&body=' + encodeURIComponent('מצורף המסמך החתום.\n(יש לצרף את הקובץ שנשמר במכשיר.)');
  }
  show($('mailBtn'), !share && !!to);
  $('dlBtn').classList.toggle('primary', !share);
  $('doneHint').textContent = share
    ? 'הכפתור פותח את רשימת האפליקציות, בוחרים וואטסאפ (או מייל) והקובץ נשלח מצורף.'
    : 'במחשב: שומרים את הקובץ ומצרפים אותו לוואטסאפ או למייל.';
}

$('viewBtn').addEventListener('click', () => {
  const w = window.open(signedUrl, '_blank');
  if (!w) location.href = signedUrl;
});
$('dlBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = signedUrl; a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
});
$('shareBtn').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [signedFile()], title: fileName(),
                            text: meta.share_text || 'מצורף המסמך החתום.' });
  } catch (e) {
    if (e && e.name !== 'AbortError') alert('השיתוף לא נפתח. אפשר להוריד ולצרף ידנית.');
  }
});
$('againBtn').addEventListener('click', () => {
  sigPad?.clear();
  iniPad?.clear();
  filled.sig = filled.initials = filled.date = null;
  paintAll();
  signedBytes = null;
  if (signedUrl) { URL.revokeObjectURL(signedUrl); signedUrl = null; }
  $('signBtn').textContent = 'אישור והחתמת המסמך';
  show($('doneStep'), false);
  show($('fillStep'), true);
  refreshReady();
});
