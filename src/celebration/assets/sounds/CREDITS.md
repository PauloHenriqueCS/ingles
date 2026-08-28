# Celebration sound assets — source & license

Both files are **Creative Commons CC0 1.0 Universal** (public domain dedication),
free for commercial use, **no attribution required**. Author: Kenney (kenney.nl).
They were downloaded from the official Kenney packs and transcoded from the
original `.ogg` to `.mp3` (MP3 plays on iOS WKWebView / Safari, where OGG does
not; MP3 is universally supported across iOS, Android and desktop browsers).

| File | Original | Kenney pack | License | Source |
|------|----------|-------------|---------|--------|
| `activity-complete.mp3` | `confirmation_001.ogg` | Interface Sounds | CC0 1.0 | https://kenney.nl/assets/interface-sounds |
| `day-complete.mp3` | `jingles_STEEL05.ogg` (steel-drum jingle) | Music Jingles | CC0 1.0 | https://kenney.nl/assets/music-jingles |

- CC0 1.0 legal text: https://creativecommons.org/publicdomain/zero/1.0/
- Transcode: `ffmpeg -i <in>.ogg -ar 44100 -ac 2 -codec:a libmp3lame -b:a 160k <out>.mp3`
  (ffmpeg used only as a one-off build tool; it is NOT a project dependency.)

Durations: activity ≈ 0.34s, day ≈ 0.99s — within the target 300–500ms /
600–1000ms. To swap either sound, drop a replacement `.mp3` here with the same
filename and update this file.
