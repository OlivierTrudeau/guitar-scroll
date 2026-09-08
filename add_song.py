#!/usr/bin/env python3
"""
Add a song to GuitarScroll by pasting Ultimate Guitar tab content, or from a URL.

Usage:
    python3 add_song.py                     # interactive: prompts you to paste
    python3 add_song.py --file tab.txt      # from a saved text file
    python3 add_song.py --url URL           # fetch + parse a UG tab page
    python3 add_song.py --no-push           # don't auto-push to GitHub

    Steps (paste mode):
    1. Go to the Ultimate Guitar tab page in your browser
    2. Select all the chord/lyric content (Cmd+A or just the tab area)
    3. Run: python3 add_song.py
    4. Paste the content, then press Enter, then Ctrl+D (Mac) or Ctrl+Z (Win)
    5. The script parses it, adds to songs.json, and pushes to GitHub
    6. Refresh the app on your phone

    Steps (URL mode):
    python3 add_song.py --url https://tabs.ultimate-guitar.com/tab/artist/song-chords-123
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from html import unescape

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SONGS_JSON = os.path.join(SCRIPT_DIR, "songs.json")


def format_capo(c):
    if c is None or c == 0 or c == "0" or c == "":
        return "No capo"
    try:
        n = int(c)
    except (TypeError, ValueError):
        return str(c)
    mod = n % 100
    if 10 < mod < 14:
        suf = "th"
    else:
        suf = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf} fret"


def decode_strum_code(code):
    n = int(code)
    hundreds = n // 100
    kind = n % 100
    if hundreds == 2:
        return "-"
    if kind == 1:
        return "D"
    if kind == 2:
        return "U"
    if kind == 3:
        return "X"
    return "?"


def format_strumming(strummings):
    if not strummings:
        return ""
    pat = strummings[0]
    strokes = []
    for m in pat.get("measures") or []:
        code = m["measure"] if isinstance(m, dict) else m
        strokes.append(decode_strum_code(code))
    text = " ".join(strokes)
    part = (pat.get("part") or "").strip()
    bpm = pat.get("bpm")
    if part:
        text = f"{part}: {text}"
    if bpm:
        text += f" ({bpm} bpm)"
    return text


def clean_ug_body(body):
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    body = re.sub(r"\[/?tab\]", "", body, flags=re.I)
    body = re.sub(r"\[ch\](.*?)\[/ch\]", r"\1", body, flags=re.I)
    return body.strip()


def parse_ug_html(html_text):
    match = re.search(
        r'<div[^>]*class="[^"]*js-store[^"]*"[^>]*data-content="([^"]+)"',
        html_text,
        re.I,
    )
    if not match:
        raise ValueError("Could not find tab data (js-store) on that page.")
    data = json.loads(unescape(match.group(1)))
    page = data["store"]["page"]["data"]
    tab = page["tab"]
    tv = page.get("tab_view") or {}
    meta = tv.get("meta") or {}
    content = ((tv.get("wiki_tab") or {}).get("content")) or ""
    if not content.strip():
        raise ValueError(
            "No free chord sheet on that link (official/pro tabs aren't supported)."
        )
    tuning = meta.get("tuning") or {}
    title = tab.get("song_name") or "Untitled"
    song_id = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")
    return {
        "id": song_id,
        "title": title,
        "artist": tab.get("artist_name") or "",
        "capo": format_capo(meta.get("capo")),
        "tuning": tuning.get("value") or tuning.get("name") or "",
        "strum": format_strumming(tv.get("strummings") or []),
        "body": clean_ug_body(content),
    }


def fetch_ug_url(url):
    if not re.match(r"^https?://(tabs\.)?ultimate-guitar\.com/tab/", url, re.I):
        raise ValueError("URL must be an Ultimate Guitar tab link.")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def parse_ug_paste(text):
    lines = text.strip().split("\n")

    title = ""
    artist = ""
    capo = ""
    tuning = ""
    strum = ""
    body_lines = []
    found_tab_start = False

    for i, line in enumerate(lines):
        stripped = line.strip()

        if not title and not found_tab_start:
            chords_match = re.match(r"^(.+?)\s+Chords?\s*$", stripped, re.I)
            if chords_match:
                title = chords_match.group(1).strip()
                continue

        if not artist and not found_tab_start:
            artist_match = re.match(r"^by\s+(.+)", stripped, re.I)
            if artist_match:
                artist = artist_match.group(1).strip()
                continue

        if re.match(r"^Tuning:", stripped, re.I):
            val = re.sub(r"^Tuning:\s*", "", stripped, flags=re.I).strip()
            capo_in_tuning = re.search(r"\s*Capo:?\s*(.+)", val, re.I)
            if capo_in_tuning:
                capo = capo_in_tuning.group(1).strip()
                val = val[: capo_in_tuning.start()].strip()
            tuning = val
            continue

        if re.match(r"^Capo:", stripped, re.I) or re.match(r"^Capo\s+\d", stripped, re.I):
            capo = re.sub(r"^Capo:?\s*", "", stripped, flags=re.I).strip()
            continue

        if re.match(r"^Strumming", stripped, re.I):
            strum = re.sub(r"^Strumming[:\s]*", "", stripped, flags=re.I).strip()
            continue

        if re.match(r"^\[", stripped) or found_tab_start:
            found_tab_start = True
            body_lines.append(line.rstrip())

        elif not found_tab_start and is_chord_line(stripped) and stripped:
            found_tab_start = True
            body_lines.append(line.rstrip())

    while body_lines and not body_lines[0].strip():
        body_lines.pop(0)
    while body_lines and not body_lines[-1].strip():
        body_lines.pop()

    body = "\n".join(body_lines)
    body = re.sub(r"\[tab\]|\[/tab\]|\[ch\]|\[/ch\]", "", body)

    if not title:
        title = input("Song title: ").strip() or "Untitled"
    if not artist:
        artist = input("Artist: ").strip()

    song_id = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")

    return {
        "id": song_id,
        "title": title,
        "artist": artist,
        "capo": capo,
        "tuning": tuning,
        "strum": strum,
        "body": body,
    }


CHORD_RE = re.compile(
    r"^[A-G][#b]?(m|maj|min|dim|aug|sus|add|M)?[0-9]?[0-9]?(/[A-G][#b]?)?(\*)?$"
)


def is_chord_line(line):
    if not line.strip():
        return False
    tokens = line.strip().split()
    if not tokens:
        return False
    chord_count = sum(1 for t in tokens if CHORD_RE.match(t.strip("()")))
    return chord_count / len(tokens) >= 0.5


def load_songs():
    if os.path.exists(SONGS_JSON):
        with open(SONGS_JSON, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_songs(songs):
    with open(SONGS_JSON, "w", encoding="utf-8") as f:
        json.dump(songs, f, ensure_ascii=False, indent=2)


def git_push(song_title):
    subprocess.run(["git", "add", "songs.json"], cwd=SCRIPT_DIR, check=True)
    subprocess.run(
        ["git", "commit", "-m", f"Add song: {song_title}"],
        cwd=SCRIPT_DIR,
        check=True,
    )
    subprocess.run(["git", "push"], cwd=SCRIPT_DIR, check=True)


def main():
    no_push = "--no-push" in sys.argv
    from_file = None
    from_url = None
    if "--file" in sys.argv:
        idx = sys.argv.index("--file")
        if idx + 1 < len(sys.argv):
            from_file = sys.argv[idx + 1]
    if "--url" in sys.argv:
        idx = sys.argv.index("--url")
        if idx + 1 < len(sys.argv):
            from_url = sys.argv[idx + 1]

    if from_url:
        print(f"Fetching {from_url} …")
        html_text = fetch_ug_url(from_url)
        song = parse_ug_html(html_text)
    elif from_file:
        with open(from_file, "r", encoding="utf-8") as f:
            text = f.read()
        if not text.strip():
            print("No content provided.")
            sys.exit(1)
        song = parse_ug_paste(text)
    else:
        print("Paste the tab content from Ultimate Guitar (Ctrl+D when done):\n")
        text = sys.stdin.read()
        if not text.strip():
            print("No content provided.")
            sys.exit(1)
        song = parse_ug_paste(text)

    print(f"\n  Title:  {song['title']}")
    print(f"  Artist: {song['artist']}")
    print(f"  Capo:   {song['capo'] or 'none'}")
    print(f"  Tuning: {song['tuning'] or 'standard'}")
    print(f"  Strum:  {song.get('strum') or 'none'}")
    print(f"  Body:   {len(song['body'].split(chr(10)))} lines")

    songs = load_songs()
    existing = next((s for s in songs if s["id"] == song["id"]), None)
    if existing:
        print(f"\nSong '{song['title']}' already exists — updating it.")
        existing.update(song)
    else:
        songs.append(song)

    save_songs(songs)
    print(f"\nSaved to songs.json ({len(songs)} songs total)")

    if not no_push:
        print("Pushing to GitHub...")
        git_push(song["title"])
        print("Done! Refresh the app on your phone to see the new song.")
    else:
        print(
            'Skipped push. Run \'git add . && git commit -m "add song" && git push\' when ready.'
        )


if __name__ == "__main__":
    main()
