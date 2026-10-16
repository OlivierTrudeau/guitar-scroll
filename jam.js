/*
 * Live jam sync for GuitarScroll.
 *
 * The site is static (GitHub Pages), so two phones can't talk to each other
 * directly. A jam is a short code plus a few public MQTT brokers: the player
 * publishes the open chart, then the scroll position a few times a second,
 * and everyone who has the code subscribes and follows. The room is opened on
 * every broker at once, so the two phones still meet when one of the relays
 * is down. The code is the only access check — treat a jam link like a room key.
 *
 * Followers do not need the song saved. The host sends the chart itself, again
 * whenever someone joins without it, and in pieces when it is long. Play
 * updates also carry the title, so a phone that already has the song can show
 * it before the rest of the chart arrives.
 *
 * Followers do not copy the host's pixel speed. Charts reflow to the screen
 * width, so the same chord sits at a different scrollTop on each phone. The
 * host sends progress as a fraction of the chart, and the follower scrolls to
 * that fraction, coasting between packets so the motion stays smooth.
 *
 * Phones on the same network can find a jam without the code. Browsers can't
 * broadcast on the LAN, so each one derives a key from its public address
 * (and the private /24, when WebRTC exposes one) and listens on that topic.
 * A host announces only the code and the song title there — never the chart.
 *
 * Followers can also see the rest of the host's library: titles and artists
 * only, on their own topic, so they know what they could ask for next. Charts
 * and practice history stay off that list.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Jam = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Unambiguous spoken aloud: no 0/O, 1/I/L.
  var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var CODE_LENGTH = 5;
  // HiveMQ first; the others are tried if a socket never finishes connecting.
  var BROKERS = [
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://broker.emqx.io:8084/mqtt",
    "wss://test.mosquitto.org:8081",
  ];
  var PEER_TTL_MS = 8000;
  var COAST_MS = 1200;
  // Small enough that a public broker will carry each piece. A short chart
  // still goes out as one message.
  var CHUNK_CHARS = 6000;

  function randomId(n) {
    var bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    return s;
  }

  function newCode() {
    return randomId(CODE_LENGTH);
  }

  // Accepts "k7mqp", "K7M QP", or a full jam URL.
  function normalizeCode(raw) {
    if (raw == null) return "";
    var text = String(raw).trim();
    var fromQuery = text.match(/[?&]jam=([^&#\s]+)/i);
    if (fromQuery) {
      try { text = decodeURIComponent(fromQuery[1]); }
      catch (e) { text = fromQuery[1]; }
    }
    text = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (text.length !== CODE_LENGTH) return "";
    for (var i = 0; i < text.length; i++) {
      if (ALPHABET.indexOf(text.charAt(i)) === -1) return "";
    }
    return text;
  }

  function jamTopics(code) {
    var base = "gsjam/v1/" + code;
    return { song: base + "/s", play: base + "/p", here: base + "/h", library: base + "/lib" };
  }

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function publicSong(song) {
    song = song || {};
    var speed = song.speed;
    return {
      id: String(song.id || ""),
      title: String(song.title || ""),
      artist: String(song.artist || ""),
      capo: String(song.capo || ""),
      strum: String(song.strum || ""),
      speed: typeof speed === "number" && isFinite(speed) ? speed : null,
      body: String(song.body || ""),
    };
  }

  // Titles and artists only. Practice notes and chart text stay on the host's phone.
  function publicCatalog(songs) {
    var list = [];
    var src = songs || [];
    for (var i = 0; i < src.length; i++) {
      var song = src[i] || {};
      var id = String(song.id || "");
      var title = String(song.title || "").trim();
      if (!id && !title) continue;
      list.push({
        id: id,
        title: title || "Untitled",
        artist: String(song.artist || "").trim(),
      });
    }
    list.sort(function (a, b) {
      var at = a.title.toLowerCase();
      var bt = b.title.toLowerCase();
      if (at < bt) return -1;
      if (at > bt) return 1;
      var aa = a.artist.toLowerCase();
      var ba = b.artist.toLowerCase();
      if (aa < ba) return -1;
      if (aa > ba) return 1;
      return 0;
    });
    return list;
  }

  function catalogRev(list) {
    var s = JSON.stringify(list || []);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function songRev(song) {
    var pub = publicSong(song);
    var s = [pub.id, pub.title, pub.artist, pub.capo, pub.strum, pub.speed == null ? "" : String(pub.speed), pub.body].join("\u0001");
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  // Cut on code-unit boundaries, but never through a surrogate pair, so a
  // rejoined chart is byte-for-byte the chart that was sent.
  function splitChunks(str, size) {
    str = String(str || "");
    size = size || CHUNK_CHARS;
    if (str.length <= size) return [str];
    var out = [];
    var i = 0;
    while (i < str.length) {
      var end = Math.min(str.length, i + size);
      if (end < str.length) {
        var cu = str.charCodeAt(end - 1);
        if (cu >= 0xD800 && cu <= 0xDBFF) end--;
        if (end <= i) end = Math.min(str.length, i + 1);
      }
      out.push(str.slice(i, end));
      i = end;
    }
    return out;
  }

  function normName(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // A follower who already saved this song can show it while the host's copy
  // is still arriving. Id wins; otherwise title and artist, ignoring accents.
  function matchLibrary(library, hint) {
    if (!hint || !library || !library.length) return null;
    var id = hint.id || (hint.song && hint.song.id) || "";
    var i;
    if (id) {
      for (i = 0; i < library.length; i++) {
        if (library[i] && library[i].id === id && library[i].body) return library[i];
      }
    }
    var title = normName(hint.title || (hint.song && hint.song.title));
    var artist = normName(hint.artist || (hint.song && hint.song.artist));
    if (!title) return null;
    for (i = 0; i < library.length; i++) {
      var song = library[i];
      if (!song || !song.body) continue;
      if (normName(song.title) !== title) continue;
      if (artist && normName(song.artist) !== artist) continue;
      return song;
    }
    return null;
  }

  function progressOf(scrollTop, scrollHeight, clientHeight) {
    var max = scrollHeight - clientHeight;
    if (!(max > 0)) return 0;
    return clamp01(scrollTop / max);
  }

  // Fold a host sample into the cursor the follower renders from.
  // `now` is the follower's clock at arrival — extrapolation uses that, not
  // the host's timestamp, so the two phones don't need synced clocks.
  // The host marks a drag or a scrub with `seek`. Progress alone can't tell a
  // scrub from autoscroll: a short chart at 50× covers most of the page
  // between two packets.
  function cursorFromSample(prev, sample, now) {
    sample = sample || {};
    var progress = clamp01(sample.progress);
    var playing = !!sample.playing;
    var velocity = 0;
    var seek = true;
    var same = !!(prev && prev.rev === sample.rev);
    if (playing && same && !sample.seek) {
      var dt = Number(sample.ts) - Number(prev.ts);
      var dp = progress - prev.progress;
      if (dt >= 40 && dt <= 2500 && Math.abs(dp) <= dt * 0.02) {
        velocity = dp / dt;
        seek = false;
      } else if (prev.playing && (prev.velocity || 0) !== 0 && dt > 2500) {
        // A stalled packet: keep the last speed instead of freezing.
        velocity = prev.velocity;
        seek = false;
      }
    }
    if (!playing || sample.seek || !same) {
      velocity = 0;
      seek = true;
    }
    return {
      rev: sample.rev,
      playing: playing,
      speed: sample.speed,
      progress: progress,
      ts: Number(sample.ts) || now,
      velocity: velocity,
      seek: seek,
      receivedAt: now,
    };
  }

  function targetProgress(cursor, now) {
    if (!cursor) return 0;
    if (!cursor.playing) return clamp01(cursor.progress);
    var elapsed = now - cursor.receivedAt;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > COAST_MS) elapsed = COAST_MS;
    return clamp01(cursor.progress + cursor.velocity * elapsed);
  }

  function concat(parts) {
    var len = 0;
    for (var i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    var o = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], o);
      o += parts[j].length;
    }
    return out;
  }

  function encodeRemainingLength(n) {
    if (n < 0 || n > 268435455) throw new Error("mqtt length");
    var out = [];
    do {
      var byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Uint8Array.from(out);
  }

  function mqttString(str) {
    var body = new TextEncoder().encode(str);
    if (body.length > 65535) throw new Error("mqtt string");
    var out = new Uint8Array(2 + body.length);
    out[0] = body.length >> 8;
    out[1] = body.length & 255;
    out.set(body, 2);
    return out;
  }

  function withFixed(typeFlags, body) {
    var rl = encodeRemainingLength(body.length);
    var out = new Uint8Array(1 + rl.length + body.length);
    out[0] = typeFlags;
    out.set(rl, 1);
    out.set(body, 1 + rl.length);
    return out;
  }

  function encodeConnect(clientId, keepAlive) {
    var head = new Uint8Array([
      0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
      0x04,
      0x02,
      (keepAlive >> 8) & 255,
      keepAlive & 255,
    ]);
    return withFixed(0x10, concat([head, mqttString(clientId)]));
  }

  function encodePublish(topic, payload, retain) {
    var body = payload instanceof Uint8Array ? payload : new TextEncoder().encode(String(payload));
    return withFixed(retain ? 0x31 : 0x30, concat([mqttString(topic), body]));
  }

  function encodeSubscribe(topic, packetId) {
    var id = new Uint8Array([(packetId >> 8) & 255, packetId & 255]);
    return withFixed(0x82, concat([id, mqttString(topic), new Uint8Array([0])]));
  }

  function encodePingreq() { return new Uint8Array([0xc0, 0x00]); }
  function encodeDisconnect() { return new Uint8Array([0xe0, 0x00]); }

  function encodeJson(obj) {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  function readRemainingLength(buf, offset) {
    var value = 0;
    var multiplier = 1;
    var bytes = 0;
    for (;;) {
      if (offset + bytes >= buf.length) return null;
      var byte = buf[offset + bytes];
      bytes++;
      value += (byte & 127) * multiplier;
      if ((byte & 128) === 0) return { value: value, bytes: bytes };
      if (bytes === 4) return { error: true };
      multiplier *= 128;
    }
  }

  function readMqttString(buf, offset) {
    if (offset + 2 > buf.length) return null;
    var len = (buf[offset] << 8) | buf[offset + 1];
    var start = offset + 2;
    if (start + len > buf.length) return null;
    return {
      value: new TextDecoder().decode(buf.subarray(start, start + len)),
      next: start + len,
    };
  }

  function decodePacket(packet) {
    var type = packet[0] >> 4;
    var flags = packet[0] & 0x0f;
    var rl = readRemainingLength(packet, 1);
    if (!rl || rl.error) return { type: "error" };
    var o = 1 + rl.bytes;
    if (type === 2) {
      return { type: "connack", returnCode: packet[o + 1] || 0 };
    }
    if (type === 3) {
      var topic = readMqttString(packet, o);
      if (!topic) return { type: "error" };
      o = topic.next;
      var qos = (flags >> 1) & 0x03;
      if (qos > 0) o += 2;
      return { type: "publish", topic: topic.value, payload: packet.slice(o), retain: (flags & 1) === 1 };
    }
    if (type === 9) {
      return { type: "suback", packetId: (packet[o] << 8) | packet[o + 1] };
    }
    if (type === 13) return { type: "pingresp" };
    return { type: "other", packetType: type };
  }

  function createParser() {
    var buf = new Uint8Array(0);
    return {
      push: function (chunk) {
        if (!(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
        if (buf.length === 0) buf = chunk;
        else {
          var next = new Uint8Array(buf.length + chunk.length);
          next.set(buf, 0);
          next.set(chunk, buf.length);
          buf = next;
        }
        var packets = [];
        for (;;) {
          if (buf.length < 2) break;
          var rl = readRemainingLength(buf, 1);
          if (!rl) break;
          if (rl.error) {
            buf = new Uint8Array(0);
            packets.push({ type: "error" });
            break;
          }
          var total = 1 + rl.bytes + rl.value;
          if (buf.length < total) break;
          packets.push(decodePacket(buf.slice(0, total)));
          buf = buf.slice(total);
        }
        return packets;
      },
    };
  }

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return data.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    return Promise.resolve(new Uint8Array(data));
  }

  function defaultConnect(url, opts) {
    return new Promise(function (resolve, reject) {
      var ws;
      var settled = false;
      var failed = false;
      var pendingSub = new Map();
      var packetId = 1;
      var parser = createParser();
      var timer = setTimeout(function () { fail(new Error("timeout")); }, 8000);

      function fail(err) {
        if (settled) return;
        failed = true;
        settled = true;
        clearTimeout(timer);
        try { if (ws) ws.close(); } catch (e) { /* already closing */ }
        reject(err);
      }

      try {
        ws = new WebSocket(url, "mqtt");
      } catch (err) {
        fail(err);
        return;
      }
      ws.binaryType = "arraybuffer";

      var conn = {
        publish: function (topic, payload, retain) {
          if (ws.readyState !== WebSocket.OPEN) return false;
          if (ws.bufferedAmount > 262144) return false;
          ws.send(encodePublish(topic, payload, !!retain));
          return true;
        },
        subscribe: function (topic) {
          var id = packetId++;
          if (id === 0) id = packetId++;
          ws.send(encodeSubscribe(topic, id));
          return new Promise(function (res, rej) {
            var subTimer = setTimeout(function () { rej(new Error("suback timeout")); }, 8000);
            pendingSub.set(id, function () {
              clearTimeout(subTimer);
              res();
            });
          });
        },
        close: function () {
          clearInterval(conn._ping);
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(encodeDisconnect());
          } catch (e) { /* socket already gone */ }
          try { ws.close(); } catch (e2) { /* socket already gone */ }
        },
      };

      ws.onopen = function () {
        ws.send(encodeConnect(opts.clientId, 30));
      };
      ws.onmessage = function (ev) {
        toBytes(ev.data).then(function (bytes) {
          var packets = parser.push(bytes);
          for (var i = 0; i < packets.length; i++) {
            var p = packets[i];
            if (p.type === "connack") {
              if (p.returnCode !== 0) {
                fail(new Error("connack " + p.returnCode));
                return;
              }
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              conn._ping = setInterval(function () {
                if (ws.readyState === WebSocket.OPEN) ws.send(encodePingreq());
              }, 10000);
              resolve(conn);
            } else if (p.type === "suback") {
              var done = pendingSub.get(p.packetId);
              if (done) {
                pendingSub.delete(p.packetId);
                done();
              }
            } else if (p.type === "publish") {
              if (opts.onMessage) opts.onMessage(p.topic, p.payload);
            } else if (p.type === "error") {
              try { ws.close(); } catch (e) { /* parser asked us to drop */ }
            }
          }
        }).catch(function () { /* ignore a frame we couldn't read */ });
      };
      ws.onerror = function () { fail(new Error("socket error")); };
      ws.onclose = function () {
        clearInterval(conn._ping);
        if (!settled) fail(new Error("socket closed"));
        else if (!failed && opts.onClose) opts.onClose();
      };
    });
  }

  function createSession(options) {
    options = options || {};
    var connect = options.connect || defaultConnect;
    var brokers = options.brokers || BROKERS.slice();
    var hostId = options.hostId || randomId(8);
    var selfId = options.selfId || randomId(8);
    var hereMs = options.hereMs || 3000;
    var peerTtl = options.peerTtl || PEER_TTL_MS;

    var role = "idle";
    var code = "";
    var sockets = [];
    var retryTimers = [];
    var epoch = 0;
    var announced = false;
    var stopped = false;
    var ended = false;
    var seq = 0;
    var lockedHost = "";
    var hereTimer = null;
    var peerTimer = null;
    var peers = new Map();
    var lastSong = null;
    var lastPlay = null;
    var liveWaiters = [];
    var heldRev = "";
    var songHeader = null;
    var chunkBags = Object.create(null);
    var lastLibrary = null;
    var libHeader = null;
    var libBags = Object.create(null);
    var heldLibRev = "";
    var lastPlaySeq = 0;
    var lastResendAt = 0;
    var resendMs = options.resendMs || 1200;

    function emitStatus(status) {
      if (options.onStatus) options.onStatus(status);
    }

    function failWaiters(err) {
      var waiters = liveWaiters;
      liveWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i].reject(err);
    }

    function readyWaiters() {
      var waiters = liveWaiters;
      liveWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i].resolve(code);
    }

    function topics() {
      return jamTopics(code);
    }

    function write(topic, obj, retain) {
      if (stopped) return false;
      var payload;
      try { payload = encodeJson(obj); }
      catch (e) { return false; }
      var ok = false;
      for (var i = 0; i < sockets.length; i++) {
        var s = sockets[i];
        if (!s) continue;
        try {
          if (s.publish(topic, payload, !!retain)) ok = true;
        } catch (e2) { /* that relay is gone */ }
      }
      return ok;
    }

    function transmitSong() {
      if (!lastSong || stopped) return;
      lastResendAt = Date.now();
      var header = {
        v: 1,
        kind: "song",
        hostId: lastSong.hostId,
        rev: lastSong.rev,
        seq: ++seq,
        parts: lastSong.parts || 0,
        song: lastSong.song,
      };
      write(topics().song, header, true);
      var chunks = lastSong.chunks;
      if (!chunks) return;
      for (var i = 0; i < chunks.length; i++) {
        write(topics().song + "/" + i, {
          v: 1,
          kind: "chunk",
          hostId: lastSong.hostId,
          rev: lastSong.rev,
          seq: ++seq,
          i: i,
          n: chunks.length,
          data: chunks[i],
        }, true);
      }
    }

    function transmitPlay() {
      if (!lastPlay || !lastSong || stopped) return;
      lastPlay.seq = ++seq;
      lastPlay.rev = lastSong.rev;
      lastPlay.id = lastSong.song.id;
      lastPlay.title = lastSong.song.title;
      lastPlay.artist = lastSong.song.artist;
      write(topics().play, lastPlay, true);
    }

    // Someone joined without this chart. Play packets repeat on their own;
    // the chart has to be asked for again or a missed copy is gone for good.
    function maybeResend() {
      var now = Date.now();
      if (now - lastResendAt < resendMs) return;
      transmitSong();
      transmitPlay();
      transmitLibrary();
    }

    function emitPeers() {
      var now = Date.now();
      var n = 0;
      peers.forEach(function (t, id) {
        if (now - t > peerTtl) peers.delete(id);
        else n++;
      });
      if (options.onPeers) options.onPeers(n);
    }

    function notePeer(id) {
      if (!id || id === selfId) return;
      peers.set(String(id), Date.now());
      emitPeers();
    }

    function startHere() {
      clearInterval(hereTimer);
      var send = function () {
        write(topics().here, { v: 1, kind: "here", id: selfId, rev: heldRev || "", lib: heldLibRev || "" }, false);
      };
      send();
      hereTimer = setInterval(send, hereMs);
    }

    function startPeerSweep() {
      clearInterval(peerTimer);
      emitPeers();
      peerTimer = setInterval(emitPeers, 2000);
    }

    function emitSong(rev, song) {
      if (!song || !rev || heldRev === rev) return;
      heldRev = rev;
      if (options.onSong) {
        options.onSong({ v: 1, kind: "song", hostId: lockedHost, rev: rev, song: song });
      }
    }

    function tryAssemble() {
      if (!songHeader || songHeader.kind !== "song" || !songHeader.song || !songHeader.rev) return;
      var rev = songHeader.rev;
      var n = songHeader.parts || 0;
      if (!n) {
        emitSong(rev, songHeader.song);
        return;
      }
      var parts = chunkBags[rev];
      if (!parts) return;
      var body = "";
      for (var i = 0; i < n; i++) {
        if (typeof parts[i] !== "string") return;
        body += parts[i];
      }
      var song = {};
      var src = songHeader.song;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) song[k] = src[k];
      }
      song.body = body;
      emitSong(rev, song);
    }

    function handle(topic, bytes) {
      if (stopped) return;
      var msg;
      try { msg = JSON.parse(new TextDecoder().decode(bytes)); }
      catch (e) { return; }
      if (!msg || msg.v !== 1) return;
      var t = topics();
      if (role === "host") {
        if (topic === t.here && msg.kind === "here") {
          notePeer(msg.id);
          if ((lastSong && msg.rev !== lastSong.rev) || (lastLibrary && (msg.lib || "") !== lastLibrary.rev)) maybeResend();
        }
        return;
      }
      if (role !== "follow" || ended) return;
      var chunkTopic = topic.indexOf(t.song + "/") === 0;
      var libChunk = topic.indexOf(t.library + "/") === 0;
      if (topic !== t.song && topic !== t.play && topic !== t.library && !chunkTopic && !libChunk) return;
      if (msg.hostId) {
        if (lockedHost && msg.hostId !== lockedHost) return;
        lockedHost = msg.hostId;
      }
      if (msg.kind === "end") {
        ended = true;
        clearInterval(hereTimer);
        hereTimer = null;
        if (options.onEnd) options.onEnd();
        shutdown();
        return;
      }
      // Play and the chart travel on different topics, and the chart is often
      // much larger. A shared sequence number let a play packet that arrived
      // first throw the chart away — which is exactly the message a phone
      // without the song is waiting on.
      if (topic === t.play && msg.kind === "play") {
        if (typeof msg.seq === "number") {
          if (msg.seq <= lastPlaySeq) return;
          lastPlaySeq = msg.seq;
        }
        if (options.onPlay) options.onPlay(msg);
        return;
      }
      if (topic === t.song && msg.kind === "song" && msg.song) {
        var kept = chunkBags[msg.rev];
        songHeader = msg;
        chunkBags = Object.create(null);
        if (kept) chunkBags[msg.rev] = kept;
        tryAssemble();
        return;
      }
      if (chunkTopic && msg.kind === "chunk" && msg.rev && typeof msg.i === "number") {
        if (!chunkBags[msg.rev]) chunkBags[msg.rev] = [];
        chunkBags[msg.rev][msg.i] = String(msg.data == null ? "" : msg.data);
        tryAssemble();
        return;
      }
      if (topic === t.library && msg.kind === "library") {
        var keptLib = libBags[msg.rev];
        libHeader = msg;
        libBags = Object.create(null);
        if (keptLib) libBags[msg.rev] = keptLib;
        tryAssembleLibrary();
        return;
      }
      if (libChunk && msg.kind === "libchunk" && msg.rev && typeof msg.i === "number") {
        if (!libBags[msg.rev]) libBags[msg.rev] = [];
        libBags[msg.rev][msg.i] = String(msg.data == null ? "" : msg.data);
        tryAssembleLibrary();
      }
    }

    function emitLibrary(rev, songs) {
      if (!rev || heldLibRev === rev) return;
      heldLibRev = rev;
      if (options.onLibrary) {
        options.onLibrary({ v: 1, kind: "library", hostId: lockedHost, rev: rev, songs: songs });
      }
    }

    function tryAssembleLibrary() {
      if (!libHeader || libHeader.kind !== "library" || !libHeader.rev) return;
      var rev = libHeader.rev;
      var n = libHeader.parts || 0;
      if (!n) {
        emitLibrary(rev, publicCatalog(libHeader.songs || []));
        return;
      }
      var parts = libBags[rev];
      if (!parts) return;
      var json = "";
      for (var i = 0; i < n; i++) {
        if (typeof parts[i] !== "string") return;
        json += parts[i];
      }
      var parsed;
      try { parsed = JSON.parse(json); }
      catch (e) { return; }
      if (!Array.isArray(parsed)) return;
      emitLibrary(rev, publicCatalog(parsed));
    }

    function transmitLibrary() {
      if (!lastLibrary || stopped) return;
      var header = {
        v: 1,
        kind: "library",
        hostId: lastLibrary.hostId,
        rev: lastLibrary.rev,
        seq: ++seq,
        parts: lastLibrary.parts || 0,
        songs: lastLibrary.songs,
      };
      write(topics().library, header, true);
      var chunks = lastLibrary.chunks;
      if (!chunks) return;
      for (var i = 0; i < chunks.length; i++) {
        write(topics().library + "/" + i, {
          v: 1,
          kind: "libchunk",
          hostId: lastLibrary.hostId,
          rev: lastLibrary.rev,
          seq: ++seq,
          i: i,
          n: chunks.length,
          data: chunks[i],
        }, true);
      }
    }

    function later(fn, ms) {
      var timer = setTimeout(fn, ms);
      retryTimers.push(timer);
      return timer;
    }

    function clearRetries() {
      for (var i = 0; i < retryTimers.length; i++) clearTimeout(retryTimers[i]);
      retryTimers = [];
    }

    function subscribeAll(conn) {
      var t = topics();
      if (role === "host") return conn.subscribe(t.here);
      return conn.subscribe(t.song).then(function () {
        return conn.subscribe(t.song + "/#");
      }).then(function () {
        return conn.subscribe(t.play);
      }).then(function () {
        return conn.subscribe(t.library);
      }).then(function () {
        return conn.subscribe(t.library + "/#");
      });
    }

    // The first relay to come up is enough to start. Each one that joins
    // after that gets the chart too, so a follower stuck on a different
    // relay still receives it.
    function noteLive() {
      var first = !announced;
      announced = true;
      if (first) {
        emitStatus("live");
        if (role === "host") startPeerSweep();
        else startHere();
        readyWaiters();
      }
      if (role === "host") {
        transmitSong();
        transmitPlay();
        transmitLibrary();
      }
    }

    function noteDrop() {
      var any = false;
      for (var i = 0; i < sockets.length; i++) if (sockets[i]) any = true;
      if (!any && announced && !stopped) {
        announced = false;
        emitStatus("reconnecting");
      }
    }

    function connectOne(idx, seenEpoch) {
      if (stopped || seenEpoch !== epoch) return;
      connect(brokers[idx], {
        clientId: "g" + randomId(10),
        onMessage: function (topic, payload) {
          if (seenEpoch !== epoch || stopped) return;
          handle(topic, payload);
        },
        onClose: function () {
          if (seenEpoch !== epoch || stopped) return;
          sockets[idx] = null;
          noteDrop();
          later(function () { connectOne(idx, seenEpoch); }, 500);
        },
      }).then(function (conn) {
        if (seenEpoch !== epoch || stopped) {
          try { conn.close(); } catch (e) { /* replaced by a newer socket */ }
          return;
        }
        return subscribeAll(conn).then(function () {
          if (seenEpoch !== epoch || stopped) {
            try { conn.close(); } catch (e) { /* user left while subscribing */ }
            return;
          }
          sockets[idx] = conn;
          noteLive();
        }, function () {
          try { conn.close(); } catch (e) { /* already closing */ }
          if (seenEpoch === epoch && !stopped) later(function () { connectOne(idx, seenEpoch); }, 500);
        });
      }).catch(function () {
        if (seenEpoch !== epoch || stopped) return;
        later(function () { connectOne(idx, seenEpoch); }, 700);
      });
    }

    function connectAll() {
      sockets = new Array(brokers.length);
      for (var i = 0; i < brokers.length; i++) connectOne(i, epoch);
    }

    function shutdown() {
      var busy = false;
      for (var i = 0; i < sockets.length; i++) if (sockets[i]) busy = true;
      if (stopped && !busy && !hereTimer && !peerTimer && liveWaiters.length === 0 && retryTimers.length === 0) {
        role = "idle";
        return;
      }
      stopped = true;
      ended = true;
      role = "idle";
      epoch++;
      announced = false;
      clearRetries();
      clearInterval(hereTimer);
      clearInterval(peerTimer);
      hereTimer = null;
      peerTimer = null;
      var open = sockets;
      sockets = [];
      for (var j = 0; j < open.length; j++) {
        if (!open[j]) continue;
        try { open[j].close(); } catch (e) { /* already closed */ }
      }
      failWaiters(new Error("closed"));
    }

    function begin(nextRole, rawCode) {
      var norm = nextRole === "host" ? String(rawCode || "") : normalizeCode(rawCode);
      if (!norm || (nextRole === "host" && normalizeCode(norm) !== norm)) {
        return Promise.reject(new Error("bad code"));
      }
      shutdown();
      stopped = false;
      ended = false;
      role = nextRole;
      code = norm;
      seq = 0;
      lockedHost = nextRole === "host" ? hostId : "";
      lastSong = null;
      lastPlay = null;
      lastLibrary = null;
      peers = new Map();
      heldRev = "";
      songHeader = null;
      chunkBags = Object.create(null);
      libHeader = null;
      libBags = Object.create(null);
      heldLibRev = "";
      lastPlaySeq = 0;
      lastResendAt = 0;
      announced = false;
      emitStatus("connecting");
      var promise = new Promise(function (resolve, reject) {
        liveWaiters.push({ resolve: resolve, reject: reject });
      });
      connectAll();
      return promise;
    }

    return {
      get role() { return role; },
      get code() { return code; },
      host: function (wanted) { return begin("host", wanted || newCode()); },
      follow: function (wanted) { return begin("follow", wanted); },
      publishSong: function (song) {
        if (role !== "host" || ended || stopped) return;
        var pub = publicSong(song);
        var rev = songRev(pub);
        var pieces = splitChunks(pub.body, CHUNK_CHARS);
        if (pieces.length <= 1) {
          lastSong = { hostId: hostId, rev: rev, parts: 0, song: pub, chunks: null };
        } else {
          lastSong = {
            hostId: hostId,
            rev: rev,
            parts: pieces.length,
            song: {
              id: pub.id,
              title: pub.title,
              artist: pub.artist,
              capo: pub.capo,
              strum: pub.strum,
              speed: pub.speed,
              body: "",
            },
            chunks: pieces,
          };
        }
        transmitSong();
      },
      publishLibrary: function (songs) {
        if (role !== "host" || ended || stopped) return;
        var list = publicCatalog(songs);
        var rev = catalogRev(list);
        if (lastLibrary && lastLibrary.rev === rev) return;
        var pieces = splitChunks(JSON.stringify(list), CHUNK_CHARS);
        if (pieces.length <= 1) {
          lastLibrary = { hostId: hostId, rev: rev, parts: 0, songs: list, chunks: null };
        } else {
          lastLibrary = { hostId: hostId, rev: rev, parts: pieces.length, songs: [], chunks: pieces };
        }
        transmitLibrary();
      },
      publishPlay: function (state) {
        if (role !== "host" || ended || stopped || !lastSong) return;
        state = state || {};
        lastPlay = {
          v: 1,
          kind: "play",
          hostId: hostId,
          rev: lastSong.rev,
          id: lastSong.song.id,
          title: lastSong.song.title,
          artist: lastSong.song.artist,
          playing: !!state.playing,
          seek: !!state.seek,
          speed: typeof state.speed === "number" ? state.speed : null,
          progress: Math.round(clamp01(state.progress) * 100000) / 100000,
          ts: typeof state.ts === "number" ? state.ts : Date.now(),
        };
        transmitPlay();
      },
      end: function () {
        if (role !== "host") {
          shutdown();
          return;
        }
        ended = true;
        var base = { v: 1, kind: "end", hostId: hostId };
        write(topics().song, Object.assign({ seq: ++seq }, base), true);
        write(topics().play, Object.assign({ seq: ++seq }, base), true);
        shutdown();
        emitStatus("ended");
      },
      close: function () {
        shutdown();
        emitStatus("closed");
      },
    };
  }

  function nearKeyFrom(text) {
    text = String(text || "");
    if (!text) return "";
    var h1 = 2166136261;
    var h2 = 2166136261 ^ 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 16777619);
      h2 ^= c;
      h2 = Math.imul(h2, 16777619);
    }
    h1 = h1 >>> 0;
    h2 = h2 >>> 0;
    var s = "";
    var n = ALPHABET.length;
    for (var a = 0; a < 4; a++) {
      s += ALPHABET[h1 % n];
      h1 = Math.floor(h1 / n);
    }
    for (var b = 0; b < 4; b++) {
      s += ALPHABET[h2 % n];
      h2 = Math.floor(h2 / n);
    }
    return s;
  }

  function usableNearKey(key) {
    key = String(key || "").trim().toUpperCase();
    if (key.length !== 8) return "";
    for (var i = 0; i < key.length; i++) {
      if (ALPHABET.indexOf(key.charAt(i)) === -1) return "";
    }
    return key;
  }

  function ipv4Parts(ip) {
    var m = String(ip || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    var parts = [+m[1], +m[2], +m[3], +m[4]];
    for (var i = 0; i < 4; i++) if (parts[i] > 255) return null;
    return parts;
  }

  function isPrivateIp(ip) {
    var p = ipv4Parts(ip);
    if (!p) return false;
    if (p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }

  function isPublicIp(ip) {
    var p = ipv4Parts(ip);
    if (!p) return false;
    if (isPrivateIp(ip)) return false;
    if (p[0] === 0 || p[0] === 127 || p[0] >= 224) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    return true;
  }

  function privatePrefix(ip) {
    if (!isPrivateIp(ip)) return "";
    var p = ipv4Parts(ip);
    return p[0] + "." + p[1] + "." + p[2] + ".0/24";
  }

  function tracePublicIp() {
    if (typeof fetch !== "function") return Promise.resolve("");
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 2500);
    var opts = ctrl ? { signal: ctrl.signal } : undefined;
    function read(url, pick) {
      return fetch(url, opts).then(function (r) { return r.text(); }).then(pick);
    }
    return read("https://www.cloudflare.com/cdn-cgi/trace", function (text) {
      var m = String(text || "").match(/(?:^|\n)ip=([0-9.]+)/);
      return m && isPublicIp(m[1]) ? m[1] : "";
    }).catch(function () { return ""; }).then(function (ip) {
      if (ip) return ip;
      return read("https://api.ipify.org?format=json", function (text) {
        var m = String(text || "").match(/"ip"\s*:\s*"([0-9.]+)"/);
        return m && isPublicIp(m[1]) ? m[1] : "";
      }).catch(function () { return ""; });
    }).then(function (ip) {
      clearTimeout(timer);
      return ip || "";
    });
  }

  function discoverNetwork() {
    return new Promise(function (resolve) {
      if (typeof RTCPeerConnection !== "function") {
        tracePublicIp().then(function (ip) { resolve({ publicIp: ip, privatePrefix: "" }); });
        return;
      }
      var pc;
      try {
        pc = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.cloudflare.com:3478" },
          ],
        });
      } catch (e) {
        tracePublicIp().then(function (ip) { resolve({ publicIp: ip, privatePrefix: "" }); });
        return;
      }
      var done = false;
      var publicIp = "";
      var prefix = "";
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { pc.close(); } catch (err) { /* gathering already finished */ }
        if (publicIp) {
          resolve({ publicIp: publicIp, privatePrefix: prefix });
          return;
        }
        tracePublicIp().then(function (ip) {
          resolve({ publicIp: ip || "", privatePrefix: prefix });
        });
      }
      var timer = setTimeout(finish, 2500);
      pc.onicecandidate = function (ev) {
        if (!ev.candidate) {
          finish();
          return;
        }
        var parts = String(ev.candidate.candidate || "").split(" ");
        var ip = parts[4] || "";
        var typ = "";
        for (var i = 0; i < parts.length; i++) {
          if (parts[i] === "typ" && parts[i + 1]) typ = parts[i + 1];
        }
        if ((typ === "srflx" || typ === "host") && isPublicIp(ip) && !publicIp) publicIp = ip;
        if (typ === "host" && !prefix) prefix = privatePrefix(ip);
        if (publicIp && prefix) finish();
      };
      try {
        pc.createDataChannel("gs");
        pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).catch(function () { finish(); });
      } catch (e2) {
        finish();
      }
    });
  }

  function networkKey(options) {
    options = options || {};
    var storage = options.storage || null;
    if (!storage && typeof localStorage !== "undefined") {
      try { storage = localStorage; } catch (e) { storage = null; }
    }
    if (storage) {
      try {
        var override = usableNearKey(storage.getItem("guitarscroll_netkey"));
        if (override) return Promise.resolve(override);
      } catch (e2) { /* private mode */ }
    }
    return discoverNetwork().then(function (info) {
      if (!info || !info.publicIp) return "";
      var material = info.publicIp;
      if (info.privatePrefix) material += "|" + info.privatePrefix;
      return nearKeyFrom(material);
    });
  }

  function createNearby(options) {
    options = options || {};
    var connect = options.connect || defaultConnect;
    var brokers = options.brokers || BROKERS.slice();
    var selfId = options.selfId || randomId(8);
    var key = usableNearKey(options.key);
    var announceMs = options.announceMs || 2000;
    var sockets = [];
    var retryTimers = [];
    var epoch = 0;
    var stopped = true;
    var announced = false;
    var info = null;
    var announceTimer = null;
    var liveWaiters = [];

    function topic() {
      return "gsjam/v1/near/" + key;
    }

    function emitStatus(status) {
      if (options.onStatus) options.onStatus(status);
    }

    function failWaiters(err) {
      var waiters = liveWaiters;
      liveWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i].reject(err);
    }

    function readyWaiters() {
      var waiters = liveWaiters;
      liveWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i].resolve(key);
    }

    function write(obj) {
      if (stopped) return false;
      var payload;
      try { payload = encodeJson(obj); }
      catch (e) { return false; }
      var ok = false;
      for (var i = 0; i < sockets.length; i++) {
        var s = sockets[i];
        if (!s) continue;
        try {
          if (s.publish(topic(), payload, false)) ok = true;
        } catch (e2) { /* that relay is gone */ }
      }
      return ok;
    }

    function transmit() {
      if (!info || stopped) return;
      write({
        v: 1,
        kind: "near",
        from: selfId,
        code: info.code,
        title: info.title || "",
        artist: info.artist || "",
      });
    }

    function transmitStop(code) {
      write({ v: 1, kind: "near-stop", from: selfId, code: code || "" });
    }

    function handle(topicName, bytes) {
      if (stopped || topicName !== topic()) return;
      var msg;
      try { msg = JSON.parse(new TextDecoder().decode(bytes)); }
      catch (e) { return; }
      if (!msg || msg.v !== 1 || !msg.from || msg.from === selfId) return;
      if (msg.kind === "near") {
        var code = normalizeCode(msg.code);
        if (!code) return;
        if (options.onNear) {
          options.onNear({
            from: String(msg.from),
            code: code,
            title: String(msg.title || ""),
            artist: String(msg.artist || ""),
          });
        }
        return;
      }
      if (msg.kind === "near-stop") {
        if (options.onStop) {
          options.onStop({
            from: String(msg.from),
            code: normalizeCode(msg.code) || "",
          });
        }
      }
    }

    function later(fn, ms) {
      var timer = setTimeout(fn, ms);
      retryTimers.push(timer);
      return timer;
    }

    function clearRetries() {
      for (var i = 0; i < retryTimers.length; i++) clearTimeout(retryTimers[i]);
      retryTimers = [];
    }

    function noteLive() {
      var first = !announced;
      announced = true;
      if (first) {
        emitStatus("live");
        readyWaiters();
      }
      if (info) {
        transmit();
        if (!announceTimer) announceTimer = setInterval(transmit, announceMs);
      }
    }

    function noteDrop() {
      var any = false;
      for (var i = 0; i < sockets.length; i++) if (sockets[i]) any = true;
      if (!any && announced && !stopped) {
        announced = false;
        clearInterval(announceTimer);
        announceTimer = null;
        emitStatus("reconnecting");
      }
    }

    function connectOne(idx, seenEpoch) {
      if (stopped || seenEpoch !== epoch) return;
      connect(brokers[idx], {
        clientId: "n" + randomId(10),
        onMessage: function (topicName, payload) {
          if (seenEpoch !== epoch || stopped) return;
          handle(topicName, payload);
        },
        onClose: function () {
          if (seenEpoch !== epoch || stopped) return;
          sockets[idx] = null;
          noteDrop();
          later(function () { connectOne(idx, seenEpoch); }, 500);
        },
      }).then(function (conn) {
        if (seenEpoch !== epoch || stopped) {
          try { conn.close(); } catch (e) { /* replaced */ }
          return;
        }
        return conn.subscribe(topic()).then(function () {
          if (seenEpoch !== epoch || stopped) {
            try { conn.close(); } catch (e) { /* left while subscribing */ }
            return;
          }
          sockets[idx] = conn;
          noteLive();
        }, function () {
          try { conn.close(); } catch (e) { /* already closing */ }
          if (seenEpoch === epoch && !stopped) later(function () { connectOne(idx, seenEpoch); }, 500);
        });
      }).catch(function () {
        if (seenEpoch !== epoch || stopped) return;
        later(function () { connectOne(idx, seenEpoch); }, 700);
      });
    }

    function connectAll() {
      sockets = new Array(brokers.length);
      for (var i = 0; i < brokers.length; i++) connectOne(i, epoch);
    }

    function shutdown() {
      var busy = false;
      for (var i = 0; i < sockets.length; i++) if (sockets[i]) busy = true;
      if (stopped && !busy && liveWaiters.length === 0 && retryTimers.length === 0 && !announceTimer) return;
      if (info && announced && !stopped) {
        var code = info.code;
        info = null;
        clearInterval(announceTimer);
        announceTimer = null;
        transmitStop(code);
      }
      stopped = true;
      epoch++;
      announced = false;
      clearRetries();
      clearInterval(announceTimer);
      announceTimer = null;
      var open = sockets;
      sockets = [];
      for (var j = 0; j < open.length; j++) {
        if (!open[j]) continue;
        try { open[j].close(); } catch (e) { /* already closed */ }
      }
      failWaiters(new Error("closed"));
    }

    return {
      get key() { return key; },
      open: function () {
        if (!key) return Promise.reject(new Error("bad key"));
        if (!stopped && announced) return Promise.resolve(key);
        shutdown();
        stopped = false;
        announced = false;
        epoch++;
        emitStatus("connecting");
        var promise = new Promise(function (resolve, reject) {
          liveWaiters.push({ resolve: resolve, reject: reject });
        });
        connectAll();
        return promise;
      },
      announce: function (next) {
        if (!next) {
          var had = info;
          info = null;
          clearInterval(announceTimer);
          announceTimer = null;
          if (had && announced && !stopped) transmitStop(had.code);
          return;
        }
        var code = normalizeCode(next.code);
        if (!code) return;
        info = {
          code: code,
          title: String(next.title || ""),
          artist: String(next.artist || ""),
        };
        if (announced && !stopped) {
          transmit();
          if (!announceTimer) announceTimer = setInterval(transmit, announceMs);
        }
      },
      close: function () {
        shutdown();
      },
    };
  }

  return {
    ALPHABET: ALPHABET,
    BROKERS: BROKERS,
    newCode: newCode,
    normalizeCode: normalizeCode,
    jamTopics: jamTopics,
    publicSong: publicSong,
    publicCatalog: publicCatalog,
    songRev: songRev,
    splitChunks: splitChunks,
    matchLibrary: matchLibrary,
    progressOf: progressOf,
    cursorFromSample: cursorFromSample,
    targetProgress: targetProgress,
    nearKeyFrom: nearKeyFrom,
    usableNearKey: usableNearKey,
    isPrivateIp: isPrivateIp,
    networkKey: networkKey,
    encodeConnect: encodeConnect,
    encodePublish: encodePublish,
    encodeSubscribe: encodeSubscribe,
    encodePingreq: encodePingreq,
    encodeDisconnect: encodeDisconnect,
    createParser: createParser,
    createSession: createSession,
    createNearby: createNearby,
  };
});
