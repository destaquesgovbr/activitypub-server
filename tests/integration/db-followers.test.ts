import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { TEST_ACTORS } from "../helpers/fixtures.js";

async function seedActor(sql: ReturnType<typeof getSql>) {
	const a = TEST_ACTORS.agricultura;
	const [row] = await sql`
		INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk)
		VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})
		RETURNING id
	`;
	return row.id as number;
}

describe("ap_followers table", () => {
	beforeAll(async () => {
		await setupTestDatabase();
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	it("inserts follower and selects by actor_id", async () => {
		const sql = getSql();
		const actorId = await seedActor(sql);

		await sql`
			INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server)
			VALUES (${actorId}, 'https://mastodon.social/users/alice', 'https://mastodon.social/users/alice/inbox', 'mastodon.social')
		`;

		const rows = await sql`SELECT * FROM ap_followers WHERE actor_id = ${actorId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].follower_uri).toBe("https://mastodon.social/users/alice");
		expect(rows[0].status).toBe("active");
	});

	it("enforces unique (actor_id, follower_uri)", async () => {
		const sql = getSql();
		const actorId = await seedActor(sql);
		const followerUri = "https://mastodon.social/users/alice";

		await sql`
			INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server)
			VALUES (${actorId}, ${followerUri}, 'https://mastodon.social/users/alice/inbox', 'mastodon.social')
		`;

		await expect(
			sql`INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server)
				VALUES (${actorId}, ${followerUri}, 'https://mastodon.social/users/alice/inbox', 'mastodon.social')`,
		).rejects.toThrow(/unique/i);
	});

	it("updates status to removed (unfollow)", async () => {
		const sql = getSql();
		const actorId = await seedActor(sql);
		const followerUri = "https://mastodon.social/users/alice";

		await sql`
			INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server)
			VALUES (${actorId}, ${followerUri}, 'https://mastodon.social/users/alice/inbox', 'mastodon.social')
		`;

		await sql`UPDATE ap_followers SET status = 'removed' WHERE actor_id = ${actorId} AND follower_uri = ${followerUri}`;

		const [row] =
			await sql`SELECT status FROM ap_followers WHERE actor_id = ${actorId} AND follower_uri = ${followerUri}`;
		expect(row.status).toBe("removed");
	});

	it("selects only active followers", async () => {
		const sql = getSql();
		const actorId = await seedActor(sql);

		await sql`
			INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server, status)
			VALUES
				(${actorId}, 'https://mastodon.social/users/alice', 'https://mastodon.social/users/alice/inbox', 'mastodon.social', 'active'),
				(${actorId}, 'https://mastodon.social/users/bob', 'https://mastodon.social/users/bob/inbox', 'mastodon.social', 'removed')
		`;

		const active =
			await sql`SELECT * FROM ap_followers WHERE actor_id = ${actorId} AND status = 'active'`;
		expect(active).toHaveLength(1);
		expect(active[0].follower_uri).toContain("alice");
	});

	it("filters by follower_server", async () => {
		const sql = getSql();
		const actorId = await seedActor(sql);

		await sql`
			INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server)
			VALUES
				(${actorId}, 'https://mastodon.social/users/alice', 'https://mastodon.social/users/alice/inbox', 'mastodon.social'),
				(${actorId}, 'https://fosstodon.org/users/bob', 'https://fosstodon.org/users/bob/inbox', 'fosstodon.org')
		`;

		const mastodon =
			await sql`SELECT * FROM ap_followers WHERE follower_server = 'mastodon.social'`;
		expect(mastodon).toHaveLength(1);
	});

	it("cascade deletes followers when actor is removed", async () => {
		const sql = getSql();
		const actorId = await seedActor(sql);

		await sql`
			INSERT INTO ap_followers (actor_id, follower_uri, follower_inbox_uri, follower_server)
			VALUES (${actorId}, 'https://mastodon.social/users/alice', 'https://mastodon.social/users/alice/inbox', 'mastodon.social')
		`;

		await sql`DELETE FROM ap_actors WHERE id = ${actorId}`;

		const rows = await sql`SELECT * FROM ap_followers WHERE actor_id = ${actorId}`;
		expect(rows).toHaveLength(0);
	});
});
