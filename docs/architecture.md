# ActivityPub Federation Server - Architecture

## Overview

The ActivityPub Federation Server publishes government news from
DestaquesGovBr to the fediverse (Mastodon, Pleroma, Misskey, etc).

It exposes **182 actors** (1 portal + 156 agencies + 25 themes) that
remote users can follow. When new articles are scraped, an Airflow DAG
detects them, enqueues them for publishing, and the server delivers them
to every follower's inbox.

### Tech Stack

| Component       | Technology                              |
|-----------------|-----------------------------------------|
| Runtime         | Node.js 22, TypeScript                  |
| Framework       | Hono (HTTP) + Fedify (ActivityPub)      |
| Database        | PostgreSQL 15 (Cloud SQL)               |
| Queue           | Fedify PostgresMessageQueue             |
| Orchestration   | Cloud Composer (Airflow 3)              |
| Hosting         | Cloud Run (web + worker)                |
| CI/CD           | GitHub Actions                          |

---

## System Architecture

```
                    ┌──────────────┐
                    │  gov.br sites│
                    │  (~160 sites)│
                    └──────┬───────┘
                           │ scraping
                           ▼
                    ┌──────────────┐
                    │  govbrnews   │
                    │  (PostgreSQL)│
                    └──────┬───────┘
                           │
          ┌────────────────▼─────────────────┐
          │    Cloud Composer (Airflow 3)     │
          │    DAG: federation_publish        │
          │    schedule: */10 * * * *         │
          └────────────────┬─────────────────┘
                           │ enqueue + trigger
                           ▼
          ┌──────────────────────────────────┐
          │    ActivityPub Server (Cloud Run) │
          │                                  │
          │  ┌──────────┐    ┌────────────┐  │
          │  │   Web    │    │   Worker   │  │
          │  │ (Hono)   │    │ (Fedify Q) │  │
          │  └────┬─────┘    └─────┬──────┘  │
          │       │                │          │
          │       └───────┬────────┘          │
          │               ▼                   │
          │        ┌─────────────┐            │
          │        │ Federation  │            │
          │        │ DB (PG)     │            │
          │        └─────────────┘            │
          └──────────────┬───────────────────┘
                         │ HTTP POST (signed)
                         ▼
          ┌──────────────────────────────────┐
          │     Fediverse                    │
          │  mastodon.social, fosstodon.org  │
          │  pleroma, misskey, ...           │
          └──────────────────────────────────┘
```

---

## Cloud Run Services

The server runs as **two Cloud Run services** from the same Docker image,
differentiated by `NODE_TYPE`:

| Service                            | NODE_TYPE | Role                                |
|------------------------------------|-----------|-------------------------------------|
| `destaquesgovbr-federation-web`    | `web`     | HTTP endpoints, ActivityPub protocol|
| `destaquesgovbr-federation-worker` | `worker`  | Consumes Fedify message queue       |

**Web node** handles:
- WebFinger discovery (`/.well-known/webfinger`)
- Actor profiles (`/ap/actors/{identifier}`)
- Inbox (Follow/Undo) (`/ap/actors/{identifier}/inbox`)
- Outbox (`/ap/actors/{identifier}/outbox`)
- `/trigger-publish` (called by Airflow DAG)
- `/health`

**Worker node** handles:
- Processing the Fedify `PostgresMessageQueue`
- Signing and delivering HTTP POST requests to remote inboxes
- Retry with exponential backoff on failures

The web node has `manuallyStartQueue: true` so it does NOT consume the
queue — it only enqueues. The worker has `startQueue()` so it actively
polls and processes messages.

---

## Publish Workflow

The full lifecycle from news article to fediverse delivery:

