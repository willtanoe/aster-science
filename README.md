# aster-science

A local, self-contained build of **Claude Science 0.1.72** that runs without a
Claude account and talks to any **OpenAI-compatible** `/chat/completions`
endpoint.

Two pieces make that work:

1. `bin/aster-science.exe` — the upstream release binary with a small set of
   same-length byte patches in its embedded JavaScript bundle (BYOK credential,
   web-UI auth gate, display brand).
2. `proxy/aster-proxy.mjs` — a dependency-free Node server that speaks the
   Anthropic Messages API to the app and translates every call to OpenAI Chat
   Completions.

Everything the app downloads or stores stays inside this folder
(`claude-science-data/`). Nothing is written to `%USERPROFILE%\.claude-science`.

---

## 1. Requirements

| Item | Notes |
|---|---|
| Windows x64 | The upstream binary is a Windows PE32+ executable |
| Node.js 18+ | Launcher, proxy and all patch tools; Node 24 tested |
| `bin/Claude-Science-0.1.72.exe` | Upstream release, only needed for the first install |
| PowerShell | Used by the launcher for the proxy health probe and by `stop.cmd` |

The repository intentionally does **not** contain executables, runtime state or
credentials.

---

## 2. Quick start

```bat
:: 1. put the upstream release here:
::    bin\Claude-Science-0.1.72.exe

:: 2. patch the binary and record your endpoint
install.cmd

:: 3. run
aster-science.cmd serve
```

`aster-science.cmd serve` starts the proxy (if not already listening), then the
daemon, and prints a single-use login link. The UI opens without a Claude
sign-in.

Other commands:

```bat
aster-science.cmd serve --no-browser          :: start without opening a browser
aster-science.cmd serve --port 8010           :: custom UI port (proxy stays 8787)
aster-science.cmd status                      :: daemon status as JSON
aster-science.cmd url                         :: fresh single-use login link
aster-science.cmd logs --tail                 :: follow daemon logs
aster-science.cmd stop                        :: stop the daemon
stop.cmd                                      :: stop daemon and proxy
```

The launcher always runs from its own directory (`cd /d "%~dp0"`), so it can be
invoked from any shell or a shortcut.

---

## 3. What the installer does

`install.cmd` is idempotent and performs, in order:

1. checks that `node` is on `PATH`;
2. creates `config.toml` with absolute paths for this machine
   (`tools/make-config.mjs`) if it does not exist;
3. patches `bin\Claude-Science-0.1.72.exe` → `bin\aster-science.exe`
   (`tools/patch-aster-science.mjs`);
4. replaces the seven `RT_ICON` resources in that executable
   (`tools/patch-icon.mjs`, using `assets/aster.ico`);
5. prompts for the OpenAI-compatible base URL, API key, model and optional model
   map, and writes them to `env.local.cmd`.

Nothing is patched twice: step 3/4 are skipped when `bin\aster-science.exe`
already exists. Delete `bin\aster-science.exe` and re-run `install.cmd` to
rebuild it from the upstream binary.

### Manual install

```bat
node tools\make-config.mjs
node tools\patch-aster-science.mjs bin\Claude-Science-0.1.72.exe bin\aster-science.exe
node tools\patch-icon.mjs bin\aster-science.exe assets
node tools\build-ico.mjs
```

Then create `env.local.cmd` yourself (see below).

---

## 4. Environment

`env.local.cmd` is written by the installer, sourced by the launcher and by
`proxy/run-proxy.cmd`, and is **gitignored**. Values can also be set as normal
user environment variables; the file wins because it is `call`ed first.

A commented template lives in `env.local.cmd.example` — copy it to
`env.local.cmd` for a manual setup.

