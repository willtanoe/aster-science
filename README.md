# aster-science

A local, self-contained build of **Claude Science 0.1.72** that

- runs without a Claude account/OAuth sign-in,
- accepts a bring-your-own-key credential,
- speaks the Anthropic Messages API to a bundled translator that forwards to
  any **OpenAI-compatible** `/chat/completions` endpoint.

Everything else (web UI, agent loop, skills, sandbox, artifacts, conda envs)
is the upstream application. All state and downloads live in
`./claude-science-data`; nothing is written to `%USERPROFILE%\.claude-science`.

## Requirements

- Windows x64
- Node.js 18+ (launcher and proxy; Node 24 tested)
- The upstream `Claude-Science-0.1.72.exe` for the first patch

## Install

```bat
install.cmd
```

The installer

1. patches `Claude-Science-0.1.72.exe` → `aster-science.exe`
   (two same-length byte edits; see `tools/patch-aster-science.mjs`),
2. asks for the OpenAI-compatible base URL, key, model and optional model map,
3. writes `env.local.cmd` (gitignored — never commit credentials).

## Run

```bat
aster-science.cmd serve          :: start proxy + daemon, open the UI
aster-science.cmd serve --no-browser
aster-science.cmd status
aster-science.cmd url            :: fresh single-use login link
stop.cmd                         :: stop daemon + proxy
```

`aster-science.cmd` starts `proxy/aster-proxy.mjs` when its `/health` is not
answering, then runs the daemon with:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=sk-ant-aster      (placeholder; the proxy ignores it)
```

## Environment (installer-provided)

| Variable | Meaning |
|---|---|
| `ASTER_OPENAI_BASE_URL` | upstream base URL, default `https://api.openai.com/v1` |
| `ASTER_OPENAI_API_KEY` | upstream key (required) |
| `ASTER_OPENAI_MODEL` | upstream model for unmapped aliases, default `gpt-4o` |
| `ASTER_MODEL_MAP` | JSON `{ "claude-opus-5": "gpt-4o", ... }` |
| `ASTER_PROXY_PORT` | proxy port, default `8787` |
| `ASTER_PROXY_HOST` | proxy bind host, default `127.0.0.1` |

Values live in `env.local.cmd`, which is gitignored.

## What the binary patch does

`tools/patch-aster-science.mjs` performs byte-for-byte (same-length) edits in
the embedded JS bundle of the release build:

- **Display brand** — `Claude Science` becomes `Aster  Science` (two spaces
  keep the length; HTML/JSX collapse them, so the rendered brand is
  "Aster Science").
- **CLI name** — the known-basename comparison misses and the `mt` fallback
  returns `aster-science`, so `--version`, `--help` and the console prefix use
  the new name.
- **Build gate** — `if(!t)` in the Anthropic client gate becomes `if(0 )`,
  so a BYOK key is accepted without an OAuth token.
- **Web-UI gate** — the `/api/auth/status` early return when no OAuth token
  exists reports `authenticated:!0` instead of `!1`, so the UI does not force
  the Claude sign-in screen. Account/subscription fields stay `null`.
- **Credential resolver** — the terminal
  `throw Error("No credentials available …")` in
  `CredentialResolver.resolve()` becomes
  `return{api_key:process.env.ANTHROPIC_API_KEY||"sk-ant-aster",auth_token:null}`.

The patcher refuses to write when a pattern is missing or not unique, and
prints file offsets plus the output SHA-256.

## Icon

`assets/aster.svg` is rasterized to seven PNGs (`assets/icon-{16,24,32,48,64,128,256}.png`)
and packed into `assets/aster.ico` by `tools/build-ico.mjs`. Each PNG is an
indexed-color encode that fits the original icon slot in the PE resource
section; `tools/patch-icon.mjs` overwrites the seven `RT_ICON` payloads in
place, updates the data-entry sizes and the `RT_GROUP_ICON` `dwBytesInRes`,
and never resizes or shifts the resource section.

Internal identifiers are intentionally unchanged: `claude-science-data` (the
`--here` folder name), `.claude-science` defaults, OAuth/update URLs and
package names stay as upstream so paths, `--here` detection, stop-guard and
update plumbing keep working. Some secondary display strings (the sandbox
subsystem's `[claude-science]` prefix, prose mentioning "Claude") remain.

## Translation proxy

`proxy/aster-proxy.mjs` exposes:

- `GET /v1/models` — configured aliases (`claude-opus-5`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`) so the app keeps its model-specific behaviour,
- `POST /v1/messages` — Anthropic Messages ⇄ OpenAI Chat Completions,
  non-streaming and streaming,
- `POST /v1/messages/count_tokens` — character-based estimate,
- `GET /health`.

Mapping covers system prompts, text, images, tools (`input_schema` ↔
`function.parameters`), tool choice, `tool_use`/`tool_result` round-trips,
stop reasons and usage.

Known limits:

- tool results are sent as text; images inside tool results become a
  `[image omitted]` marker,
- `thinking`/reasoning deltas are not forwarded,
- prompt-cache fields are reported as zero,
- only the first upstream choice is used.

## Layout

```
aster-science.cmd          launcher (proxy + daemon)
stop.cmd                   stop daemon + proxy
install.cmd                patch binary + icon, write env.local.cmd
config.toml                instance paths (data dir, conda home, auth, venvs)
proxy/aster-proxy.mjs      Anthropic → OpenAI translator
proxy/run-proxy.cmd        proxy console wrapper
tools/patch-aster-science.mjs   JS bundle patches (brand, BYOK, auth, resolver)
tools/patch-icon.mjs            in-place RT_ICON/RT_GROUP_ICON replacement
tools/build-ico.mjs             packs the seven PNGs into assets/aster.ico
assets/aster.svg           logo source
assets/icon-*.png          seven rasterized sizes (indexed PNG)
assets/aster.ico           multi-size ICO
assets/aster.png           logo raster
```
