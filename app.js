(function () {
  "use strict";

  const STORAGE_KEY = "guitarscroll_songs";

  // ── DOM refs ──
  const $ = (s) => document.querySelector(s);
  const libraryView = $("#library-view");
  const editView = $("#edit-view");
  const playerView = $("#player-view");
  const songListEl = $("#song-list");
  const emptyState = $("#empty-state");
  const addSongBtn = $("#add-song-btn");
  const calendarBtn = $("#calendar-btn");
  const editBackBtn = $("#edit-back-btn");
  const saveSongBtn = $("#save-song-btn");
  const editTitle = $("#edit-title");
  const titleInput = $("#song-title-input");
  const artistInput = $("#song-artist-input");
  const capoInput = $("#song-capo-input");
  const tuningInput = $("#song-tuning-input");
  const strumInput = $("#song-strum-input");
  const bodyInput = $("#song-body-input");
  const ugUrlInput = $("#ug-url-input");
  const ugImportBtn = $("#ug-import-btn");
  const ugImportStatus = $("#ug-import-status");
  const ugImportProgress = $("#ug-import-progress");
  const playerBackBtn = $("#player-back-btn");
  const playerSongTitle = $("#player-song-title");
  const playerSongArtist = $("#player-song-artist");
  const editCurrentBtn = $("#edit-current-btn");
  const songMeta = $("#song-meta");
  const songContent = $("#song-content");
  const scrollToggle = $("#scroll-toggle");
  const scrollSlower = $("#scroll-slower");
  const scrollFaster = $("#scroll-faster");
  const speedLabel = $("#speed-label");
  const searchInput = $("#search-input");
  const proficiencyFilter = $("#proficiency-filter");
  const sortBtn = $("#sort-btn");
  const sortDropdown = $("#sort-dropdown");
  const proficiencyStarsEl = $("#proficiency-stars");
  const proficiencyLabel = $("#proficiency-label");
  const menuBtn = $("#menu-btn");
  const menuDropdown = $("#menu-dropdown");
  const tunerBtn = $("#tuner-btn");
  const tunerView = $("#tuner-view");
  const tunerBackBtn = $("#tuner-back-btn");
  const tunerToggle = $("#tuner-toggle");
  const tunerNote = $("#tuner-note");
  const tunerCents = $("#tuner-cents");
  const tunerFreq = $("#tuner-freq");
  const tunerDial = $("#tuner-dial");
  const tunerNeedle = $("#tuner-needle");
  const dialTicks = $("#dial-ticks");
  const tunerStatus = $("#tuner-status");
  const tunerMsg = $("#tuner-msg");
  const tunerHint = $("#tuner-hint");
  const tunerStringsEl = $(".tuner-strings");
  const tunerTuningSelect = $("#tuner-tuning");
  const tunerLevelFill = $("#tuner-level-fill");
  const exportBtn = $("#export-btn");
  const importBtn = $("#import-btn");
  const importFile = $("#import-file");
  // Global practice calendar view
  const statsView = $("#stats-view");
  const statsBackBtn = $("#stats-back-btn");
  const statsTotalEl = $("#stats-total");
  const statsStreakEl = $("#stats-streak");
  const statsTodayEl = $("#stats-today");
  const statsCalendarEl = $("#stats-calendar");

  let songs = [];
  let editingId = null;
  let currentSongId = null;
  let scrolling = false;
  let speed = 10;
  let scrollRAF = null;
  let playedTimer = null;
  // A song counts as "played" only after the auto-scroller runs uninterrupted for this long
  const PLAYED_THRESHOLD_MS = 5000;
  // Songs not played within this window are flagged as "rusty" (may need practice)
  const RUSTY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
  let editingProficiency = 0;
  let activeFilterLevel = "all";
  let activeSort = "default";
  let searchQuery = "";

  // ── Persistence ──
  function loadSongs() {
    try {
      songs = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      songs = [];
    }
  }
  function saveSongs() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(songs));
  }

  // Backfill practice fields for songs created before this feature existed, so the
  // counter/calendar have consistent data to read from
  function migratePracticeData() {
    let changed = false;
    for (const s of songs) {
      // Give every song a practice log array
      if (!Array.isArray(s.practiceLog)) {
        // Seed the log with the one known play so history isn't lost
        s.practiceLog = s.lastPlayed ? [s.lastPlayed] : [];
        changed = true;
      }
      // Derive the count from the log if it's missing
      if (typeof s.practiceCount !== "number") {
        s.practiceCount = s.practiceLog.length;
        changed = true;
      }
    }
    if (changed) saveSongs();
  }

  function mergeSongsFromRepo() {
    return fetch("songs.json?t=" + Date.now())
      .then((r) => r.ok ? r.json() : [])
      .then((repoSongs) => {
        let added = 0;
        for (const rs of repoSongs) {
          if (!songs.find((s) => s.id === rs.id)) {
            songs.push(rs);
            added++;
          }
        }
        if (added) saveSongs();
        return added;
      })
      .catch(() => 0);
  }

  // ── Views ──
  function showView(view) {
    [libraryView, editView, playerView, statsView, tunerView].forEach((v) => v.classList.remove("active"));
    view.classList.add("active");
    stopScroll();
    // Leaving the tuner view should always release the mic
    if (view !== tunerView) stopTuner();
  }

  // ── Library ──
  function getFilteredSongs() {
    const filtered = songs.filter((song) => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = (song.title || "").toLowerCase().includes(q);
        const matchesArtist = (song.artist || "").toLowerCase().includes(q);
        if (!matchesTitle && !matchesArtist) return false;
      }
      if (activeFilterLevel !== "all") {
        const level = parseInt(activeFilterLevel, 10);
        const songLevel = song.proficiency || 0;
        if (songLevel !== level) return false;
      }
      return true;
    });

    // Never-played songs sort as "infinitely stale" (0) so they surface first when
    // finding what to practice, and last when sorting by most recent
    const lastTs = (s) => s.lastPlayed || 0;

    // Least recently played first — the "what should I brush up on?" view
    if (activeSort === "rusty") {
      filtered.sort((a, b) => lastTs(a) - lastTs(b));
    // Most recently played first
    } else if (activeSort === "recent") {
      filtered.sort((a, b) => lastTs(b) - lastTs(a));
    // Most practiced sessions first
    } else if (activeSort === "most") {
      filtered.sort((a, b) => (b.practiceCount || 0) - (a.practiceCount || 0));
    }
    // "default" — leave in original library order

    return filtered;
  }

  function proficiencyStars(level) {
    if (!level) return '<span class="prof-badge unrated">Not rated</span>';
    const labels = ["", "Learning", "Rough", "Decent", "Good", "Nailed it"];
    let stars = "";
    for (let i = 1; i <= 5; i++) {
      stars += i <= level ? '<span class="star filled">★</span>' : '<span class="star">★</span>';
    }
    return `<span class="prof-badge level-${level}">${stars} <span class="prof-text">${labels[level]}</span></span>`;
  }

  function renderLibrary() {
    songListEl.innerHTML = "";
    const filtered = getFilteredSongs();
    const hasAnySongs = songs.length > 0;
    const hasResults = filtered.length > 0;

    emptyState.style.display = hasAnySongs ? "none" : "flex";

    if (hasAnySongs && !hasResults) {
      const noResults = document.createElement("div");
      noResults.className = "no-results";
      noResults.textContent = "No songs match your filters";
      songListEl.appendChild(noResults);
      return;
    }

    filtered.forEach((song) => {
      const el = document.createElement("div");
      el.className = "song-item";
      el.innerHTML = `
        <div class="song-item-info">
          <div class="song-item-title">${esc(song.title || "Untitled")}</div>
          <div class="song-item-artist">${esc(song.artist || "")}</div>
          <div class="song-item-prof">${proficiencyStars(song.proficiency)}</div>
          <div class="song-item-meta-row">
            ${lastPlayedBadge(song.lastPlayed)}
            ${practiceCountBadge(song.practiceCount)}
          </div>
        </div>
        <button class="song-item-delete" data-id="${song.id}" aria-label="Delete">✕</button>`;
      el.querySelector(".song-item-info").addEventListener("click", () => openPlayer(song.id));
      el.querySelector(".song-item-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${song.title}"?`)) {
          songs = songs.filter((s) => s.id !== song.id);
          saveSongs();
          renderLibrary();
        }
      });
      songListEl.appendChild(el);
    });
  }

  // ── Proficiency stars (editor) ──
  function updateEditorStars() {
    const labels = ["Not rated", "Learning", "Rough", "Decent", "Good", "Nailed it"];
    proficiencyStarsEl.querySelectorAll(".star-btn").forEach((btn) => {
      const v = parseInt(btn.dataset.value, 10);
      btn.classList.toggle("active", v <= editingProficiency);
    });
    proficiencyLabel.textContent = labels[editingProficiency];
  }

  proficiencyStarsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".star-btn");
    if (!btn) return;
    const val = parseInt(btn.dataset.value, 10);
    editingProficiency = val === editingProficiency ? 0 : val;
    updateEditorStars();
  });

  // ── Ultimate Guitar import ──
  // The app is static (GitHub Pages), so the browser can't fetch UG directly
  // (CORS). We try free public proxies / readers, then parse title/artist/
  // capo/tuning/strum/body into the editor fields.
  const UG_URL_RE = /^https?:\/\/(?:tabs\.)?ultimate-guitar\.com\/tab\/.+/i;
  let ugProgressTimer = null;

  function setUgStatus(msg, kind) {
    if (!msg) {
      ugImportStatus.hidden = true;
      ugImportStatus.textContent = "";
      ugImportStatus.classList.remove("is-error", "is-ok", "is-progress");
      return;
    }
    ugImportStatus.hidden = false;
    ugImportStatus.textContent = msg;
    ugImportStatus.classList.toggle("is-error", kind === "error");
    ugImportStatus.classList.toggle("is-ok", kind === "ok");
    ugImportStatus.classList.toggle("is-progress", kind === "progress");
  }

  function setUgLoading(loading) {
    ugImportBtn.disabled = loading;
    ugImportBtn.classList.toggle("is-loading", loading);
    ugImportBtn.setAttribute("aria-busy", loading ? "true" : "false");
    if (ugImportProgress) ugImportProgress.hidden = !loading;
    if (!loading && ugProgressTimer) {
      clearInterval(ugProgressTimer);
      ugProgressTimer = null;
    }
  }

  function startUgProgress() {
    setUgLoading(true);
    const steps = [
      "Fetching tab…",
      "Reading chords & lyrics…",
      "Extracting strumming pattern…",
      "Almost done…",
    ];
    let i = 0;
    setUgStatus(steps[0], "progress");
    ugProgressTimer = setInterval(() => {
      i = Math.min(i + 1, steps.length - 1);
      setUgStatus(steps[i], "progress");
    }, 2800);
  }

  function formatCapo(c) {
    if (c === null || c === undefined || c === "" || c === 0 || c === "0") {
      return "No capo";
    }
    const n = parseInt(c, 10);
    if (Number.isNaN(n)) return String(c);
    const mod = n % 100;
    let suf = "th";
    if (mod < 11 || mod > 13) {
      suf = { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
    }
    return n + suf + " fret";
  }

  // Ultimate Guitar encodes each slot of the strumming grid as
  // arrow * 100 + kind, where arrow is 0 for down, 1 for up and 2 for no
  // arrow at all, and kind is 1 for a plain stroke, 2 for a muted one (an x
  // drawn over the arrow) and 3 for an accented one (a > over the arrow).
  // When there is no arrow the kind picks the glyph instead: 201 is a
  // percussive mute, 202 an unused slot and 203 a rest.
  function decodeStrumCode(code) {
    const n = parseInt(code, 10);
    if (Number.isNaN(n)) return "-";
    const arrow = Math.floor(n / 100);
    const kind = n % 100;
    if (arrow === 2) return kind === 1 ? "X" : "-";
    if (kind === 2) return "X";
    return arrow === 1 ? "U" : "D";
  }

  // A sixteenth-note grid reads far better as "D-DU -U-U" than as sixteen
  // loose characters, so split it back into beats.
  function groupStrokesIntoBeats(strokes, denominator, isTriplet) {
    const den = parseInt(denominator, 10);
    const perBeat = isTriplet ? 3 : Number.isFinite(den) ? den / 4 : 0;
    if (!Number.isInteger(perBeat) || perBeat < 2) return strokes.join(" ");
    const beats = [];
    for (let i = 0; i < strokes.length; i += perBeat) {
      beats.push(strokes.slice(i, i + perBeat).join(""));
    }
    return beats.join(" ");
  }

  function formatStrumming(strummings) {
    if (!Array.isArray(strummings)) return "";
    const bpms = new Set();
    const parts = [];
    for (const pat of strummings) {
      if (!pat) continue;
      const strokes = (pat.measures || []).map((m) =>
        decodeStrumCode(typeof m === "object" && m ? m.measure : m)
      );
      if (!strokes.some((s) => s !== "-")) continue;
      let text = groupStrokesIntoBeats(strokes, pat.denuminator, pat.is_triplet);
      const part = (pat.part || "").trim();
      if (part) text = part + ": " + text;
      if (pat.bpm) bpms.add(pat.bpm);
      parts.push(text);
    }
    if (!parts.length) return "";
    let text = parts.join(" · ");
    if (bpms.size === 1) text += " (" + [...bpms][0] + " bpm)";
    return text;
  }

  function strummingsFromTabView(tv) {
    let list = Array.isArray(tv.strummings) ? tv.strummings.slice() : [];
    if (list.length) return list;
    const raw = tv.encode_strummings;
    if (!raw) return [];
    try {
      const enc = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(enc.patterns) ? enc.patterns : [];
    } catch {
      return [];
    }
  }

  function stripHtmlToText(htmlChunk) {
    let text = String(htmlChunk || "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n");
    text = text.replace(/<[^>]+>/g, "");
    return unescapeHtmlEntities(text).replace(/\u00a0/g, " ");
  }

  function parseUgRenderedHtml(htmlText) {
    // Prefer structured js-store when present (raw HTML proxies)
    if (htmlText.includes("js-store") && /data-content=/.test(htmlText)) {
      try {
        return parseUgJsStore(htmlText);
      } catch {
        // fall through to rendered DOM parse
      }
    }

    let title = "";
    let artist = "";
    const og = htmlText.match(/og:title"\s+content="([^"]+)"/i);
    let song = "";
    if (og) {
      song = unescapeHtmlEntities(og[1])
        .replace(/\s*\((Chords|Tab|Bass|Ukulele)\)\s*$/i, "")
        .trim();
      const dash = song.indexOf(" - ");
      if (dash > 0) {
        artist = song.slice(0, dash).trim();
        title = song.slice(dash + 3).trim();
      } else {
        title = song;
      }
    } else {
      const rawTitle = ((htmlText.match(/<title>([^<]+)<\/title>/i) || [])[1] || "");
      song = unescapeHtmlEntities(rawTitle)
        .replace(/\s*@\s*Ultimate-Guitar\.Com.*$/i, "")
        .trim();
      const by = song.match(/^(.+?)\s+CHORDS?\s+by\s+(.+)$/i);
      if (by) {
        title = by[1].trim();
        artist = by[2].trim();
      } else {
        title = song.replace(/\s*\((Chords|Tab|Bass|Ukulele)\)\s*$/i, "").trim();
      }
    }

    let capo = "";
    const capoMatch =
      htmlText.match(/id="capo"[^>]*>([^<]+)</i) ||
      htmlText.match(/Capo:\s*<\/[^>]+>\s*<[^>]+>(?:<[^>]+>)?([^<]+)/i);
    if (capoMatch) capo = unescapeHtmlEntities(capoMatch[1]).trim();

    let tuning = "";
    const tunMatch =
      htmlText.match(/id="tuning"[^>]*>([^<]+)</i) ||
      htmlText.match(/Tuning:\s*<\/[^>]+>\s*<[^>]+>(?:<[^>]+>)?([^<]+)/i);
    if (tunMatch) tuning = unescapeHtmlEntities(tunMatch[1]).trim();

    let body = "";
    const preMatch = htmlText.match(/<pre class="[^"]*"[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) body = cleanUgBody(stripHtmlToText(preMatch[1]));
    if (!body) throw new Error("Could not extract chords/lyrics from that page.");

    return {
      title: title || "Untitled",
      artist,
      capo,
      tuning,
      strum: "",
      body,
    };
  }

  function cleanUgBody(body) {
    return String(body || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\[\/?tab\]/gi, "")
      .replace(/\[ch\](.*?)\[\/ch\]/gi, "$1")
      .trim();
  }

  function unescapeHtmlEntities(str) {
    const el = document.createElement("textarea");
    el.innerHTML = str;
    return el.value;
  }

  function parseUgJsStore(htmlText) {
    const match =
      htmlText.match(/<div[^>]*class="[^"]*js-store[^"]*"[^>]*data-content="([^"]+)"/i) ||
      htmlText.match(/data-content='([^']+)'/i);
    if (!match) throw new Error("Could not find tab data on that page.");
    const data = JSON.parse(unescapeHtmlEntities(match[1]));
    const page = data && data.store && data.store.page && data.store.page.data;
    if (!page || !page.tab) throw new Error("Unexpected Ultimate Guitar page format.");
    const tab = page.tab;
    const tv = page.tab_view || {};
    const meta = tv.meta || {};
    const content = (tv.wiki_tab && tv.wiki_tab.content) || "";
    if (!String(content).trim()) {
      throw new Error("No free chord sheet on that link (official/pro tabs aren't supported).");
    }
    const tuning = meta.tuning || {};
    return {
      title: tab.song_name || "",
      artist: tab.artist_name || "",
      capo: formatCapo(meta.capo),
      tuning: tuning.value || tuning.name || "",
      strum: formatStrumming(strummingsFromTabView(tv)),
      body: cleanUgBody(content),
    };
  }

  function parseUgMarkdown(title, content) {
    let artist = "";
    let song = title || "";
    song = song.replace(/\s*\((Chords|Tab|Bass|Ukulele)\)\s*$/i, "").trim();
    const dash = song.indexOf(" - ");
    if (dash > 0) {
      artist = song.slice(0, dash).trim();
      song = song.slice(dash + 3).trim();
    }
    let capo = "";
    let tuning = "";
    const capoMatch = content.match(/\|\s*Capo:\s*\|\s*([^|\n]+)/i);
    if (capoMatch) capo = capoMatch[1].trim();
    const tunMatch = content.match(/\|\s*Tuning:\s*\|\s*(?:\[([^\]]+)\]|([^|\n]+))/i);
    if (tunMatch) tuning = (tunMatch[1] || tunMatch[2] || "").trim();

    let body = "";
    const fence = content.match(/```[^\n]*\n([\s\S]*?)```/);
    if (fence) {
      body = fence[1].trim();
    } else {
      const markers = ["[Intro]", "[Verse", "[Chorus]", "[Bridge]", "whole song"];
      let idx = -1;
      for (const marker of markers) {
        if (marker === "[Verse") {
          const m = content.match(/\[Verse[^\]]*\]/);
          if (m) idx = m.index;
        } else {
          idx = content.indexOf(marker);
        }
        if (idx >= 0) break;
      }
      if (idx >= 0) {
        body = content.slice(idx).trim();
        for (const stop of ["\nLast update:", "\nRating", "\nPlay next", "\nRelated tabs", "\n© "]) {
          const s = body.indexOf(stop);
          if (s >= 0) body = body.slice(0, s).trim();
        }
      }
    }
    if (!body) throw new Error("Could not extract chords/lyrics from that page.");
    return {
      title: song,
      artist,
      capo,
      tuning,
      strum: "",
      body: cleanUgBody(body),
    };
  }

  async function fetchText(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 25000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: (opts && opts.headers) || {},
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // These proxies hand back Ultimate Guitar's own server response, which still
  // carries the js-store JSON: chord sheet, capo, tuning and the numeric
  // strumming codes. Reader services return the page after React has hydrated
  // it, and by then that JSON is gone, so they can only recover the chords.
  // Each proxy is individually flaky, so they all run at once.
  const UG_HTML_PROXIES = [
    (url) => "https://proxy.corsfix.com/?" + url,
    (url) => "https://cors.eu.org/" + url,
    (url) => "https://api.cors.lol/?url=" + encodeURIComponent(url),
    (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  ];

  async function fetchSongFromHtmlProxy(url, buildProxyUrl) {
    const htmlText = await fetchText(buildProxyUrl(url), { timeout: 25000 });
    return parseUgJsStore(htmlText);
  }

  async function fetchSongFromJinaHtml(url) {
    const raw = await fetchText("https://r.jina.ai/" + url, {
      timeout: 40000,
      headers: {
        Accept: "text/html",
        "X-Return-Format": "html",
      },
    });
    return parseUgRenderedHtml(raw);
  }

  async function fetchSongFromJinaMarkdown(url) {
    const raw = await fetchText("https://r.jina.ai/" + url, {
      timeout: 35000,
      headers: { Accept: "application/json" },
    });
    const payload = JSON.parse(raw);
    const data = payload.data || payload;
    if (!data.content) throw new Error("Empty reader response");
    return parseUgMarkdown(data.title || "", data.content);
  }

  // Resolves with the first attempt to come back with a usable song, or null
  // once every one of them has failed.
  async function firstUsableSong(attempts, errors) {
    const settled = attempts.map((promise, i) =>
      promise.then(
        (song) => ({ i, song }),
        (err) => ({ i, err })
      )
    );
    const pending = new Set(settled);
    while (pending.size) {
      const result = await Promise.race(pending);
      pending.delete(settled[result.i]);
      if (result.song && result.song.body) return result.song;
      if (result.err && result.err.message) errors.push(result.err.message);
    }
    return null;
  }

  async function importFromUltimateGuitar(rawUrl) {
    const url = String(rawUrl || "").trim();
    if (!UG_URL_RE.test(url)) {
      throw new Error("Paste a full Ultimate Guitar tab link (tabs.ultimate-guitar.com/tab/…).");
    }

    const errors = [];
    const fromHtml = await firstUsableSong(
      UG_HTML_PROXIES.map((build) => fetchSongFromHtmlProxy(url, build)),
      errors
    );
    if (fromHtml) return fromHtml;

    // Nothing got through with the strumming attached; settle for the chords.
    setUgStatus("Trying another source…", "progress");
    const fromReader = await firstUsableSong(
      [fetchSongFromJinaHtml(url), fetchSongFromJinaMarkdown(url)],
      errors
    );
    if (fromReader) return fromReader;

    throw new Error(
      "Couldn't fetch that tab (network/proxy). Try again, or paste the chords manually." +
        (errors.length ? " (" + errors[0] + ")" : "")
    );
  }

  function applyImportedSong(song) {
    if (song.title) titleInput.value = song.title;
    if (song.artist) artistInput.value = song.artist;
    if (song.capo) capoInput.value = song.capo;
    if (song.tuning) tuningInput.value = song.tuning;
    if (song.strum) strumInput.value = song.strum;
    if (song.body) bodyInput.value = song.body;
  }

  async function handleUgImport() {
    const url = ugUrlInput.value.trim();
    if (!url) {
      setUgStatus("Paste an Ultimate Guitar link first.", "error");
      ugUrlInput.focus();
      return;
    }
    startUgProgress();
    try {
      const song = await importFromUltimateGuitar(url);
      applyImportedSong(song);
      if (song.strum) {
        setUgStatus("Imported — check the fields, then tap ✓ to save.", "ok");
      } else {
        setUgStatus("Imported — add a strumming pattern if you know it, then tap ✓.", "ok");
      }
      if (window.Analytics) {
        window.Analytics.track("ug-import", {
          title: song.title || "",
          artist: song.artist || "",
          has_strum: Boolean(song.strum),
        });
      }
    } catch (err) {
      setUgStatus(err.message || "Import failed.", "error");
    } finally {
      setUgLoading(false);
    }
  }

  // ── Edit ──
  function openEditor(id) {
    editingId = id;
    const song = id ? songs.find((s) => s.id === id) : null;
    editTitle.textContent = song ? "Edit Song" : "Add Song";
    titleInput.value = song ? song.title : "";
    artistInput.value = song ? song.artist : "";
    capoInput.value = song ? song.capo : "";
    tuningInput.value = song ? song.tuning : "";
    strumInput.value = song ? song.strum : "";
    bodyInput.value = song ? song.body : "";
    editingProficiency = song ? (song.proficiency || 0) : 0;
    updateEditorStars();
    ugUrlInput.value = "";
    setUgLoading(false);
    setUgStatus("", null);
    showView(editView);
    if (song) titleInput.focus();
    else ugUrlInput.focus();
  }

  function saveSong() {
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!title && !body) { showView(libraryView); renderLibrary(); return; }
    if (editingId) {
      const song = songs.find((s) => s.id === editingId);
      if (song) {
        Object.assign(song, {
          title: title || "Untitled",
          artist: artistInput.value.trim(),
          capo: capoInput.value.trim(),
          tuning: tuningInput.value.trim(),
          strum: strumInput.value.trim(),
          proficiency: editingProficiency,
          body,
        });
      }
    } else {
      songs.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: title || "Untitled",
        artist: artistInput.value.trim(),
        capo: capoInput.value.trim(),
        tuning: tuningInput.value.trim(),
        strum: strumInput.value.trim(),
        proficiency: editingProficiency,
        body,
      });
      // Track new-song creation — a strong sign someone has adopted the app
      if (window.Analytics) {
        window.Analytics.track("song-add", { library_size: songs.length });
      }
    }
    saveSongs();
    renderLibrary();
    if (editingId && currentSongId === editingId) {
      openPlayer(editingId);
    } else {
      showView(libraryView);
    }
  }

  // ── Parser ──
  const CHORD_RE = /^[A-G][#b]?(m|maj|min|dim|aug|sus|add|M)?[0-9]?[0-9]?(\/(A-G)[#b]?)?(\*)?$/;
  const SECTION_RE = /^\[(.+)\]$/;

  function isChordToken(token) {
    return CHORD_RE.test(token.replace(/[()]/g, ""));
  }

  function isChordLine(line) {
    if (!line.trim()) return false;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length === 0) return false;
    const chordTokens = tokens.filter((t) => isChordToken(t) || /^x\d+$/i.test(t) || t === "|" || t === "*");
    return chordTokens.length / tokens.length >= 0.5;
  }

  function parseBody(raw) {
    const lines = raw.split("\n");
    const result = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trimEnd();

      if (!trimmed) {
        result.push({ type: "empty" });
        i++;
        continue;
      }

      const sectionMatch = trimmed.match(SECTION_RE);
      if (sectionMatch) {
        result.push({ type: "section", text: sectionMatch[1] });
        i++;
        continue;
      }

      if (isChordLine(trimmed)) {
        const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
        const nextTrimmed = nextLine.trimEnd();
        const nextIsSection = SECTION_RE.test(nextTrimmed);
        const nextIsChord = isChordLine(nextTrimmed);
        const nextIsEmpty = !nextTrimmed;

        if (!nextIsSection && !nextIsChord && !nextIsEmpty && nextTrimmed) {
          result.push({ type: "chord-lyric", chords: trimmed, lyrics: nextTrimmed });
          i += 2;
        } else {
          result.push({ type: "chord-only", text: trimmed });
          i++;
        }
        continue;
      }

      if (/\[([A-G][#b]?[^\]]*)\]/.test(trimmed) && !SECTION_RE.test(trimmed)) {
        result.push({ type: "inline-chord", text: trimmed });
        i++;
        continue;
      }

      result.push({ type: "lyric", text: trimmed });
      i++;
    }

    return result;
  }

  function renderParsed(parsed) {
    let html = "";
    for (const item of parsed) {
      switch (item.type) {
        case "empty":
          html += `<span class="line-empty"></span>\n`;
          break;
        case "section":
          html += `<span class="line-section">${esc(item.text)}</span>\n`;
          break;
        case "chord-only":
          html += `<span class="line-chord">${esc(item.text)}</span>\n`;
          break;
        case "chord-lyric":
          html += `<span class="line-chord">${esc(item.chords)}</span>\n`;
          html += `<span class="line-lyric">${esc(item.lyrics)}</span>\n`;
          break;
        case "inline-chord": {
          const parts = item.text.split(/(\[[^\]]+\])/g);
          let out = "";
          for (const p of parts) {
            if (p.startsWith("[") && p.endsWith("]")) {
              out += `<span class="line-chord">${esc(p.slice(1, -1))}</span> `;
            } else {
              out += esc(p);
            }
          }
          html += `<span class="line-lyric">${out}</span>\n`;
          break;
        }
        case "lyric":
          html += `<span class="line-lyric">${esc(item.text)}</span>\n`;
          break;
      }
    }
    return html;
  }

  // ── Player ──
  function openPlayer(id) {
    const song = songs.find((s) => s.id === id);
    if (!song) return;
    currentSongId = id;
    playerSongTitle.textContent = song.title;
    playerSongArtist.textContent = song.artist;

    songMeta.innerHTML = "";
    if (song.tuning) songMeta.innerHTML += `<span class="meta-tag"><strong>Tuning:</strong> ${esc(song.tuning)}</span>`;
    if (song.capo) songMeta.innerHTML += `<span class="meta-tag"><strong>Capo:</strong> ${esc(song.capo)}</span>`;
    const rusty = isRusty(song.lastPlayed);
    songMeta.innerHTML += `<span class="meta-tag last-played${rusty ? " rusty" : ""}"><strong>Last played:</strong> ${esc(formatLastPlayed(song.lastPlayed))}</span>`;

    let contentHTML = "";
    if (song.strum) {
      contentHTML += `<span class="strum-pattern">Strum: ${esc(song.strum)}</span>`;
    }
    const parsed = parseBody(song.body || "");
    contentHTML += renderParsed(parsed);
    songContent.innerHTML = contentHTML;
    songContent.scrollTop = 0;

    showView(playerView);

    // Track that a song was actually opened — key signal of real usage
    if (window.Analytics) {
      window.Analytics.track("song-open", {
        song_title: song.title,
        artist: song.artist || "",
        proficiency: song.proficiency || 0,
      });
    }
  }

  // ── Auto-scroll ──
  // Records the current song as played; called once the scroller runs past the threshold
  function markPlayed(id) {
    const song = songs.find((s) => s.id === id);
    if (!song) return;
    const now = Date.now();
    song.lastPlayed = now;

    // Ensure the practice log exists (older songs won't have it)
    if (!Array.isArray(song.practiceLog)) song.practiceLog = [];

    // Only count one practice session per calendar day per song — avoids inflating
    // the counter if the user replays the same song several times in one sitting
    const alreadyToday = song.practiceLog.some((ts) => isSameDay(ts, now));
    if (!alreadyToday) {
      song.practiceLog.push(now);
      song.practiceCount = (song.practiceCount || 0) + 1;
    }

    saveSongs();
    // Refresh the "last played" line in the player if this song is open
    if (currentSongId === id) {
      renderLastPlayedMeta(song);
    }
    renderLibrary();
    if (window.Analytics) window.Analytics.track("song-practiced");
  }

  function startScroll() {
    scrolling = true;
    scrollToggle.textContent = "❚❚";
    scrollToggle.classList.add("active");

    // Track autoscroll starts — shows people are playing along, not just browsing
    if (window.Analytics) {
      const current = songs.find((s) => s.id === currentSongId);
      window.Analytics.track("autoscroll-start", {
        song_title: current ? current.title : "",
        speed: speed,
      });
    }
    // Mark as played only after sustained scrolling — a quick tap shouldn't count
    if (currentSongId && !playedTimer) {
      const id = currentSongId;
      playedTimer = setTimeout(() => {
        playedTimer = null;
        markPlayed(id);
      }, PLAYED_THRESHOLD_MS);
    }
    let last = performance.now();
    let accum = 0;

    function tick(now) {
      if (!scrolling) return;
      const dt = now - last;
      last = now;
      accum += speed * dt * 0.004;
      if (accum >= 1) {
        const px = Math.floor(accum);
        songContent.scrollTop += px;
        accum -= px;
      }
      const maxScroll = songContent.scrollHeight - songContent.clientHeight;
      if (songContent.scrollTop >= maxScroll) {
        stopScroll();
        return;
      }
      scrollRAF = requestAnimationFrame(tick);
    }
    scrollRAF = requestAnimationFrame(tick);
  }

  function stopScroll() {
    scrolling = false;
    scrollToggle.textContent = "▶";
    scrollToggle.classList.remove("active");
    if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }
    // Scrolling stopped before the threshold — cancel the pending "played" mark
    if (playedTimer) { clearTimeout(playedTimer); playedTimer = null; }
  }

  function updateSpeedLabel() {
    speedLabel.textContent = speed + "×";
  }

  // ── Auto-import raw text files ──
  function autoImportFromText(text, filename) {
    const lines = text.split("\n");
    let title = filename || "Untitled";
    let artist = "";
    let capo = "";
    let tuning = "";
    let strum = "";
    let bodyStart = 0;

    const dashMatch = filename ? filename.match(/^(.+?)\s*-\s*(.+)$/) : null;
    if (dashMatch) {
      title = dashMatch[1].trim();
      artist = dashMatch[2].trim();
    }

    const firstLine = lines[0] || "";
    const metaFields = firstLine.match(/(Tuning:\s*[^\s]+|Key:\s*[^\s]+|Capo:\s*[^,\n]+)/gi);
    if (metaFields) {
      for (const f of metaFields) {
        if (/^tuning/i.test(f)) tuning = f.replace(/^tuning:\s*/i, "");
        if (/^capo/i.test(f)) capo = f.replace(/^capo:\s*/i, "");
      }
      bodyStart = 1;
    }

    if (/^\*\s*=/.test(lines[bodyStart] || "")) {
      strum = lines[bodyStart].trim();
      bodyStart++;
    }

    const body = lines.slice(bodyStart).join("\n").trim();

    return { title, artist, capo, tuning, strum, body };
  }

  // ── Helpers ──
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // Local-midnight timestamp for a given date — the canonical "day" key for practice logs
  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // True when two timestamps fall on the same calendar day (local time)
  function isSameDay(a, b) {
    return startOfDay(a) === startOfDay(b);
  }

  // Collapses every song's practice log into a Set of distinct day-keys the user practiced
  function practicedDaySet() {
    const days = new Set();
    for (const s of songs) {
      if (!Array.isArray(s.practiceLog)) continue;
      for (const ts of s.practiceLog) days.add(startOfDay(ts));
    }
    return days;
  }

  // Counts consecutive days (ending today or yesterday) with at least one practice session.
  // Passing a specific song's day-set gives a per-song streak; omit for the global streak.
  function computeStreak(daySet) {
    const oneDay = 24 * 60 * 60 * 1000;
    let cursor = startOfDay(Date.now());

    // Streak stays alive if practiced today OR yesterday; otherwise it's broken
    if (!daySet.has(cursor)) {
      cursor -= oneDay;
      if (!daySet.has(cursor)) return 0;
    }

    // Walk backwards day-by-day until we hit a gap
    let streak = 0;
    while (daySet.has(cursor)) {
      streak++;
      cursor -= oneDay;
    }
    return streak;
  }

  // A song is "rusty" if it has been played before but not recently (may need practice)
  function isRusty(ts) {
    if (!ts) return false;
    return Date.now() - ts > RUSTY_THRESHOLD_MS;
  }

  // Human-friendly relative time, e.g. "Today", "3 days ago", "2 months ago"
  function formatLastPlayed(ts) {
    if (!ts) return "Never";
    const diff = Date.now() - ts;
    const day = 24 * 60 * 60 * 1000;
    const days = Math.floor(diff / day);

    // Same day
    if (days <= 0) return "Today";
    // Yesterday
    if (days === 1) return "Yesterday";
    // Within the last few weeks — show days
    if (days < 30) return `${days} days ago`;
    // A month or more — show months
    const months = Math.floor(days / 30);
    if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
    // A year or more — show years
    const years = Math.floor(days / 365);
    return years === 1 ? "1 year ago" : `${years} years ago`;
  }

  // Small badge for the library list; flags rusty songs so forgotten ones stand out
  function lastPlayedBadge(ts) {
    const rusty = isRusty(ts);
    const cls = "song-item-lastplayed" + (rusty ? " rusty" : "") + (!ts ? " never" : "");
    const icon = rusty ? "⏳ " : "";
    return `<div class="${cls}">${icon}${esc(formatLastPlayed(ts))}</div>`;
  }

  // Re-renders just the "last played" meta tag in the open player (after a play is recorded)
  function renderLastPlayedMeta(song) {    const existing = songMeta.querySelector(".meta-tag.last-played");
    const rusty = isRusty(song.lastPlayed);
    const html = `<span class="meta-tag last-played${rusty ? " rusty" : ""}"><strong>Last played:</strong> ${esc(formatLastPlayed(song.lastPlayed))}</span>`;
    // Replace the existing tag in place if present
    if (existing) {
      existing.outerHTML = html;
    // Otherwise append it (e.g. first play in this session)
    } else {
      songMeta.innerHTML += html;
    }
  }

  // Small "times practiced" badge for the library list
  function practiceCountBadge(count) {
    const n = count || 0;
    // No sessions yet — nothing to show
    if (!n) return "";
    return `<span class="practice-badge">🎸 ${n}×</span>`;
  }

  // ── Global practice calendar (streaks + heatmap) ──
  function practiceCountByDay() {
    const counts = new Map();
    for (const s of songs) {
      if (!Array.isArray(s.practiceLog)) continue;
      for (const ts of s.practiceLog) {
        const day = startOfDay(ts);
        counts.set(day, (counts.get(day) || 0) + 1);
      }
    }
    return counts;
  }

  function openPracticeCalendar() {
    const daySet = practicedDaySet();
    const streak = computeStreak(daySet);
    const today = startOfDay(Date.now());
    let todayCount = 0;
    let total = 0;
    for (const s of songs) {
      if (!Array.isArray(s.practiceLog)) continue;
      total += s.practiceLog.length;
      todayCount += s.practiceLog.filter((ts) => startOfDay(ts) === today).length;
    }

    statsStreakEl.textContent = streak;
    statsTodayEl.textContent = todayCount;
    statsTotalEl.textContent = total;
    statsStreakEl.parentElement.classList.toggle("active", streak > 0);

    renderCalendar(practiceCountByDay());
    showView(statsView);
    if (window.Analytics) window.Analytics.track("stats-open");
  }

  // Renders a GitHub-style heatmap for roughly the last ~18 weeks of practice
  function renderCalendar(dayCounts) {
    const WEEKS = 18;
    const oneDay = 24 * 60 * 60 * 1000;
    statsCalendarEl.innerHTML = "";

    // Anchor the grid to the end of the current week so today sits in the last column
    const today = startOfDay(Date.now());
    const todayDow = new Date(today).getDay(); // 0 = Sunday
    const gridEnd = today + (6 - todayDow) * oneDay;
    const gridStart = gridEnd - (WEEKS * 7 - 1) * oneDay;

    for (let i = 0; i < WEEKS * 7; i++) {
      const dayTs = gridStart + i * oneDay;
      const cell = document.createElement("span");

      // Future days (after today) render as empty placeholders
      if (dayTs > today) {
        cell.className = "cal-cell future";
      } else {
        const count = dayCounts.get(dayTs) || 0;
        let lvl = "lvl-0";
        if (count >= 3) lvl = "lvl-3";
        else if (count === 2) lvl = "lvl-2";
        else if (count === 1) lvl = "lvl-1";
        cell.className = "cal-cell " + lvl;
        const d = new Date(dayTs);
        cell.title =
          d.toLocaleDateString() +
          (count ? ` — ${count} session${count === 1 ? "" : "s"}` : "");
      }
      statsCalendarEl.appendChild(cell);
    }
  }

  // ── Tuner (fully offline: mic + Web Audio pitch detection) ──
  // Everything here runs locally in the browser — no network calls — so the
  // tuner works with no connection, unlike a typical online phone tuner.
  // pitch.js does the actual pitch estimation; this half turns a stream of
  // estimates into a readout that settles quickly without twitching.
  const TUNING_KEY = "guitarscroll_tuning";
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const TUNINGS = [
    { id: "standard", label: "Standard", notes: ["E2", "A2", "D3", "G3", "B3", "E4"] },
    { id: "drop-d", label: "Drop D", notes: ["D2", "A2", "D3", "G3", "B3", "E4"] },
    { id: "half-step", label: "Half step down", notes: ["D#2", "G#2", "C#3", "F#3", "A#3", "D#4"] },
    { id: "full-step", label: "Full step down", notes: ["D2", "G2", "C3", "F3", "A3", "D4"] },
    { id: "drop-c", label: "Drop C", notes: ["C2", "G2", "C3", "F3", "A3", "D4"] },
    { id: "dadgad", label: "DADGAD", notes: ["D2", "A2", "D3", "G3", "A3", "D4"] },
    { id: "open-g", label: "Open G", notes: ["D2", "G2", "D3", "G3", "B3", "D4"] },
    { id: "open-d", label: "Open D", notes: ["D2", "A2", "D3", "F#3", "A3", "D4"] },
  ];

  // 8192 samples is ~170 ms at 48 kHz — a dozen periods of the low E, which is
  // what the detector needs down there. Windows overlap, so readings still
  // arrive every TUNER_INTERVAL_MS.
  const TUNER_FRAME = 8192;
  const TUNER_INTERVAL_MS = 33;
  // A single ringing string scores ~0.95; a strummed chord or room noise
  // scores well under 0.5, and there is nothing sensible to show for those.
  // Once a note is on screen the bar drops, so a string stays tracked as it
  // decays into the noise instead of blinking out halfway through.
  const MIN_CLARITY = 0.86;
  const HELD_CLARITY = 0.78;
  const HOLD_MS = 1500; // keep the last note on screen between plucks
  const NEW_NOTE_CENTS = 60; // a jump bigger than this means a different string
  const NEW_NOTE_FRAMES = 2; // ...but only after it repeats, so noise can't move us
  const HISTORY_LEN = 5;
  const IN_TUNE_CENTS = 3;
  const IN_TUNE_HOLD_FRAMES = 8;
  // Past a semitone and a half from every string in the tuning, naming a
  // string would be a guess — show the note actually being played instead and
  // let the player pin the string they meant.
  const STRING_RANGE_CENTS = 150;

  // Dial geometry, in the units of the SVG viewBox in index.html. The pointer
  // swings DIAL_SWEEP_DEG either side of straight up over ±DIAL_RANGE_CENTS.
  const DIAL_CX = 160;
  const DIAL_CY = 185;
  const DIAL_R = 150;
  const DIAL_SWEEP_DEG = 72;
  const DIAL_RANGE_CENTS = 50;

  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let detector = null;
  let tunerRAF = null;
  let tunerActive = false;
  let tunerBuf = null;
  let lastAnalysisAt = 0;

  let activeTuning = TUNINGS[0];
  let pinnedNote = null; // string the player locked onto by tapping it
  let tunedStrings = new Set(); // sticky green until the tuner is stopped

  // Displayed pitch is tracked in log space so smoothing is even across octaves.
  let smoothedLog = 0;
  let hasReading = false;
  let recentFreqs = [];
  let pendingFreqs = [];
  let lastGoodAt = 0;
  let inTuneStreak = 0;

  function parseNote(note) {
    const m = /^([A-G]#?)(-?\d+)$/.exec(note);
    return { name: m[1], octave: m[2] };
  }

  function noteToMidi(note) {
    const parts = parseNote(note);
    return NOTE_NAMES.indexOf(parts.name) + (parseInt(parts.octave, 10) + 1) * 12;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function noteFreq(note) {
    return midiToFreq(noteToMidi(note));
  }

  function centsBetween(freq, reference) {
    return 1200 * Math.log2(freq / reference);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Which string the readout should aim at: the one the player pinned, or
  // whichever open string of the current tuning is closest.
  function pickTarget(freq) {
    if (pinnedNote) return pinnedNote;
    let best = null;
    let bestDist = Infinity;
    for (const note of activeTuning.notes) {
      const dist = Math.abs(centsBetween(freq, noteFreq(note)));
      if (dist < bestDist) {
        bestDist = dist;
        best = note;
      }
    }
    return bestDist <= STRING_RANGE_CENTS ? best : null;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  function dialPoint(cents, radius) {
    const angle = (cents / DIAL_RANGE_CENTS) * DIAL_SWEEP_DEG * (Math.PI / 180);
    return { x: DIAL_CX + Math.sin(angle) * radius, y: DIAL_CY - Math.cos(angle) * radius };
  }

  // Notches cut across the arc band every 5 cents, wider ones every 25. Zero
  // gets no notch — the green target zone already marks it.
  function buildDial() {
    dialTicks.textContent = "";
    for (let c = -DIAL_RANGE_CENTS; c <= DIAL_RANGE_CENTS; c += 5) {
      if (c === 0) continue;
      const inner = dialPoint(c, 142);
      const outer = dialPoint(c, 158);
      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("class", "dial-tick" + (c % 25 === 0 ? " major" : ""));
      tick.setAttribute("x1", inner.x.toFixed(2));
      tick.setAttribute("y1", inner.y.toFixed(2));
      tick.setAttribute("x2", outer.x.toFixed(2));
      tick.setAttribute("y2", outer.y.toFixed(2));
      dialTicks.appendChild(tick);
    }
  }

  function pointNeedle(cents) {
    const clamped = Math.max(-DIAL_RANGE_CENTS, Math.min(DIAL_RANGE_CENTS, cents));
    tunerNeedle.style.transform = "rotate(" + (clamped / DIAL_RANGE_CENTS) * DIAL_SWEEP_DEG + "deg)";
  }

  function buildTuningOptions() {
    tunerTuningSelect.innerHTML = "";
    for (const tuning of TUNINGS) {
      const opt = document.createElement("option");
      opt.value = tuning.id;
      opt.textContent = tuning.label;
      tunerTuningSelect.appendChild(opt);
    }
    tunerTuningSelect.value = activeTuning.id;
  }

  function renderTunerStrings() {
    tunerStringsEl.innerHTML = "";
    for (const note of activeTuning.notes) {
      const parts = parseNote(note);
      const btn = document.createElement("button");
      btn.className = "tuner-string";
      btn.dataset.note = note;
      btn.innerHTML = esc(parts.name) + "<sub>" + esc(parts.octave) + "</sub>";
      btn.setAttribute("aria-label", "Tune the " + parts.name + parts.octave + " string");
      tunerStringsEl.appendChild(btn);
    }
    highlightStrings(null);
  }

  // Highlight the string being tuned; keep already-tuned ones green.
  function highlightStrings(targetNote) {
    tunerStringsEl.querySelectorAll(".tuner-string").forEach((btn) => {
      const note = btn.dataset.note;
      btn.classList.toggle("target", note === targetNote);
      btn.classList.toggle("in-tune", tunedStrings.has(note));
      btn.classList.toggle("pinned", note === pinnedNote);
      btn.setAttribute("aria-pressed", note === pinnedNote ? "true" : "false");
    });
  }

  function updateHint() {
    tunerHint.textContent = pinnedNote
      ? "Locked to " + pinnedNote + " — tap it again for automatic"
      : "Tap a string to lock the tuner to it";
    tunerHint.classList.toggle("pinned", !!pinnedNote);
  }

  function clearReading() {
    hasReading = false;
    smoothedLog = 0;
    recentFreqs = [];
    pendingFreqs = [];
    lastGoodAt = 0;
    inTuneStreak = 0;
  }

  function renderWaiting() {
    tunerNote.textContent = "—";
    tunerNote.className = "tuner-note";
    tunerCents.textContent = "";
    tunerCents.className = "tuner-cents";
    tunerFreq.textContent = tunerActive ? "Play a string…" : "Tap start & play a string";
    tunerStatus.textContent = "—";
    tunerStatus.className = "tuner-status";
    tunerDial.className = "tuner-dial";
    pointNeedle(0);
    highlightStrings(pinnedNote);
  }

  function renderReading(stale) {
    const freq = Math.pow(2, smoothedLog);
    const target = pickTarget(freq);

    let name;
    let octave;
    let targetFreq;
    if (target) {
      const parts = parseNote(target);
      name = parts.name;
      octave = parts.octave;
      targetFreq = noteFreq(target);
    } else {
      // Not an open string — fall back to naming the nearest semitone so the
      // readout still means something on a fretted note.
      const midi = Math.round(69 + 12 * Math.log2(freq / 440));
      name = NOTE_NAMES[((midi % 12) + 12) % 12];
      octave = String(Math.floor(midi / 12) - 1);
      targetFreq = midiToFreq(midi);
    }

    const cents = centsBetween(freq, targetFreq);
    const rounded = Math.round(cents);
    const closeEnough = Math.abs(cents) <= IN_TUNE_CENTS;

    if (closeEnough && !stale) inTuneStreak++;
    else if (!closeEnough) inTuneStreak = 0;
    if (target && inTuneStreak >= IN_TUNE_HOLD_FRAMES) tunedStrings.add(target);

    tunerNote.innerHTML =
      esc(name) + '<span style="font-size:0.4em;vertical-align:super;">' + esc(octave) + "</span>";
    tunerCents.textContent = (rounded > 0 ? "+" : rounded < 0 ? "−" : "±") + Math.abs(rounded) + " ¢";
    tunerFreq.textContent = freq.toFixed(2) + " Hz → " + targetFreq.toFixed(2) + " Hz";
    pointNeedle(cents);

    tunerNote.className = "tuner-note " + (closeEnough ? "in-tune" : "detecting");
    tunerCents.className = "tuner-cents " + (closeEnough ? "in-tune" : cents < 0 ? "flat" : "sharp");
    tunerDial.className = "tuner-dial" + (closeEnough ? " in-tune" : "") + (stale ? " stale" : "");

    if (!target) {
      tunerStatus.textContent = "Not an open string — tap the one you mean";
      tunerStatus.className = "tuner-status";
    } else if (closeEnough) {
      const done = tunedStrings.size;
      tunerStatus.textContent = done ? "In tune ✓  ·  " + done + "/6 done" : "In tune ✓";
      tunerStatus.className = "tuner-status in-tune";
    } else if (cents < 0) {
      tunerStatus.textContent = "Too flat — tune up ↑";
      tunerStatus.className = "tuner-status flat";
    } else {
      tunerStatus.textContent = "Too sharp — tune down ↓";
      tunerStatus.className = "tuner-status sharp";
    }

    highlightStrings(target);
  }

  // Fold one detector estimate into the displayed pitch. Small differences are
  // smoothed away; a genuine move to another string is confirmed over a couple
  // of readings and then jumped to, so switching strings feels immediate.
  function acceptReading(freq) {
    if (!hasReading) {
      hasReading = true;
      smoothedLog = Math.log2(freq);
      recentFreqs = [freq];
      pendingFreqs = [];
      inTuneStreak = 0;
      return;
    }

    const jump = Math.abs(1200 * (Math.log2(freq) - smoothedLog));
    if (jump > NEW_NOTE_CENTS) {
      pendingFreqs.push(freq);
      if (pendingFreqs.length > NEW_NOTE_FRAMES) pendingFreqs.shift();
      if (pendingFreqs.length < NEW_NOTE_FRAMES) return;
      const spread = 1200 * Math.log2(Math.max(...pendingFreqs) / Math.min(...pendingFreqs));
      if (spread > NEW_NOTE_CENTS) return;
      smoothedLog = Math.log2(median(pendingFreqs));
      recentFreqs = [median(pendingFreqs)];
      pendingFreqs = [];
      inTuneStreak = 0;
      return;
    }

    pendingFreqs = [];
    recentFreqs.push(freq);
    if (recentFreqs.length > HISTORY_LEN) recentFreqs.shift();

    // Median first, so a single bad estimate cannot move the needle at all.
    const targetLog = Math.log2(median(recentFreqs));
    const delta = Math.abs(1200 * (targetLog - smoothedLog));
    // Chase hard while the pitch is still moving, then settle down so the
    // needle holds still once the string is steady.
    const alpha = delta > 20 ? 0.6 : delta > 6 ? 0.3 : 0.12;
    smoothedLog += (targetLog - smoothedLog) * alpha;
  }

  function tunerLoop() {
    if (!tunerActive) return;
    tunerRAF = requestAnimationFrame(tunerLoop);

    const now = performance.now();
    if (now - lastAnalysisAt < TUNER_INTERVAL_MS) return;
    lastAnalysisAt = now;

    analyser.getFloatTimeDomainData(tunerBuf);
    const result = detector.detect(tunerBuf);

    // Input level, so it is obvious at a glance whether the mic hears anything
    const db = result.rms > 0 ? 20 * Math.log10(result.rms) : -100;
    tunerLevelFill.style.width = Math.max(0, Math.min(100, (db + 60) * (100 / 55))) + "%";

    if (result.frequency > 0 && result.clarity >= (hasReading ? HELD_CLARITY : MIN_CLARITY)) {
      lastGoodAt = now;
      acceptReading(result.frequency);
      renderReading(false);
      return;
    }

    if (!hasReading) {
      renderWaiting();
    } else if (now - lastGoodAt > HOLD_MS) {
      // The note has died away — go back to waiting rather than leaving a
      // stale "in tune" claim on screen.
      clearReading();
      renderWaiting();
    } else {
      renderReading(true);
    }
  }

  async function startTuner() {
    tunerMsg.textContent = "";
    tunerMsg.className = "tuner-msg";
    try {
      // Request the mic — this is the only permission the tuner needs. The
      // browser's voice processing would wreck the pitch, so it is all off.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS starts the context suspended until a user gesture resumes it
      if (audioCtx.state === "suspended") await audioCtx.resume();

      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = TUNER_FRAME;

      // Keep only the band the strings live in: below 60 Hz is mains hum and
      // handling rumble, above 1 kHz is pick attack and fret noise. Web Audio
      // takes Q in dB for these types, so -3.01 dB is a flat Butterworth, and
      // two of each gives a steep enough slope to matter.
      let node = source;
      for (const [type, hz] of [["highpass", 60], ["highpass", 60], ["lowpass", 1000], ["lowpass", 1000]]) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = hz;
        filter.Q.value = -3.0103;
        node.connect(filter);
        node = filter;
      }
      node.connect(analyser);

      tunerBuf = new Float32Array(analyser.fftSize);
      detector = new PitchDetector(audioCtx.sampleRate, analyser.fftSize);

      clearReading();
      lastAnalysisAt = 0;
      tunedStrings = new Set();
      highlightStrings(null);

      tunerActive = true;
      tunerToggle.textContent = "Stop tuner";
      tunerToggle.classList.add("active");
      renderWaiting();
      if (window.Analytics) window.Analytics.track("tuner-start");
      tunerLoop();
    } catch (err) {
      // getUserMedia may well have succeeded before whatever failed, so let
      // stopTuner release the mic rather than leaving it open and recording.
      stopTuner();
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      tunerMsg.textContent = denied
        ? "Microphone access is needed for the tuner. Please allow it and try again."
        : "Could not start the tuner: " + ((err && err.message) || "no microphone found");
      tunerMsg.className = "tuner-msg error";
    }
  }

  function stopTuner() {
    tunerActive = false;
    if (tunerRAF) { cancelAnimationFrame(tunerRAF); tunerRAF = null; }
    // Release the mic so the browser stops showing the recording indicator
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    analyser = null;
    detector = null;
    tunerBuf = null;
    clearReading();
    tunedStrings = new Set();
    tunerToggle.textContent = "Start tuner";
    tunerToggle.classList.remove("active");
    tunerLevelFill.style.width = "0%";
    renderWaiting();
  }

  function setTuning(id) {
    const tuning = TUNINGS.find((t) => t.id === id);
    if (!tuning || tuning === activeTuning) return;
    activeTuning = tuning;
    pinnedNote = null;
    tunedStrings = new Set();
    clearReading();
    try { localStorage.setItem(TUNING_KEY, tuning.id); } catch (e) { /* private mode */ }
    renderTunerStrings();
    updateHint();
    renderWaiting();
  }

  function openTuner() {
    showView(tunerView);
    if (window.Analytics) window.Analytics.track("tuner-open");
  }

  (function initTuner() {
    let saved = null;
    try { saved = localStorage.getItem(TUNING_KEY); } catch (e) { /* private mode */ }
    activeTuning = TUNINGS.find((t) => t.id === saved) || TUNINGS[0];
    buildDial();
    buildTuningOptions();
    renderTunerStrings();
    updateHint();
  })();

  // ── Event Wiring ──
  addSongBtn.addEventListener("click", () => openEditor(null));
  calendarBtn.addEventListener("click", openPracticeCalendar);
  editBackBtn.addEventListener("click", () => { showView(libraryView); renderLibrary(); });
  saveSongBtn.addEventListener("click", saveSong);
  ugImportBtn.addEventListener("click", handleUgImport);
  ugUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleUgImport();
    }
  });
  playerBackBtn.addEventListener("click", () => { showView(libraryView); stopScroll(); });
  editCurrentBtn.addEventListener("click", () => openEditor(currentSongId));
  statsBackBtn.addEventListener("click", () => { showView(libraryView); renderLibrary(); });

  // Tuner: open/close and start/stop mic listening
  tunerBtn.addEventListener("click", openTuner);
  tunerBackBtn.addEventListener("click", () => { stopTuner(); showView(libraryView); });
  tunerToggle.addEventListener("click", () => { tunerActive ? stopTuner() : startTuner(); });
  tunerTuningSelect.addEventListener("change", () => setTuning(tunerTuningSelect.value));

  // Tapping a string locks the tuner to it, which is the only way to tune a
  // string that starts out closer to one of its neighbours.
  tunerStringsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tuner-string");
    if (!btn) return;
    pinnedNote = pinnedNote === btn.dataset.note ? null : btn.dataset.note;
    inTuneStreak = 0;
    updateHint();
    if (hasReading) renderReading(false);
    else highlightStrings(pinnedNote);
  });

  scrollToggle.addEventListener("click", () => { scrolling ? stopScroll() : startScroll(); });  scrollSlower.addEventListener("click", () => { speed = Math.max(1, speed - 1); updateSpeedLabel(); });
  scrollFaster.addEventListener("click", () => { speed = Math.min(50, speed + 1); updateSpeedLabel(); });

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderLibrary();
  });

  proficiencyFilter.addEventListener("click", (e) => {
    const pill = e.target.closest(".filter-pill");
    if (!pill) return;
    proficiencyFilter.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    activeFilterLevel = pill.dataset.level;
    renderLibrary();
  });

  function syncSortUI() {
    sortDropdown.querySelectorAll(".sort-option").forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.sort === activeSort);
    });
    sortBtn.classList.toggle("is-active", activeSort !== "default");
    const open = !sortDropdown.classList.contains("hidden");
    sortBtn.setAttribute("aria-expanded", open ? "true" : "false");
    sortBtn.classList.toggle("is-open", open);
  }

  function closeSortDropdown() {
    sortDropdown.classList.add("hidden");
    sortBtn.classList.remove("is-open");
    sortBtn.setAttribute("aria-expanded", "false");
  }

  sortBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.add("hidden");
    sortDropdown.classList.toggle("hidden");
    syncSortUI();
  });

  sortDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
    const opt = e.target.closest(".sort-option");
    if (!opt) return;
    activeSort = opt.dataset.sort;
    closeSortDropdown();
    syncSortUI();
    renderLibrary();
  });

  // ── Menu / Backup ──
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSortDropdown();
    menuDropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    menuDropdown.classList.add("hidden");
    closeSortDropdown();
  });

  menuDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  exportBtn.addEventListener("click", () => {
    menuDropdown.classList.add("hidden");
    const data = JSON.stringify(songs, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `guitarscroll-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener("click", () => {
    menuDropdown.classList.add("hidden");
    importFile.click();
  });

  importFile.addEventListener("change", () => {
    const file = importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error("not an array");
        let added = 0;
        let updated = 0;
        for (const s of imported) {
          if (!s.id || !s.title) continue;
          const existing = songs.find((x) => x.id === s.id);
          if (existing) {
            Object.assign(existing, s);
            updated++;
          } else {
            songs.push(s);
            added++;
          }
        }
        saveSongs();
        renderLibrary();
        alert(`Import done: ${added} added, ${updated} updated.`);
      } catch {
        alert("Invalid backup file.");
      }
      importFile.value = "";
    };
    reader.readAsText(file);
  });

  // ── Init ──
  loadSongs();
  migratePracticeData();
  mergeSongsFromRepo().then(() => { renderLibrary(); });
  renderLibrary();
  syncSortUI();
  updateSpeedLabel();

  // ── Service Worker ──
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