| Variable | Default | Meaning |
|---|---|---|
| `ASTER_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Upstream base URL; `/chat/completions` and `/models` are appended |
| `ASTER_OPENAI_API_KEY` | — (required) | Upstream key; sent as `Authorization: Bearer …` |
| `ASTER_OPENAI_MODEL` | `gpt-4o` | Upstream model used for aliases without an explicit mapping |
| `ASTER_MODEL_MAP` | — | JSON object mapping app model ids to upstream model ids |
| `ASTER_PROXY_PORT` | `8787` | Local proxy port |
| `ASTER_PROXY_HOST` | `127.0.0.1` | Local proxy bind address |

Example `env.local.cmd`:

```bat
@echo off
set "ASTER_OPENAI_BASE_URL=https://api.openai.com/v1"
set "ASTER_OPENAI_API_KEY=sk-..."
set "ASTER_OPENAI_MODEL=gpt-4o"
set "ASTER_MODEL_MAP={"claude-opus-5":"gpt-4o","claude-sonnet-4-6":"gpt-4o-mini","claude-haiku-4-5":"gpt-4o-mini"}"
```

The app itself receives:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:<ASTER_PROXY_PORT>
ANTHROPIC_API_KEY=sk-ant-aster        (placeholder; the proxy ignores it)
```

The placeholder exists because the patched credential resolver returns
`process.env.ANTHROPIC_API_KEY`; any non-empty value is enough.

---

## 5. Configuration (`config.toml`)

`config.toml` is generated per machine and gitignored. `tools/make-config.mjs`
writes absolute paths so every consumer resolves them identically regardless of
its working directory (kernels and MCP servers do run elsewhere):

```toml
data_dir = '<repo>/claude-science-data'

[paths]
auth_dir = '<repo>/claude-science-data/auth'
conda_home = '<repo>/claude-science-data/conda'
venvs_base = '<repo>/claude-science-data/venvs'
```

| Key | Why it is pinned |
|---|---|
| `data_dir` | Database, artifacts, workspaces, logs, runtime assets, electron engine |
| `auth_dir` | Encryption keys, DPAPI copies, trusted-folder registry (`here-instances.json`) |
| `conda_home` | micromamba binary, package cache, conda envs, pip/npm caches |
| `venvs_base` | Path-based Python venvs (upstream default is `/tmp/operon-venvs`) |

All other roots (artifacts, workspaces, staging, tool-results,
compaction-history, r-libs, runtime, electron) already default under
`data_dir`.

Relative paths are accepted by the app but are resolved against the current
working directory at each use, which breaks for processes that `cd` elsewhere;
that is why the generator writes absolute paths.

The daemon is always started with `--here`, which makes
`<cwd>/claude-science-data` the instance data dir and keeps it a separate
instance from the global `%USERPROFILE%\.claude-science`.

### Moving the folder

Move the whole directory, delete nothing, then:

```bat
node tools\make-config.mjs --force
aster-science.cmd serve
```

The data folder keeps its name (`claude-science-data`) because `--here`
registers instances by that name. If you rename it, use `--data-dir` instead;
the app refuses a `--data-dir` whose basename is `claude-science-data` without
`--here`.

---

## 6. Binary patches

`tools/patch-aster-science.mjs` edits the embedded JavaScript source inside the
Bun-compiled executable. Every edit is **the same byte length** as the text it
replaces, so no offset, table or embedded-module size changes.

| Patch | Original | Replacement | Purpose |
|---|---|---|---|
| `brand-display` | `Claude Science` | `Aster  Science` | UI/help/messages brand. Two spaces preserve length; HTML collapses them |
| `brand-cli-detect` | `t==="claude-science"` | `t==="aster-science "` | Makes the known-basename check miss (Bun rewrites argv0 to the embedded name) |
| `brand-cli-name` | `return"claude-science"})()` | `return"aster-science" })()` | CLI name fallback: `--version`, `--help`, console prefix |
| `byok-gate` | `if(!t)throw new Lw("This build requires …")` | `if(0 )throw …` | Accepts a BYOK key without an OAuth token |
| `status-authenticated` | `if(!c)return{authenticated:!1,…}` | `if(!c)return{authenticated:!0,…}` | UI does not force the Claude sign-in screen; account fields stay `null` |
| `env-credential` | `throw Error("No credentials available …")` | `return{api_key:process.env.ANTHROPIC_API_KEY\|\|"sk-ant-aster",auth_token:null}` | `CredentialResolver.resolve()` falls back to the environment credential |

The tool refuses to write when a pattern is missing, appears more than once
(for single-occurrence patches), or when a replacement would change the length.
It prints every file offset and the output SHA-256.

