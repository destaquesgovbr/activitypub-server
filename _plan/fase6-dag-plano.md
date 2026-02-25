# Phase 6: Airflow DAG — Automatic Article Detection & Federation Publishing

## Approach: Option A (Payload in Queue)
The DAG reads news content from the govbrnews database and stores the full article payload as JSONB in `ap_publish_queue.news_payload`. The federation server deserializes the payload directly — no cross-database query needed.

---

## Work Stream 1: Schema Migration

**File:** `activitypub-server/sql/schema.sql`

Add `news_payload JSONB` column to `ap_publish_queue`:
```sql
ALTER TABLE ap_publish_queue ADD COLUMN news_payload JSONB;
```

After migration, make `news_payload NOT NULL` for new rows. The column stores the full `NewsRow` shape:
```json
{
  "unique_id": "...",
  "title": "...",
  "content_html": "...",
  "summary": "...",
  "image_url": "...",
  "tags": ["..."],
  "published_at": "2025-01-01T00:00:00Z",
  "canonical_url": "https://..."
}
```

**New migration script:** `activitypub-server/scripts/migrate-add-payload.ts` — runs the ALTER TABLE via postgres.js.

---

## Work Stream 2: Federation Server Changes

### 2a. `src/db.ts` — Update `PublishQueueRow` interface
- Add `news_payload: NewsRow | null` field
- Update `getPendingPublishQueue()` to SELECT the new column and parse JSONB

### 2b. `src/publisher.ts` — Read payload from queue row
- Remove the `fetchNews` parameter from `processPublishQueue()`
- Read `item.news_payload` directly instead of calling `fetchNews(item.news_unique_id)`
- If `news_payload` is null, mark as failed (backwards compat for old rows)

### 2c. `src/index.ts` — Simplify trigger-publish handler
- The `/trigger-publish` endpoint currently doesn't pass `fetchNews` — now it won't need to since payload is in the queue row

---

## Work Stream 3: Test Updates

### 3a. Unit tests — `tests/unit/publisher.test.ts`
- Update test fixtures to include `news_payload` in queue rows
- Remove tests for `fetchNews` callback
- Add test: queue row with valid `news_payload` → article built and sent
- Add test: queue row with null `news_payload` → marked as failed

### 3b. Integration tests — `tests/integration/publish-flow.test.ts`
- Update queue insertion to include `news_payload` JSONB
- Verify end-to-end: insert queue row with payload → processPublishQueue → activity sent

### 3c. E2E tests (if existing) — verify with real Fedify context

---

## Work Stream 4: Terraform — New Secrets & IAM

### 4a. `infra/terraform/composer_secrets.tf` — New Airflow secrets

1. **Connection: `federation_postgres`** — Airflow connection to the federation Cloud SQL database
   - Source: existing `federation-database-url` secret in Secret Manager
   - Format: `postgresql://user:pass@host:5432/dbname`
   - Secret name: `airflow-connections-federation_postgres`

2. **Variable: `federation_web_url`** — URL of the federation web service
   - Value: Cloud Run web service URL (from `google_cloud_run_v2_service.federation_web.uri`)
   - Secret name: `airflow-variables-federation_web_url`

3. **Variable: `federation_auth_token`** — Bearer token for `/trigger-publish`
   - Source: existing `federation-auth-token` secret
   - Secret name: `airflow-variables-federation_auth_token`

### 4b. `infra/terraform/composer_iam.tf` — Grant Composer SA access
- Add `secretmanager.secretAccessor` binding for the new secrets to the Composer service account

---

## Work Stream 5: DAG Implementation

**File:** `data-platform/src/data_platform/dags/federation_publish.py`

### DAG: `federation_publish`
- **Schedule:** `*/10 * * * *` (every 10 minutes)
- **Catchup:** False
- **Tags:** `["federation", "activitypub"]`

### Task 1: `detect_new_articles`
Using `PostgresHook(postgres_conn_id="postgres_default")` (govbrnews DB):

