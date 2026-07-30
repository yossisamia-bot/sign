// quick-sign - חתימה על מסמך בדפדפן, בלי שרת ובלי תוכנת החתמה חיצונית.
// הכל קורה במכשיר של החותם: pdf-lib מטמיע את החתימה ב-PDF, ואז שיתוף/צפייה/הורדה.
// הגיאומטריה של מקום החתימה מגיעה מ-meta.json (נכתב ע"י publish.py) - לא מנחשים כאן.
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

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

try {
  const key = await crypto.subtle.importKey('raw', b64ToBytes(keyB64), 'AES-GCM', false, ['decrypt']);
  const base = `docs/${slug}/`;
  const grab = async name => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(name + ' ' + r.status);
    const raw = new Uint8Array(await r.arrayBuffer());
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  };
  const [m, p, prev] = await Promise.all([grab('meta.enc'), grab('doc.enc'), grab('preview.enc')]);
  meta = JSON.parse(new TextDecoder().decode(m));
  pdfBytes = p;
  $('docTitle').textContent = meta.title || 'מסמך לחתימה';
  $('docSub').textContent = [meta.signer ? 'לחתימת ' + meta.signer : '', meta.subtitle]
    .filter(Boolean).join(' · ');
  document.title = meta.title || document.title;
  $('preview').src = URL.createObjectURL(new Blob([prev], { type: 'image/png' }));
  show($('loading'), false);
  show($('app'), true);
} catch (e) {
  fail('לא הצלחנו לפתוח את המסמך. ייתכן שהלינק לא הועבר במלואו, או שהמסמך הוסר. (' +
       (e && e.message ? e.message : e) + ')');
  throw e;
}

/* ---------- לוח החתימה ---------- */
const pad = $('pad');
// הלוח מקבל את הפרופורציה של המקום במסמך, כדי שמה שחותמים הוא מה שנופל שם.
// בלי זה חותמים גדול בלוח גבוה, ה-contain-fit מכווץ לפי הגובה, והחתימה יוצאת זעירה.
{
  const b = meta.sig_rect_topleft;
  // aspect-ratio ולא חישוב גובה ב-JS: הדפדפן עושה את הפריסה, בלי למדוד רוחב שאולי עוד 0.
  pad.style.aspectRatio = (b[2] - b[0]) / (b[3] - b[1]);
}
const ctx = pad.getContext('2d');
let drawing = false, hasInk = false, last = null;

// חייב לרוץ מחדש בכל שינוי פריסה: אם מודדים את הקנבס לפני שהפריסה התייצבה (טאב מוסתר,
// סיבוב מסך, תמונה שנטענת) הוא נשאר בגודל אפסי והחתימה יוצאת מרוחה או בלתי אפשרית.
function sizePad() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const r = pad.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;              // פריסה עוד לא מוכנה
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (w === pad.width && h === pad.height) return;        // בלי לאפס דיו לחינם
  const keep = hasInk ? pad.toDataURL() : null;
  pad.width = w;
  pad.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = '#10233f';
  ctx.lineWidth = 2.6;
  if (keep) { const i = new Image(); i.onload = () => ctx.drawImage(i, 0, 0, r.width, r.height); i.src = keep; }
}
sizePad();
if (window.ResizeObserver) new ResizeObserver(sizePad).observe(pad);
addEventListener('resize', sizePad);
addEventListener('orientationchange', sizePad);
addEventListener('load', sizePad);
$('preview').addEventListener('load', sizePad);

const pt = ev => {
  const r = pad.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
};
pad.addEventListener('pointerdown', ev => {
  ev.preventDefault();
  pad.setPointerCapture?.(ev.pointerId);
  drawing = true; last = pt(ev);
  ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(last.x + 0.1, last.y); ctx.stroke();
  ink();
});
pad.addEventListener('pointermove', ev => {
  if (!drawing) return;
  ev.preventDefault();
  const p = pt(ev);
  ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
  last = p;
});
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
  pad.addEventListener(t, () => { drawing = false; });
}
function ink() { hasInk = true; pad.classList.add('has'); $('signBtn').disabled = false; }
function clearPad() {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pad.width, pad.height); ctx.restore();
  hasInk = false; pad.classList.remove('has'); $('signBtn').disabled = true;
  const o = $('overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
}
$('clearBtn').addEventListener('click', clearPad);