Verification:

```bat
bin\aster-science.exe --version
:: aster-science 0.1.72 (release, public)

bin\aster-science.exe --help
:: aster-science — run Claude on your data, locally, in your browser
```

### Upstream version changes

The patches are written against **0.1.72**. Another build will almost certainly
have different minified text; the tool will fail with `expected … found 0` and
must be re-derived against the new bundle. Do not force it by relaxing the
checks without re-reading the new source.

---

## 7. Icon pipeline

```
assets/source/aster.svg  (1024×1024)
        │  rasterize (Chromium canvas or any SVG rasterizer)
        ▼
assets/icon-{16,24,32,48,64,128,256}.png   indexed PNG, alpha + palette
        │  tools/build-ico.mjs
        ▼
assets/aster.ico          PNG-compressed ICO, seven frames
        │  tools/patch-icon.mjs
        ▼
bin/aster-science.exe     seven RT_ICON payloads + RT_GROUP_ICON sizes
```

The original icon slots are `570, 964, 1377, 2206, 2858, 5513, 10597` bytes for
`16, 24, 32, 48, 64, 128, 256` px. The PNGs in this repository are indexed-color
encodes sized to fit those budgets:

| Size | PNG | Slot |
|---|---|---|
| 16 | 468 B | 570 B |
| 24 | 729 B | 964 B |
| 32 | 1140 B | 1377 B |
| 48 | 1991 B | 2206 B |
| 64 | 2619 B | 2858 B |
| 128 | 4285 B | 5513 B |
| 256 | 8112 B | 10597 B |

`patch-icon.mjs` overwrites each payload in place, zero-fills the remainder,
updates `IMAGE_RESOURCE_DATA_ENTRY.Size`, and updates each `RT_GROUP_ICON`
`dwBytesInRes`. It never resizes or shifts the resource section, so RVAs and
section headers stay valid. A payload larger than its slot is refused.

The rasterization step is not part of the repository (it needs an SVG
rasterizer). If you replace `aster.svg`, regenerate the seven PNGs with the same
sizes, keep each within its budget, then run:

```bat
node tools\build-ico.mjs
node tools\patch-icon.mjs bin\aster-science.exe assets
```

`assets/source/aster.ico` is the original 32 px icon that shipped with the
design; it is kept as a reference, not used by the patcher.

---

## 8. Translation proxy

`proxy/aster-proxy.mjs` is a single-file Node HTTP server with no
dependencies. It is started on demand by the launcher and writes its console to
`claude-science-data/logs/aster-proxy.log`.

| Endpoint | Behaviour |
|---|---|
| `GET /health` | `{ok, upstream, models, default_model}`; used by the launcher |
| `GET /v1/models` | Serves the configured aliases, so the app keeps its model-specific behaviour |
| `POST /v1/messages` | Anthropic Messages → OpenAI Chat Completions (streaming and non-streaming) |
| `POST /v1/messages/count_tokens` | Character-based estimate (`len/4`) |

