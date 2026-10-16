/*
 * Jam sync — run with `node test_jam.js`.
 *
 * Checks the MQTT packet codec, the scroll-progress cursor, a fake in-process
 * broker, and (unless JAM_SKIP_LIVE=1) a real round trip through a public
 * broker so a follower actually receives the host's chart.
 */
const Jam = require("./jam.js");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  }
}
function assertClose(a, b, msg) {
  if (!(Math.abs(a - b) < 1e-9)) {
    failed++;
    console.error("FAIL:", msg, "got", a, "expected", b);
  }
}

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

// ── Codec ──
{
  const connect = Jam.encodeConnect("x", 30);
  assert(hex(connect) === "10 0d 00 04 4d 51 54 54 04 02 00 1e 00 01 78", "connect packet " + hex(connect));

  const pub = Jam.encodePublish("t", new TextEncoder().encode("hi"), false);
  assert(hex(pub) === "30 05 00 01 74 68 69", "publish packet " + hex(pub));
  const retained = Jam.encodePublish("t", new TextEncoder().encode("hi"), true);
  assert(retained[0] === 0x31, "retain flag");

  const parser = Jam.createParser();
  assert(parser.push(pub.slice(0, 2)).length === 0, "partial packet waits");
  const one = parser.push(pub.slice(2));
  assert(one.length === 1 && one[0].type === "publish" && one[0].topic === "t", "rest of packet decodes");
  assert(new TextDecoder().decode(one[0].payload) === "hi", "publish payload");

  const sub = Jam.encodeSubscribe("gsjam/v1/K7MQP/s", 1);
  const both = Jam.createParser().push(concat(sub, Jam.encodePingreq(), retained));
  assert(both.length === 3, "three packets in one buffer, got " + both.length);
  assert(both[0].type === "other" || both[0].packetType === 8, "subscribe is not a server packet we parse");
  // Subscribe is a client packet; the parser still frames it.
  assert(both[1].type === "pingresp" || both[1].packetType === 12 || both[1].type === "other", "ping framed");
  const pingOnly = Jam.createParser().push(Jam.encodePingreq());
  assert(pingOnly.length === 1, "pingreq frames as one packet");

  const suback = new Uint8Array([0x90, 0x03, 0x00, 0x07, 0x00]);
  const ack = Jam.createParser().push(suback);
  assert(ack.length === 1 && ack[0].type === "suback" && ack[0].packetId === 7, "suback id");

  const connack = new Uint8Array([0x20, 0x02, 0x00, 0x00]);
  const ca = Jam.createParser().push(connack);
  assert(ca[0].type === "connack" && ca[0].returnCode === 0, "connack");
}

