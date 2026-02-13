import postgres from "postgres";

let pool: postgres.Sql | null = null;

export function getPool(): postgres.Sql {
	if (!pool) {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) {
			throw new Error("DATABASE_URL environment variable is required");
		}
		pool = postgres(databaseUrl);
	}
	return pool;
}

export function setPool(p: postgres.Sql): void {
	pool = p;
}

export async function closePool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
	}
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export interface ActorRow {
	id: number;
	identifier: string;
	actor_type: "agency" | "theme" | "portal";
	display_name: string;
	summary: string | null;
	icon_url: string | null;
	agency_key: string | null;
	theme_code: string | null;
	rsa_public_key_jwk: Record<string, unknown>;
	rsa_private_key_jwk: Record<string, unknown>;
	ed25519_public_key_jwk: Record<string, unknown> | null;
	ed25519_private_key_jwk: Record<string, unknown> | null;
	is_active: boolean;
}

export async function getActorByIdentifier(identifier: string): Promise<ActorRow | null> {
	const sql = getPool();
	const rows = await sql<ActorRow[]>`
		SELECT * FROM ap_actors WHERE identifier = ${identifier} AND is_active = TRUE
	`;
	return rows[0] ?? null;
}

export async function getAllActors(): Promise<ActorRow[]> {
	const sql = getPool();
	return sql<ActorRow[]>`SELECT * FROM ap_actors WHERE is_active = TRUE ORDER BY identifier`;
}

// ---------------------------------------------------------------------------
// Followers
// ---------------------------------------------------------------------------

export interface FollowerRow {
	id: number;
	actor_id: number;
	follower_uri: string;
	follower_inbox_uri: string;
	follower_shared_inbox_uri: string | null;
	follower_server: string;
	follow_activity_uri: string | null;
	status: "active" | "pending" | "removed";
	followed_at: Date;
}

export async function getActiveFollowers(actorId: number): Promise<FollowerRow[]> {
	const sql = getPool();
	return sql<FollowerRow[]>`
		SELECT * FROM ap_followers WHERE actor_id = ${actorId} AND status = 'active'
	`;
}

export async function insertFollower(params: {
	actorId: number;
	followerUri: string;
	followerInboxUri: string;
	followerSharedInboxUri: string | null;
	followerServer: string;
	followActivityUri: string | null;
}): Promise<FollowerRow> {
	const sql = getPool();
	const [row] = await sql<FollowerRow[]>`
		INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_shared_inbox_uri, follower_server, follow_activity_uri)
		VALUES (${params.actorId}, ${params.followerUri}, ${params.followerInboxUri}, ${params.followerSharedInboxUri}, ${params.followerServer}, ${params.followActivityUri})
		ON CONFLICT (actor_id, follower_uri) DO UPDATE SET
			status = 'active',
			follower_inbox_uri = EXCLUDED.follower_inbox_uri,
			follower_shared_inbox_uri = EXCLUDED.follower_shared_inbox_uri,
			followed_at = NOW()
		RETURNING *
	`;
	return row;
}

export async function removeFollower(actorId: number, followerUri: string): Promise<void> {
	const sql = getPool();
	await sql`
		UPDATE ap_followers SET status = 'removed'
		WHERE actor_id = ${actorId} AND follower_uri = ${followerUri}
	`;
}

// ---------------------------------------------------------------------------
// Publish Queue
// ---------------------------------------------------------------------------

export interface PublishQueueRow {
	id: number;
	news_unique_id: string;
	actor_identifier: string;
	status: "pending" | "processing" | "published" | "failed";
	error_message: string | null;
	queued_at: Date;
	processed_at: Date | null;
}

export async function getPendingPublishQueue(limit: number): Promise<PublishQueueRow[]> {
	const sql = getPool();
	return sql<PublishQueueRow[]>`
		SELECT * FROM ap_publish_queue
		WHERE status = 'pending'
		ORDER BY queued_at
		LIMIT ${limit}
	`;
}

export async function markPublished(id: number): Promise<void> {
	const sql = getPool();
	await sql`
		UPDATE ap_publish_queue SET status = 'published', processed_at = NOW()
		WHERE id = ${id}
	`;
}

