# Frameforge

Parse every frame of a video. Drop a file, paste a video/URL, then scroll, scrub, or step through frames.

Single Bun process — no Vite. React UI is bundled via HTML import in `Bun.serve`.

## Requirements

- [Bun](https://bun.sh) 1.2+ (HTML imports / fullstack)
- [ffmpeg](https://ffmpeg.org) and `ffprobe` on your `PATH`

## Run

```bash
bun install
bun run dev
```

Open http://localhost:3456

## Usage

1. **File** — drop a video or click _Choose file_
2. **URL** — paste a direct video link (or paste anywhere with ⌘V / Ctrl+V)
3. **Sample** — extract every frame, or every Nth for long clips
4. Browse with filmstrip, scrubber, **Prev/Next**, or keys: `←` `→` / `K` `J` / `Space`
5. **Download frame** saves the selected JPEG

## Lint / format

[`eslint-config-mahir`](https://github.com/imranbarbhuiya/eslint-config-mahir) react preset + Prettier (same as `npx eslint-config-mahir -p react --prettier -y`):

```bash
bun run lint
bun run format
```

## Notes

- Direct media URLs work best (e.g. `.mp4`). Sites that only embed players need a real file URL.
- Long videos at full frame rate can produce thousands of frames and use disk under `data/`.
