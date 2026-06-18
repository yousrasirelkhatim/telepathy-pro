/* =========================================================================
   TPSession — Single source of truth for session entry & invite links
   -------------------------------------------------------------------------
   Flow A (buyer/host):  /play?session=JS-xxx  →  lobby  →  invite ?room=XXX
   Flow B (friend):      /play?room=XXX         →  join as player2
   Flow C (manual):      /play + typed code     →  validate → lobby or join

   INVITE RULE (do not change): invite links ALWAYS use ?room=ROOMID only.
   Never ?session= or ?code= in invite URLs — that caused duplicate rooms.
   ========================================================================= */
(function (global) {
  'use strict';

  var deps = {};

  function configure(handlers) {
    deps = handlers || {};
  }

  function isRoomCode(v) {
    return /^[A-Z0-9]{6}$/.test(String(v || '').toUpperCase());
  }

  function isSessionCode(v) {
    return /^JS[-_]?[A-Z0-9]{4,}$/i.test(String(v || '').trim());
  }

  function isInviteUrl() {
    return !!(global.__friendMode || (new URLSearchParams(location.search).get('room') || '').match(/^[A-Z0-9]{6}$/i));
  }

  function normalizeCode(raw) {
    if (global.TPCodes && global.TPCodes.normalize) return global.TPCodes.normalize(raw);
    return String(raw || '').toUpperCase().trim();
  }

  function db() {
    return (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length)
      ? firebase.database() : null;
  }

  function inviteLinkFor(roomId) {
    var l = (typeof global.lang !== 'undefined' && global.lang === 'en') ? 'en' : 'ar';
    return location.origin + '/play?room=' + encodeURIComponent(roomId) + '&lang=' + l;
  }

  function sessionOwnerStorageKey(sessionCode) {
    return 'tp_owned_session_' + normalizeCode(sessionCode);
  }

  function markLocalSessionOwner(sessionCode, roomId) {
    try {
      if (sessionCode && roomId) localStorage.setItem(sessionOwnerStorageKey(sessionCode), roomId);
    } catch (_) {}
  }

  function isLocalSessionOwner(sessionCode, roomId) {
    try {
      return localStorage.getItem(sessionOwnerStorageKey(sessionCode)) === roomId;
    } catch (_) { return false; }
  }

  function clearLocalSessionOwner(sessionCode) {
    try { localStorage.removeItem(sessionOwnerStorageKey(sessionCode)); } catch (_) {}
  }

  function accessRoomRef(accessCode) {
    var d = db();
    if (!d) throw new Error('db_unavailable');
    return d.ref('accessRooms/' + normalizeCode(accessCode));
  }

  async function resolveSessionRoomCode(sessionCode) {
    var code = normalizeCode(sessionCode);
    if (!/^JS-/i.test(code)) return '';
    var d = db();
    if (!d) return '';
    try {
      var idxSnap = await d.ref('sessionIndex/' + code).once('value');
      var idx = idxSnap.val();
      if (idx && isRoomCode(idx.roomId)) {
        var roomSnap = await d.ref('rooms/' + idx.roomId).once('value');
        var room = roomSnap.val();
        if (room && !room.expired && room.accessCode === code) return idx.roomId;
      }
    } catch (_) {}
    try {
      var markerSnap = await accessRoomRef(code).once('value');
      var marker = markerSnap.val();
      if (marker && isRoomCode(marker.roomId)) {
        var roomSnap2 = await d.ref('rooms/' + marker.roomId).once('value');
        var room2 = roomSnap2.val();
        if (room2 && !room2.expired && room2.accessCode === code) return marker.roomId;
      }
    } catch (_) {}
    return '';
  }

  async function inspectAccessRoom(accessCode) {
    var code = normalizeCode(accessCode);
    var roomId = '';
    try {
      var markerSnap = await accessRoomRef(code).once('value');
      var marker = markerSnap.val();
      if (marker && isRoomCode(marker.roomId)) roomId = marker.roomId;
    } catch (_) {}
    if (!roomId) {
      try { roomId = await resolveSessionRoomCode(code); } catch (_) {}
    }
    if (!roomId) return { state: 'empty' };

    var d = db();
    var roomSnap = await d.ref('rooms/' + roomId).once('value');
    var room = roomSnap.val();
    if (!room || room.accessCode !== code || room.expired) return { state: 'stale', roomId: roomId };

    var players = room.players || {};
    var hasP1 = !!players.player1;
    var hasP2 = !!players.player2;
    var totalUses = Number(room.totalUses || 0);

    if (!hasP1) return { state: 'stale', roomId: roomId };
    if (room.status === 'playing') return { state: 'busy', roomId: roomId };
    if (room.status === 'waiting') {
      if (hasP1 && hasP2 && totalUses === 0) return { state: 'busy', roomId: roomId };
      if (hasP1 && !hasP2 && totalUses === 0) return { state: 'rejoin', roomId: roomId };
      return { state: 'stale', roomId: roomId };
    }
    return { state: 'stale', roomId: roomId };
  }

  function setJoinCode(code) {
    var el = document.getElementById('roomCodeInput');
    if (el) el.value = String(code || '').toUpperCase();
  }

  function getQuickCode() {
    var el = document.getElementById('quickCode');
    return el ? String(el.value || '').trim().toUpperCase() : '';
  }

  function setAccessCodeContext(code, validation) {
    var res = validation || {};
    global.__activeAccessCode = normalizeCode(code);
    global.__codeRemaining = res.remaining;
    global.__codeMaxSessions = res.maxSessions || 5;
    global.__codeUsedSessions = res.usedSessions || 0;
  }

  function enterBuyerMode(code) {
    global.__buyerMode = true;
    global.__friendMode = false;
    document.documentElement.classList.add('boot-buyer');
    document.body.classList.add('buyer-mode');
    document.body.classList.remove('friend-mode');
    var entry = document.getElementById('codeEntryBlock');
    var ready = document.getElementById('buyerReadyBlock');
    var friend = document.getElementById('friendReadyBlock');
    var f = document.getElementById('quickCode');
    if (entry) entry.classList.add('hidden');
    if (friend) friend.classList.add('hidden');
    if (ready) ready.classList.remove('hidden');
    if (f) f.value = code;
    var btn = document.getElementById('quickStartBtn');
    var tr = deps.t ? deps.t('buyer_start') : 'buyer_start';
    if (btn) btn.textContent = (tr !== 'buyer_start') ? tr : 'افتح غرفة الدعوة  ←';
    try {
      var saved = localStorage.getItem('tp_player_name');
      var nameF = document.getElementById('playerName');
      if (saved && nameF && !nameF.value) nameF.value = saved;
    } catch (_) {}
    setTimeout(function () {
      var nameF2 = document.getElementById('playerName');
      if (nameF2) nameF2.focus();
    }, 200);
  }

  function enterFriendMode(code) {
    global.__friendMode = true;
    global.__buyerMode = false;
    document.documentElement.classList.add('boot-friend');
    document.body.classList.add('friend-mode');
    document.body.classList.remove('buyer-mode');
    var entry = document.getElementById('codeEntryBlock');
    var ready = document.getElementById('buyerReadyBlock');
    var friend = document.getElementById('friendReadyBlock');
    var f = document.getElementById('quickCode');
    if (entry) entry.classList.add('hidden');
    if (ready) ready.classList.add('hidden');
    if (friend) friend.classList.remove('hidden');
    if (f) f.value = code;
    var btn = document.getElementById('quickStartBtn');
    var tr = deps.t ? deps.t('friend_join_btn') : 'friend_join_btn';
    if (btn) btn.textContent = (tr !== 'friend_join_btn') ? tr : 'انضم للتحدي  ←';
    try {
      var saved = localStorage.getItem('tp_player_name');
      var nameF = document.getElementById('playerName');
      if (saved && nameF && !nameF.value) nameF.value = saved;
    } catch (_) {}
    setTimeout(function () {
      var nameF2 = document.getElementById('playerName');
      if (nameF2) nameF2.focus();
    }, 200);
  }
  global.__enterFriendMode = enterFriendMode;

  async function resolveSessionEntry(sessionCode) {
    var norm = normalizeCode(sessionCode);
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var existingRoom = await resolveSessionRoomCode(norm);
        if (existingRoom) {
          if (isLocalSessionOwner(norm, existingRoom)) {
            global.__pendingReconnectRoom = existingRoom;
          } else {
            enterFriendMode(existingRoom);
          }
          return;
        }
      } catch (_) {}
      if (attempt < 2) await new Promise(function (r) { setTimeout(r, 600); });
    }
  }

  function initFromURL() {
    var p = new URLSearchParams(location.search);
    var room = (p.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var session = (p.get('session') || '').toUpperCase().trim();
    var code = (p.get('code') || session || '').toUpperCase();

    if (session && /^JS-/i.test(session)) {
      enterBuyerMode(session);
      resolveSessionEntry(session);
    } else if (room && isRoomCode(room)) {
      enterFriendMode(room);
    } else if (code) {
      var f = document.getElementById('quickCode');
      if (f) f.value = code;
      if (isRoomCode(code)) enterFriendMode(code);
      else enterBuyerMode(code);
    }
  }

  async function enterWithAccessCode(accessCode, validation) {
    if (deps.getRoomRef && deps.getRoomRef() && deps.getRoomCode && deps.getRoomCode()) {
      deps.showToast('أنت داخل غرفة بالفعل');
      return;
    }
    await deps.ensurePlayAuth();
    var code = normalizeCode(accessCode);
    if (!code) { deps.showToast('أدخل الكود'); return; }

    var res = validation;
    if (!res && global.TPCodes && global.TPCodes.validate) {
      res = await global.TPCodes.validate(code);
    }
    if (!res || !res.ok) {
      deps.showToast((res && res.message) || 'كود غير صالح');
      return;
    }
    setAccessCodeContext(code, res);

    for (var attempt = 0; attempt < 3; attempt++) {
      var existing = await inspectAccessRoom(code);
      if (existing.state === 'busy') {
        deps.showToast('الجلسة الحالية لا تزال نشطة. انتظر انتهاءها أو اضغط «تحدي جديد»');
        return;
      }
      if (existing.state === 'rejoin' && existing.roomId) {
        await deps.reconnectToRoom(existing.roomId);
        return;
      }
      if (existing.state === 'stale') {
        await accessRoomRef(code).remove().catch(function () {});
      }

      var newRoomId = deps.generateRoomCode();
      var tx = await accessRoomRef(code).transaction(function (cur) {
        if (cur && cur.roomId) return cur;
        return { roomId: newRoomId, at: Date.now() };
      });
      var claimed = tx.snapshot && tx.snapshot.val();
      if (claimed && claimed.roomId === newRoomId) {
        await deps.createRoom(newRoomId);
        return;
      }
    }
    deps.showToast('تعذّر تجهيز الغرفة الآن. حاول مرة أخرى');
  }

  async function runQuickStart() {
    if (global.__quickStartBusy) {
      deps.showToast('جاري تجهيز الغرفة...');
      return;
    }
    global.__quickStartBusy = true;
    try {
      var name = deps.getName();
      if (!name) { deps.showToast('أدخل اسمك أولاً'); return; }

      if ((global.__buyerMode || global.__friendMode) && !global.__pendingPhoto) {
        deps.showToast(deps.t('need_photo'));
        var ph = document.getElementById('qsPhotoLabel');
        if (ph) {
          ph.scrollIntoView({ behavior: 'smooth', block: 'center' });
          ph.style.boxShadow = '0 0 0 3px rgba(168,85,247,0.6)';
          setTimeout(function () { ph.style.boxShadow = ''; }, 2000);
        }
        return;
      }

      var codeRaw = getQuickCode();
      if (!codeRaw) { deps.showToast('أدخل الكود'); return; }

      if (global.__pendingReconnectRoom && global.__buyerMode) {
        var roomId = global.__pendingReconnectRoom;
        var sessionNorm = getQuickCode();
        global.__pendingReconnectRoom = null;
        if (isLocalSessionOwner(sessionNorm, roomId)) {
          await deps.reconnectToRoom(roomId);
          return;
        }
        global.__buyerMode = false;
        enterFriendMode(roomId);
        setJoinCode(roomId);
        await deps.joinRoom();
        return;
      }

      if (isRoomCode(codeRaw)) {
        setJoinCode(codeRaw);
        await deps.joinRoom();
        return;
      }

      if (isSessionCode(codeRaw)) {
        var norm = normalizeCode(codeRaw);
        var existingRoom = await resolveSessionRoomCode(norm);
        if (existingRoom) {
          if (global.__buyerMode && isLocalSessionOwner(norm, existingRoom)) {
            await deps.reconnectToRoom(existingRoom);
          } else {
            if (!global.__friendMode) enterFriendMode(existingRoom);
            setJoinCode(existingRoom);
            var f = document.getElementById('quickCode');
            if (f) f.value = existingRoom;
            await deps.joinRoom();
          }
          return;
        }
        if (global.TPCodes && global.TPCodes.validate) {
          var v = await global.TPCodes.validate(norm);
          if (!v.ok) { deps.showToast(v.message || 'كود غير صالح'); return; }
          await enterWithAccessCode(norm, v);
        }
        return;
      }

      if (global.TPCodes && global.TPCodes.validate) {
        var v2 = await global.TPCodes.validate(codeRaw);
        if (!v2.ok) { deps.showToast(v2.message || 'كود غير صالح'); return; }
        await enterWithAccessCode(codeRaw, v2);
      }
    } finally {
      global.__quickStartBusy = false;
    }
  }

  global.TPSession = {
    configure: configure,
    initFromURL: initFromURL,
    runQuickStart: runQuickStart,
    enterWithAccessCode: enterWithAccessCode,
    enterBuyerMode: enterBuyerMode,
    enterFriendMode: enterFriendMode,
    inviteLinkFor: inviteLinkFor,
    isRoomCode: isRoomCode,
    isSessionCode: isSessionCode,
    isInviteUrl: isInviteUrl,
    isLocalSessionOwner: isLocalSessionOwner,
    markLocalSessionOwner: markLocalSessionOwner,
    clearLocalSessionOwner: clearLocalSessionOwner,
    resolveSessionRoomCode: resolveSessionRoomCode,
    inspectAccessRoom: inspectAccessRoom,
    setJoinCode: setJoinCode,
    setAccessCodeContext: setAccessCodeContext,
    normalizeCode: normalizeCode,
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('homeSection') && deps.createRoom) initFromURL();
  });
})(window);
