# Archived Soraya source

Fetched on 2026-07-22 from the live return moe article demo:

- `rig.json` — `https://blog.return.moe/assets/demo/soraya/rig.json`
- `atlas.json` — `https://blog.return.moe/assets/demo/soraya/atlas.json`
- top-level `../../atlas.png` — `https://blog.return.moe/assets/demo/soraya/atlas.png`
- `fallback.png` — `https://blog.return.moe/assets/demo/soraya/fallback.png`
- `math.js`, `motion.js`, `rig-runtime.js`, and `webgl-renderer.js` — the corresponding files
  under `https://blog.return.moe/assets/js/soraya-demo/`

The SHA-256 hashes recorded by the source atlas manifest are hashes of decoded RGBA pixels, not
PNG container bytes. The imported files match them exactly:

- atlas pixels: `636e060bea6936d43f4359f93f6900f16385ac6f8509f6171ae182654bed17ac`
- fallback pixels: `b103cb2cd96e26ddfb6593669ca900941c97294d9cd6d8a403e04aeb2fa4e45d`

These files are provenance and reproducibility inputs. Lyre runtimes ignore them because they
are not listed in `manifest.json`.
