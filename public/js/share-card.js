/* =========================================================================
   Telepathy – Share Card generator (Canvas-based, no deps)
   Renders a 1080x1350 (Instagram story / WhatsApp friendly) image card
   with the result, names (optional), and photos (optional).
   ========================================================================= */
(function (global) {
  'use strict';

  const W = 1080, H = 1350;
  const PALETTES = {
    romantic: { a: '#ff5b93', b: '#a855f7', c: '#ffd0e1', label: '💞 رومانسي', heading: 'تحدي القلوب' },
    fun:      { a: '#00d4ff', b: '#a855f7', c: '#9af0ff', label: '⚡ شبابي',   heading: 'تحدي التخاطر' },
    luxury:   { a: '#ffd700', b: '#7c3aed', c: '#fff3b0', label: '👑 فاخر',    heading: 'تحدي توافق العقول' },
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

  function ratingFor(pct) {
    if (pct <= 20) return { txt: 'ضعيف', emoji: '😶' };
    if (pct <= 45) return { txt: 'جيد', emoji: '🙂' };
    if (pct <= 70) return { txt: 'قوي', emoji: '🔥' };
    return { txt: 'تخاطر استثنائي', emoji: '🧠⚡' };
  }

  /** Render the share card as a Canvas. opts: {pct, name1, name2, photo1, photo2, template, brandName, brandLogo, qrUrl} */
  async function render(opts) {
    await loadFont();
    const palette = PALETTES[opts.template] || PALETTES.fun;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Background gradient
    const bg = gradient(ctx, 0, 0, W, H, [
      [0,   '#0a0a1a'],
      [0.4, '#15102e'],
      [1,   '#050511'],
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
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    roundRect(ctx, 50, 50, W - 100, H - 100, 60);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.stroke();

    // Top label / template badge
    ctx.font = '600 36px Tajawal, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(palette.heading, W / 2, 160);

    // Logo / brand top-right
    if (opts.brandName) {
      ctx.font = 'bold 28px Tajawal, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(opts.brandName, W - 90, 110);
    }

    // Photos circle
    const [img1, img2] = await Promise.all([loadImage(opts.photo1), loadImage(opts.photo2)]);
    drawCircleImage(ctx, img1, 280, 360, 100);
    drawCircleImage(ctx, img2, W - 280, 360, 100);

    // Heart / link icon between
    ctx.font = '90px serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = palette.a;
    ctx.shadowColor = palette.a; ctx.shadowBlur = 30;
    ctx.fillText(opts.template === 'romantic' ? '💞' : '🧠', W / 2, 380);
    ctx.shadowBlur = 0;

    // Names
    ctx.font = 'bold 56px Tajawal, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    const n1 = (opts.name1 || 'اللاعب 1').slice(0, 18);
    const n2 = (opts.name2 || 'اللاعب 2').slice(0, 18);
    ctx.fillText(`${n1}  ✦  ${n2}`, W / 2, 540);

    // Big result ring
    const cx = W / 2, cy = 830;
    drawProgressRing(ctx, cx, cy, 200, opts.pct || 0, palette);

    // Pct text
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 180px Tajawal, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(opts.pct || 0)}%`, cx, cy - 10);

    ctx.font = '600 38px Tajawal, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('نسبة التخاطر', cx, cy + 100);

    // Rating
    const r = ratingFor(opts.pct || 0);
    ctx.font = 'bold 56px Tajawal, sans-serif';
    const ratingGrad = gradient(ctx, 0, 0, W, 0, [[0, palette.a], [1, palette.b]]);
    ctx.fillStyle = ratingGrad;
    ctx.fillText(`${r.emoji}  ${r.txt}`, cx, 1130);

    // Footer
    ctx.font = '500 28px Tajawal, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('Telepathy Challenge  •  تحدي التخاطر', W / 2, H - 110);

    // Site / QR text
    ctx.font = 'bold 32px Tajawal, sans-serif';
    ctx.fillStyle = palette.a;
    ctx.fillText(opts.siteUrl || 'four-fruits-fun.web.app', W / 2, H - 70);

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
    fileToDataURL,
    ratingFor,
  };
})(window);
