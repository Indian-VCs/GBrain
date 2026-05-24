# Tutorial: Set up GBrain as your company brain

By the end of this tutorial you will have a GBrain installation that your whole team can use as a shared, always-on, queryable institutional memory. Three different teammates will each query it through their own AI agent and get an answer that's correctly scoped to what they're allowed to see. Total time: about 90 minutes if you've got Postgres ready, two hours if you're standing it up from scratch. Total cost: about $5 in API calls for the demo, then a few dollars a month at sustained use.

I'm Garry Tan. I built GBrain to run my own AI agents at Y Combinator. After about two months of multi-user features landing (parallel sync across team sources, per-user OAuth scoping, leak-free isolation across every read path), it's finally usable as a company brain too, not just a personal one. This tutorial walks you through the exact setup I'd run if I were standing it up for a 10-50 person company today.

---

## Part 1: The mental model

### What a company brain actually is

Most personal-knowledge tools force one fixed layout and one user. A company brain is the opposite of both:

- **One database, many slices.** Your meetings are one slice. Your customer notes are another. Your internal wiki is a third. Each slice is called a *source*. They live in the same brain but stay independent.
- **One server, many people.** Each teammate gets their own login. Each login is scoped to a specific set of slices. When alice queries the brain she sees her slices and the shared ones, never the slice that's pinned to bob.
- **One synthesis layer, many questions.** Anyone on the team can ask the brain a question in plain English and get back a sourced answer, not a list of pages they then have to read themselves.

That last point is the differentiator. MemPalace and most peer AI-memory stacks return a list of top-K retrieved pages and expect you to read them. GBrain returns a synthesized answer with citations, plus an honest note on what the brain doesn't know yet. That's the brain layer.

### What "federated sources" means in plain English

A federated brain holds multiple sources in one database. When alice runs a search, the brain looks across every source alice is allowed to see, ranks results across all of them, and returns one merged list. Bob doing the same query on his login sees a different merged list, because his scope is different.

The mechanism: every page row carries a `source_id`. Every read query filters by the active user's scope. The filter happens at the SQL layer, not the application layer, so an agent that tries to escape its scope through clever queries still can't see other sources. We fuzz-tested this across search, list, lookup, and multi-source reads on a 3-source test brain and got zero leaks.

### What OAuth scoping does

Each user (or each AI agent for a user) gets an OAuth client. The client carries two settings:

- **Write source.** Where new pages from this client land. One source per client. A teammate writing to the wrong source isn't possible because the client only has authority over its own.
- **Read scope.** Which sources this client can read from. Can be one source, can be a federated list of several.

So alice's agent might write to `customers-alice` and read from `customers-alice + shared`. Bob's agent might write to `internal-wiki` and read from `internal-wiki + shared`. Neither can see the other's writes.

### What you get that one person's brain doesn't

- **Shared memory.** The whole team queries the same database. The contract notes that alice wrote on Tuesday show up when bob asks about that customer on Friday, with citations back to alice's notes.
- **Scoped privacy.** Performance reviews don't leak into customer queries. Legal docs don't leak into sales searches.
- **One sync pipeline.** A single git repo (or multiple if you want them isolated per team) feeds the brain. Everyone sees the latest.
- **One operating burden.** One server to monitor, not one per user.

---

## Part 2: What you'll need before you start