```
AIRFLOW (Cloud Composer)                AP-SERVER (Cloud Run)
════════════════════════                ══════════════════════

┌─────────────────────┐
│  federation_publish  │
│  DAG (*/10 min)      │
└──────────┬──────────┘
           │
 ┌─────────▼──────────┐        ┌─────────────────────────────────────────┐
 │ detect_and_enqueue  │        │          FEDERATION DB (PostgreSQL)     │
 │                     │        │                                        │
 │ 1. Read watermark ─────────>│  ap_sync_watermark                     │
 │                     │<───────│  ┌────────────────────────────────┐    │
 │ 2. Query govbrnews  │        │  │ id=1 | last_processed_at | .. │    │
 │    in batches of 500│        │  └────────────────────────────────┘    │
 │                     │        │                                        │
 │ 3. Bulk INSERT ────────────>│  ap_publish_queue                      │
 │    (execute_values)  │       │  ┌────────────────────────────────┐    │
 │                     │        │  │ news_id  | actor   | payload  │    │
 │ 4. Update watermark ──────>│  │ abc123   | portal  | {...}    │    │
 │                     │        │  │ abc123   | mcom    | {...}    │    │
 └─────────┬──────────┘        │  │ abc123   | tema-20 | {...}    │    │
           │                    │  └────────────────────────────────┘    │
           │                    │           status: pending              │
           ▼                    └─────────────────────────────────────────┘
 ┌─────────────────────┐
 │  trigger_publish     │
 │                     │
 │  POST /trigger- ───────────────────────────────────┐
 │  publish             │                              │
 └─────────────────────┘                              │
                                                       │
═══════════════════════════════════════════════════════╪═══
                                                       │
  CLOUD RUN: WEB                                       ▼
  (manuallyStartQueue = true)       ┌─────────────────────────────┐
                                    │     /trigger-publish        │
                                    └──────────────┬──────────────┘
                                                   │
                         ┌─────────────────────────▼──────────────────────────┐
                         │            processPublishQueue()                    │
                         │                                                    │
                         │  For EACH pending item in the queue:               │
                         │                                                    │
                         │  ┌──────────────────────────────────────────────┐  │
                         │  │ 1. getActorByIdentifier()                    │  │
                         │  │    SELECT * FROM ap_actors                   │  │
                         │  │    WHERE identifier = 'portal'               │  │
                         │  └─────────────────────┬────────────────────────┘  │
                         │                        │                           │
                         │  ┌─────────────────────▼────────────────────────┐  │
                         │  │ 2. buildArticleActivity()                    │  │
                         │  │    Create {                                  │  │
                         │  │      actor:  /ap/actors/portal               │  │
                         │  │      object: Article {title, content, tags}  │  │
                         │  │      to:     as:Public                       │  │
                         │  │      cc:     portal/followers                │  │
                         │  │    }                                         │  │
                         │  └─────────────────────┬────────────────────────┘  │
                         │                        │                           │
                         │  ┌─────────────────────▼────────────────────────┐  │
                         │  │ 3. ctx.sendActivity()                        │  │
                         │  │                                              │  │
                         │  │    Does NOT make HTTP requests!              │  │
                         │  │    INSERT into PostgresMessageQueue ──────────────┐
                         │  │    (Fedify internal table)                   │  │ │
                         │  └─────────────────────┬────────────────────────┘  │ │
                         │                        │                           │ │
                         │  ┌─────────────────────▼────────────────────────┐  │ │
                         │  │ 4. markPublished(id)                         │  │ │
                         │  │    UPDATE ap_publish_queue                   │  │ │
                         │  │    SET status = 'published'                  │  │ │
                         │  └──────────────────────────────────────────────┘  │ │
                         │                                                    │ │
                         │  Returns {processed, published, failed}            │ │
                         └────────────────────────────────────────────────────┘ │
                                                                               │
                         ┌─────────────────────────────────────────────────┐   │
                         │          PostgresMessageQueue                    │   │
                         │          (Fedify internal table in federation DB)│<──┘
                         │                                                 │
                         │  ┌───────────────────────────────────────────┐  │
                         │  │ msg_id | type | payload                  │  │
                         │  │ 1      | send | {activity, recipients..} │  │
                         │  │ 2      | send | ...                      │  │
                         │  └────────────────────┬──────────────────────┘  │
                         └───────────────────────┼────────────────────────┘
                                                 │
                                                 │ Worker consumes
                                                 │ (fedi.startQueue)
                                                 │
                         ┌───────────────────────▼────────────────────────┐
                         │              WORKER (Cloud Run)                 │
                         │                                                │
                         │  For EACH message in the Fedify queue:         │
                         │                                                │
                         │  1. Resolve followers of the actor             │
                         │     SELECT * FROM ap_followers                 │
                         │     WHERE actor_id = X AND status = 'active'   │
                         │                                                │
                         │  2. Group by shared inbox                      │
                         │     (preferSharedInbox: true)                  │
                         │                                                │
                         │     mastodon.social (300 followers) -> 1 POST  │
                         │     fosstodon.org (50 followers)    -> 1 POST  │
                         │     small-server.net (1 follower)   -> 1 POST  │
                         │                                                │
                         │  3. HTTP POST signed with actor's RSA key      │
                         │     ┌────────────────────────────────────────┐ │
                         │     │ POST https://mastodon.social/inbox    │ │
                         │     │ Content-Type: application/activity+json│ │
                         │     │ Signature: keyId="..portal#main-key"  │ │
                         │     │                                       │ │
                         │     │ {"@context": "https://w3.org/ns/as",  │ │
                         │     │  "type": "Create",                    │ │
                         │     │  "actor": ".../ap/actors/portal",     │ │
                         │     │  "object": {"type": "Article",        │ │
                         │     │    "name": "Safra recorde...",        │ │
                         │     │    "content": "<p>...</p>"}}          │ │
                         │     └────────────────────────────────────────┘ │
                         │                                                │
                         │  4. Retry with exponential backoff on failure   │
                         │     (managed by Fedify)                        │
                         │                                                │
                         └────────────────────┬───────────────────────────┘
                                              │
                                              ▼
                         ┌────────────────────────────────────────────────┐
                         │           REMOTE SERVERS                       │
                         │           (Mastodon, Pleroma, Misskey, ...)    │
                         │                                                │
                         │  Receive signed POST at shared inbox           │
                         │  Distribute internally to each local follower  │
                         │  Article appears in users' timelines           │
                         └────────────────────────────────────────────────┘
```

