# aster-science (macOS / arm64)

A local, self-contained build of **Claude Science** that runs without a
Claude account and talks to any **OpenAI-compatible** `/chat/completions`
endpoint.

This is the macOS port of the Windows build. Two pieces make it work:

1. `bin/claude-science` — the upstream daemon from the DMG with a small set of
   same-length byte patches in its embedded JavaScript bundle (BYOK credential,
   web-UI auth gate, display brand, sign-in logo), re-signed ad-hoc so macOS
   runs it.
2. `proxy/aster-proxy.mjs` — a dependency-free Node server that speaks the
   Anthropic Messages API to the app and translates every call to OpenAI Chat
   Completions.

Everything the app downloads or stores stays inside this folder
(`claude-science-data/`). Nothing is written to `~/.claude-science`.

> The upstream daemon file keeps its original name (`claude-science`) on
> purpose: the daemon's own lockfile guard recognises that basename and `stop`
> / wedged-daemon recovery refuse to signal it otherwise. The CLI and UI still
> say *aster-science* / *Aster Science* because the byte patches rename the
> display strings.

---

## 1. Requirements

| Item | Notes |
| --- | --- |
| Apple Silicon (arm64) | The upstream daemon is a thin arm64 Mach-O |
| macOS 13+ | The daemon refuses to start on older releases |
| Node.js 18+ | Launcher, proxy and all patch tools; Node 24 tested |
| `source/Claude-Science-<version>.dmg` | Upstream release; the installer picks the newest match |
| `hdiutil`, `codesign`, `sips`, `iconutil` | Part of macOS |

The repository intentionally does **not** contain executables, runtime state,
credentials or the DMG.

---

## 2. Quick start

```
# 1. put the upstream release here:
#    source/Claude-Science-<version>.dmg

# 2. patch the daemon, record your endpoint, build the Dock app
./install.sh

# 3. run
./aster-science.sh serve          # or double-click "Aster Science.app"
```

`serve` starts the proxy (if not already listening), starts the daemon and
prints a single-use login link (it also opens your browser). The UI opens
without a Claude sign-in.

Other commands:

```
./aster-science.sh serve --no-browser        # start without opening a browser
./aster-science.sh serve --port 8010         # custom UI port (proxy stays 8787)
./aster-science.sh serve --detached          # run the daemon in the background
./aster-science.sh status                    # daemon status as JSON
./aster-science.sh url                       # fresh single-use login link
./aster-science.sh logs --tail               # follow daemon logs
./aster-science.sh stop                      # stop the daemon
./stop.sh                                    # stop daemon and proxy
```

The launcher always runs from its own directory, so it can be invoked from any
shell or a shortcut.

---

## 3. What the installer does

`install.sh` is idempotent and performs, in order:

1. checks that `node` is on `PATH`;
2. creates `config.toml` with absolute paths for this checkout
   (`tools/make-config.mjs`) if it does not exist; on macOS it also refuses a
   data dir outside `$HOME` or inside the system temp folder, because the
   daemon refuses those;
3. mounts the newest `source/*.dmg` read-only, copies the daemon out as
   `bin/Claude-Science-<version>`, patches it into `bin/claude-science`, and
   re-signs it ad-hoc with the upstream entitlements
   (`tools/patch-aster-science.mjs`); an existing output is rebuilt only when
   the upstream DMG is newer;
4. builds `assets/aster.icns` (`tools/build-icns.sh`);
5. prompts for the OpenAI-compatible base URL, API key, model and optional
   model map, and writes them to `env.local.sh`;
6. builds `Aster Science.app` (`tools/make-app.sh`).

Prompts can be skipped for scripted installs:

```
./install.sh <base_url> <api_key> [model] [model_map]
./install.sh https://api.openai.com/v1 sk-... gpt-4o @map.json
```

`model_map` is inline JSON or `@path/to/map.json`. Inline JSON is fragile when
an argument passes through another shell's quoting; `@file` is the reliable
form and is validated before anything is written:

