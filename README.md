# Inkwell Media

Free, private photo, video and audio tools that run entirely in your browser.

Live site: https://inkwelltools.com/inkwellmedia

Files are processed on the visitor's own device and are never uploaded.

## What's here

- `inkwellmedia/`: the shared code (`media.js`, `media-shell.js`, `captions-worker.js`, `sw.js`, styles and images) plus the bundled third-party libraries in `vendor/` and `ffmpeg/`.
- One folder per tool page, for example `compress-video/`, `blur-faces/` and `passport-photo/`.

The site is plain static files. There is no build step: serve the folder with any static web server.

## Licence

Inkwell Media's own code is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).
Copyright © 2026 Adam Bey / Inkwell Tools.

The names "Inkwell", "Inkwell Tools" and "Inkwell Media" and their logos are not covered by this licence.

## Third-party software

Third-party software is used unmodified, under its own licence:

| Project | Licence | Source |
|---|---|---|
| ffmpeg.wasm (FFmpeg with x264) | GPL / LGPL | https://github.com/ffmpegwasm/ffmpeg.wasm |
| IMG.LY background-removal | AGPL-3.0 | https://github.com/imgly/background-removal-js |
| heic-to with libheif | LGPL-3.0 | https://github.com/hoppergee/heic-to |
| fflate | MIT | https://github.com/101arrowz/fflate |
| face-api with TensorFlow.js | MIT, Apache-2.0 | https://github.com/vladmandic/face-api |
| Transformers.js | Apache-2.0 | https://github.com/huggingface/transformers.js |
| Whisper speech model | MIT | https://github.com/openai/whisper |