| Requirement | Why | How to get it |
|---|---|---|
| A Postgres database (self-hosted or Supabase) | PGLite is single-machine; a company brain needs shared | Supabase free tier works fine for the first 50K pages. Self-hosted Postgres 16+ also works. |
| An API key for embeddings | The brain needs to embed every page to make semantic search work | ZeroEntropy is the default and cheapest. Get a key at [zeroentropy.dev](https://dashboard.zeroentropy.dev). OpenAI and Voyage also supported. |
| An Anthropic API key | The synthesis layer (`gbrain think`) uses Claude | [console.anthropic.com](https://console.anthropic.com) |
| A git repo with markdown content | The brain syncs from a git repo by convention | Create an empty repo on GitHub. We'll seed it in Part 3. |
| Bun installed | The CLI runs on Bun | `curl -fsSL https://bun.sh/install \| bash` |
| A machine to host the server | Always on. Modest size. 2 vCPU, 4 GB RAM is plenty for under 100K pages | Any VPS, an EC2 t3.medium, a home server. Fly.io works well too. |

Estimated cost at sustained use for a 25-person company: about $35 a month in embeddings (ZeroEntropy at $0.05 per million tokens), maybe $50 a month in Anthropic calls for `gbrain think` queries, plus your hosting bill. Under $100 a month for the AI side at most companies your size.

---

## Part 3: Install gbrain on the host machine

SSH into your host. We'll do everything else from this machine.

```bash
# Install the CLI
curl -fsSL https://bun.sh/install | bash
bun install -g github:garrytan/gbrain

# Verify
gbrain --version
```

You should see `gbrain 0.40.6.0` or newer.

Now connect to your Postgres. The brain stores its connection string in `~/.gbrain/config.json`:

```bash
# Self-hosted Postgres
gbrain init --postgres "postgresql://user:pass@host:5432/gbrain"

# Or Supabase (use the pooler connection string from your Supabase dashboard)
gbrain init --postgres "postgresql://postgres:pass@db.YOUR-PROJECT.supabase.co:5432/postgres"
```

The init runs schema migrations, sets up the pgvector extension, and seeds the default source. Output ends with `migrations applied`.

Set your API keys:

```bash
gbrain config set zeroentropy_api_key ze_...
gbrain config set anthropic_api_key sk-ant-...
```

Verify the install is healthy:

```bash
gbrain doctor
```

You want green checks across schema, connectivity, embedding provider, and chat provider. If anything's yellow, the error message names the fix command. Most issues are missing API keys.

---

## Part 4: Create your first source and sync it

The brain starts with one source called `default`. For a company brain we want multiple. Let's create three that reflect a typical company shape:

```bash
# A shared all-hands source for content everyone reads
gbrain sources add shared --path /srv/brain-repos/shared --name "Shared company wiki"

# A scoped source for sales/customer notes
gbrain sources add customers --path /srv/brain-repos/customers --name "Customer notes"

# A scoped source for internal-only docs (legal, HR, performance)
gbrain sources add internal --path /srv/brain-repos/internal --name "Internal-only"
```

Each `--path` should be a directory on disk where you've checked out a git repo. Create them:

```bash
sudo mkdir -p /srv/brain-repos
sudo chown $USER /srv/brain-repos
cd /srv/brain-repos
git clone git@github.com:acme-co/shared-wiki.git shared
git clone git@github.com:acme-co/customers.git customers
git clone git@github.com:acme-co/internal-docs.git internal
```

Each repo holds markdown files in subdirectories. A typical shape:

```
shared/
  ├── people/
  │   └── alice-example.md
  ├── companies/
  │   └── acme-co.md
  └── concepts/
      └── retention-strategy.md
```

If your content doesn't fit that shape (Notion exports, Obsidian vaults, a custom layout), GBrain's schema-pack system can detect your actual shape and propose a schema for it. Run `gbrain schema detect` and follow the prompts. For this tutorial we'll assume the default layout, which uses the `gbrain-base` schema pack.

Now sync each source. The first sync embeds every page, which costs money proportional to your corpus size:

```bash
gbrain sync --all
```

The `--all` flag was added in v0.40.6.0; it runs every configured source in parallel under a per-source lock so they don't step on each other. Output looks like:

```
[shared]   100/100 pages
[customers] 240/240 pages
[internal]  85/85 pages
✓ all sources synced
```

Check the dashboard:

```bash
gbrain sources status
```

You should see all three sources with recent sync timestamps and page counts.

---

## Part 5: Spin up the HTTP MCP server

Now the brain is loaded. Time to make it reachable from teammates' machines. The server speaks the Model Context Protocol over HTTP with OAuth 2.1 for authentication.

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0
```

The `--bind 0.0.0.0` is important. By default the server binds to localhost only, which is correct for a personal install but blocks remote teammates. Setting `0.0.0.0` accepts connections from any interface.

The server prints an admin bootstrap token to stderr on first start. Save it; you'll use it once for the admin dashboard.

For development, you can tunnel the local server out via ngrok:

```bash
ngrok http 3131 --domain your-brain.ngrok.app
```

For production, put your server behind a real hostname with a real TLS certificate. Let's call your final URL `https://brain.acme-co.com` for the rest of this tutorial.

Re-run the server with the public URL so the OAuth discovery metadata matches what clients hit:

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://brain.acme-co.com
```

You should be able to hit `https://brain.acme-co.com/health` and get a `{"status":"ok"}` back.

---

## Part 6: Register one OAuth client per teammate

Each teammate (or each AI agent for a teammate) gets their own OAuth client. The client controls what they can write and what they can read. Let's set up three teammates:

- **alice-example** writes to `customers` and reads `customers + shared`. She's in sales.
- **bob-example** writes to `internal` and reads `internal + shared`. He's the head of ops.
- **carol-example** writes to `shared` and reads all three. She's the head of legal and needs visibility into customer obligations.

```bash
# Alice (sales): writes customers, reads customers + shared
gbrain auth register-client alice-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source customers \
  --federated-read customers,shared

# Bob (ops): writes internal, reads internal + shared
gbrain auth register-client bob-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source internal \
  --federated-read internal,shared

# Carol (legal): writes shared, reads all three
gbrain auth register-client carol-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source shared \
  --federated-read shared,customers,internal
```

Each `register-client` command prints a `client_id` and a `client_secret`. Save both for each teammate. They go into the teammate's local agent config.

A note on the flags:

- `--scopes read,write` lets the client query the brain and write new pages. You can omit `write` for read-only clients (executive summaries, dashboards). The `admin` scope is needed for operational commands like `gbrain remote doctor` and is usually reserved for your own admin client.
- `--source` controls write authority. A client can only write to one source.
- `--federated-read` controls read scope. A client can read from one or more sources.

---

## Part 7: Verify the scoping works

Before we hand the brain to teammates, verify the scoping actually scopes. Spin up two terminal windows on your local machine and talk to the server using each client's credentials:

```bash
# Terminal 1, as alice
export GBRAIN_REMOTE_CLIENT_ID=<alice's client_id>
export GBRAIN_REMOTE_CLIENT_SECRET=<alice's client_secret>
export GBRAIN_REMOTE_MCP_URL=https://brain.acme-co.com/mcp

gbrain search "performance review" --remote
```

Alice should see results only from `customers` and `shared`. The performance-review notes live in `internal`, which she's not scoped to read. She shouldn't see them.

```bash
# Terminal 2, as bob (export his credentials similarly)
gbrain search "performance review" --remote
```

Bob should see the performance-review notes from `internal`, plus anything related from `shared`. He shouldn't see anything tagged with a customer name that lives only in `customers`.

If both queries return correctly scoped results, your isolation is working. If alice sees an `internal` row in her results, stop and check the `--source` and `--federated-read` flags on her client.

The v0.40.6.0 release benchmark suite verifies this scoping across four different read paths (search, list, lookup, federated reads) with a fuzz harness and gets zero leaks. So if your setup behaves the same way, you're on the same isolation contract.

---

## Part 8: Connect each teammate's AI agent

Each teammate runs their AI client (Claude Code, Cursor, Claude Desktop, OpenClaw, Hermes) configured to point at your brain server through their OAuth credentials.

The recommended path for each teammate is the thin-client install. On their machine:

```bash
curl -fsSL https://bun.sh/install | bash
bun install -g github:garrytan/gbrain

gbrain init --mcp-only \
  --issuer-url https://brain.acme-co.com \
  --mcp-url https://brain.acme-co.com/mcp \
  --oauth-client-id <their client_id> \
  --oauth-client-secret <their client_secret>
```

The thin-client install creates a local config that knows how to talk to your brain but never opens its own database. Most CLI commands route through the remote server transparently.

Now configure their AI client. For Claude Desktop, the teammate adds an MCP server entry in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "company-brain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

When Claude Desktop launches, it talks to the local `gbrain serve` stdio bridge, which forwards every request to your remote brain over HTTPS with their OAuth token attached. From Claude Desktop's perspective it's just one MCP server.

For Claude Code, Cursor, OpenClaw, Hermes, and other clients, the per-client setup steps live in [`docs/mcp/`](../mcp/). They all follow the same shape: point the agent at the local `gbrain serve` bridge, which knows about the remote.

---

## Part 9: First real query as a teammate

Have alice run a real query from her machine. The interesting verb is `gbrain think`, which gives back a synthesized answer instead of raw pages.

```bash
gbrain think "What's the latest update from acme-co? When did we last talk to them?"
```

What alice gets back, assuming the brain has been syncing for a week and her sources contain a customer page for acme-co and several meeting notes:

```
## Answer

The most recent customer contact with acme-co was a renewal-discussion
meeting on 2026-05-18, attended by alice-example and acme-co's CTO. Key
points discussed [meetings/2026-05-18-acme-renewal]:

- They are upgrading their plan from team to enterprise.
- Annual contract value is moving from $48K to $180K.
- Decision driver: a new compliance requirement they have to meet by Q3.

Prior contact was a quarterly check-in on 2026-04-03 [meetings/2026-04-03-acme-q2-checkin].

**Gap noted:** No customer-success notes have been filed since the
2026-05-18 renewal meeting. If a follow-up has happened, it's not in
the brain yet.
```

Three things to notice:

1. **Sourced.** Every claim cites the meeting note it came from.
2. **Synthesized.** Alice didn't read three pages and stitch them together. The brain did.
3. **Honest about gaps.** The brain knows what it doesn't know and says so, instead of inventing a follow-up that didn't happen.

That last part is what we call the gap analysis. It's the part of the brain layer that nobody else ships. The synthesized answer's job is to be useful, but it's also to be loud about what's missing.

Bob asking the same question would get nothing about acme-co. He's not scoped to read `customers`. He'd see his own internal-ops content if he asked something relevant to that. Carol asking would see both, because she's scoped to read all three sources.

---

## Part 10: Operating the brain

Once it's up and running, three commands do most of the operational work.

### Background daemon: `gbrain autopilot`

```bash
# On the host, as a service
gbrain autopilot --install
```

The autopilot installs a daemon that runs every five minutes. On a healthy brain (health score 95+) it sleeps. On a brain that's drifting (stale pages, missing embeddings, low link density) it submits the right targeted maintenance jobs to bring it back. Every hour or so it runs a full maintenance cycle to keep the underlying invariants (extract links from new pages, embed unembedded chunks, consolidate duplicate notes) exercised.

### Self-healing: `gbrain doctor --remediate`

```bash
gbrain doctor --remediate --yes --target-score 90 --max-usd 5
```

The brain has a health score from 0 to 100, computed from several axes (embedding coverage, link density, sync freshness, orphan count). The `--remediate` flag tells the brain to compute a dependency-ordered plan of maintenance jobs that would raise the score to the `--target-score`, then run that plan. The `--max-usd 5` is your cost cap: the brain refuses to start the plan if the cost estimate exceeds the cap. Safe to cron.

### Monitoring: `gbrain sources status` and the admin dashboard

```bash
gbrain sources status
```

Returns a per-source dashboard: when each source last synced, how many pages, how many embedded, how many unacked sync failures. This is the at-a-glance health check.

The admin dashboard at `https://brain.acme-co.com/admin` shows live request volume, registered OAuth clients, recent activity, and brain stats. Use the admin bootstrap token from Part 5 to log in the first time, then register additional admin users from inside the dashboard.

---

## Part 11: Cost and speed expectations

Real numbers from the v0.40.6.0 release benchmark, running the default stack (gbrain with ZeroEntropy for embedding + reranker):

- **Embedding cost:** $0.05 per million tokens. For comparison, gbrain configured with OpenAI is $0.13 (2.6× more expensive) and gbrain configured with Voyage is $0.18 (3.6× more expensive).
- **Ingest speed:** about 22 seconds for a small test corpus of 164 pages on the host machine. For a 10K-page corpus, expect about 20 minutes the first time, then most syncs are incremental and finish in seconds.
- **Query latency:** about 122 milliseconds median for a `gbrain search`. For comparison, the same query through gbrain with OpenAI takes about 282 ms (2.3× slower).
- **`gbrain think` latency:** a few seconds, dominated by the Anthropic API. The brain layer is the only place where you wait long enough to notice.
- **Retrieval quality:** on the public LongMemEval benchmark, gbrain hits 97.60% recall at the top 5 retrieved sessions, beating the previous published state of the art at 96.6%. On the in-house BrainBench corpus of relational queries (the kind that look like "who works at X"), gbrain beats commodity vector retrieval by 38 percentage points, because the graph layer surfaces relationships that vector similarity alone misses.

The full release benchmark page including the methodology and the receipt JSON for every run lives in [the gbrain-evals repo](https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

---

## Part 12: Common gotchas

The things I learned the hard way while building this.

### "My teammate can't see anything"

Check `gbrain auth list` on the host and confirm their client has `--source` set to a source that actually exists. Empty or null `--source` means the client falls through to the `default` source, which probably has no content if you set up three named sources.

### "Sync is slow and feels stuck"

The first sync embeds every page, which takes time. Check `gbrain sources status` for the live page count. If it's climbing you're not stuck, you're just embedding. If you've got a 10K-page corpus and ZeroEntropy is being throttled, the per-source parallel sync will look like progress on three sources at once rather than one source moving fast.

### "I see a page I shouldn't see"

This shouldn't happen, but if you suspect it, run `gbrain search <query> --remote --json` as the constrained client and inspect the `source_id` field on every returned result. Every row should be in the client's `--federated-read` set. If one isn't, file an issue with the exact slug and source IDs; we want to know.

### "The synthesis answer is wrong"

The synthesis layer is grounded in the retrieved pages. If the retrieved pages contain bad information, the answer will too. The gap-analysis note often catches this: if the answer says "based on retrieved pages from date X" and date X is six months ago, the brain is telling you the information is stale. Run `gbrain sync --all` to refresh and try again.

### "OAuth `/token` endpoint returns 401 for my client"

Verify the client secret matches what was printed at register-client time. The server stores only a SHA-256 hash of the secret; if you lost the original, you have to revoke the client and re-register. Use `gbrain auth revoke-client <client_id>` and re-run `register-client`.

### "Postgres connection is exhausting"

Each parallel sync worker opens its own pool. With three sources and the default four workers per source, you can hit your Postgres connection limit if it's set low. Either reduce the worker count with `gbrain sync --all --parallel 2 --workers 2`, or raise your Postgres `max_connections` to at least 100. Supabase's free tier defaults to 60, which is tight.

### "I want to add a fourth teammate but they need access to all three sources"

```bash
gbrain auth register-client diana-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source shared \
  --federated-read shared,customers,internal
```

That's it. The `--federated-read` list can hold any of the registered sources. Add or rotate teammates as the org grows.

---

## What you built

You now have a multi-user GBrain installation running against Postgres, serving three federated sources (a shared wiki, a customers source, an internal-only source) over HTTP MCP with OAuth 2.1. Each teammate has their own scoped OAuth client. Each can query the brain in plain English through their AI agent and get back synthesized, sourced answers that are correctly scoped to what they're allowed to see. The brain self-heals via the autopilot daemon and the `doctor --remediate` command. Cost is bounded; speed is fast.

What to do next:

- **Add more sources** as the org grows. Each team or data class is a candidate for a source.
- **Wire ingestion** from external systems (Granola, Linear, Slack) using the [ingestion source contract](../skillpack-anatomy.md). Most companies want their meetings auto-ingested.
- **Set up the dream cycle.** Overnight enrichment that fixes citations, dedupes people pages, and surfaces contradictions. `gbrain autopilot --install` enables it by default.
- **Explore the rest of the brain layer.** `gbrain whoknows`, `gbrain find_trajectory`, `gbrain founder scorecard` (especially useful for VC and ops teams), and the contradiction-detection cycle that surfaces conflicts between different people's notes.

If you're building in this space (which YC has flagged as the [company-brain category in its Request for Startups](https://www.ycombinator.com/rfs#company-brain)), you might as well build on this. Everything described above is open source, MIT licensed, and what I run in production behind my own AI agents.

Questions, gotchas, or wins worth sharing? Open an issue at [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain/issues).
