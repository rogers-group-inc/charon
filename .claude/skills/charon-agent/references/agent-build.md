# Agent build, versioning and distribution

From `agent/README.md`.

## Layout

- `agent/src-tauri/` — Rust core (Tauri v2): `Cargo.toml` (`rust-version` is the MSRV pin —
  see `charon-tech-lifecycle`), `build.rs`, `tauri.conf.json`, `src/{main,client,config,posture}.rs`.
- `agent/ui/` — web GUI (vanilla JS) reusing the Charon stylesheet: `css/styles.css`,
  `css/charon.css` and `js/theme-init.js` are exact copies of the server's `public/` files
  (polaris theme system, following the OS; `tests/unit/agentUiSync.test.ts` fails on drift),
  `css/agent.css` is the agent's own layout. The version lives in three places kept in step:
  `agent/VERSION`, `agent/src-tauri/Cargo.toml` and `agent/src-tauri/tauri.conf.json`.
- `agent/VERSION` — bumped on any agent change.

## Build

The server image ships **no** Rust toolchain. Installers (MSI / NSIS / dmg / AppImage / deb) are
produced by `tauri build`:

```
cd agent && cargo tauri build      # produces platform installers
```

Icons (`src-tauri/icons/`) are expected from a CI bundle step.

**State today:** no workflow under `.github/workflows/` builds the agent yet, and CodeQL does
not yet scan Rust (`.github/workflows/codeql.yml` notes adding it once the crate has source).
TODO: populate when the agent release workflow exists.

## Distribution

Built installers are dropped under `data/agents/<version>/` with a `manifest.json`
(`{ version, files: [{ platform, arch, filename, sha256 }] }`). The Maintenance tab lists and
serves them (`src/services/agentDistService.ts`); only files named in the manifest are served —
no path traversal.