function concat(a, b, c) {
  const parts = [a, b].concat(c ? [c] : []);
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── Codes and chart identity ──
{
  for (let i = 0; i < 30; i++) {
    const code = Jam.newCode();
    assert(Jam.normalizeCode(code) === code, "generated code round trips " + code);
  }
  assert(Jam.normalizeCode("k7mqp") === "K7MQP", "lowercase code");
  assert(Jam.normalizeCode("K7M QP") === "K7MQP", "spaced code");
  assert(Jam.normalizeCode("https://example.com/guitar-scroll/?jam=K7MQP") === "K7MQP", "url code");
  assert(Jam.normalizeCode("https://example.com/?jam=k7mqp&x=1") === "K7MQP", "url code with extra query");
  assert(Jam.normalizeCode("OOOOO") === "", "ambiguous letters rejected");
  assert(Jam.normalizeCode("K7MQ") === "", "short code rejected");
  assert(Jam.normalizeCode("") === "", "empty code rejected");

  const song = { id: "1", title: "Hello", artist: "A", capo: "2nd fret", strum: "D DU", speed: 5, body: "C\nHi", practiceLog: [1, 2, 3] };
  const pub = Jam.publicSong(song);
  assert(!("practiceLog" in pub), "practice history stays on the phone");
  assert(pub.title === "Hello" && pub.speed === 5, "public song fields");
  assert(Jam.songRev(song) === Jam.songRev(pub), "rev ignores private fields");
  assert(Jam.songRev(song) !== Jam.songRev(Object.assign({}, song, { body: "C\nHo" })), "rev changes with the chart");

  const pieces = Jam.splitChunks("a".repeat(5999) + "🎸" + "b".repeat(80), 6000);
  assert(pieces.length === 2, "long chart splits, got " + pieces.length);
  assert(pieces.join("") === "a".repeat(5999) + "🎸" + "b".repeat(80), "split keeps the emoji intact");

  const lib = [
    { id: "a", title: "On Va S'aimer Encore", artist: "Vincent Vallières", body: "Am" },
    { id: "b", title: "Other", artist: "X", body: "G" },
  ];
  assert(Jam.matchLibrary(lib, { title: "On Va S'aimer Encore", artist: "Vincent Vallieres" }).id === "a", "title match ignores accents");
  assert(Jam.matchLibrary(lib, { id: "b", title: "Nope", artist: "" }).id === "b", "id match wins");
  assert(Jam.matchLibrary(lib, { title: "Missing", artist: "X" }) == null, "unknown song is not in the library");

  assert(Jam.progressOf(0, 500, 100) === 0, "progress at top");
  assertClose(Jam.progressOf(200, 500, 100), 0.5, "progress halfway");
  assert(Jam.progressOf(999, 500, 100) === 1, "progress clamps");
  assert(Jam.progressOf(10, 80, 100) === 0, "no scroll range");
}

// ── Follower cursor ──
{
  const a = Jam.cursorFromSample(null, { rev: "r", playing: true, progress: 0.1, speed: 8, ts: 1000 }, 5000);
  assert(a.seek === true && a.velocity === 0, "first sample snaps");
  assertClose(Jam.targetProgress(a, 5000), 0.1, "first sample holds at arrival");

  const b = Jam.cursorFromSample(a, { rev: "r", playing: true, progress: 0.12, speed: 8, ts: 1500 }, 5400);
  assertClose(b.velocity, 0.02 / 500, "velocity from host timestamps");
  assert(b.seek === false, "steady scroll is not a seek");
  assertClose(Jam.targetProgress(b, 5400), 0.12, "no coast at the instant a packet arrives");
  assertClose(Jam.targetProgress(b, 5650), 0.12 + b.velocity * 250, "coasts between packets");
  const coastCap = Jam.targetProgress(b, 5400 + 10000);
  assertClose(coastCap, 0.12 + b.velocity * 1200, "coast stops after 1.2s without a packet");

  const scrub = Jam.cursorFromSample(b, { rev: "r", playing: true, seek: true, progress: 0.7, speed: 8, ts: 1800 }, 5700);
  assert(scrub.seek === true && scrub.velocity === 0, "a host scrub snaps followers");

  const paused = Jam.cursorFromSample(b, { rev: "r", playing: false, progress: 0.2, speed: 4, ts: 2000 }, 6000);
  assert(paused.playing === false && paused.velocity === 0, "pause clears velocity");
  assertClose(Jam.targetProgress(paused, 9000), 0.2, "paused position does not drift");

  // High multiplier on a short chart: large but steady progress steps stay smooth.
  let cursor = Jam.cursorFromSample(null, { rev: "r", playing: true, progress: 0, speed: 50, ts: 0 }, 0);
  cursor = Jam.cursorFromSample(cursor, { rev: "r", playing: true, progress: 0.16, speed: 50, ts: 250 }, 250);
  assert(cursor.seek === false && cursor.velocity > 0, "fast steady scroll keeps its velocity");
}

// ── Two sessions, one in-process broker ──
function mqttMatch(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function fakeBroker() {
  const retained = new Map();
  const clients = [];
  function deliver(topic, payload) {
    for (const client of clients) {
      for (const filter of client.subs) {
        if (mqttMatch(filter, topic) && client.opts.onMessage) {
          client.opts.onMessage(topic, payload);
          break;
        }
      }
    }
  }
  function connect(_url, opts) {
    const client = {
      opts,
      subs: new Set(),
      publish(topic, payload, retain) {
        const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
        if (retain) retained.set(topic, bytes);
        deliver(topic, bytes);
        return true;
      },
      subscribe(topic) {
        this.subs.add(topic);
        for (const [retainedTopic, payload] of retained) {
          if (mqttMatch(topic, retainedTopic) && this.opts.onMessage) {
            this.opts.onMessage(retainedTopic, payload);
          }
        }
        return Promise.resolve();
      },
      close() {
        client.subs.clear();
        if (opts.onClose) opts.onClose();
      },
    };
    clients.push(client);
    return Promise.resolve(client);
  }
  return { connect };
}

async function sessionTest() {
  const broker = fakeBroker();
  const seen = [];
  let peers = -1;
  let ended = false;
  const code = "K7MQP";
  const host = Jam.createSession({
    connect: broker.connect,
    brokers: ["ws://fake"],
    onPeers: (n) => { peers = n; },
    peerTtl: 8000,
  });
  const follow = Jam.createSession({
    connect: broker.connect,
    brokers: ["ws://fake"],
    hereMs: 20,
    onSong: (msg) => seen.push(msg),
    onPlay: (msg) => seen.push(msg),
    onEnd: () => { ended = true; },
  });
  await host.host(code);
  await follow.follow(code);
  host.publishSong({
    id: "song-1",
    title: "Maybe I'm Wrong",
    artist: "Kid Laroi",
    capo: "No capo",
    strum: "D",
    speed: 10,
    body: "[Verse]\nC\nHeart on my sleeve",
    practiceSeconds: { 1: 50 },
  });
  host.publishPlay({ playing: true, speed: 10, progress: 0.25, ts: 1000 });
  await delay(80);
  assert(seen.some((m) => m.kind === "song" && m.song.title === "Maybe I'm Wrong"), "follower receives the chart");
  assert(seen.some((m) => m.kind === "song" && !m.song.practiceSeconds), "chart payload has no practice log");
  assert(seen.some((m) => m.kind === "play" && m.playing === true && m.progress === 0.25), "follower receives playhead");
  assert(peers >= 1, "host sees the follower, count=" + peers);

  const before = seen.length;
  const rogue = await broker.connect("ws://fake", { onMessage() {} });
  const topics = Jam.jamTopics(code);
  rogue.publish(topics.song, new TextEncoder().encode(JSON.stringify({
    v: 1, kind: "song", hostId: "INTRUDER", seq: 99999, rev: "nope",
    song: { id: "x", title: "Hijack", artist: "", capo: "", strum: "", speed: null, body: "no" },
  })), true);
  assert(seen.length === before, "a different host id cannot replace the chart");

  host.end();
  await delay(20);
  assert(ended, "ending the jam tells the follower");
  assert(host.role === "idle", "host session stops");
}

async function chartWithoutLibrary() {
  const broker = fakeBroker();
  const seen = [];
  const code = "K7MQP";
  const body = "a".repeat(5999) + "🎸" + "b".repeat(4000) + "\nonly on the host phone";
  const host = Jam.createSession({ connect: broker.connect, brokers: ["ws://fake"] });
  const follow = Jam.createSession({
    connect: broker.connect,
    brokers: ["ws://fake"],
    onSong: (msg) => seen.push(msg),
    onPlay: (msg) => seen.push(msg),
  });
  await host.host(code);
  await follow.follow(code);
  host.publishSong({
    id: "host-only",
    title: "Not In Your Library",
    artist: "Host",
    capo: "2nd fret",
    strum: "D DU",
    speed: 6,
    body: body,
  });
  host.publishPlay({ playing: true, speed: 6, progress: 0.42, ts: 5000 });
  await delay(40);
  const song = seen.find((m) => m.kind === "song");
  assert(song && song.song.body === body, "follower receives a long chart they don't have saved");
  assert(song && song.song.title === "Not In Your Library" && song.song.capo === "2nd fret", "chart title and capo come with it");
  const play = seen.find((m) => m.kind === "play");
  assert(play && play.title === "Not In Your Library" && play.id === "host-only", "play updates name the song");
  host.close();
  follow.close();
}

// A play packet is small and often arrives before the chart. It must not
// make the chart unreadable.
async function playBeforeChart() {
  const broker = fakeBroker();
  const seen = [];
  const code = "K7MQP";
  const follow = Jam.createSession({
    connect: broker.connect,
    brokers: ["ws://fake"],
    onSong: (msg) => seen.push(msg),
    onPlay: (msg) => seen.push(msg),
  });
  await follow.follow(code);
  const topics = Jam.jamTopics(code);
  const raw = await broker.connect("ws://fake", { onMessage() {} });
  raw.publish(topics.play, JSON.stringify({
    v: 1, kind: "play", hostId: "H", seq: 50, rev: "r1",
    playing: true, progress: 0.2, speed: 4, ts: 1,
    id: "x", title: "Remote Only", artist: "Z",
  }), false);
  raw.publish(topics.song, JSON.stringify({
    v: 1, kind: "song", hostId: "H", seq: 1, parts: 0, rev: "r1",
    song: { id: "x", title: "Remote Only", artist: "Z", capo: "", strum: "", speed: 4, body: "C\nonly on the host" },
  }), false);
  await delay(30);
  assert(seen.some((m) => m.kind === "song" && m.song.body === "C\nonly on the host"), "a play packet cannot drop the chart");
  assert(seen.some((m) => m.kind === "play" && m.progress === 0.2), "the early play packet is kept");
  follow.close();
}

async function resendMissedChart() {
  const broker = fakeBroker();
  const seen = [];
  const code = "K7MQP";
  let drop = 1;
  const host = Jam.createSession({ connect: broker.connect, brokers: ["ws://fake"], resendMs: 20 });
  const follow = Jam.createSession({
    brokers: ["ws://fake"],
    connect: (url, opts) => broker.connect(url, Object.assign({}, opts, {
      onMessage(topic, payload) {
        if (drop && topic.endsWith("/s")) {
          drop--;
          return;
        }
        opts.onMessage(topic, payload);
      },
    })),
    hereMs: 20,
    onSong: (msg) => seen.push(msg),
  });
  await host.host(code);
  await follow.follow(code);
  host.publishSong({ id: "m", title: "Missed Once", artist: "Host", capo: "", strum: "", speed: null, body: "D\ntry again" });
  await waitFor(() => seen.some((m) => m.kind === "song" && m.song.title === "Missed Once" && m.song.body === "D\ntry again"), 1000);
  assert(drop === 0, "the first chart copy was the one that got lost");
  host.close();
  follow.close();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(pred, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(tick, 30);
    })();
  });
}