export async function markFailed(id: number, errorMessage: string): Promise<void> {
	const sql = getPool();
	await sql`
		UPDATE ap_publish_queue SET status = 'failed', error_message = ${errorMessage}, processed_at = NOW()
		WHERE id = ${id}
	`;
}

export async function getPublishedItemsForActor(
	actorIdentifier: string,
	limit: number,
	offset = 0,
): Promise<{ items: PublishQueueRow[]; totalCount: number }> {
	const sql = getPool();
	const items = await sql<PublishQueueRow[]>`
		SELECT * FROM ap_publish_queue
		WHERE actor_identifier = ${actorIdentifier} AND status = 'published'
		ORDER BY processed_at DESC
		LIMIT ${limit} OFFSET ${offset}
	`;
	const [{ count }] = await sql<{ count: number }[]>`
		SELECT COUNT(*)::int as count FROM ap_publish_queue
		WHERE actor_identifier = ${actorIdentifier} AND status = 'published'
	`;
	return { items, totalCount: count };
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export interface ActivityRow {
	id: number;
	activity_uri: string;
	activity_type: string;
	actor_id: number;
	news_unique_id: string;
	total_recipients: number;
	delivered_count: number;
	failed_count: number;
	status: string;
	created_at: Date;
}

export async function insertActivity(params: {
	activityUri: string;
	activityType: string;
	actorId: number;
	newsUniqueId: string;
	totalRecipients: number;
}): Promise<ActivityRow> {
	const sql = getPool();
	const [row] = await sql<ActivityRow[]>`
		INSERT INTO ap_activities (activity_uri, activity_type, actor_id, news_unique_id, total_recipients)
		VALUES (${params.activityUri}, ${params.activityType}, ${params.actorId}, ${params.newsUniqueId}, ${params.totalRecipients})
		RETURNING *
	`;
	return row;
}

// ---------------------------------------------------------------------------
// Delivery Log
// ---------------------------------------------------------------------------

export async function insertDeliveryLog(params: {
	activityId: number;
	targetInboxUri: string;
	targetServer: string;
	status: "pending" | "success" | "failed" | "abandoned";
	httpStatusCode?: number;
	errorMessage?: string;
}): Promise<void> {
	const sql = getPool();
	await sql`
		INSERT INTO ap_delivery_log (activity_id, target_inbox_uri, target_server, status, http_status_code, error_message)
		VALUES (${params.activityId}, ${params.targetInboxUri}, ${params.targetServer}, ${params.status}, ${params.httpStatusCode ?? null}, ${params.errorMessage ?? null})
	`;
}

// ---------------------------------------------------------------------------
// Dead Servers
// ---------------------------------------------------------------------------

export async function recordServerFailure(serverHostname: string): Promise<boolean> {
	const sql = getPool();
	const [row] = await sql<{ is_dead: boolean }[]>`
		INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, first_failure_at, last_failure_at)
		VALUES (${serverHostname}, 1, NOW(), NOW())
		ON CONFLICT (server_hostname) DO UPDATE SET
			consecutive_failures = ap_dead_servers.consecutive_failures + 1,
			last_failure_at = NOW(),
			is_dead = (ap_dead_servers.consecutive_failures + 1 >= 50)
		RETURNING is_dead
	`;
	return row.is_dead;
}

export async function isServerDead(serverHostname: string): Promise<boolean> {
	const sql = getPool();
	const rows = await sql<{ is_dead: boolean }[]>`
		SELECT is_dead FROM ap_dead_servers WHERE server_hostname = ${serverHostname}
	`;
	return rows[0]?.is_dead ?? false;
}

export async function getDeadServersForProbe(): Promise<string[]> {
	const sql = getPool();
	const rows = await sql<{ server_hostname: string }[]>`
		SELECT server_hostname FROM ap_dead_servers
		WHERE is_dead = TRUE AND (next_probe_at IS NULL OR next_probe_at <= NOW())
	`;
	return rows.map((r) => r.server_hostname);
}

export async function resetServerForProbe(serverHostname: string): Promise<void> {
	const sql = getPool();
	const nextProbe = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 1 week
	await sql`
		UPDATE ap_dead_servers
		SET is_dead = FALSE, consecutive_failures = 0, next_probe_at = ${nextProbe}
		WHERE server_hostname = ${serverHostname}
	`;
}
