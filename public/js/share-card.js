/* =========================================================================
   Telepathy – Share Card generator (Canvas-based, no deps)
   Renders a 1080x1350 (Instagram story / WhatsApp friendly) image card
   ========================================================================= */
(function (global) {
  'use strict';

  const W = 1080, H = 1350;
  const PALETTES = {
    romantic: { a: '#ff5b93', b: '#c026d3', c: '#ffd0e1', label: '💞 رومانسي', heading: 'تحدي القلوب', headingEn: 'Hearts Challenge', icon: '💞' },
    fun:      { a: '#22d3ee', b: '#a855f7', c: '#9af0ff', label: '⚡ شبابي',   heading: 'تحدي التخاطر', headingEn: 'Telepathy Challenge', icon: '🧠' },
    luxury:   { a: '#ffd700', b: '#7c3aed', c: '#fff3b0', label: '👑 فاخر',    heading: 'تحدي توافق العقول', headingEn: 'Minds Match Challenge', icon: '👑' },
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
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function gradient(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([p, c]) => g.addColorStop(p, c));
    return g;
  }

  function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function drawStars(ctx, count, seed) {
    const rnd = seededRandom(seed || 42);
    ctx.save();
    for (let i = 0; i < count; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const r = rnd() * 1.8 + 0.4;
      ctx.fillStyle = `rgba(255,255,255,${0.12 + rnd() * 0.55})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawGrid(ctx) {
    ctx.save();
    ctx.globalAlpha = 0.04;
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 48) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 48) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawNeonFrame(ctx, palette) {
    const pad = 48;
    const r = 52;
    ctx.save();
    ctx.shadowColor = palette.b;
    ctx.shadowBlur = 28;
    ctx.strokeStyle = gradient(ctx, pad, pad, W - pad, H - pad, [[0, palette.a], [0.5, palette.b], [1, palette.a]]);
    ctx.lineWidth = 4;
    roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, r);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    roundRect(ctx, pad + 10, pad + 10, W - pad * 2 - 20, H - pad * 2 - 20, r - 8);
    ctx.stroke();
    ctx.restore();
  }

  function drawCircleImage(ctx, img, cx, cy, r, ringColor) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = gradient(ctx, cx - r, cy - r, cx + r, cy + r, [[0, ringColor || '#fff'], [1, 'rgba(255,255,255,0.4)']]);
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      const ratio = Math.max((2 * r) / img.width, (2 * r) / img.height);
      const w = img.width * ratio, h = img.height * ratio;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    } else {
      ctx.fillStyle = '#1a1238';
      ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = 'bold 72px Tajawal, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('👤', cx, cy);
    }
    ctx.restore();
  }

  function drawProgressRing(ctx, cx, cy, radius, pct, palette) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = 22;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.stroke();

    const grad = gradient(ctx, cx - radius, cy - radius, cx + radius, cy + radius, [
      [0, palette.a], [0.5, palette.b], [1, palette.a],
    ]);
    ctx.beginPath();
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.strokeStyle = grad;
    ctx.shadowColor = palette.b;
    ctx.shadowBlur = 24;
    const start = -Math.PI / 2;
    const end = start + (Math.PI * 2 * Math.max(0, Math.min(100, pct))) / 100;
    ctx.arc(cx, cy, radius, start, end);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function ratingFor(pct, en) {
    if (pct <= 20) return { txt: en ? 'Weak' : 'ضعيف', emoji: '😶', color: '#94a3b8' };
    if (pct <= 45) return { txt: en ? 'Good' : 'جيد', emoji: '🙂', color: '#22d3ee' };
    if (pct <= 70) return { txt: en ? 'Strong' : 'قوي', emoji: '🔥', color: '#f97316' };
    return { txt: en ? 'Exceptional' : 'تخاطر استثنائي', emoji: '🧠⚡', color: '#a855f7' };
  }

  function fitText(ctx, text, maxWidth, fontSize, weight, family) {
    let size = fontSize;
    const safeFamily = family || 'Tajawal, sans-serif';
    do {
      ctx.font = `${weight || 'bold'} ${size}px ${safeFamily}`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size >= 24);
    return size;
  }

  function drawPhaseRow(ctx, phases, palette, startY, en) {
    const items = phases.slice(0, 4);
    if (!items.length) return;
    const gap = 16;
    const cardW = (W - 128 - gap * 3) / 4;
    const cardH = 118;
    const startX = 64;

    items.forEach((p, i) => {
      const x = startX + i * (cardW + gap);
      const y = startY;
      const pct = Math.max(0, Math.min(100, Number(p.pct || 0)));

      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      roundRect(ctx, x, y, cardW, cardH, 18);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.font = '800 30px Tajawal, sans-serif';
      ctx.fillStyle = gradient(ctx, x, y, x + cardW, y, [[0, palette.a], [1, palette.b]]);
      ctx.textAlign = 'center';
      ctx.fillText(`${pct}%`, x + cardW / 2, y + 46);

      const labelSize = fitText(ctx, p.label, cardW - 16, 22, '700');
      ctx.font = `700 ${labelSize}px Tajawal, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(p.label, x + cardW / 2, y + 78);

      const barX = x + 14;
      const barW = cardW - 28;
      const barY = y + cardH - 18;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      roundRect(ctx, barX, barY, barW, 6, 3);
      ctx.fill();
      if (pct > 0) {
        ctx.fillStyle = gradient(ctx, barX, barY, barX + barW, barY, [[0, palette.a], [1, palette.b]]);
        roundRect(ctx, barX, barY, barW * pct / 100, 6, 3);
        ctx.fill();
      }
    });
  }

  function drawRatingBadge(ctx, cx, y, text, palette, ratingMeta) {
    const padX = 36;
    ctx.font = '900 38px Tajawal, sans-serif';
    const tw = ctx.measureText(text).width;
    const bw = tw + padX * 2;
    const bh = 62;
    const bx = cx - bw / 2;

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, bx, y, bw, bh, 31);
    ctx.fill();
    ctx.strokeStyle = gradient(ctx, bx, y, bx + bw, y, [[0, palette.a], [1, palette.b]]);
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ratingMeta && ratingMeta.color ? ratingMeta.color : '#fff';
    ctx.fillText(text, cx, y + bh / 2 + 2);
  }

  /** Render the share card as a Canvas */
  async function render(opts) {
    await loadFont();
    const palette = PALETTES[opts.template] || PALETTES.fun;
    const en = opts.lang === 'en';
    const pct = Math.round(Number(opts.pct || 0));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = gradient(ctx, 0, 0, W, H, [
      [0, '#06040f'],
      [0.45, '#120a2e'],
      [1, '#070516'],
    ]);
    ctx.fillRect(0, 0, W, H);

    const glow1 = ctx.createRadialGradient(W * 0.2, 180, 40, W * 0.2, 180, 520);
    glow1.addColorStop(0, palette.a + '55');
    glow1.addColorStop(1, 'transparent');
    ctx.fillStyle = glow1; ctx.fillRect(0, 0, W, H);

    const glow2 = ctx.createRadialGradient(W * 0.85, H * 0.75, 40, W * 0.85, H * 0.75, 600);
    glow2.addColorStop(0, palette.b + '44');
    glow2.addColorStop(1, 'transparent');
    ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);

    drawGrid(ctx);
    drawStars(ctx, 90, pct * 997 + 13);
    drawNeonFrame(ctx, palette);

    // Top badge
    const badgeText = en ? palette.headingEn : palette.heading;
    ctx.font = '900 36px Tajawal, sans-serif';
    const btw = ctx.measureText(badgeText).width + 48;
    const bx = (W - btw) / 2;
    ctx.fillStyle = gradient(ctx, bx, 88, bx + btw, 88, [[0, palette.a + 'cc'], [1, palette.b + 'cc']]);
    roundRect(ctx, bx, 88, btw, 52, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, W / 2, 114);

    // Subtitle
    ctx.font = '700 28px Tajawal, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(en ? 'Result Card' : 'بطاقة النتيجة', W / 2, 168);

    // Avatars + names
    const [img1, img2] = await Promise.all([loadImage(opts.photo1), loadImage(opts.photo2)]);
    const avatarY = 310;
    const avatarR = 88;
    drawCircleImage(ctx, img1, 248, avatarY, avatarR, palette.a);
    drawCircleImage(ctx, img2, W - 248, avatarY, avatarR, palette.b);

    // Center icon
    ctx.font = '72px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = palette.a;
    ctx.shadowBlur = 32;
    ctx.fillText(palette.icon || '🧠', W / 2, avatarY);
    ctx.shadowBlur = 0;

    const n1 = (opts.name1 || (en ? 'Player 1' : 'اللاعب 1')).slice(0, 14);
    const n2 = (opts.name2 || (en ? 'Player 2' : 'اللاعب 2')).slice(0, 14);
    ctx.font = `800 ${fitText(ctx, n1, 200, 32, '800')}px Tajawal, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(n1, 248, avatarY + avatarR + 44);
    ctx.font = `800 ${fitText(ctx, n2, 200, 32, '800')}px Tajawal, sans-serif`;
    ctx.fillText(n2, W - 248, avatarY + avatarR + 44);

    // Score panel
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(ctx, 98, 520, W - 196, 430, 40);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const cx = W / 2, cy = 720;
    drawProgressRing(ctx, cx, cy, 168, pct, palette);

    ctx.fillStyle = '#fff';
    ctx.font = '900 156px Tajawal, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = palette.b;
    ctx.shadowBlur = 18;
    ctx.fillText(`${pct}%`, cx, cy - 6);
    ctx.shadowBlur = 0;

    ctx.font = '700 34px Tajawal, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText(en ? 'Telepathy Score' : 'نسبة التخاطر', cx, cy + 88);

    const ratingMeta = ratingFor(pct, en);
    const ratingText = opts.rating && opts.rating !== '-' ? opts.rating : `${ratingMeta.emoji}  ${ratingMeta.txt}`;
    drawRatingBadge(ctx, cx, 860, ratingText, palette, ratingMeta);

    // Phase stats row
    const phases = opts.phases || [];
    drawPhaseRow(ctx, phases, palette, 960, en);

    // Footer
    ctx.font = '600 26px Tajawal, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const footerLine = opts.roomCode
      ? (en ? `Room ${opts.roomCode}` : `غرفة ${opts.roomCode}`)
      : (en ? 'Telepathy Challenge' : 'Telepathy Challenge');
    ctx.fillText(footerLine, W / 2, H - 88);

    ctx.font = '900 34px Tajawal, sans-serif';
    ctx.fillStyle = gradient(ctx, 0, H - 60, W, H - 60, [[0, palette.a], [1, palette.b]]);
    ctx.fillText(opts.siteUrl || 'teleplay.online', W / 2, H - 52);

    return canvas;
  }

  function download(canvas, filename) {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'telepathy-result.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

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
              } catch (e) { /* cancelled */ }
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
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@700;900&display=swap" rel="stylesheet">
<style>
  @page { size: 1080px 1350px; margin: 0; }
  html,body{margin:0;background:#06040f;width:100%;min-height:100%;display:grid;place-items:center;font-family:Tajawal,sans-serif}
  img{width:100vw;max-width:1080px;height:auto;display:block}
  @media print { html,body{background:#06040f} img{width:100%;height:auto} }
</style>
</head>
<body><img alt="Telepathy result card" src="${dataUrl}"><script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body>
</html>`);
    win.document.close();
    return true;
  }

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
