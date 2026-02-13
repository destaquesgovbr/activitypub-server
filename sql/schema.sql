-- ActivityPub Federation Schema
-- Database: federation (separate Cloud SQL instance)

-- Actors: 182 total (1 portal + 156 agencies + 25 themes)
CREATE TABLE IF NOT EXISTS ap_actors (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(150) UNIQUE NOT NULL,
    actor_type VARCHAR(20) NOT NULL
        CHECK (actor_type IN ('agency', 'theme', 'portal')),
    display_name VARCHAR(500) NOT NULL,
    summary TEXT,
    icon_url TEXT,
    agency_key VARCHAR(100),
    theme_code VARCHAR(10),
    rsa_public_key_jwk JSONB NOT NULL,
    rsa_private_key_jwk JSONB NOT NULL,
    ed25519_public_key_jwk JSONB,
    ed25519_private_key_jwk JSONB,
    keys_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Followers: remote accounts that follow our actors
CREATE TABLE IF NOT EXISTS ap_followers (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES ap_actors(id) ON DELETE CASCADE,
    follower_uri TEXT NOT NULL,
    follower_inbox_uri TEXT NOT NULL,
    follower_shared_inbox_uri TEXT,
    follower_server TEXT NOT NULL,
    follow_activity_uri TEXT,
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active', 'pending', 'removed')),
    followed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(actor_id, follower_uri)
);
CREATE INDEX IF NOT EXISTS idx_ap_followers_actor
    ON ap_followers(actor_id) WHERE status = 'active';

-- Publish queue: filled by Airflow DAG, consumed by federation-web /trigger-publish
CREATE TABLE IF NOT EXISTS ap_publish_queue (
    id SERIAL PRIMARY KEY,
    news_unique_id VARCHAR(32) NOT NULL,
    actor_identifier VARCHAR(150) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'published', 'failed')),
    error_message TEXT,
    queued_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE(news_unique_id, actor_identifier)
);
CREATE INDEX IF NOT EXISTS idx_ap_publish_queue_pending
    ON ap_publish_queue(queued_at) WHERE status = 'pending';

-- Activities: log of published AP activities
CREATE TABLE IF NOT EXISTS ap_activities (
    id SERIAL PRIMARY KEY,
    activity_uri TEXT UNIQUE NOT NULL,
    activity_type VARCHAR(50) NOT NULL,
    actor_id INTEGER NOT NULL REFERENCES ap_actors(id),
    news_unique_id VARCHAR(32) NOT NULL,
    total_recipients INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'queued'
        CHECK (status IN ('queued', 'delivering', 'completed', 'partial', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    delivery_completed_at TIMESTAMPTZ
);

-- Delivery log: per-inbox delivery attempts
CREATE TABLE IF NOT EXISTS ap_delivery_log (
    id SERIAL PRIMARY KEY,
    activity_id INTEGER NOT NULL REFERENCES ap_activities(id) ON DELETE CASCADE,
    target_inbox_uri TEXT NOT NULL,
    target_server TEXT NOT NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
    http_status_code SMALLINT,
    error_message TEXT,
    attempt_count SMALLINT DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    first_attempted_at TIMESTAMPTZ DEFAULT NOW(),
    succeeded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ap_delivery_pending
    ON ap_delivery_log(next_retry_at) WHERE status = 'failed';

-- Dead servers: permanently unreachable remote servers
CREATE TABLE IF NOT EXISTS ap_dead_servers (
    id SERIAL PRIMARY KEY,
    server_hostname TEXT UNIQUE NOT NULL,
    consecutive_failures INTEGER DEFAULT 0,
    first_failure_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    is_dead BOOLEAN DEFAULT FALSE,
    next_probe_at TIMESTAMPTZ
);

-- Sync watermark: Airflow DAG checkpoint (singleton row)
CREATE TABLE IF NOT EXISTS ap_sync_watermark (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_processed_at TIMESTAMPTZ NOT NULL,
    last_run_at TIMESTAMPTZ NOT NULL,
    articles_queued INTEGER DEFAULT 0
);
INSERT INTO ap_sync_watermark (last_processed_at, last_run_at)
    VALUES (NOW(), NOW())
    ON CONFLICT (id) DO NOTHING;