async function liveTest() {
  if (process.env.JAM_SKIP_LIVE === "1") {
    console.log("skip live broker");
    return;
  }
  const code = Jam.newCode();
  const got = [];
  let ended = false;
  let followStatus = "";
  let hostStatus = "";
  const host = Jam.createSession({
    onStatus: (s) => { hostStatus = s; },
  });
  const follow = Jam.createSession({
    onStatus: (s) => { followStatus = s; },
    onSong: (msg) => got.push(msg),
    onPlay: (msg) => got.push(msg),
    onEnd: () => { ended = true; },
  });
  try {
    await Promise.race([
      (async () => {
        const liveBody = "G\nhello from the jam\n" + ("C\nonly the host has this line " + "x".repeat(40) + "\n").repeat(200);
        await follow.follow(code);
        await host.host(code);
        host.publishSong({ id: "live", title: "Live Song", artist: "Tester", capo: "", strum: "", speed: 4, body: liveBody });
        host.publishPlay({ playing: true, speed: 4, progress: 0.4, ts: Date.now() });
        await waitFor(() => got.some((m) => m.kind === "song" && m.song.title === "Live Song" && m.song.body === liveBody), 12000);
        await waitFor(() => got.some((m) => m.kind === "play" && m.playing && m.progress === 0.4), 8000);
        host.end();
        await waitFor(() => ended, 8000);
      })(),
      delay(35000).then(() => { throw new Error("live jam timed out, host=" + hostStatus + " follow=" + followStatus); }),
    ]);
  } finally {
    try { host.close(); } catch (e) { /* already ended */ }
    try { follow.close(); } catch (e) { /* already ended */ }
  }
}

(async () => {
  try {
    await sessionTest();
    await chartWithoutLibrary();
    await playBeforeChart();
    await resendMissedChart();
    await liveTest();
  } catch (err) {
    failed++;
    console.error("FAIL:", err && err.stack || err);
  }
  if (failed) {
    console.error(failed + " failed");
    process.exit(1);
  }
  console.log("jam ok");
})();
