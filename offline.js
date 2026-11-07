/*
 * Offline jam: phones talk straight to each other over the local network
 * (the cottage router, or one phone's hotspot) with WebRTC data channels, so
 * no internet, cell signal or server is involved.
 *
 * Browsers can't discover each other, so pairing is done by eye: the host's
 * phone shows a QR code, the joining phone scans it and shows a reply code,
 * and the host scans that. Both codes carry only what a connection needs —
 * ICE credentials, the certificate fingerprint and the phone's local
 * addresses — packed into a few hundred characters.
 *
 * The host acts as the hub. It plays the part of the MQTT broker the online
 * jam uses: Jam.createSession() is handed `connect` functions from here
 * instead, so the same session code drives both. The hub keeps the latest
 * retained message per topic and replays them to each phone that joins, which
 * is how a late joiner gets the chart.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Offline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PREFIX = "GS1";
  var SEP = "~";
  var ICE_WAIT_MS = 4000;
  var MAX_BUFFERED = 1024 * 1024;

  function supported() {
    return typeof RTCPeerConnection === "function";
  }

  // ── Signal packing ──
  function bytesToB64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlToBytes(text) {
    var s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function fingerprintToB64(fp) {
    var hex = fp.replace(/[^0-9A-Fa-f]/g, "");
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytesToB64url(bytes);
  }
  function b64ToFingerprint(b64) {
    var bytes = b64urlToBytes(b64);
    var parts = [];
    for (var i = 0; i < bytes.length; i++) parts.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16).toUpperCase());
    return parts.join(":");
  }

  // Pulls the few fields that matter out of a local description
  function extractSignal(sdp) {
    function one(re) { var m = sdp.match(re); return m ? m[1] : ""; }
    var ufrag = one(/a=ice-ufrag:(\S+)/);
    var pwd = one(/a=ice-pwd:(\S+)/);
    var fp = one(/a=fingerprint:sha-256 (\S+)/i);
    var cands = [];
    var re = /a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ host/g;
    var m;
    while ((m = re.exec(sdp))) {
      if (/^fe80:/i.test(m[1])) continue;
      var item = m[1] + "/" + m[2];
      if (cands.indexOf(item) === -1) cands.push(item);
    }
    if (!ufrag || !pwd || !fp || !cands.length) return null;
    return { ufrag: ufrag, pwd: pwd, fp: fp, cands: cands.slice(0, 4) };
  }

  function pack(kind, code, sig) {
    return [PREFIX, kind, code, sig.ufrag, sig.pwd, fingerprintToB64(sig.fp), sig.cands.join(",")].join(SEP);
  }

  // Returns { kind, code, ufrag, pwd, fp, cands } or null
  function unpack(text) {
    var raw = String(text || "").trim();
    var at = raw.indexOf(PREFIX + SEP);
    if (at === -1) return null;
    raw = raw.slice(at).split(/\s/)[0];
    var p = raw.split(SEP);
    if (p.length !== 7 || p[0] !== PREFIX || (p[1] !== "o" && p[1] !== "a")) return null;
    var cands = p[6].split(",").filter(Boolean);
    if (!p[3] || !p[4] || !p[5] || !cands.length) return null;
    var fp;
    try { fp = b64ToFingerprint(p[5]); } catch (e) { return null; }
    return { kind: p[1], code: p[2], ufrag: p[3], pwd: p[4], fp: fp, cands: cands };
  }

  // The remote description, rebuilt from the packed fields. Both ends run this
  // same code, so it does not depend on what any one browser would write.
  function buildSdp(sig, asOffer) {
    var lines = [
      "v=0",
      "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "a=group:BUNDLE 0",
      "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:" + sig.ufrag,
      "a=ice-pwd:" + sig.pwd,
      "a=fingerprint:sha-256 " + sig.fp,
      "a=setup:" + (asOffer ? "actpass" : "active"),
      "a=mid:0",
      "a=sctp-port:5000",
      "a=max-message-size:262144",
    ];
    var prio = 2113937151;
    for (var i = 0; i < sig.cands.length; i++) {
      var at = sig.cands[i].lastIndexOf("/");
      lines.push("a=candidate:" + (i + 1) + " 1 udp " + (prio - i * 256) + " " + sig.cands[i].slice(0, at) + " " + sig.cands[i].slice(at + 1) + " typ host");
    }
    lines.push("a=end-of-candidates");
    return lines.join("\r\n") + "\r\n";
  }

  function newPc() {
    // No STUN/TURN: on a shared network the phones reach each other directly.
    return new RTCPeerConnection({ iceServers: [] });
  }

  function gathered(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === "complete") { resolve(); return; }
      var done = false;
      function finish() { if (done) return; done = true; resolve(); }
      pc.addEventListener("icegatheringstatechange", function () {
        if (pc.iceGatheringState === "complete") finish();
      });
      setTimeout(finish, ICE_WAIT_MS);
    });
  }

  var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  function bytesToText(bytes) { return decoder.decode(bytes); }
  function textToBytes(text) { return encoder.encode(text); }

  function frame(topic, text, retain) {
    return JSON.stringify([topic, text, retain ? 1 : 0]);
  }

  // ── Host: the hub ──
  // options.code        the jam code carried in the invite
  // options.onGuests(n) number of connected phones changed
  function createHub(options) {
    options = options || {};
    var code = options.code || "";
    var guests = new Map();      // id -> { dc, pc }
    var retained = new Map();    // topic -> text
    var local = null;            // the host's own session
    var nextId = 1;
    var closed = false;

    function emit() { if (options.onGuests) options.onGuests(guests.size); }

    function sendTo(g, msg) {
      try {
        if (g.dc.readyState === "open" && g.dc.bufferedAmount < MAX_BUFFERED) g.dc.send(msg);
      } catch (e) { /* that phone dropped; its close handler cleans up */ }
    }

    function broadcast(msg, exceptId) {
      guests.forEach(function (g, id) { if (id !== exceptId) sendTo(g, msg); });
    }

    function onGuestMessage(id, data) {
      var arr;
      try { arr = JSON.parse(data); } catch (e) { return; }
      if (!Array.isArray(arr) || typeof arr[0] !== "string" || typeof arr[1] !== "string") return;
      if (arr[2]) retained.set(arr[0], arr[1]);
      broadcast(data, id);
      if (local && local.onMessage) local.onMessage(arr[0], textToBytes(arr[1]));
    }

    function attach(id, pc, dc) {
      var g = { pc: pc, dc: dc, open: false };
      dc.onopen = function () {
        g.open = true;
        guests.set(id, g);
        // Bring the newcomer up to date: chart, play state, library
        retained.forEach(function (text, topic) { sendTo(g, frame(topic, text, true)); });
        emit();
      };
      dc.onmessage = function (ev) { onGuestMessage(id, ev.data); };
      function gone() {
        if (guests.delete(id)) emit();
        try { pc.close(); } catch (e) { /* closed already */ }
      }
      dc.onclose = gone;
      pc.addEventListener("connectionstatechange", function () {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") gone();
      });
    }

    var hub = {
      get guestCount() { return guests.size; },
      setCode: function (c) { code = c; },

      // What Jam.createSession({ connect }) calls for the host's own session
      connect: function (url, opts) {
        local = opts || {};
        return Promise.resolve({
          publish: function (topic, payload, retain) {
            if (closed) return false;
            var text = bytesToText(payload);
            if (retain) retained.set(topic, text);
            broadcast(frame(topic, text, retain), null);
            return true;
          },
          subscribe: function () { return Promise.resolve(); },
          close: function () { /* the hub outlives the session's reconnects */ },
        });
      },

      // Start pairing one more phone. Resolves with the text to show as a QR.
      invite: function () {
        if (!supported()) return Promise.reject(new Error("unsupported"));
        var id = nextId++;
        var pc = newPc();
        var dc = pc.createDataChannel("gs", { ordered: true });
        attach(id, pc, dc);
        return pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          return gathered(pc);
        }).then(function () {
          var sig = extractSignal(pc.localDescription.sdp);
          if (!sig) throw new Error("no local address");
          var pending = null;
          return {
            text: pack("o", code, sig),
            // Resolves once the other phone is connected
            accept: function (answerText) {
              var a = unpack(answerText);
              if (!a || a.kind !== "a") return Promise.reject(new Error("not a reply code"));
              return pc.setRemoteDescription({ type: "answer", sdp: buildSdp(a, false) }).then(function () {
                pending = new Promise(function (resolve, reject) {
                  var t = setTimeout(function () { reject(new Error("timeout")); }, 20000);
                  var check = function () {
                    if (guests.has(id)) { clearTimeout(t); resolve(); }
                  };
                  dc.addEventListener("open", check);
                  check();
                  pc.addEventListener("connectionstatechange", function () {
                    if (pc.connectionState === "failed") { clearTimeout(t); reject(new Error("failed")); }
                  });
                });
                return pending;
              });
            },
            cancel: function () { if (!guests.has(id)) { try { pc.close(); } catch (e) { /* done */ } } },
          };
        });
      },

      close: function () {
        closed = true;
        guests.forEach(function (g) { try { g.pc.close(); } catch (e) { /* done */ } });
        guests.clear();
        retained.clear();
        local = null;
      },
    };
    return hub;
  }

  // ── Guest: scans the host's invite, replies, then follows ──
  // Resolves with { code, reply, ready, connect, close }:
  //   reply    text to show the host as a QR
  //   ready    resolves when the data channel to the host is open
  //   connect  what Jam.createSession({ connect }) calls
  function joinWithInvite(inviteText) {
    if (!supported()) return Promise.reject(new Error("unsupported"));
    var o = unpack(inviteText);
    if (!o || o.kind !== "o") return Promise.reject(new Error("not an invite code"));
    var pc = newPc();
    var dc = null;
    var opts = null;
    var closedByUs = false;
    var openWaiters = [];

    var ready = new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("timeout")); }, 60000);
      pc.ondatachannel = function (ev) {
        dc = ev.channel;
        dc.onmessage = function (m) {
          var arr;
          try { arr = JSON.parse(m.data); } catch (e) { return; }
          if (!Array.isArray(arr) || typeof arr[0] !== "string" || typeof arr[1] !== "string") return;
          if (opts && opts.onMessage) opts.onMessage(arr[0], textToBytes(arr[1]));
        };
        dc.onclose = function () { if (!closedByUs && opts && opts.onClose) opts.onClose(); };
        function opened() {
          clearTimeout(t);
          resolve();
          var w = openWaiters; openWaiters = [];
          w.forEach(function (f) { f(); });
        }
        if (dc.readyState === "open") opened(); else dc.onopen = opened;
      };
      pc.addEventListener("connectionstatechange", function () {
        if (pc.connectionState === "failed") { clearTimeout(t); reject(new Error("failed")); }
      });
    });
    ready.catch(function () { /* surfaced by whoever awaits it */ });

    return pc.setRemoteDescription({ type: "offer", sdp: buildSdp(o, true) }).then(function () {
      return pc.createAnswer();
    }).then(function (answer) {
      return pc.setLocalDescription(answer);
    }).then(function () {
      return gathered(pc);
    }).then(function () {
      var sig = extractSignal(pc.localDescription.sdp);
      if (!sig) throw new Error("no local address");
      return {
        code: o.code,
        reply: pack("a", o.code, sig),
        ready: ready,
        connect: function (url, copts) {
          opts = copts || {};
          return new Promise(function (resolve, reject) {
            function make() {
              resolve({
                publish: function (topic, payload, retain) {
                  if (!dc || dc.readyState !== "open" || dc.bufferedAmount > MAX_BUFFERED) return false;
                  try { dc.send(frame(topic, bytesToText(payload), retain)); return true; }
                  catch (e) { return false; }
                },
                subscribe: function () { return Promise.resolve(); },
                close: function () { /* the link stays up across session restarts */ },
              });
            }
            if (dc && dc.readyState === "open") make();
            else if (pc.connectionState === "failed" || pc.connectionState === "closed") reject(new Error("closed"));
            else openWaiters.push(make);
          });
        },
        close: function () { closedByUs = true; try { pc.close(); } catch (e) { /* done */ } },
      };
    });
  }

  return {
    supported: supported,
    createHub: createHub,
    joinWithInvite: joinWithInvite,
    unpack: unpack,
    _buildSdp: buildSdp,
    _extractSignal: extractSignal,
    _pack: pack,
  };
});
