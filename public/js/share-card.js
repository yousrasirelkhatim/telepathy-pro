/* =========================================================================
   Telepathy – Share Card generator (Canvas-based, no deps)
   Renders a 1080x1350 (Instagram story / WhatsApp friendly) image card
   with the result, names (optional), and photos (optional).
   ========================================================================= */
(function (global) {
  'use strict';

  const W = 1080, H = 1350;
  const PALETTES = {
    romantic: { a: '#ff5b93', b: '#a855f7', c: '#ffd0e1', label: '💞 رومانسي', heading: 'تحدي القلوب', headingEn: 'Hearts Challenge' },
    fun:      { a: '#00d4ff', b: '#a855f7', c: '#9af0ff', label: '⚡ شبابي',   heading: 'تحدي التخاطر', headingEn: 'Telepathy Challenge' },
    luxury:   { a: '#ffd700', b: '#7c3aed', c: '#fff3b0', label: '👑 فاخر',    heading: 'تحدي توافق العقول', headingEn: 'Minds Match Challenge' },
  };

  function loadFont() {
    return document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function gradient(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([p, c]) => g.addColorStop(p, c));
    return g;
  }

  function drawCircleImage(ctx, img, cx, cy, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      const ratio = Math.max((2 * r) / img.width, (2 * r) / img.height);
      const w = img.width * ratio, h = img.height * ratio;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    } else {
      ctx.fillStyle = '#2a2a4a';
      ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = 'bold 120px Tajawal, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('👤', cx, cy);
    }
    ctx.restore();
    // ring
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
  }

  function drawStars(ctx, count) {
    ctx.save();
    for (let i = 0; i < count; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const r = Math.random() * 2 + 0.5;
      ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawProgressRing(ctx, cx, cy, radius, pct, palette) {
    // Track
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = 26;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();

    // Progress (gradient stroke)
    const grad = gradient(ctx, cx - radius, cy - radius, cx + radius, cy + radius, [
      [0, palette.a], [0.5, palette.b], [1, palette.a],
    ]);
    ctx.beginPath();
    ctx.lineWidth = 26;
    ctx.lineCap = 'round';
    ctx.strokeStyle = grad;
    ctx.shadowColor = palette.b;
    ctx.shadowBlur = 30;
    const start = -Math.PI / 2;
    const end = start + (Math.PI * 2 * pct) / 100;
    ctx.arc(cx, cy, radius, start, end);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function ratingFor(pct, en) {
    if (pct <= 20) return { txt: en ? 'Weak' : 'ضعيف', emoji: '😶' };
    if (pct <= 45) return { txt: en ? 'Good' : 'جيد', emoji: '🙂' };
    if (pct <= 70) return { txt: en ? 'Strong' : 'قوي', emoji: '🔥' };
    return { txt: en ? 'Exceptional' : 'تخاطر استثنائي', emoji: '🧠⚡' };
  }

  function fitText(ctx, text, maxWidth, fontSize, weight, family) {
    let size = fontSize;
    const safeFamily = family || 'Tajawal, sans-serif';
    do {
      ctx.font = `${weight || 'bold'} ${size}px ${safeFamily}`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size >= 28);
    return size;
  }

  /** Render the share card as a Canvas. opts: {pct, name1, name2, photo1, photo2, template, brandName, brandLogo, qrUrl} */
  async function render(opts) {
    await loadFont();
    const palette = PALETTES[opts.template] || PALETTES.fun;
    const en = opts.lang === 'en';
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Background gradient
    const bg = gradient(ctx, 0, 0, W, H, [
      [0,   '#090a1f'],
      [0.46, '#171233'],
      [1,   '#070616'],
    ]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Color glow blobs
    const glow1 = ctx.createRadialGradient(180, 220, 50, 180, 220, 600);
    glow1.addColorStop(0, palette.a + 'aa');
    glow1.addColorStop(1, 'transparent');
    ctx.fillStyle = glow1; ctx.fillRect(0, 0, W, H);

    const glow2 = ctx.createRadialGradient(W - 200, H - 300, 50, W - 200, H - 300, 700);
    glow2.addColorStop(0, palette.b + 'aa');
    glow2.addColorStop(1, 'transparent');
    ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);

    drawStars(ctx, 110);

    // Frame (glass)
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    roundRect(ctx, 64, 64, W - 128, H - 128, 58);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.stroke();

    // Soft inner panel for the score area
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    roundRect(ctx, 118, 560, W - 236, 440, 46);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();

    // Top label / template badge
    ctx.font = '700 34px Tajawal, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText(en ? palette.headingEn : palette.heading, W / 2, 150);

    ctx.font = '900 42px Tajawal, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(en ? 'Telepathy Result Card' : 'بطاقة نتيجة التخاطر', W / 2, 208);

    // Logo / brand top-right
    if (opts.brandName) {
      ctx.font = 'bold 28px Tajawal, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(opts.brandName, W - 90, 118);
    }

    // Photos circle
    const [img1, img2] = await Promise.all([loadImage(opts.photo1), loadImage(opts.photo2)]);
    drawCircleImage(ctx, img1, 268, 375, 92);
    drawCircleImage(ctx, img2, W - 268, 375, 92);

    // Heart / link icon between
    ctx.font = '82px serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = palette.a;
    ctx.shadowColor = palette.a; ctx.shadowBlur = 30;
    ctx.fillText(opts.template === 'romantic' ? '💞' : '🧠', W / 2, 386);
    ctx.shadowBlur = 0;

    // Names
    const n1 = (opts.name1 || (en ? 'Player 1' : 'اللاعب 1')).slice(0, 18);
    const n2 = (opts.name2 || (en ? 'Player 2' : 'اللاعب 2')).slice(0, 18);
    fitText(ctx, `${n1}  ✦  ${n2}`, 760, 56, 'bold');
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`${n1}  ✦  ${n2}`, W / 2, 515);

    // Big result ring
    const cx = W / 2, cy = 755;
    drawProgressRing(ctx, cx, cy, 178, opts.pct || 0, palette);

    // Pct text
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 168px Tajawal, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(opts.pct || 0)}%`, cx, cy - 8);

    ctx.font = '600 38px Tajawal, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(en ? 'Match rate' : 'نسبة التخاطر', cx, cy + 90);

    // Rating
    const r = ratingFor(opts.pct || 0, en);
    fitText(ctx, opts.rating || `${r.emoji}  ${r.txt}`, 680, 54, 'bold');
    const ratingGrad = gradient(ctx, 0, 0, W, 0, [[0, palette.a], [1, palette.b]]);
    ctx.fillStyle = ratingGrad;
    ctx.fillText(opts.rating || `${r.emoji}  ${r.txt}`, cx, 980);

    const phases = opts.phases || [];
    if (phases.length) {
      const cardW = 370;
      const cardH = 92;
      const gapX = 36;
      const gapY = 28;
      const startX = (W - (cardW * 2 + gapX)) / 2;
      const startY = 1048;
      ctx.textAlign = 'center';
      phases.slice(0, 4).forEach((p, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = startX + col * (cardW + gapX);
        const y = startY + row * (cardH + gapY);
        const pct = Math.max(0, Math.min(100, Number(p.pct || 0)));

        ctx.fillStyle = 'rgba(255,255,255,0.065)';
        roundRect(ctx, x, y, cardW, cardH, 24);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = '800 38px Tajawal, sans-serif';
        ctx.fillStyle = gradient(ctx, x, y, x + cardW, y + cardH, [[0, palette.a], [1, palette.b]]);
        ctx.fillText(`${pct}%`, x + cardW / 2, y + 43);

        ctx.font = '700 28px Tajawal, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(p.label, x + cardW / 2, y + 73);

        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        roundRect(ctx, x + 30, y + cardH - 13, cardW - 60, 7, 4);
        ctx.fill();
        ctx.fillStyle = gradient(ctx, x + 30, y, x + cardW - 30, y, [[0, palette.a], [1, palette.b]]);
        const fillW = (cardW - 60) * pct / 100;
        roundRect(ctx, x + 30 + (cardW - 60 - fillW), y + cardH - 13, fillW, 7, 4);
        ctx.fill();
      });
    }

    // Footer
    ctx.font = '500 28px Tajawal, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText(opts.roomCode ? (en ? `Room ${opts.roomCode}  •  Telepathy Challenge` : `غرفة ${opts.roomCode}  •  Telepathy Challenge`) : (en ? 'Telepathy Challenge' : 'Telepathy Challenge  •  تحدي التخاطر'), W / 2, H - 95);

    // Site / QR text
    ctx.font = 'bold 32px Tajawal, sans-serif';
    ctx.fillStyle = palette.a;
    ctx.fillText(opts.siteUrl || 'teleplay.online', W / 2, H - 58);

    return canvas;
  }

  /** Trigger download of canvas as PNG */
  function download(canvas, filename) {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'telepathy-result.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Try Web Share API with a generated image file; fallback to download */
  async function share(canvas, opts) {
    try {
      if (canvas.toBlob && navigator.canShare) {
        return await new Promise((resolve) => {
          canvas.toBlob(async (blob) => {
            const file = new File([blob], 'telepathy-result.png', { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
              try {
                await navigator.share({
                  files: [file],
                  title: 'Telepathy Challenge',
                  text: opts && opts.text || 'نتيجتنا في تحدي التخاطر! 🧠⚡',
                });
                resolve(true);
                return;
              } catch (e) { /* user cancelled */ }
            }
            download(canvas, 'telepathy-result.png');
            resolve(false);
          });
        });
      }
    } catch (e) {}
    download(canvas, 'telepathy-result.png');
    return false;
  }

  function printPdf(canvas, filename) {
    const dataUrl = canvas.toDataURL('image/png');
    const win = window.open('', '_blank');
    if (!win) {
      download(canvas, (filename || 'telepathy-result.pdf').replace(/\.pdf$/i, '.png'));
      return false;
    }
    win.document.write(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${filename || 'telepathy-result.pdf'}</title>
<style>
  @page { size: 1080px 1350px; margin: 0; }
  html,body{margin:0;background:#05050f;width:100%;min-height:100%;display:grid;place-items:center}
  img{width:100vw;max-width:1080px;height:auto;display:block}
  @media print { html,body{background:#05050f} img{width:100%;height:auto} }
</style>
</head>
<body><img alt="Telepathy result card" src="${dataUrl}"><script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body>
</html>`);
    win.document.close();
    return true;
  }

  /** Convert a File (image upload) to a small base64 data URL (max 320x320) */
  function fileToDataURL(file, maxSide = 320) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  global.TPCard = {
    PALETTES,
    render,
    download,
    share,
    printPdf,
    fileToDataURL,
    ratingFor,
  };
})(window);
