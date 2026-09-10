# GuitarScroll

Autoscrolling chord & lyric viewer. Lives at:
https://oliviertrudeau.github.io/guitar-scroll/

## Add a song

### In the app (easiest)

1. Tap **＋**
2. Paste an Ultimate Guitar link, e.g.
   `https://tabs.ultimate-guitar.com/tab/eminem/temporary-chords-5347992`
3. Tap **Import** — title, artist, capo, tuning, strumming, and chords/lyrics fill in
4. Tap **✓** to save

Works for free/public chord sheets. Official/pro tabs won't have extractable content.
Import uses a public page reader/proxy (the browser can't call Ultimate Guitar directly).

### From the CLI

```bash
cd ~/Desktop/Personnel/Songs/app
python3 add_song.py --url 'https://tabs.ultimate-guitar.com/tab/artist/song-chords-123' --no-push
# or paste tab text interactively:
python3 add_song.py
```

Paste mode: copy the tab from Ultimate Guitar, run the script, paste, then Ctrl+D.

## Run locally

```bash
cd ~/Desktop/Personnel/Songs/app
python3 -m http.server 8080
# open http://localhost:8080
```

## Tuner

The tuner runs entirely offline: the microphone goes through a 60–1000 Hz
band-pass and then `pitch.js`, which estimates the pitch with the McLeod Pitch
Method. `app.js` turns that stream of estimates into the readout, and picks
which string of the selected tuning you are aiming at.

`test_pitch.js` checks the detector against synthesised plucked-string signals
— realistic inharmonicity, weak or missing fundamentals, room noise, mains
hum, long decays, other capture rates — and fails if any of them drift beyond
a few cents:

```bash
node test_pitch.js
```

## Push changes

```bash
git add . && git commit -m "message" && git push
```

Because the app is hosted on GitHub Pages, every `git push` updates the live
site for everyone automatically. The one catch: the app is a PWA and its service
worker (`sw.js`) caches files, so returning visitors keep the old version until
the cache changes. Whenever you change `index.html`, `app.js`, `pitch.js`,
`style.css`, or `analytics.js`, bump `CACHE_NAME` in `sw.js` (e.g.
`guitarscroll-v12` → `guitarscroll-v13`) so everyone reliably picks up the new
files.

## Usage tracking (analytics)

The app reports anonymous usage so you can see how many people use it, whether
they keep coming back, and whether it's spreading. It uses
[PostHog](https://posthog.com/) — its free tier includes **1 million
events/month** (no credit card), which is effectively unlimited for an app
shared with friends.

### Setup — already done

This project is already wired to a PostHog project (the key lives in
`analytics.js`). Nothing to configure to start collecting data. To point at a
*different* PostHog project later, edit the two constants near the top of
`analytics.js`:
   - `POSTHOG_KEY` → your `phc_...` key (**Settings → Project → Project API Key**)
   - `POSTHOG_HOST` → `https://us.i.posthog.com` (US) or
     `https://eu.i.posthog.com` (EU)

The API key is a *public* client key — safe to ship in a static site. It can
only send events, not read your data.

### What you'll see (in PostHog)

- **Web analytics / Trends**: total visits, unique visitors, and referrers —
  great for spotting word-of-mouth (e.g. people arriving from WhatsApp links
  your friends shared).
- **Events** we send:
  - `$pageview` — app opened (captured automatically)
  - `song-open` — a song was opened (includes title, artist, proficiency)
  - `autoscroll-start` — someone played along (includes song + speed)
  - `song-practiced` — a song was practiced (scrolled past the ~5s threshold)
  - `song-add` — someone added their own song (includes library size)
  - `ug-import` — someone imported a song from an Ultimate Guitar link
- **Retention** (left sidebar → Retention): the real "user stories" view — e.g.
  "of the people who used it this week, how many came back next week." This is
  what tells daily users apart from people who drifted away after a month.
- **Persons**: each anonymous device is one person with its own timeline of
  events, so you can literally watch one (anonymous) user's journey over time.
- **Funnels**: e.g. opened app → opened a song → started autoscroll, to see
  where people drop off.

### Privacy

We use PostHog's `identified_only` mode and never call `identify()`, so no
names or emails are ever collected — each visitor is just an anonymous,
PostHog-generated id per device. That's enough for retention and user-journey
analysis without knowing who anyone is.


