# Screen Capture Benchmark

## Run

```bash
cd /Users/Working/9remote
node benchmark/screenCapture.js
```

## Output

Images saved to `benchmark/output/` for visual inspection.

## Libraries tested

| Library | Type | Notes |
|---------|------|-------|
| `@hurdlegroup/robotjs` | C++ N-API | Current implementation, raw BGRA |
| `node-screenshots` | Rust (XCap) N-API | Zero-dep, built-in JPEG/PNG encode |
| `screenshot-desktop` | Spawn native tools | screencapture (mac), PowerShell (win) |

## Encoders tested

| Encoder | Notes |
|---------|-------|
| `sharp` JPEG/WebP/PNG | libvips (C), current implementation |
| `@julusian/jpeg-turbo` | libjpeg-turbo (C), SIMD accelerated |
| `@napi-rs/image` | Rust-based, fast WebP/AVIF |