### Shared Inbox Optimization

When delivering an activity, Fedify groups followers by shared inbox.
Instead of sending one HTTP POST per follower, it sends one per **server**.

Example: if `@portal` has 1000 followers across 50 servers, the worker
sends 50 HTTP requests, not 1000.

```
Without shared inbox:           With shared inbox:

  follower_1 -> POST /inbox       mastodon.social
  follower_2 -> POST /inbox         (300 followers) -> 1 POST /inbox
  follower_3 -> POST /inbox       fosstodon.org
  ...                               (50 followers)  -> 1 POST /inbox
  follower_1000 -> POST /inbox    ...49 more servers -> 1 POST each

  = 1000 HTTP requests            = 50 HTTP requests
```

---

## Queue State Machine

### ap_publish_queue

The DAG enqueues items; the web node processes them.

```
                processPublishQueue()
  ┌─────────┐   sendActivity() OK    ┌───────────┐
  │ pending ├────────────────────────>│ published │
  └────┬────┘                         └───────────┘
       │
       │      actor not found
       │      payload null             ┌────────┐
       └──────────────────────────────>│ failed  │
              sendActivity() throws    └─────────┘
```

### Fedify Message Queue (internal)

Managed entirely by Fedify. The worker consumes messages and delivers.

```
  ┌─────────┐   worker picks up   ┌────────────┐   HTTP 2xx   ┌───────────┐
  │ queued  ├────────────────────>│ delivering ├─────────────>│ delivered │
  └─────────┘                     └─────┬──────┘              └───────────┘
                                        │
                                        │ HTTP error
                                        ▼
                                  ┌───────────┐  max retries  ┌───────────┐
                                  │  retry    ├──────────────>│ abandoned │
                                  │ (backoff) │               └───────────┘
                                  └───────────┘
```

### ap_followers

Remote accounts following our actors.

```
  Follow received         Undo(Follow) received
  ┌─────────┐   Accept    ┌────────┐
  │ pending ├────────────>│ active │
  └─────────┘             └───┬────┘
                              │ Undo(Follow)
                              ▼
                          ┌─────────┐
                          │ removed │
                          └─────────┘
```

---

## Database Schema

8 tables in the `federation` database:

| Table                | Purpose                                      | Key columns                                |
|----------------------|----------------------------------------------|--------------------------------------------|
| `ap_actors`          | 182 actors (portal, agencies, themes)        | identifier, actor_type, RSA+Ed25519 keys   |
| `ap_followers`       | Remote accounts following our actors         | actor_id, follower_uri, shared_inbox_uri   |
| `ap_publish_queue`   | Items waiting to be published                | news_unique_id, actor_identifier, payload  |
| `ap_activities`      | Log of published ActivityPub activities      | activity_uri, actor_id, news_unique_id     |
| `ap_delivery_log`    | Per-inbox delivery attempts                  | activity_id, target_inbox_uri, status      |
| `ap_dead_servers`    | Permanently unreachable remote servers       | server_hostname, consecutive_failures      |
| `ap_sync_watermark`  | Airflow DAG checkpoint (singleton)           | last_processed_at                          |
| Fedify internal      | PostgresMessageQueue (managed by Fedify)     | -                                          |

