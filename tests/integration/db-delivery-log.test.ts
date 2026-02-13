import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { TEST_ACTORS } from "../helpers/fixtures.js";

async function seedActivityChain(sql: ReturnType<typeof getSql>) {
	const a = TEST_ACTORS.agricultura;
	const [actor] = await sql`
		INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk)
		VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})
		RETURNING id
	`;

	const [activity] = await sql`
		INSERT INTO ap_activities (activity_uri, activity_type, actor_id, news_unique_id)
		VALUES ('https://example.com/ap/activities/test-001', 'Create', ${actor.id}, 'news-abc')
		RETURNING id
	`;

	return { actorId: actor.id as number, activityId: activity.id as number };
}

describe("ap_delivery_log table", () => {
	beforeAll(async () => {
		await setupTestDatabase();
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	it("inserts delivery log with success status", async () => {
		const sql = getSql();
		const { activityId } = await seedActivityChain(sql);

		await sql`
			INSERT INTO ap_delivery_log (activity_id, target_inbox_uri, target_server, status, http_status_code, succeeded_at)
			VALUES (${activityId}, 'https://mastodon.social/inbox', 'mastodon.social', 'success', 202, NOW())
		`;

		const [row] = await sql`SELECT * FROM ap_delivery_log WHERE activity_id = ${activityId}`;
		expect(row.status).toBe("success");
		expect(row.http_status_code).toBe(202);
		expect(row.succeeded_at).not.toBeNull();
	});

	it("inserts delivery log with failed status and error", async () => {
		const sql = getSql();
		const { activityId } = await seedActivityChain(sql);

		await sql`
			INSERT INTO ap_delivery_log (activity_id, target_inbox_uri, target_server, status, http_status_code, error_message, attempt_count)
			VALUES (${activityId}, 'https://dead.server/inbox', 'dead.server', 'failed', 500, 'Internal Server Error', 3)
		`;

		const [row] = await sql`SELECT * FROM ap_delivery_log WHERE target_server = 'dead.server'`;
		expect(row.status).toBe("failed");
		expect(row.error_message).toBe("Internal Server Error");
		expect(row.attempt_count).toBe(3);
	});

	it("updates attempt_count and next_retry_at", async () => {
		const sql = getSql();
		const { activityId } = await seedActivityChain(sql);

		await sql`
			INSERT INTO ap_delivery_log (activity_id, target_inbox_uri, target_server, status)
			VALUES (${activityId}, 'https://mastodon.social/inbox', 'mastodon.social', 'failed')
		`;

		const nextRetry = new Date(Date.now() + 60_000);
		await sql`
			UPDATE ap_delivery_log
			SET attempt_count = attempt_count + 1, next_retry_at = ${nextRetry}
			WHERE activity_id = ${activityId} AND target_server = 'mastodon.social'
		`;

		const [row] =
			await sql`SELECT attempt_count, next_retry_at FROM ap_delivery_log WHERE activity_id = ${activityId}`;
		expect(row.attempt_count).toBe(1);
		expect(row.next_retry_at).not.toBeNull();
	});

	it("aggregates success rate by server", async () => {
		const sql = getSql();
		const { activityId } = await seedActivityChain(sql);

		await sql`
			INSERT INTO ap_delivery_log (activity_id, target_inbox_uri, target_server, status)
			VALUES
				(${activityId}, 'https://a.com/inbox', 'a.com', 'success'),
				(${activityId}, 'https://a.com/inbox2', 'a.com', 'success'),
				(${activityId}, 'https://a.com/inbox3', 'a.com', 'failed')
		`;

		const [row] = await sql`
			SELECT target_server,
				COUNT(*) FILTER (WHERE status = 'success')::int as ok,
				COUNT(*) FILTER (WHERE status = 'failed')::int as fail
			FROM ap_delivery_log
			GROUP BY target_server
		`;
		expect(row.ok).toBe(2);
		expect(row.fail).toBe(1);
	});

	it("cascade deletes logs when activity is removed", async () => {
		const sql = getSql();
		const { activityId } = await seedActivityChain(sql);

		await sql`
			INSERT INTO ap_delivery_log (activity_id, target_inbox_uri, target_server, status)
			VALUES (${activityId}, 'https://mastodon.social/inbox', 'mastodon.social', 'success')
		`;

		await sql`DELETE FROM ap_activities WHERE id = ${activityId}`;

		const rows = await sql`SELECT * FROM ap_delivery_log WHERE activity_id = ${activityId}`;
		expect(rows).toHaveLength(0);
	});
});
