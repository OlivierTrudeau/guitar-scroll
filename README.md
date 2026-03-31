# GuitarScroll

Autoscrolling chord & lyric viewer. Lives at:
https://oliviertrudeau.github.io/guitar-scroll/

## Add a song

```bash
cd ~/Desktop/Personnel/Songs/app
python3 add_song.py
```

Paste the tab content from Ultimate Guitar, press Enter, then Ctrl+D.

## Run locally

```bash
cd ~/Desktop/Personnel/Songs/app
python3 -m http.server 8080
# open http://localhost:8080
```

## Push changes

```bash
git add . && git commit -m "message" && git push
```