Default aliases: `claude-opus-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
Override with `ASTER_MODEL_MAP`; unmapped aliases use `ASTER_OPENAI_MODEL`.

### Translation coverage

- system prompt (string or text blocks) → `system` message
- user text and images (base64 / URL) → text parts and `image_url`
- assistant text and `tool_use` → `content` and `tool_calls`
- `tool_result` → `tool` messages, emitted before any user content
- tools: `input_schema` ↔ `function.parameters`
- `tool_choice`: `auto`/`any`/`none`/`tool` ↔ `auto`/`required`/`none`/function
- `max_tokens`, `temperature`, `top_p`, `stop_sequences`
- streaming SSE → Anthropic `message_start` / `content_block_*` /
  `message_delta` / `message_stop`, including `input_json_delta` for tool calls
- finish reasons: `tool_calls` → `tool_use`, `length` → `max_tokens`,
  `content_filter` → `refusal`
- usage: `prompt_tokens`/`completion_tokens` → `input_tokens`/`output_tokens`

### Known limits

- images inside `tool_result` become `[image omitted: …]` text;
- `thinking` / reasoning deltas are dropped;
- prompt-cache counters are reported as zero;
- only the first upstream choice is used;
- `count_tokens` is an estimate, not the upstream tokenizer;
- the proxy does not validate the incoming placeholder key and binds to
  `127.0.0.1` by default — do not change `ASTER_PROXY_HOST` to a public
  interface without putting authentication in front of it.

Upstream errors are relayed with their status and body as an Anthropic-style
`{"type":"error", …}` payload.

---

## 9. Layout

```
aster-science.cmd              launcher: config bootstrap, proxy, daemon
stop.cmd                       stop daemon + proxy
install.cmd                    patch binary + icon, write env.local.cmd
config.toml                    generated per-machine paths (gitignored)
bin/                           upstream and patched executables (gitignored)
claude-science-data/           DB, conda, electron, skills, logs (gitignored)
proxy/aster-proxy.mjs          Anthropic → OpenAI translator
proxy/run-proxy.cmd            proxy console wrapper (logs to file)
tools/make-config.mjs          writes absolute config.toml
tools/patch-aster-science.mjs  JS bundle patches
tools/patch-icon.mjs           in-place PE icon replacement
tools/build-ico.mjs            packs PNGs into assets/aster.ico
assets/source/aster.svg        logo source
assets/source/aster.png        logo raster source
assets/source/aster.ico        original 32 px icon
assets/icon-*.png              seven rasterized sizes
assets/aster.ico               generated multi-size ICO
env.local.cmd                  installer-provided env (gitignored)
```

---

## 10. Troubleshooting

**`node` not found** — install Node 18+ and reopen the terminal so `PATH` is
refreshed.

**`[aster-science] WARNING: proxy not answering on …`** — the proxy failed to
start. Check `claude-science-data/logs/aster-proxy.log`; the usual causes are a
port conflict (`ASTER_PROXY_PORT`) or an invalid `ASTER_MODEL_MAP` JSON.

**Port 8000 already in use** — `aster-science.cmd serve --port 8010`. The proxy
port is independent.

**`bin\aster-science.exe` is locked** — the daemon is running. `stop.cmd`, then
re-run the patcher or installer.

**UI shows the Claude sign-in screen** — the binary is unpatched or was patched
with a tool that only applied the BYOK gate. Re-run
`tools\patch-aster-science.mjs`; `/api/auth/status` must report
`"authenticated":true`.

**Model list empty / chat returns 500** — the proxy cannot reach the upstream
or the key is missing. `curl http://127.0.0.1:8787/health` and check the proxy
log.

**`--here refused` or `trusted data folders`** — the data folder is registered
per auth dir. Do not move `claude-science-data` between auth dirs; regenerate
`config.toml` and start once with the same `--here` path.

**Windows sandbox elevation** — `cmd`/batch cells and in-cell git need a
one-time administrator approval; run `claude-science sandbox setup` from a
desktop session. Python/R cells work without it.

**Icon still shows the old logo** — Explorer caches icons. The PE resources are
patched (verify with an icon extractor); sign out/in or refresh the icon cache.

---

## 11. Verification recipes

```bat
:: CLI brand and version
bin\aster-science.exe --version
bin\aster-science.exe --help

:: proxy is alive and lists aliases
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models

:: translated chat (non-streaming)
curl -s -X POST http://127.0.0.1:8787/v1/messages ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"claude-opus-5\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"

:: daemon state (data dir, engine pin, auth)
aster-science.cmd status
```

The daemon caches the last good model list in
`claude-science-data/models-last-good.json`; an entry keyed by the proxy URL
proves the app reached the proxy.

---

## 12. Intentionally unchanged internals

These stay as upstream because other logic depends on them:

- `claude-science-data` (the `--here` folder name and the instance marker),
- `.claude-science` default paths and `config.toml` fallback,
- OAuth/update URLs, package names and the `claude-science.exe` pid-guard
  string,
- some secondary display strings (the sandbox subsystem's `[claude-science]`
  prefix, prose mentioning "Claude").

The binary is the upstream vendor's proprietary software. Patch a copy you are
entitled to use; this repository contains only patch tooling and original
assets.