/* חיתוך למלבן הדיו בפועל - כדי שהחתימה לא תיראה זעירה בתוך מסגרת ריקה */
function trimmed() {
  const w = pad.width, h = pad.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad2 = Math.round(Math.min(w, h) * 0.02);
  x0 = Math.max(0, x0 - pad2); y0 = Math.max(0, y0 - pad2);
  x1 = Math.min(w - 1, x1 + pad2); y1 = Math.min(h - 1, y1 + pad2);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(pad, x0, y0, cw, ch, 0, 0, cw, ch);
  return { canvas: c, w: cw, h: ch };
}

/* התאמה "contain" של החתימה לתוך המלבן שהוגדר במסמך */
function fit(box, iw, ih) {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const s = Math.min(bw / iw, bh / ih);
  const w = iw * s, h = ih * s;
  return { x: box[0] + (bw - w) / 2, yTop: box[3] - h, w, h };
}

/* סימון החתימה על התצוגה המקדימה, כדי שהחותם יראה מיד שזה נפל במקום */
function overlay(img, box) {
  const o = $('overlay'), r = $('preview').getBoundingClientRect();
  if (!r.width) return;
  const [pw, ph] = meta.page_size;
  o.width = Math.round(r.width); o.height = Math.round(r.height);
  const g = o.getContext('2d');
  g.clearRect(0, 0, o.width, o.height);
  const f = fit(box, img.w, img.h);
  g.drawImage(img.canvas, f.x / pw * o.width, f.yTop / ph * o.height,
              f.w / pw * o.width, f.h / ph * o.height);
}

/* ---------- הטמעה ב-PDF ---------- */
$('signBtn').addEventListener('click', async () => {
  const btn = $('signBtn');
  btn.disabled = true; btn.textContent = 'רגע...';
  try {
    const img = trimmed();
    if (!img) throw new Error('לא זוהתה חתימה');
    const box = meta.sig_rect_topleft;
    const doc = await PDFDocument.load(pdfBytes);
    const page = doc.getPage((meta.page || 1) - 1);
    const H = page.getHeight();
    const png = await doc.embedPng(img.canvas.toDataURL('image/png'));
    const f = fit(box, img.w, img.h);
    // pdf-lib מודד y מלמטה; ה-box שלנו הוא מקור שמאל-עליון. לכן היפוך.
    page.drawImage(png, { x: f.x, y: H - f.yTop - f.h, width: f.w, height: f.h });
    signedBytes = await doc.save();
    if (signedUrl) URL.revokeObjectURL(signedUrl);
    signedUrl = URL.createObjectURL(new Blob([signedBytes], { type: 'application/pdf' }));
    overlay(img, box);
    show($('signStep'), false);
    show($('doneStep'), true);
    setupDone();
    $('doneStep').scrollIntoView({ behavior: 'smooth', block: 'center' });
    // hook לאימות אוטומטי (לא בשימוש ה-UI): מאפשר להוציא את התוצר ולהסתכל עליו,
    // במקום להסתמך על "החתימה הוטמעה" כטענה לא מאומתת.
    window.__signed = { bytes: signedBytes.length, head: new TextDecoder().decode(signedBytes.slice(0, 5)),
                        placed: f, pageHeight: H, raw: signedBytes };
  } catch (e) {
    alert('משהו נתקע בהטמעת החתימה: ' + e.message);
    btn.disabled = false; btn.textContent = 'אישור החתימה';
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
  clearPad();
  signedBytes = null;
  if (signedUrl) { URL.revokeObjectURL(signedUrl); signedUrl = null; }
  $('signBtn').textContent = 'אישור החתימה';
  show($('doneStep'), false);
  show($('signStep'), true);
});
