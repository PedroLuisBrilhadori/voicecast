# voicecast — F0 Report (runtime de-risk and impediments)

Date: 2026-09-19 · Machine: pchome-win (Win 11 26200, RTX 3050, 32GB, 1 physical monitor + 1 virtual, **scaleFactor 1.53**)

## Summary

| Item | Verdict |
|---|---|
| **Electron PoC** | ✅ **PASSED the full script** — see numbers below |
| **WebView2 PoC (Tauri)** | ❌ `getDisplayMedia` → **NotAllowedError "Permission denied"**, no picker (evidence: maintainer's screenshot; click interaction also unsuccessful) |
| Tauri setup on Windows | ⚠️ requires installing rustup + VS Build Tools (~GBs) — not installed today |
| Mic coexistence (F9 daemon + app) | ✅ OK (WASAPI shared) |
| ZCode handoff (Read of MP4) | ✅ OK with videos < 30MB |
| ASR word-timestamps (:8701) | ✅ already returns `words {w,start,end,p}` |
| Jev | ✅ confirmed: gate only (`noul`), no streaming/vision/execution |

## Electron PoC numbers (Electron 44.4.3 · Chromium 152 · Node 24)

| Metric | Value |
|---|---|
| Sources enumerated | 2 screens + 11 windows (real names: ZCode, Obsidian, VSCode, WhatsApp…) with thumbnails |
| Screen+mic recording 12s | MP4 H.264 1920x1080 ~25fps + AAC · **2.4MB** · audible audio (max −38.5dB) |
| Window+mic recording 8s | 1.0MB · audio max −19.8dB |
| mimeType chosen | `video/mp4;codecs="avc1.42E01E,mp4a.40.2"` (native MP4, as predicted) |
| Stream start latency | 0.9–1.5s |
| Global shortcuts Ctrl+F9 / Ctrl+Shift+F9 | ✅ registered |
| Transparent fullscreen overlay + rectangle | ✅ works (proof: `overlay-proof.png`); CSS × physical coords (DPI 1.53) |
| RAM (sum of processes) | **254MB idle → 566MB recording** |
| Dev size (node_modules) | 382MB (typical packaged ~200–250MB) |
| Quirks | 1921×1081 track (+1px, round the crop); rVFC doesn't count frames in a hidden renderer (measurement artifact, not of the file) |

## Cross-validations

- **ZCode Read video**: read successfully (a) a 5.8MB/30s synthetic MP4 and (b) **the real PoC recording (2.4MB)** — complete recording→agent loop.
- **30MB Read limit**: 60s synthetic at CRF23 = 43.8MB (overflows); real screen ≈ 7–12MB/min → **the handoff should point to screenshots + clips + transcript**, not the long raw session.
- **Mic coexistence**: `sounddevice` (same stack as the F9 daemon) recorded simultaneously with Electron — peak 1249, max −28.4dB. No exclusivity.
- **ffmpeg**: WSL 8.0 analyzes/processes everything via /mnt/c; the product resolves the binary like voice does (env > PATH > imageio-ffmpeg).

## Impediments and countermeasures (none blocking)

1. **Read 30MB** → handoff artifacts: screenshots (PNG), short clips (≤1–2min), transcript, and an eventual session "contact sheet" in a single PNG.
2. **fMP4 without duration** → remux `-c copy -movflags +faststart` on stop (M1 pipeline).
3. **Real DPI 1.53** → region/crop math in physical px from day 1 (tested in the overlay).
4. **Mimosa guard** blocked PoC code with `open()` of a dynamic path → in the product, literal/sanitized paths (documented fuss for M0).

## Runtime decision — FINAL: **Electron**

- **WebView2 (Tauri's engine on Windows) denied `getDisplayMedia`** on the machine's runtime 153: `NotAllowedError — Permission denied`, no picker; the user's click also unsuccessful. It's the behavior of risk #5314: capture in WebView2 doesn't come for free — it would require capture in Rust (windows-capture crate) or a `ScreenCaptureStarting` handler on the host.
- **Electron passed 100% of the script**: window/screen capture with thumbs, native avc1+AAC MP4, transparent overlay (with real DPI 1.53), global shortcuts, sub-1.5s latency, mic coexisting with the F9 daemon.
- Accepted, known costs: RAM ~254MB idle / ~566MB recording; ~250MB installed; new runtime in the workspace.
- Practical tiebreaker: Tauri would still carry installing rustup+VS Build Tools (~GBs) **before** writing the product's first line.

## Pending items

- [x] WebView2 PoC result — ❌ denied (screenshot archived in the 2026-09-19 session)
- [ ] Learning note in the vault (capturar-nota skill)
- [ ] M0: create the `voicecast` repo and bring this report to `docs/`