```python
@task
def detect_new_articles():
    """Read watermark, query new articles, return list of NewsRow dicts."""
    from airflow.providers.postgres.hooks.postgres import PostgresHook

    govbr_hook = PostgresHook(postgres_conn_id="postgres_default")
    fed_hook = PostgresHook(postgres_conn_id="federation_postgres")

    # 1. Read watermark from federation DB
    watermark = fed_hook.get_first(
        "SELECT last_processed_at FROM ap_sync_watermark WHERE id = 1"
    )
    last_processed_at = watermark[0] if watermark else "1970-01-01T00:00:00Z"

    # 2. Query new articles from govbrnews DB
    articles = govbr_hook.get_records("""
        SELECT n.unique_id, n.title, n.content, n.url, n.image_url,
               n.tags, n.published_at, n.created_at,
               n.agency_key, n.theme_l1_id, t.code as theme_code
        FROM news n
        LEFT JOIN themes t ON n.theme_l1_id = t.id
        WHERE n.created_at > %s
        ORDER BY n.created_at ASC
        LIMIT 500
    """, parameters=[last_processed_at])

    return articles  # passed via XCom
```

### Task 2: `enqueue_articles`
Using `PostgresHook(postgres_conn_id="federation_postgres")` (federation DB):

```python
@task
def enqueue_articles(articles):
    """Insert queue rows with news_payload for each actor mapping."""
    if not articles:
        return {"queued": 0}

    fed_hook = PostgresHook(postgres_conn_id="federation_postgres")

    max_created_at = None
    total_queued = 0

    for row in articles:
        unique_id, title, content, url, image_url, tags, published_at, created_at, agency_key, theme_l1_id, theme_code = row

        news_payload = {
            "unique_id": unique_id,
            "title": title,
            "content_html": content,
            "summary": None,  # govbrnews doesn't have summary
            "image_url": image_url,
            "tags": tags or [],
            "published_at": published_at.isoformat(),
            "canonical_url": url,
        }

        # Determine target actors
        actors = ["portal"]  # always
        if agency_key:
            actors.append(agency_key)
        if theme_code:
            actors.append(f"tema-{theme_code}")

        for actor in actors:
            fed_hook.run("""
                INSERT INTO ap_publish_queue (news_unique_id, actor_identifier, news_payload)
                VALUES (%s, %s, %s::jsonb)
                ON CONFLICT (news_unique_id, actor_identifier) DO NOTHING
            """, parameters=[unique_id, actor, json.dumps(news_payload)])
            total_queued += 1

        if max_created_at is None or created_at > max_created_at:
            max_created_at = created_at

    # Update watermark
    if max_created_at:
        fed_hook.run("""
            INSERT INTO ap_sync_watermark (id, last_processed_at, last_run_at, articles_queued)
            VALUES (1, %s, NOW(), %s)
            ON CONFLICT (id) DO UPDATE SET
                last_processed_at = EXCLUDED.last_processed_at,
                last_run_at = EXCLUDED.last_run_at,
                articles_queued = EXCLUDED.articles_queued
        """, parameters=[max_created_at, total_queued])

    return {"queued": total_queued}
```

### Task 3: `trigger_publish`
HTTP call to federation web service:

```python
@task
def trigger_publish(enqueue_result):
    """Call /trigger-publish on the federation web service."""
    if enqueue_result["queued"] == 0:
        return {"skipped": True}

    import requests
    from airflow.models import Variable

    web_url = Variable.get("federation_web_url")
    auth_token = Variable.get("federation_auth_token")

    resp = requests.post(
        f"{web_url}/trigger-publish",
        headers={"Authorization": f"Bearer {auth_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()
```

### Flow:
```python
articles = detect_new_articles()
result = enqueue_articles(articles)
trigger_publish(result)
```

---

## Work Stream 6: Deployment Order

1. **Terraform apply** — Create new secrets and IAM bindings
2. **Schema migration** — Run `migrate-add-payload.ts` on federation DB
3. **Deploy federation server** — Push to `activitypub-server` main (CI/CD deploys to Cloud Run)
4. **Deploy DAG** — Push to `data-platform` main (CI/CD syncs DAG to Composer)
5. **Verify** — Check Airflow UI for successful DAG runs, check federation logs for delivery

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `activitypub-server/sql/schema.sql` | Add `news_payload JSONB` column |
| `activitypub-server/scripts/migrate-add-payload.ts` | New migration script |
| `activitypub-server/src/db.ts` | Update `PublishQueueRow`, `getPendingPublishQueue()` |
| `activitypub-server/src/publisher.ts` | Remove `fetchNews`, read `news_payload` |
| `activitypub-server/tests/unit/publisher.test.ts` | Update test fixtures |
| `activitypub-server/tests/integration/publish-flow.test.ts` | Update queue insertions |
| `infra/terraform/composer_secrets.tf` | Add federation connection + variables |
| `infra/terraform/composer_iam.tf` | Grant Composer SA secret access |
| `data-platform/src/data_platform/dags/federation_publish.py` | New DAG file |