```json
{
  "claude-opus-5": "gpt-4o",
  "claude-sonnet-4-6": { "model": "deepseek-chat", "base_url": "https://api.deepseek.com/v1", "api_key": "sk-..." }
}
```

Omitted arguments still prompt; an omitted model defaults to `gpt-4o`.

Nothing is patched twice: step 3 is skipped when `bin/claude-science` already
exists and is newer than the DMG. Delete it and re-run `install.sh` to rebuild
it from the upstream binary.

### Manual install

```
node tools/make-config.mjs
node tools/patch-aster-science.mjs source/Claude-Science-<version>.dmg
node tools/build-icns.sh
node tools/write-env.mjs <base_url> <api_key> [model] [map]
tools/make-app.sh
```

---

## 4. Environment

`env.local.sh` is written by the installer, sourced by the launcher and by
`proxy/run-proxy.sh`, and is **gitignored**. Values can also be set as normal
environment variables; the file wins because it is sourced first.

A commented template lives in `env.local.sh.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ASTER_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Upstream base URL; `/chat/completions` and `/models` are appended |
| `ASTER_OPENAI_API_KEY` | — (required) | Upstream key; sent as `Authorization: Bearer …` |
| `ASTER_OPENAI_MODEL` | `gpt-4o` | Upstream model used for aliases without an explicit mapping |
| `ASTER_MODEL_MAP` | — | JSON route map: `{"<alias>":"<model>"}` or `{"<alias>":{"model","base_url?","api_key?"}}`. Non-empty keys become the advertised aliases |
| `ASTER_PROXY_PORT` | `8787` | Local proxy port |
| `ASTER_PROXY_HOST` | `127.0.0.1` | Local proxy bind address |

The app itself receives:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:<ASTER_PROXY_PORT>
ANTHROPIC_API_KEY=sk-ant-aster        (placeholder; the proxy ignores it)
```

The placeholder exists because the patched credential resolver returns
`process.env.ANTHROPIC_API_KEY`; any non-empty value is enough.

### Model routing (aliases → routes)

The app never sends an upstream model name. It sends an **alias** such as
`claude-opus-5`. The proxy resolves each alias to a **route**:

```
route = { model: <upstream model id>, base: <upstream base URL>, apiKey: <upstream key> }
```

Default aliases (used when `ASTER_MODEL_MAP` is unset): `claude-opus-5`,
`claude-sonnet-4-6`, `claude-haiku-4-5`.

Resolution order, exactly:

1. **Alias has a string entry** — `"claude-opus-5": "gpt-4o"` → model `gpt-4o`
   on `ASTER_OPENAI_BASE_URL` with `ASTER_OPENAI_API_KEY`.
2. **Alias has an object entry** — `"claude-sonnet-4-6": {"model":"deepseek-chat","base_url":"https://api.deepseek.com/v1","api_key":"sk-…"}`
   → that model on that base URL with that key. `base_url` and `api_key` are
   optional and fall back to the default values.
3. **Alias has no entry** — fallback to `ASTER_OPENAI_MODEL` on
   `ASTER_OPENAI_BASE_URL` with `ASTER_OPENAI_API_KEY`. This applies even when
   the alias is not advertised by `/v1/models`, so internal calls for
   `claude-sonnet-4-6` still work with a one-entry map.

Advertised aliases: if `ASTER_MODEL_MAP` has at least one valid entry, its keys
are exactly what `/v1/models` exposes (that is the model picker in the UI).
Otherwise the three defaults are exposed.

Invalid entries are reported on the proxy log and ignored; invalid JSON is
ignored as a whole. Alias keys are case-sensitive.

#### Scenario A — one upstream model for all aliases

```
export ASTER_OPENAI_BASE_URL='https://api.openai.com/v1'
export ASTER_OPENAI_API_KEY='sk-...'
export ASTER_OPENAI_MODEL='gpt-4o'
# no ASTER_MODEL_MAP
```

