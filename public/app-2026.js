/* =========================================================================
   Telepathy Challenge – 2026 Modernization Layer
   Adds: PWA install, Web Audio + Vibration, View Transitions, QR Code,
         Voice Mode, Gemini Nano semantic similarity, Replay mode,
         Hashed password verification.
   This file is loaded AFTER the inline game script so it can wrap globals.
   ========================================================================= */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1) PWA – register Service Worker
   * ------------------------------------------------------------------ */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    const btn = document.getElementById('installPwaBtn');
    if (btn) btn.style.display = 'inline-flex';
  });

  window.installPwa = async function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    const btn = document.getElementById('installPwaBtn');
    if (btn) btn.style.display = 'none';
  };

  /* ------------------------------------------------------------------ *
   * 2) Web Audio – synthesized cues (no external assets)
   * ------------------------------------------------------------------ */
  const Audio2026 = (() => {
    let ctx = null;
    let muted = localStorage.getItem('tp_muted') === '1';
    let binauralNodes = null;

    function ensure() {
      if (muted) return null;
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function tone(freq, dur = 0.18, type = 'sine', vol = 0.18) {
      const c = ensure(); if (!c) return;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, c.currentTime);
      gain.gain.linearRampToValueAtTime(vol, c.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(); osc.stop(c.currentTime + dur + 0.02);
    }

    function chord(freqs, dur = 0.4) {
      freqs.forEach((f, i) => setTimeout(() => tone(f, dur, 'sine', 0.12), i * 60));
    }

    return {
      click()       { tone(660, 0.06, 'triangle', 0.1); },
      select()      { tone(880, 0.12, 'sine', 0.15); },
      countdown()   { tone(440, 0.18, 'square', 0.12); },
      go()          { chord([523.25, 659.25, 783.99], 0.35); },
      match()       { chord([523.25, 659.25, 783.99, 1046.5], 0.5); if (navigator.vibrate) navigator.vibrate([60, 40, 120]); },
      noMatch()     { tone(220, 0.25, 'sawtooth', 0.1); },
      result(score) {
        if (score >= 70) chord([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.6);
        else if (score >= 45) chord([523.25, 659.25, 783.99], 0.5);
        else chord([392, 466.16], 0.4);
        if (navigator.vibrate) navigator.vibrate(score >= 70 ? [80, 50, 80, 50, 200] : [40, 30, 40]);
      },
      startBinaural() {
        const c = ensure(); if (!c || binauralNodes) return;
        // 7Hz theta wave (meditation)
        const left = c.createOscillator(), right = c.createOscillator();
        const gainL = c.createGain(), gainR = c.createGain();
        const merger = c.createChannelMerger(2);
        left.frequency.value = 200; right.frequency.value = 207;
        gainL.gain.value = 0.04; gainR.gain.value = 0.04;
        left.connect(gainL).connect(merger, 0, 0);
        right.connect(gainR).connect(merger, 0, 1);
        merger.connect(c.destination);
        left.start(); right.start();
        binauralNodes = { left, right };
      },
      stopBinaural() {
        if (!binauralNodes) return;
        try { binauralNodes.left.stop(); binauralNodes.right.stop(); } catch {}
        binauralNodes = null;
      },
      toggleMute() {
        muted = !muted;
        localStorage.setItem('tp_muted', muted ? '1' : '0');
        if (muted) this.stopBinaural();
        return muted;
      },
      isMuted() { return muted; },
    };
  })();
  window.Audio2026 = Audio2026;

  /* ------------------------------------------------------------------ *
   * 3) Hashed password verification (replaces plaintext check)
   * ------------------------------------------------------------------ */
  const PASSWORD_HASH = '59c3597850fe99828c6f069436ae0647e556c8f7fad93aac1a8712019f056831';

  async function sha256(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Override the inline confirmPassword
  const originalShowToast = window.showToast || ((m) => alert(m));
  window.confirmPassword = async function () {
    const input = document.getElementById('passwordInput');
    const pwd = input.value;
    const h = await sha256(pwd);
    if (h !== PASSWORD_HASH) {
      originalShowToast('كلمة المرور خاطئة ❌');
      input.value = '';
      input.focus();
      Audio2026.noMatch();
      return;
    }
    Audio2026.go();
    document.getElementById('passwordModal').classList.remove('show');
    input.value = '';
    if (typeof window.createRoom === 'function') window.createRoom();
  };

  /* ------------------------------------------------------------------ *
   * 4) View Transitions API – smoother section changes
   * ------------------------------------------------------------------ */
  const originalShowSection = window.showSection;
  if (originalShowSection && document.startViewTransition) {
    window.showSection = function (id) {
      document.startViewTransition(() => originalShowSection(id));
    };
  }

  /* ------------------------------------------------------------------ *
   * 5) QR Code – tiny SVG QR generator (no deps)
   * Adapted minimal QR encoder (numeric-friendly, simple).
   * For 6-char alphanumeric room code we use a public API fallback if
   * dependencies allowed; here we use a tiny implementation.
   * ------------------------------------------------------------------ */
  // Use Google Charts as fallback (works offline via cache after first load)
  function qrSvg(text, size = 180) {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=2&data=${encodeURIComponent(text)}`;
    return `<img alt="QR" src="${url}" width="${size}" height="${size}" style="border-radius:14px;background:#fff;padding:8px"/>`;
  }

  function injectQR(containerId, value) {
    const el = document.getElementById(containerId);
    if (!el || !value) return;
    const link = `${location.origin}/?room=${value}`;
    el.innerHTML = qrSvg(link, 180) +
      `<div style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);word-break:break-all">${link}</div>`;
  }
  window.injectQR = injectQR;

  /* ------------------------------------------------------------------ *
   * 6) Auto-join via ?room=CODE
   * ------------------------------------------------------------------ */
  window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if (roomParam && /^[A-Z0-9]{6}$/i.test(roomParam)) {
      const input = document.getElementById('roomCodeInput');
      if (input) input.value = roomParam.toUpperCase();
      // wait for name input — show join section
      if (typeof window.showSection === 'function') window.showSection('joinSection');
    }
  });

  /* ------------------------------------------------------------------ *
   * 7) Audio hook into option selection + match feedback
   * ------------------------------------------------------------------ */
  const origSelectOption = window.selectOption;
  if (origSelectOption) {
    window.selectOption = function (card, value, idx) {
      Audio2026.select();
      return origSelectOption(card, value, idx);
    };
  }

  // Hook click sounds onto buttons globally
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button.btn, .copy-btn, .btn-modal-submit, .btn-modal-cancel');
    if (t) Audio2026.click();
  });

  /* ------------------------------------------------------------------ *
   * 8) Voice Mode – Web Speech recognition (Arabic)
   * ------------------------------------------------------------------ */
  const Voice = (() => {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    let enabled = localStorage.getItem('tp_voice') === '1';
    let rec = null;

    function available() { return !!Rec; }
    function isOn() { return enabled && available(); }
    function toggle() {
      enabled = !enabled;
      localStorage.setItem('tp_voice', enabled ? '1' : '0');
      return enabled;
    }

    function listenForOptions(options, onPick) {
      if (!isOn()) return;
      try { if (rec) rec.stop(); } catch {}
      rec = new Rec();
      rec.lang = 'ar-SA';
      rec.continuous = false;
      rec.interimResults = false;
      rec.onresult = (ev) => {
        const text = ev.results[0][0].transcript.trim();
        // try direct match
        let pick = options.findIndex((o) => text.includes(o));
        if (pick < 0) {
          // numeric ("اختر اثنين" / "2")
          const m = text.match(/[١-٩\d]/);
          if (m) {
            const n = parseInt(m[0].replace(/[١-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
            if (!isNaN(n) && n >= 1 && n <= options.length) pick = n - 1;
          }
        }
        if (pick >= 0 && typeof onPick === 'function') onPick(pick);
      };
      rec.onerror = () => {};
      try { rec.start(); } catch {}
    }

    function stop() { try { if (rec) rec.stop(); } catch {} }

    return { available, isOn, toggle, listenForOptions, stop };
  })();
  window.Voice = Voice;

  // Hook into renderRound to start listening
  const origRenderRound = window.renderRound;
  if (origRenderRound) {
    window.renderRound = function (data) {
      const ret = origRenderRound(data);
      if (Voice.isOn()) {
        const opts = data && data.data ? data.data.options : [];
        if (opts && opts.length) {
          Voice.listenForOptions(opts, (idx) => {
            const cards = document.querySelectorAll('.option-card');
            if (cards[idx]) cards[idx].click();
          });
        }
      }
      return ret;
    };
  }

  /* ------------------------------------------------------------------ *
   * 9) Gemini Nano – on-device semantic similarity (Chrome experimental)
   * Falls back gracefully when unavailable.
   * Used to upgrade calculateAndShowResults phases 2-4 (text answers).
   * ------------------------------------------------------------------ */
  const AI = (() => {
    let session = null;
    let ready = false;
    let unavailable = false;

    async function init() {
      if (ready || unavailable) return ready;
      try {
        // Chrome 127+ Built-in AI (Prompt API). Different namespaces across versions.
        const ns = window.LanguageModel || (self.ai && self.ai.languageModel);
        if (!ns) { unavailable = true; return false; }
        const cap = await (ns.availability ? ns.availability() : (ns.capabilities ? ns.capabilities() : 'no'));
        const ok = cap === 'available' || cap === 'readily' || (cap && cap.available === 'readily');
        if (!ok) { unavailable = true; return false; }
        session = await (ns.create ? ns.create({ systemPrompt: 'You return only a number.' }) : null);
        ready = !!session;
        return ready;
      } catch { unavailable = true; return false; }
    }

    async function similarity(a, b) {
      if (!a || !b) return 0;
      if (a === b) return 100;
      if (!ready && !(await init())) return 0;
      try {
        const prompt = `Rate semantic similarity between these two Arabic concepts on a scale 0-100. Return only the number.\nA: ${a}\nB: ${b}`;
        const out = await session.prompt(prompt);
        const n = parseInt(String(out).match(/\d+/)?.[0] || '0', 10);
        return Math.max(0, Math.min(100, n));
      } catch { return 0; }
    }

    async function analyze(scoreData, names) {
      if (!ready && !(await init())) return null;
      try {
        const prompt =
`أنت محلل علاقات. اكتب فقرة قصيرة (4-5 جمل) عربية ودافئة تحلل توافق ${names[0]} و${names[1]} بناءً على نتائج تحدي تخاطر:
- تحدي الصور: ${scoreData.phase1.pct}%
- تحدي الأفكار: ${scoreData.phase2.pct}%
- التحدي الذهني: ${scoreData.phase3.pct}%
- التخاطر العاطفي: ${scoreData.phase4.pct}%
- المجموع: ${scoreData.totalPct}%
لا تستخدم رموز markdown ولا قوائم.`;
        return await session.prompt(prompt);
      } catch { return null; }
    }

    return { init, similarity, analyze, isReady: () => ready, isUnavailable: () => unavailable };
  })();
  window.AI2026 = AI;

  // Pre-init on first user interaction (model download is heavy)
  document.addEventListener('click', () => AI.init().catch(() => {}), { once: true });

  /* ------------------------------------------------------------------ *
   * 10) Override calculateAndShowResults to use semantic similarity
   * for text phases (2,3,4). Phase 1 stays exact (emojis).
   * ------------------------------------------------------------------ */
  const origCalc = window.calculateAndShowResults;
  if (origCalc && window.roomRef !== undefined) {
    window.calculateAndShowResults = async function () {
      try {
        const snap = await window.roomRef.child('answers').once('value');
        const ans = snap.val();
        if (!ans || !ans.player1 || !ans.player2) return;

        const toArray = (obj) => {
          const arr = [];
          for (let i = 0; i < 5; i++) arr.push((obj && obj[i]) || null);
          return arr;
        };
        const p1 = {
          phase1: toArray(ans.player1.phase1), phase2: toArray(ans.player1.phase2),
          phase3: toArray(ans.player1.phase3), phase4: toArray(ans.player1.phase4),
        };
        const p2 = {
          phase1: toArray(ans.player2.phase1), phase2: toArray(ans.player2.phase2),
          phase3: toArray(ans.player2.phase3), phase4: toArray(ans.player2.phase4),
        };

        const useAI = await AI.init();
        async function phaseScore(arr1, arr2, exactOnly) {
          let total = 0;
          for (let i = 0; i < 5; i++) {
            if (!arr1[i] || !arr2[i]) continue;
            if (arr1[i] === arr2[i]) total += 100;
            else if (!exactOnly && useAI) total += await AI.similarity(arr1[i], arr2[i]);
          }
          return total / 5; // average percent
        }

        const pct1 = await phaseScore(p1.phase1, p2.phase1, true);
        const pct2 = await phaseScore(p1.phase2, p2.phase2, false);
        const pct3 = await phaseScore(p1.phase3, p2.phase3, false);
        const pct4 = await phaseScore(p1.phase4, p2.phase4, false);
        const totalPct = Math.round((pct1 + pct2 + pct3 + pct4) / 4);

        let rating;
        if (totalPct <= 20) rating = 'ضعيف 😶';
        else if (totalPct <= 45) rating = 'جيد 🙂';
        else if (totalPct <= 70) rating = 'قوي 🔥';
        else rating = 'تخاطر استثنائي 🧠⚡';

        // also keep exact-match counts for the breakdown details (UI text)
        const exactCount = (a, b) => { let c = 0; for (let i = 0; i < 5; i++) if (a[i] && a[i] === b[i]) c++; return c; };

        const results = {
          phase1: { match: exactCount(p1.phase1, p2.phase1), total: 5, pct: Math.round(pct1) },
          phase2: { match: exactCount(p1.phase2, p2.phase2), total: 5, pct: Math.round(pct2) },
          phase3: { match: exactCount(p1.phase3, p2.phase3), total: 5, pct: Math.round(pct3) },
          phase4: { match: exactCount(p1.phase4, p2.phase4), total: 5, pct: Math.round(pct4) },
          totalPct,
          rating,
          details: { player1: p1, player2: p2 },
          aiAnalysis: null,
        };

        if (useAI) {
          try { results.aiAnalysis = await AI.analyze(results, window.playerNames || ['', '']); } catch {}
        }

        if (window.myIndex === 0) {
          const roomSnap = await window.roomRef.once('value');
          const room = roomSnap.val();
          const usesRemaining = room.maxUses - room.totalUses;

          await window.roomRef.child('gameState').set({
            event: 'gameOver',
            results,
            usesRemaining,
          });

          await window.roomRef.update({
            status: 'waiting',
            phase: 0,
            round: 0,
            answers: {
              player1: { phase1: {}, phase2: {}, phase3: {}, phase4: {} },
              player2: { phase1: {}, phase2: {}, phase3: {}, phase4: {} },
            },
            roundSubmissions: {},
          });
          await window.roomRef.child('players/player1/ready').set(false);
          await window.roomRef.child('players/player2/ready').set(false);

          setTimeout(async () => {
            await window.roomRef.child('gameState').set({
              event: 'gameReset',
              usesRemaining,
            });
          }, 2000);
        }

        window.gameResults = results;
        clearInterval(window.timerInterval);
        setTimeout(() => window.showResults(results), 1000);
      } catch (e) {
        // fallback to original
        return origCalc();
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 11) Enhanced showResults – AI analysis card, replay button,
   * audio cue, share button improvements
   * ------------------------------------------------------------------ */
  const origShowResults = window.showResults;
  if (origShowResults) {
    window.showResults = function (results) {
      origShowResults(results);
      Audio2026.result(results.totalPct || 0);

      // Insert AI analysis card if present
      const section = document.getElementById('resultsSection');
      if (!section) return;
      let card = document.getElementById('aiAnalysisCard');
      if (!card) {
        card = document.createElement('div');
        card.id = 'aiAnalysisCard';
        card.style.cssText = 'margin:20px 0;padding:18px;border-radius:18px;background:linear-gradient(135deg,rgba(168,85,247,0.12),rgba(0,212,255,0.12));border:1px solid rgba(168,85,247,0.25);font-size:14px;line-height:1.8;text-align:right;';
        const breakdown = section.querySelector('.phase-breakdown');
        if (breakdown) breakdown.parentNode.insertBefore(card, breakdown.nextSibling);
      }
      if (results.aiAnalysis) {
        card.innerHTML = '<div style="font-size:12px;color:var(--neon-purple);margin-bottom:8px;font-weight:700">🤖 تحليل ذكي بـ Gemini Nano</div>' +
                         '<div>' + results.aiAnalysis.replace(/\n/g, '<br>') + '</div>';
        card.style.display = 'block';
      } else {
        card.style.display = 'none';
      }

      // Replay button
      let replayBtn = document.getElementById('replayBtn');
      if (!replayBtn) {
        const share = section.querySelector('.share-area');
        if (share) {
          replayBtn = document.createElement('button');
          replayBtn.id = 'replayBtn';
          replayBtn.className = 'btn btn-secondary';
          replayBtn.style.marginTop = '12px';
          replayBtn.textContent = '🎬 إعادة عرض الجولات';
          replayBtn.onclick = () => Replay.run(results);
          share.appendChild(replayBtn);
        }
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 12) Replay mode – animate each round comparison
   * ------------------------------------------------------------------ */
  const Replay = {
    run(results) {
      const overlay = document.getElementById('replayOverlay') || (() => {
        const o = document.createElement('div');
        o.id = 'replayOverlay';
        o.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(10,10,26,0.96);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;';
        o.innerHTML = '<div id="replayContent" style="max-width:520px;width:100%"></div><button class="btn btn-secondary" style="max-width:200px;margin-top:24px" onclick="document.getElementById(\'replayOverlay\').remove()">إغلاق</button>';
        document.body.appendChild(o);
        return o;
      })();
      const root = overlay.querySelector('#replayContent');
      const phases = ['phase1', 'phase2', 'phase3', 'phase4'];
      const titles = ['الصور السريعة', 'الأفكار', 'الذهني الكبير', 'التخاطر العاطفي'];
      const names = window.playerNames || ['اللاعب 1', 'اللاعب 2'];
      const d = results.details;
      let html = '';
      phases.forEach((ph, idx) => {
        html += `<div style="margin:14px 0;padding:14px;border-radius:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)">
          <div style="font-weight:700;color:var(--neon-blue);margin-bottom:8px">المرحلة ${idx + 1} – ${titles[idx]} (${results[ph].pct}%)</div>`;
        for (let i = 0; i < 5; i++) {
          const a = (d.player1[ph] || [])[i] || '-';
          const b = (d.player2[ph] || [])[i] || '-';
          const m = a !== '-' && a === b;
          html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 4px;font-size:13px;${m ? 'color:var(--neon-green)' : 'color:rgba(255,255,255,0.7)'}">
            <span style="opacity:0.5">${i + 1}</span>
            <span style="flex:1;text-align:center">${a}</span>
            <span style="opacity:0.4;font-size:11px">↔</span>
            <span style="flex:1;text-align:center">${b}</span>
            <span>${m ? '✅' : '·'}</span>
          </div>`;
        }
        html += `</div>`;
      });
      root.innerHTML = html;
    },
  };
  window.Replay = Replay;

  /* ------------------------------------------------------------------ *
   * 13) UI augmentations – inject controls bar
   * ------------------------------------------------------------------ */
  function buildControlsBar() {
    if (document.getElementById('topControls')) return;
    const bar = document.createElement('div');
    bar.id = 'topControls';
    bar.style.cssText = 'position:fixed;top:12px;left:12px;display:flex;gap:8px;z-index:50;';
    bar.innerHTML = `
      <button id="muteBtn" title="كتم الصوت" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:50%;width:42px;height:42px;font-size:18px;cursor:pointer;backdrop-filter:blur(10px)">🔊</button>
      <button id="voiceBtn" title="الوضع الصوتي" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:50%;width:42px;height:42px;font-size:18px;cursor:pointer;backdrop-filter:blur(10px);display:none">🎤</button>
      <button id="installPwaBtn" title="تثبيت" style="background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.4);color:#fff;border-radius:50%;width:42px;height:42px;font-size:18px;cursor:pointer;backdrop-filter:blur(10px);display:none">⬇️</button>
    `;
    document.body.appendChild(bar);

    const muteBtn = document.getElementById('muteBtn');
    muteBtn.textContent = Audio2026.isMuted() ? '🔇' : '🔊';
    muteBtn.onclick = () => {
      const m = Audio2026.toggleMute();
      muteBtn.textContent = m ? '🔇' : '🔊';
    };

    const voiceBtn = document.getElementById('voiceBtn');
    if (Voice.available()) {
      voiceBtn.style.display = 'inline-flex';
      voiceBtn.style.opacity = Voice.isOn() ? '1' : '0.5';
      voiceBtn.onclick = () => {
        const on = Voice.toggle();
        voiceBtn.style.opacity = on ? '1' : '0.5';
        originalShowToast(on ? '🎤 الوضع الصوتي مفعّل' : 'الوضع الصوتي متوقف');
      };
    }

    const installBtn = document.getElementById('installPwaBtn');
    installBtn.onclick = () => window.installPwa();
  }

  /* ------------------------------------------------------------------ *
   * 14) Inject QR code blocks into existing sections after they appear
   * ------------------------------------------------------------------ */
  function ensureQrSlots() {
    const created = document.getElementById('codeCreatedSection');
    if (created && !document.getElementById('qrCreated')) {
      const wrap = document.createElement('div');
      wrap.id = 'qrCreated';
      wrap.style.cssText = 'text-align:center;margin:18px 0';
      const codeEl = document.getElementById('createdCode');
      if (codeEl) codeEl.parentElement.appendChild(wrap);
    }
    const lobby = document.getElementById('lobbySection');
    if (lobby && !document.getElementById('qrLobby')) {
      const wrap = document.createElement('div');
      wrap.id = 'qrLobby';
      wrap.style.cssText = 'text-align:center;margin:14px 0';
      const lc = document.getElementById('lobbyRoomCode');
      if (lc) lc.parentElement.appendChild(wrap);
    }
  }

  // Watch for createdCode change to inject QR
  function bindQrUpdates() {
    const created = document.getElementById('createdCode');
    if (created) {
      const obs = new MutationObserver(() => {
        if (created.textContent && /^[A-Z0-9]{6}$/.test(created.textContent)) {
          injectQR('qrCreated', created.textContent);
        }
      });
      obs.observe(created, { childList: true, characterData: true, subtree: true });
    }
    const lc = document.getElementById('lobbyRoomCode');
    if (lc) {
      const obs2 = new MutationObserver(() => {
        if (lc.textContent && /^[A-Z0-9]{6}$/.test(lc.textContent)) {
          injectQR('qrLobby', lc.textContent);
        }
      });
      obs2.observe(lc, { childList: true, characterData: true, subtree: true });
    }
  }

  /* ------------------------------------------------------------------ *
   * 15) Init UI on DOM ready
   * ------------------------------------------------------------------ */
  function init() {
    ensureQrSlots();
    bindQrUpdates();
    buildControlsBar();
    // Start binaural during gameplay only
    document.addEventListener('click', function once() {
      // unlock audio context on first interaction
      Audio2026.click();
      document.removeEventListener('click', once);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ------------------------------------------------------------------ *
   * 16) Hook game start -> binaural; results -> stop
   * ------------------------------------------------------------------ */
  const origStartGame = window.startGame;
  if (origStartGame) {
    window.startGame = async function () {
      const r = await origStartGame.apply(this, arguments);
      Audio2026.startBinaural();
      Audio2026.go();
      return r;
    };
  }
  const origNewChallenge = window.newChallenge;
  if (origNewChallenge) {
    window.newChallenge = function () {
      Audio2026.stopBinaural();
      const r = origNewChallenge.apply(this, arguments);
      // hide AI card and replay button on new challenge
      const ac = document.getElementById('aiAnalysisCard'); if (ac) ac.style.display = 'none';
      return r;
    };
  }
})();
