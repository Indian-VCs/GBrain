# Tutorial: Local personal brain on a $20 Claude subscription

This is the **fully local, near-zero-cost** path. No Render, no OpenClaw, no
Telegram, no hosted embeddings. Your brain runs on your own machine, embeddings
are generated locally, and your only recurring cost is the **$20/mo Claude Pro
subscription** you use with Claude Code.

If you want the always-on agent you talk to over Telegram (with crons processing
email/Slack/calendar while you sleep), read [personal-brain.md](personal-brain.md)
instead — that's the hosted stack (~$100–150/mo). This tutorial deliberately drops
that layer.

~15 minutes end-to-end.

---

## What you're building

```
Claude Code ──MCP──> GBrain (PGLite, local)
                        │
                        └── embeddings via Ollama (local, on-device)
```

- **A brain** — GBrain on PGLite, a local Postgres. No server, no Docker.
- **Local embeddings** — Ollama runs an embedding model on your machine.
- **Your interface** — Claude Code (terminal/IDE) *is* the agent. It queries the
  brain through an MCP server.

What you are **not** building: the OpenClaw runtime, the AlphaClaw deploy harness,
the Telegram bot, or any always-on / cron behavior. Those require a hosted,
always-on deployment and are out of scope here.

---

## Prerequisites

- macOS (this tutorial is validated on Apple Silicon).
- [Homebrew](https://brew.sh).
- [Bun](https://bun.sh) — `brew install oven-sh/bun/bun`.
- [Claude Code](https://claude.com/claude-code) signed in to a **Claude Pro ($20/mo)**
  plan. Pro includes Claude Code usage (with limits). Max plans raise those limits
  but are not required.

> **Why you still need Claude:** GBrain is a *memory layer* — it stores and searches
> knowledge, it does not reason. Claude Code is the agent that queries it. Note that
> Anthropic does not offer a first-party embeddings API on any plan, which is why
> embeddings are handled locally by Ollama below (cost: $0).

---

## Step 1 — Local embeddings with Ollama

Install Ollama and pull an embedding model:

```bash
brew install ollama
brew services start ollama          # runs as a login service (auto-starts on boot)
ollama pull nomic-embed-text
```

**Model choice — `nomic-embed-text` (768 dimensions).** It's the best balance for a
personal brain: an 8192-token context (embeds whole notes without truncation, vs
`mxbai-embed-large`'s 512-token cap), small and fast (~274 MB, comfortable on Apple
Silicon), strong retrieval quality, and it's GBrain's default/best-tested local
model. The `ollama` recipe also supports `mxbai-embed-large`, `all-minilm`,
`snowflake-arctic-embed-l-v2` (1024d, stronger retrieval, good upgrade if quality
matters), and `qwen3-embed-8b` (highest ceiling but an 8B model — heavy).

Ollama's local endpoint is unauthenticated, so no API key is needed.

---

## Step 2 — Install GBrain

```bash
bun install -g github:garrytan/gbrain
gbrain --version
```

---

## Step 3 — Create a local brain wired to Ollama

The embedding model **sizes the database schema**, so it must be chosen at init time
(setting `embedding_model` later via `config set` is a deliberate no-op on PGLite):

```bash
gbrain init --pglite --embedding-model ollama:nomic-embed-text
```

Verify `~/.gbrain/config.json` now shows:

```json
{
  "engine": "pglite",
  "embedding_model": "ollama:nomic-embed-text",
  "embedding_dimensions": 768
}
```

> **Switching models later** means a wipe + re-init (PGLite can't `ALTER` the vector
> column width): back up `~/.gbrain/brain.pglite`, re-run `init` with the new
> `--embedding-model`, then re-import and `gbrain embed --all`.

---

## Step 4 — Load your notes

```bash
gbrain import ~/notes        # any directory of markdown files
gbrain embed --all           # generate embeddings locally
gbrain query "..."           # semantic + keyword hybrid search
```

Day-to-day, after editing notes: `gbrain import ~/notes && gbrain embed --stale`
(only new/changed chunks re-embed). Or `gbrain sync --watch --repo ~/notes` to keep
the brain updated continuously.

---

## Step 5 — Wire it into Claude Code (MCP)

```bash
claude mcp add gbrain -- gbrain serve
claude mcp list        # should show: gbrain ... ✓ Connected
```

Now, in any Claude Code session in that directory, the brain is available as a tool —
Claude searches and writes to it when relevant. (Add `--scope user` if you want it
available in every directory, not just the current project.)

---

## Step 6 — Make Claude consult the brain by default

MCP makes the tools *available*, but whether Claude calls them is its own judgment —
there are no magic trigger phrases. To make grounding-in-your-brain the default,
drop a `CLAUDE.md` in your workspace:

```markdown
# Workspace instructions

This workspace has a local GBrain MCP server named `gbrain` holding my notes and
durable facts. Before answering anything about my notes, decisions, or past context,
call the gbrain `query`/`search` tools first, then answer grounded in what returns.
When I state a durable fact worth keeping, save it with the gbrain `put` tool.
Skip the brain for general knowledge or coding tasks it wouldn't contain.
```

Loaded automatically at session start — so you just talk normally and it grounds in
your brain without you asking.

---

## Cost

| Component | Cost |
|---|---|
| GBrain (PGLite, local) | $0 |
| Ollama + `nomic-embed-text` embeddings | $0 (on-device) |
| Claude Code | Your existing **$20/mo Claude Pro** |
| Render / Supabase / hosted embeddings | **not used** |
| **Total incremental** | **$0 beyond the $20 Claude subscription** |

---

## Optional — self-maintenance

GBrain ships a self-maintaining daemon (`gbrain autopilot`) that periodically
consolidates related pages, flags contradictions and orphans, and prunes *derived*
data (stale embeddings, old job records) — it does not delete your source notes.
**Nothing runs automatically until you start it.** Worth enabling only once you have
a substantial corpus; on a handful of notes it's pointless.

---

## When to graduate to the hosted stack

Stay local if you want a private, searchable brain you query on demand through Claude
Code. Move to [personal-brain.md](personal-brain.md) only if you want the *always-on*
behavior — a Telegram bot you message from your phone and crons acting while you
sleep — which needs OpenClaw running 24/7 somewhere (Render, or a cheaper always-on
VPS) plus AlphaClaw to deploy it.
