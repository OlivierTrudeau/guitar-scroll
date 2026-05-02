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
  const editBackBtn = $("#edit-back-btn");
  const saveSongBtn = $("#save-song-btn");
  const editTitle = $("#edit-title");
  const titleInput = $("#song-title-input");
  const artistInput = $("#song-artist-input");
  const capoInput = $("#song-capo-input");
  const tuningInput = $("#song-tuning-input");
  const strumInput = $("#song-strum-input");
  const bodyInput = $("#song-body-input");
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
  const proficiencyStarsEl = $("#proficiency-stars");
  const proficiencyLabel = $("#proficiency-label");
  const menuBtn = $("#menu-btn");
  const menuDropdown = $("#menu-dropdown");
  const exportBtn = $("#export-btn");
  const importBtn = $("#import-btn");
  const importFile = $("#import-file");

  let songs = [];
  let editingId = null;
  let currentSongId = null;
  let scrolling = false;
  let speed = 10;
  let scrollRAF = null;
  let editingProficiency = 0;
  let activeFilterLevel = "all";
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
    [libraryView, editView, playerView].forEach((v) => v.classList.remove("active"));
    view.classList.add("active");
    stopScroll();
  }

  // ── Library ──
  function getFilteredSongs() {
    return songs.filter((song) => {
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
    showView(editView);
    titleInput.focus();
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

    let contentHTML = "";
    if (song.strum) {
      contentHTML += `<span class="strum-pattern">Strum: ${esc(song.strum)}</span>`;
    }
    const parsed = parseBody(song.body || "");
    contentHTML += renderParsed(parsed);
    songContent.innerHTML = contentHTML;
    songContent.scrollTop = 0;

    showView(playerView);
  }

  // ── Auto-scroll ──
  function startScroll() {
    scrolling = true;
    scrollToggle.textContent = "❚❚";
    scrollToggle.classList.add("active");
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

  // ── Event Wiring ──
  addSongBtn.addEventListener("click", () => openEditor(null));
  editBackBtn.addEventListener("click", () => { showView(libraryView); renderLibrary(); });
  saveSongBtn.addEventListener("click", saveSong);
  playerBackBtn.addEventListener("click", () => { showView(libraryView); stopScroll(); });
  editCurrentBtn.addEventListener("click", () => openEditor(currentSongId));

  scrollToggle.addEventListener("click", () => { scrolling ? stopScroll() : startScroll(); });
  scrollSlower.addEventListener("click", () => { speed = Math.max(1, speed - 1); updateSpeedLabel(); });
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

  // ── Menu / Backup ──
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    menuDropdown.classList.add("hidden");
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
  mergeSongsFromRepo().then(() => renderLibrary());
  renderLibrary();
  updateSpeedLabel();

  // ── Service Worker ──
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
