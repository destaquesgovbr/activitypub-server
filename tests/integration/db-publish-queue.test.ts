import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";

describe("ap_publish_queue table", () => {
	beforeAll(async () => {
		await setupTestDatabase();
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	it("inserts entry and selects pending items", async () => {
		const sql = getSql();
		await sql`
			INSERT INTO ap_publish_queue (news_unique_id, actor_identifier)
			VALUES ('abc123', 'agricultura')
		`;

		const rows = await sql`SELECT * FROM ap_publish_queue WHERE status = 'pending'`;
		expect(rows).toHaveLength(1);
		expect(rows[0].news_unique_id).toBe("abc123");
		expect(rows[0].actor_identifier).toBe("agricultura");
	});

	it("enforces unique (news_unique_id, actor_identifier)", async () => {
		const sql = getSql();
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('abc123', 'agricultura')`;

		await expect(
			sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('abc123', 'agricultura')`,
		).rejects.toThrow(/unique/i);
	});

	it("ON CONFLICT DO NOTHING is idempotent", async () => {
		const sql = getSql();
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('abc123', 'agricultura')`;

		await sql`
			INSERT INTO ap_publish_queue (news_unique_id, actor_identifier)
			VALUES ('abc123', 'agricultura')
			ON CONFLICT (news_unique_id, actor_identifier) DO NOTHING
		`;

		const rows = await sql`SELECT * FROM ap_publish_queue`;
		expect(rows).toHaveLength(1);
	});

	it("transitions status: pending → processing → published", async () => {
		const sql = getSql();
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('abc123', 'agricultura')`;

		await sql`UPDATE ap_publish_queue SET status = 'processing' WHERE news_unique_id = 'abc123'`;
		let [row] =
			await sql`SELECT status FROM ap_publish_queue WHERE news_unique_id = 'abc123' AND actor_identifier = 'agricultura'`;
		expect(row.status).toBe("processing");

		await sql`UPDATE ap_publish_queue SET status = 'published', processed_at = NOW() WHERE news_unique_id = 'abc123'`;
		[row] =
			await sql`SELECT status, processed_at FROM ap_publish_queue WHERE news_unique_id = 'abc123' AND actor_identifier = 'agricultura'`;
		expect(row.status).toBe("published");
		expect(row.processed_at).not.toBeNull();
	});

	it("transitions status: pending → failed with error_message", async () => {
		const sql = getSql();
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('abc123', 'agricultura')`;

		const errorMsg = "Actor not found";
		await sql`UPDATE ap_publish_queue SET status = 'failed', error_message = ${errorMsg}, processed_at = NOW() WHERE news_unique_id = 'abc123'`;

		const [row] =
			await sql`SELECT status, error_message FROM ap_publish_queue WHERE news_unique_id = 'abc123' AND actor_identifier = 'agricultura'`;
		expect(row.status).toBe("failed");
		expect(row.error_message).toBe("Actor not found");
	});

	it("selects pending items ordered by queued_at", async () => {
		const sql = getSql();
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('first', 'agricultura')`;
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('second', 'portal')`;
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier, status) VALUES ('done', 'portal', 'published')`;

		const rows =
			await sql`SELECT * FROM ap_publish_queue WHERE status = 'pending' ORDER BY queued_at`;
		expect(rows).toHaveLength(2);
		expect(rows[0].news_unique_id).toBe("first");
		expect(rows[1].news_unique_id).toBe("second");
	});

	it("counts pending items correctly", async () => {
		const sql = getSql();
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('a', 'agricultura')`;
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) VALUES ('b', 'portal')`;
		await sql`INSERT INTO ap_publish_queue (news_unique_id, actor_identifier, status) VALUES ('c', 'portal', 'published')`;

		const [{ count }] =
			await sql`SELECT COUNT(*)::int as count FROM ap_publish_queue WHERE status = 'pending'`;
		expect(count).toBe(2);
	});
});
