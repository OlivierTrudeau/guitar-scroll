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
  const tunerFreq = $("#tuner-freq");
  const tunerNeedle = $("#tuner-needle");
  const tunerStatus = $("#tuner-status");
  const tunerMsg = $("#tuner-msg");
  const tunerStringsEl = $(".tuner-strings");
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

  function decodeStrumCode(code) {
    const n = parseInt(code, 10);
    if (Number.isNaN(n)) return "?";
    // UG packs stroke type in the low digits; 2xx ≈ rest / empty slot
    const hundreds = Math.floor(n / 100);
    const kind = n % 100;
    if (hundreds === 2) return "-";
    if (kind === 1) return "D";
    if (kind === 2) return "U";
    if (kind === 3) return "X";
    return "?";
  }

  function formatStrumming(strummings) {
    if (!Array.isArray(strummings) || !strummings.length) return "";
    const pat = strummings[0];
    const measures = pat.measures || [];
    const strokes = measures.map((m) =>
      decodeStrumCode(typeof m === "object" && m ? m.measure : m)
    );
    let text = strokes.join(" ").replace(/\s+/g, " ").trim();
    const part = (pat.part || "").trim();
    const bpm = pat.bpm;
    if (part) text = part + ": " + text;
    if (bpm) text += " (" + bpm + " bpm)";
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

  // UG strumming CSS-module class map (from their tab page bundle)
  function strokeFromBeatClass(className) {
    const c = String(className || "").split(/\s+/);
    if (c.includes("djwky")) return "-"; // realPause
    if (c.includes("l4MMU") || c.includes("Pp3D7")) return "X"; // mute / palm mute
    if (c.includes("vaSS9")) return "U"; // up
    if (c.includes("-u97C")) return "D"; // down
    return "-";
  }

  function parseStrumFromRenderedHtml(htmlText) {
    const sections = htmlText.match(/<section class="V2Y9h">[\s\S]*?<\/section>/g) || [];
    if (!sections.length) return "";
    const sec = sections[0];
    const cells = [...sec.matchAll(/<div class="([^"]*)">/g)].map((m) => m[1]);
    if (!cells.length) return "";
    const strokes = cells.map(strokeFromBeatClass);
    let text = strokes.join(" ").replace(/\s+/g, " ").trim();
    const bpmMatch = htmlText.match(/(\d+)\s*bpm/i);
    if (bpmMatch) text += " (" + bpmMatch[1] + " bpm)";
    return text;
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
      strum: parseStrumFromRenderedHtml(htmlText),
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
    // Prefer rendered-class decode when available in same HTML; else packed measures
    const renderedStrum = parseStrumFromRenderedHtml(htmlText);
    return {
      title: tab.song_name || "",
      artist: tab.artist_name || "",
      capo: formatCapo(meta.capo),
      tuning: tuning.value || tuning.name || "",
      strum: renderedStrum || formatStrumming(strummingsFromTabView(tv)),
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

  // Jina HTML: reliable CORS + rendered strumming pattern classes + chord sheet
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

  // allorigins sometimes has raw js-store (incl. strumming), but is flaky/CORS-fragile
  async function fetchSongFromAllOrigins(url) {
    const encoded = encodeURIComponent(url);
    const endpoints = [
      "https://api.allorigins.win/get?url=" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    let lastErr = null;
    for (const endpoint of endpoints) {
      try {
        const text = await fetchText(endpoint, { timeout: 20000 });
        let htmlText = text;
        if (endpoint.includes("/get?")) {
          const payload = JSON.parse(text);
          htmlText = payload.contents || "";
        }
        if (htmlText && htmlText.includes("js-store")) {
          return parseUgJsStore(htmlText);
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Could not load tab HTML");
  }

  async function importFromUltimateGuitar(rawUrl) {
    const url = String(rawUrl || "").trim();
    if (!UG_URL_RE.test(url)) {
      throw new Error("Paste a full Ultimate Guitar tab link (tabs.ultimate-guitar.com/tab/…).");
    }

    // Primary: Jina HTML (CORS-friendly, includes strumming UI classes)
    // Fallback: Jina markdown (body/meta only)
    // Optional: allorigins js-store if it happens to work
    const htmlAttempt = fetchSongFromJinaHtml(url);
    const mdAttempt = fetchSongFromJinaMarkdown(url);
    const aoAttempt = fetchSongFromAllOrigins(url);

    const wrap = (promise, src) =>
      promise.then(
        (song) => ({ src, song }),
        (err) => ({ src, err })
      );

    const htmlWrapped = wrap(htmlAttempt, "html");
    const mdWrapped = wrap(mdAttempt, "md");
    const aoWrapped = wrap(aoAttempt, "ao");

    // Prefer first success that includes strumming; otherwise first success with body
    const results = [];
    const pushResult = (r) => {
      if (r && r.song && r.song.body) results.push(r);
    };

    const first = await Promise.race([htmlWrapped, mdWrapped, aoWrapped]);
    pushResult(first);

    if (first.song && first.song.strum) return first.song;

    // Wait a bit for a strumming-capable result
    setUgStatus("Extracting strumming pattern…", "progress");
    const rest = await Promise.all([
      first.src === "html" ? Promise.resolve(first) : htmlWrapped,
      first.src === "md" ? Promise.resolve(first) : mdWrapped,
      first.src === "ao" ? Promise.resolve(first) : aoWrapped,
    ]);
    rest.forEach(pushResult);

    const withStrum = results.find((r) => r.song && r.song.strum);
    if (withStrum) return withStrum.song;
    if (results.length) return results[0].song;

    const errMsg =
      [first, ...rest]
        .map((r) => r && r.err && r.err.message)
        .filter(Boolean)[0] || "";
    throw new Error(
      "Couldn't fetch that tab (network/proxy). Try again, or paste the chords manually." +
        (errMsg ? " (" + errMsg + ")" : "")
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

  // ── Tuner (fully offline: mic + Web Audio autocorrelation) ──
  // Everything here runs locally in the browser — no network calls — so the
  // tuner works with no connection, unlike a typical online phone tuner.
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let tunerRAF = null;
  let tunerActive = false;
  let tunerBuf = null;

  // Smoothing / lock state — keeps the needle from jittering and remembers
  // which strings the player has already gotten in tune during this session.
  let smoothedFreq = 0;
  let smoothedCents = 0;
  let recentFreqs = [];
  let inTuneStreak = 0;
  let tunedStrings = new Set(); // sticky green until the tuner is stopped
  const FREQ_SMOOTH = 0.1; // EMA weight for new samples (lower = calmer)
  const CENTS_SMOOTH = 0.12; // separate EMA for the needle so it doesn't twitch
  const IN_TUNE_CENTS = 5; // how close counts as "in tune"
  const IN_TUNE_HOLD_FRAMES = 12; // must stay in tune this many frames to lock
  const STRING_MATCH_CENTS = 70; // ignore pitches that aren't near any open string
  const MAX_JUMP_CENTS = 90; // reject frame-to-frame leaps bigger than this

  // Standard tuning reference pitches (Hz) for the six open strings
  const STRING_FREQS = { E2: 82.41, A2: 110.0, D3: 146.83, G3: 196.0, B3: 246.94, E4: 329.63 };
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  // Convert a frequency to the nearest note name + how many cents off it is.
  // Cents (100 = one semitone) tell us whether the string is flat or sharp.
  function freqToNote(freq) {
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const noteFreq = 440 * Math.pow(2, (midi - 69) / 12);
    const cents = Math.round(1200 * Math.log2(freq / noteFreq));
    const name = NOTE_NAMES[(midi % 12 + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return { name, octave, cents, midi };
  }

  // Autocorrelation pitch detector — robust for low guitar notes where FFT
  // peak-picking struggles. Returns frequency in Hz, or -1 if the signal is
  // too quiet/noisy to trust.
  function detectPitch(buf, sampleRate) {
    const SIZE = buf.length;

    // Bail out on near-silence so we don't chase noise
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.015) return -1;

    // Trim leading/trailing samples below a threshold to sharpen correlation
    let r1 = 0, r2 = SIZE - 1;
    const thres = 0.2;
    for (let i = 0; i < SIZE / 2; i++) {
      if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    }
    for (let i = 1; i < SIZE / 2; i++) {
      if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
    }
    const trimmed = buf.slice(r1, r2);
    const n = trimmed.length;
    if (n < 64) return -1;

    // Limit lag search to guitar-ish range (~70–400 Hz) for fewer octave errors
    const minLag = Math.floor(sampleRate / 400);
    const maxLag = Math.min(n - 1, Math.floor(sampleRate / 70));
    if (maxLag <= minLag) return -1;

    const c = new Array(n).fill(0);
    for (let lag = 0; lag < n; lag++) {
      for (let i = 0; i < n - lag; i++) {
        c[lag] += trimmed[i] * trimmed[i + lag];
      }
    }

    // Find the strongest correlation peak inside the guitar lag window
    let maxval = -1, maxpos = -1;
    for (let i = minLag; i <= maxLag; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }
    let T0 = maxpos;
    if (T0 <= 0 || maxval < c[0] * 0.25) return -1;

    // Parabolic interpolation around the peak for a finer frequency estimate
    const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);

    return sampleRate / T0;
  }

  // Median of the last few readings — kills single-frame spikes
  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function smoothFrequency(rawFreq) {
    if (rawFreq <= 0) {
      // Decay toward silence slowly so a brief gap doesn't blank the UI
      if (smoothedFreq > 0) smoothedFreq *= 0.94;
      if (smoothedFreq < 20) {
        smoothedFreq = 0;
        smoothedCents = 0;
        recentFreqs = [];
      }
      return smoothedFreq;
    }

    // Reject wild jumps (octave errors / noise) unless we have no prior reading
    if (smoothedFreq > 0) {
      const jumpCents = Math.abs(1200 * Math.log2(rawFreq / smoothedFreq));
      if (jumpCents > MAX_JUMP_CENTS) return smoothedFreq;
    }

    recentFreqs.push(rawFreq);
    if (recentFreqs.length > 11) recentFreqs.shift();
    const med = median(recentFreqs);

    if (!smoothedFreq) smoothedFreq = med;
    else smoothedFreq = smoothedFreq * (1 - FREQ_SMOOTH) + med * FREQ_SMOOTH;
    return smoothedFreq;
  }

  function closestString(freq) {
    let closest = null, best = Infinity;
    for (const [note, f] of Object.entries(STRING_FREQS)) {
      const dist = Math.abs(1200 * Math.log2(freq / f));
      if (dist < best) { best = dist; closest = note; }
    }
    return { note: closest, cents: best };
  }

  // Update the note readout, needle position and string highlight from a pitch
  function renderTuner(rawFreq) {
    const freq = smoothFrequency(rawFreq);

    // No reliable pitch — keep prior reading, just stop claiming "in tune"
    if (freq <= 0) {
      inTuneStreak = 0;
      tunerNote.classList.remove("in-tune");
      tunerNote.classList.remove("detecting");
      return;
    }

    const match = closestString(freq);
    // Ignore pitches that aren't near any open string (harmonics / room noise)
    if (match.cents > STRING_MATCH_CENTS) {
      inTuneStreak = 0;
      return;
    }

    // Prefer cents relative to the closest guitar string, not arbitrary MIDI rounding
    const targetFreq = STRING_FREQS[match.note];
    const rawCents = 1200 * Math.log2(freq / targetFreq);
    // Smooth cents separately so the needle doesn't twitch on tiny pitch noise
    smoothedCents = smoothedCents * (1 - CENTS_SMOOTH) + rawCents * CENTS_SMOOTH;
    const cents = Math.round(smoothedCents);
    const { name, octave } = freqToNote(targetFreq);

    tunerNote.innerHTML = esc(name) + '<span style="font-size:0.4em;vertical-align:super;">' + octave + "</span>";
    tunerFreq.textContent = freq.toFixed(1) + " Hz";

    // Needle: map -50..+50 cents onto 0..100% of the track width
    const clamped = Math.max(-50, Math.min(50, smoothedCents));
    tunerNeedle.style.left = (50 + clamped) + "%";

    const closeEnough = Math.abs(cents) <= IN_TUNE_CENTS;
    if (closeEnough) inTuneStreak++;
    else inTuneStreak = 0;

    // Only lock a string after it stays in tune for a few frames — avoids green flash
    if (inTuneStreak >= IN_TUNE_HOLD_FRAMES) {
      tunedStrings.add(match.note);
    }

    const locked = tunedStrings.has(match.note);
    tunerNote.classList.toggle("in-tune", closeEnough || locked);
    tunerNote.classList.toggle("detecting", !(closeEnough || locked));
    tunerNeedle.classList.toggle("in-tune", closeEnough || locked);

    if (closeEnough || locked) {
      const done = tunedStrings.size;
      tunerStatus.textContent =
        locked
          ? "In tune ✓  ·  " + done + "/6 locked"
          : "In tune ✓";
      tunerStatus.className = "tuner-status in-tune";
    } else if (cents < 0) {
      tunerStatus.textContent = "Too flat — tune up ↑";
      tunerStatus.className = "tuner-status flat";
    } else {
      tunerStatus.textContent = "Too sharp — tune down ↓";
      tunerStatus.className = "tuner-status sharp";
    }

    highlightStrings(match.note);
  }

  // Highlight the active target string; keep already-tuned strings green
  function highlightStrings(targetNote) {
    tunerStringsEl.querySelectorAll(".tuner-string").forEach((btn) => {
      const note = btn.dataset.note;
      const isTarget = note === targetNote;
      const isTuned = tunedStrings.has(note);
      btn.classList.toggle("target", isTarget && !isTuned);
      btn.classList.toggle("in-tune", isTuned);
      // Tiny check mark once locked so progress across all six strings is obvious
      if (isTuned && !btn.dataset.lockedLabel) {
        btn.dataset.lockedLabel = "1";
        btn.setAttribute("aria-label", note + " in tune");
      }
    });
  }

  function tunerLoop() {
    if (!tunerActive) return;
    analyser.getFloatTimeDomainData(tunerBuf);
    const freq = detectPitch(tunerBuf, audioCtx.sampleRate);
    renderTuner(freq);
    tunerRAF = requestAnimationFrame(tunerLoop);
  }

  async function startTuner() {
    tunerMsg.textContent = "";
    tunerMsg.className = "tuner-msg";
    try {
      // Request the mic — this is the only permission the tuner needs
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS starts the context suspended until a user gesture resumes it
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096; // more samples → steadier low-string detection
      tunerBuf = new Float32Array(analyser.fftSize);
      source.connect(analyser);

      smoothedFreq = 0;
      smoothedCents = 0;
      recentFreqs = [];
      inTuneStreak = 0;
      tunedStrings = new Set();
      tunerStringsEl.querySelectorAll(".tuner-string").forEach((btn) => {
        delete btn.dataset.lockedLabel;
        btn.classList.remove("target", "in-tune");
      });

      tunerActive = true;
      tunerToggle.textContent = "Stop tuner";
      tunerToggle.classList.add("active");
      tunerFreq.textContent = "Listening…";
      if (window.Analytics) window.Analytics.track("tuner-start");
      tunerLoop();
    } catch (err) {
      // Most common cause: user denied mic access or no mic present
      tunerMsg.textContent = "Microphone access is needed for the tuner. Please allow it and try again.";
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
    smoothedFreq = 0;
    smoothedCents = 0;
    recentFreqs = [];
    inTuneStreak = 0;
    tunedStrings = new Set();
    tunerToggle.textContent = "Start tuner";
    tunerToggle.classList.remove("active");
    tunerNote.textContent = "—";
    tunerNote.className = "tuner-note";
    tunerFreq.textContent = "Tap start & play a string";
    tunerStatus.textContent = "—";
    tunerStatus.className = "tuner-status";
    tunerNeedle.style.left = "50%";
    tunerNeedle.classList.remove("in-tune");
    tunerStringsEl.querySelectorAll(".tuner-string").forEach((btn) => {
      delete btn.dataset.lockedLabel;
      btn.classList.remove("target", "in-tune");
    });
  }

  function openTuner() {
    showView(tunerView);
    if (window.Analytics) window.Analytics.track("tuner-open");
  }

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