| Alias requested | Upstream model | Endpoint |
| --- | --- | --- |
| `claude-opus-5` | `gpt-4o` | default |
| `claude-sonnet-4-6` | `gpt-4o` | default |
| `claude-haiku-4-5` | `gpt-4o` | default |
| anything else | `gpt-4o` | default |

#### Scenario B — three aliases, three models, one endpoint

```
export ASTER_MODEL_MAP='{"claude-opus-5":"gpt-4o","claude-sonnet-4-6":"gpt-4o-mini","claude-haiku-4-5":"o4-mini"}'
```

| Alias requested | Upstream model | Endpoint |
| --- | --- | --- |
| `claude-opus-5` | `gpt-4o` | default |
| `claude-sonnet-4-6` | `gpt-4o-mini` | default |
| `claude-haiku-4-5` | `o4-mini` | default |

#### Scenario C — three aliases across different providers

```
export ASTER_MODEL_MAP='{"claude-opus-5":"gpt-4o","claude-sonnet-4-6":{"model":"deepseek-chat","base_url":"https://api.deepseek.com/v1","api_key":"sk-deepseek"},"claude-haiku-4-5":{"model":"qwen-plus","base_url":"https://dashscope.aliyuncs.com/compatible-mode/v1","api_key":"sk-qwen"}}'
```

| Alias requested | Upstream model | Endpoint | Key |
| --- | --- | --- | --- |
| `claude-opus-5` | `gpt-4o` | default | default |
| `claude-sonnet-4-6` | `deepseek-chat` | `api.deepseek.com` | `sk-deepseek` |
| `claude-haiku-4-5` | `qwen-plus` | `dashscope.aliyuncs.com` | `sk-qwen` |
| anything else | `ASTER_OPENAI_MODEL` | default | default |

Each chat is logged with the resolution, for example
`chat claude-sonnet-4-6 → deepseek-chat @ api.deepseek.com`.

#### Scenario D — partial map

```
export ASTER_MODEL_MAP='{"claude-opus-5":"gpt-4o"}'
```

Only `claude-opus-5` is advertised. If the app requests `claude-sonnet-4-6`
internally, it resolves through the fallback (`ASTER_OPENAI_MODEL` on the
default endpoint) and still succeeds.

#### Verifying routes

```
curl http://127.0.0.1:8787/health
# routes: [{alias, model, base, has_key}, ...], fallback: {...}

curl http://127.0.0.1:8787/v1/models
# display_name: "claude-sonnet-4-6 → deepseek-chat @ api.deepseek.com"

curl -s -X POST http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

---

## 5. Configuration (`config.toml`)

`config.toml` is generated per machine and gitignored. `tools/make-config.mjs`
writes absolute paths so every consumer resolves them identically regardless of
its working directory (kernels and MCP servers do run elsewhere):

```
data_dir = '<repo>/claude-science-data'