### Entity Relationships

```
ap_actors
  │
  ├──< ap_followers       (actor_id -> ap_actors.id)
  │
  ├──< ap_activities      (actor_id -> ap_actors.id)
  │       │
  │       └──< ap_delivery_log  (activity_id -> ap_activities.id)
  │
  └──< ap_publish_queue   (actor_identifier -> ap_actors.identifier)

ap_dead_servers           (standalone)
ap_sync_watermark         (standalone, singleton)
```

---

## Actors

Each actor maps to an ActivityPub type:

| actor_type | AP type        | Count | Example identifier |
|------------|----------------|-------|--------------------|
| `portal`   | `Application`  | 1     | `portal`           |
| `agency`   | `Organization` | 156   | `mcom`, `anvisa`   |
| `theme`    | `Group`        | 25    | `tema-03`, `tema-20`|

Each actor has:
- **RSA-2048** key pair for HTTP Signatures
- **Ed25519** key pair for Object Integrity Proofs
- Keys stored as JWK in the database

### Endpoints per actor

```
WebFinger:  /.well-known/webfinger?resource=acct:{identifier}@{domain}
Profile:    /ap/actors/{identifier}
Inbox:      /ap/actors/{identifier}/inbox
Outbox:     /ap/actors/{identifier}/outbox
Followers:  /ap/actors/{identifier}/followers
```

---

## Airflow DAG

`federation_publish` runs every 10 minutes on Cloud Composer.

### Tasks

1. **detect_and_enqueue** - Reads watermark, queries govbrnews for new
   articles since last run, bulk-inserts into `ap_publish_queue`, updates
   watermark. Loops in batches of 500.

2. **trigger_publish** - Calls `POST /trigger-publish` on the web service,
   which processes all pending items.

### Configuration

| Airflow Variable              | Purpose                        | Default           |
|-------------------------------|--------------------------------|--------------------|
| `federation_web_url`          | Web service URL                | -                  |
| `federation_auth_token`       | Bearer token for /trigger-publish | -               |
| `federation_initial_watermark`| Starting point when no watermark exists | 7 days ago  |

### Timing (steady state, ~10 new articles)

```
T+0s      detect_and_enqueue: ~30 rows INSERT (10 articles x ~3 actors each)
T+2s      trigger_publish: POST /trigger-publish
T+2.1s    Web: processPublishQueue -> 30x sendActivity (INSERT into msg queue)
T+2.5s    Web: 30 items marked 'published', returns result
T+3s      Worker: consumes 30 messages from Fedify queue
T+3-10s   Worker: HTTP POST to each follower's shared inbox
T+10s     Articles visible in fediverse timelines
```

---

## Dead Server Handling

When HTTP delivery to a server fails repeatedly:

1. Each failure increments `consecutive_failures` in `ap_dead_servers`
2. After **50 consecutive failures**, the server is marked `is_dead = TRUE`
3. Dead servers are **skipped** during delivery (no wasted HTTP requests)
4. Periodic probing checks if dead servers have recovered
5. Revived servers get `is_dead = FALSE` and resume receiving deliveries

---

## Local Development

See [../airflow/CLAUDE.md](../airflow/CLAUDE.md) for Airflow local setup.

### Prerequisites

- Node.js 22+
- Docker
- pnpm

### Running

```bash
# Install dependencies
pnpm install

# Start federation DB (local)
docker compose up -d

# Apply schema
psql postgresql://federation:federation@localhost:5433/federation -f sql/schema.sql

# Seed actors
pnpm seed

# Start dev server
pnpm dev

# Run tests
pnpm test
```

### Local Airflow (Astro CLI)

```bash
cd airflow/
script -q /dev/null astro dev start --no-browser --wait 5m

# Airflow UI: http://localhost:8080 (admin/admin)
# Federation DB: localhost:5433
```