[paths]
auth_dir = '<repo>/claude-science-data/auth'
conda_home = '<repo>/claude-science-data/conda'
venvs_base = '<repo>/claude-science-data/venvs'
```

| Key | Why it is pinned |
| --- | --- |
| `data_dir` | Database, artifacts, workspaces, logs, runtime assets |
| `auth_dir` | Encryption keys, Keychain fallback, trusted-folder registry (`here-instances.json`) |
| `conda_home` | micromamba binary, package cache, conda envs, pip/npm caches |
| `venvs_base` | Path-based Python venvs |

The launcher always passes `--here`, which makes `<cwd>/claude-science-data` the
instance data dir and keeps it separate from the global `~/.claude-science`.

### Moving the folder

Move the whole directory, delete nothing, then:

```
node tools/make-config.mjs --force
./aster-science.sh serve
```

The data folder keeps its name (`claude-science-data`) because `--here`
registers instances by that name. Keep the folder under your home directory;
the macOS daemon refuses anything else.

---

## 6. Binary patches

`tools/patch-aster-science.mjs` extracts the daemon from the DMG and edits the
embedded JavaScript source inside the Bun-compiled Mach-O. Every edit is **the
same byte length** as the text it replaces, so no offset, table or
embedded-module size changes.

| Patch | Original | Replacement | Purpose |
| --- | --- | --- | --- |
| `brand-display` | `Claude Science` | `Aster  Science` | UI/help/messages brand. Two spaces preserve length; HTML collapses them |
| `brand-cli-detect` | `==="claude-science"` | `==="aster-science "` | Makes the known-basename check miss (Bun rewrites argv0 to the embedded name) |
| `brand-cli-name` | `return"claude-science"})()` | `return"aster-science" })()` | CLI name fallback: `--version`, `--help`, console prefix |
| `byok-gate` | `if(!t)throw new Dw("This build requires …")` | `if(0 )throw …` | Accepts a BYOK key without an OAuth token |
| `status-authenticated` | `if(!c)return{authenticated:!1,…}` | `authenticated:!0` | UI does not force the Claude sign-in screen; account fields stay `null` |
| `env-credential` | `throw Error("No credentials available …")` | `return{api_key:process.env.ANTHROPIC_API_KEY\|\|"sk-ant-aster",auth_token:null}` | `CredentialResolver.resolve()` falls back to the environment credential |
| `brand-signin-logo` | inline 76×76 SVG (viewBox 270×270) | compact Aster emblem, padded into the same slot | Sign-in/setup pages render it inline and derive their data-URI favicon from it |

The tool refuses to write when a pattern is missing, appears more than once
(for single-occurrence patches), or when a replacement would change the length.
It prints every file offset and the output SHA-256.

Because macOS will not exec a modified Mach-O, the tool then re-signs the output
ad-hoc with the upstream entitlements (`assets/entitlements.plist`: allow-jit,
allow-unsigned-executable-memory, disable-library-validation) and strips
extended attributes. The daemon itself performs no signature self-check; the
upstream `.app` launcher does, which is why this build never runs it.

With no arguments it selects the newest `source/*.dmg`, derives the version from
`Info.plist` and skips the work when `bin/claude-science` is already newer.
Exit codes: `0` up to date, `10` patched, `1` failed.

Verification:

```
bin/claude-science --version
# aster-science <version> (release, public)

bin/claude-science --help
# aster-science — run Claude on your data, locally, in your browser
```

### Upstream version changes

Nothing in the repository pins a release number. Drop a newer
`source/Claude-Science-*.dmg` next to the old one and re-run `install.sh`: the
patcher picks the newest file and the runtime assets are re-extracted under a
new `runtime/<version>-release/` directory.

Each patch is located by the text that carries it (the brand string, the gate
message, the credential error, the status object, the SVG viewBox), not by
fixed byte offsets, so minifier noise between releases does not matter. If a
release changes the shape around that text — or removes it — the tool names the
failing patch and writes nothing:

```
[patch] Claude-Science-0.2.0 (0.2.0) does not match the expected shape:
[patch]   byok-gate (condition not found before the gate message)
```

Re-derive only that patch against the new bundle. Do not relax the checks
without reading the new source.

### Web UI assets (`web-dist`)

The executable embeds a gzipped asset tree and unpacks it to
`<data_dir>/runtime/<version>-release/` on first run. The browser UI lives in
that tree under `web-dist/`; its `index.html`, favicon, PWA icons and JS chunks
carry their own copy of the brand. Those bytes are compressed inside the
executable, so the byte patches above cannot reach them.

`tools/rebrand-web-dist.mjs` rewrites the extracted copy: `<title>`, the
manifest name, `favicon.svg`, the 192/512 px PWA icons (rasterized with `sips`),
and every `Claude Science` string in `web-dist/assets/*.js` (regenerating the
`.br` siblings so precompressed responses match).

`aster-science.sh` starts it in the background on every `serve`. It exits
immediately when the tree is already branded, and with `--watch` it waits for
the extraction to finish after a fresh install or an upgrade. Re-extraction
(delete `runtime/<version>-release/` or install a new version) restores the
upstream assets; the next launch rebrands them again.

---

## 7. Icon and Dock app

```
assets/source/aster.png  (2048×2048)
        │  sips
        ▼
iconset (16 … 1024, exact iconutil names)
        │  tools/build-icns.sh
        ▼
assets/aster.icns
        │  tools/make-app.sh
        ▼
Aster Science.app  (thin wrapper + ad-hoc signature)
```

`Aster Science.app` is generated, not committed. Its executable runs
`./aster-science.sh serve "$@"` in the foreground, so the Dock icon lives
exactly as long as the daemon does; quitting it sends the signal that stops the
daemon. You can pass the same flags (`--no-browser`, `--port`, …) by running the
bundle executable directly or via `open --args`.

The vendor `.app` in the DMG is **not** used: its launcher verifies an Anthropic
Developer ID requirement and Gatekeeper's assessment, both of which a patched
build cannot satisfy.

---

## 8. Translation proxy

`proxy/aster-proxy.mjs` is a single-file Node HTTP server with no
dependencies. It is started on demand by the launcher and writes its console to
`claude-science-data/logs/aster-proxy.log`.

| Endpoint | Behaviour |
| --- | --- |
| `GET /health` | `{ok, upstream, default_model, models, routes, fallback}`; `routes` lists `{alias, model, base, has_key}` per advertised alias. Used by the launcher |
| `GET /v1/models` | Serves the advertised aliases with `display_name` = `alias → model @ host` |
| `POST /v1/messages` | Anthropic Messages → OpenAI Chat Completions (streaming and non-streaming); resolves the requested alias to its route |
| `POST /v1/messages/count_tokens` | Character-based estimate (`len/4`) |

Startup log prints every alias with its resolved route:

```
aliases: claude-opus-5 → gpt-4o @ api.openai.com, claude-sonnet-4-6 → deepseek-chat @ api.deepseek.com, claude-haiku-4-5 → qwen-plus @ dashscope.aliyuncs.com
```

### Translation coverage

- system prompt (string or text blocks) → `system` message
- user text and images (base64 / URL) → text parts and `image_url`
- assistant text and `tool_use` → `content` and `tool_calls`
- `tool_result` → `tool` messages, emitted before any user content
- tools: `input_schema` ↔ `function.parameters`
- `tool_choice`: `auto`/`any`/`none`/`tool` ↔ `auto`/`required`/`none`/function
- `max_tokens`, `temperature`, `top_p`, `stop_sequences`
- streaming SSE → Anthropic `message_start` / `content_block_*` / `message_delta` / `message_stop`, including `input_json_delta` for tool calls
- finish reasons: `tool_calls` → `tool_use`, `length` → `max_tokens`, `content_filter` → `refusal`
- usage: `prompt_tokens`/`completion_tokens` → `input_tokens`/`output_tokens`

### Known limits

- images inside `tool_result` become `[image omitted: …]` text;
- `thinking` / reasoning deltas are dropped;
- prompt-cache counters are reported as zero;
- only the first upstream choice is used;
- `count_tokens` is an estimate, not the upstream tokenizer;
- alias keys are case-sensitive; a map entry that is neither a non-empty string
  nor an object with a `model` string is ignored with a startup warning;
- if `ASTER_MODEL_MAP` is non-empty, unmapped default aliases are no longer
  advertised (they still resolve through the fallback route);
- the proxy does not validate the incoming placeholder key and binds to
  `127.0.0.1` by default — do not change `ASTER_PROXY_HOST` to a public
  interface without putting authentication in front of it.

Upstream errors are relayed with their status and body as an Anthropic-style
`{"type":"error", …}` payload.

---

## 9. Layout

```
aster-science.sh               launcher: config bootstrap, proxy, daemon
stop.sh                        stop daemon + proxy
install.sh                     patch binary, icon, env, Dock app
config.toml                    generated per-machine paths (gitignored)
bin/                           upstream and patched daemons (gitignored)
claude-science-data/           DB, conda, venvs, runtime, logs (gitignored)
proxy/aster-proxy.mjs          Anthropic → OpenAI translator
proxy/run-proxy.sh             proxy console wrapper
tools/make-config.mjs          writes absolute config.toml
tools/write-env.mjs            writes/validates env.local.sh (map file support)
tools/patch-aster-science.mjs  DMG discovery, JS bundle patches, ad-hoc signing
tools/rebrand-web-dist.mjs     brands the extracted web UI (title, favicon, icons, strings)
tools/build-icns.sh            builds assets/aster.icns from the 2048 px source
tools/make-app.sh              builds and signs Aster Science.app
assets/source/aster.png|svg    logo source
assets/aster.icns              generated multi-size icon
assets/entitlements.plist      entitlements kept on re-sign
env.local.sh                   installer-provided env (gitignored)
source/Claude-Science-*.dmg    upstream release (gitignored)
```

---

## 10. Troubleshooting

**`node` not found** — install Node 18+ and reopen the terminal so `PATH` is
refreshed.

**`hdiutil: attach failed - Resource busy`** — the DMG is already mounted.
`hdiutil info | grep Claude` and detach the stale mount, or eject it in Finder.

**`codesign` fails after patching** — make sure Xcode command line tools are
installed (`xcode-select --install`); the patch tool needs `codesign` and
`codesign --verify` to succeed, otherwise nothing runs.

**The daemon exits immediately with a signature error** — the binary was edited
after signing. Re-run `tools/patch-aster-science.mjs --force`; it re-signs.

**`--here refused: … must be inside your home directory`** — the macOS daemon
only accepts a data dir under `$HOME` and outside the system temp folder. Keep
the checkout under your home directory.

**`[daemon] WARNING: pidIsOperonDaemon(self) is false`** — the patched daemon
was renamed. Keep the file named `bin/claude-science`; `stop` will otherwise
refuse to signal it.

**`[aster-science] WARNING: proxy not answering on …`** — the proxy failed to
start. Check `claude-science-data/logs/aster-proxy.log`; the usual causes are a
port conflict (`ASTER_PROXY_PORT`) or an invalid `ASTER_MODEL_MAP` JSON.

**Port 8000 already in use** — `./aster-science.sh serve --port 8010`. The
proxy port is independent.

**UI shows the Claude sign-in screen** — the binary is unpatched or was patched
with a tool that only applied the BYOK gate. Re-run
`tools/patch-aster-science.mjs --force`; `/api/auth/status` must report
`"authenticated":true`.

**Model list empty / chat returns 500** — the proxy cannot reach the upstream
or the key is missing. `curl http://127.0.0.1:8787/health` and check the proxy
log.

**"N environments failed: python, r"** — the first boot provisions micromamba
environments in the background (hundreds of MB). The toast clears as each one
finishes; it is a cold-start budget message, not a patch failure.

**The app updated itself and the patches are gone** — the launcher always
passes `--no-auto-update`. If you ran `update` manually, re-run `install.sh`;
the patcher rebuilds from the upstream binary.

---

## 11. Verification recipes

```
# CLI brand and version
bin/claude-science --version
bin/claude-science --help

# proxy is alive and lists aliases
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models

# translated chat (non-streaming)
curl -s -X POST http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'

# daemon state (data dir, engine pin, auth)
./aster-science.sh status
```

The daemon caches the last good model list in
`claude-science-data/models-last-good.json`; an entry keyed by the proxy URL
proves the app reached the proxy.

---

## 12. Intentionally unchanged internals

These stay as upstream because other logic depends on them:

- the `claude-science` binary basename (lockfile kill-guard),
- `claude-science-data` (the `--here` folder name and the instance marker),
- `.claude-science` default paths and `config.toml` fallback,
- OAuth/update URLs, package names and the `claude-science.exe` pid-guard
  string,
- some secondary display strings (the sandbox subsystem's `[claude-science]`
  prefix, prose mentioning "Claude").

The binary is the upstream vendor's proprietary software. Patch a copy you are
entitled to use; this repository contains only patch tooling and original
assets.
