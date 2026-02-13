import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";

describe("ap_dead_servers table", () => {
	beforeAll(async () => {
		await setupTestDatabase();
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	it("inserts server with initial failure", async () => {
		const sql = getSql();
		await sql`
			INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, first_failure_at, last_failure_at)
			VALUES ('dead.server', 1, NOW(), NOW())
		`;

		const [row] = await sql`SELECT * FROM ap_dead_servers WHERE server_hostname = 'dead.server'`;
		expect(row.consecutive_failures).toBe(1);
		expect(row.is_dead).toBe(false);
	});

	it("increments consecutive_failures", async () => {
		const sql = getSql();
		await sql`
			INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, first_failure_at, last_failure_at)
			VALUES ('failing.server', 10, NOW(), NOW())
		`;

		await sql`
			UPDATE ap_dead_servers
			SET consecutive_failures = consecutive_failures + 1, last_failure_at = NOW()
			WHERE server_hostname = 'failing.server'
		`;

		const [row] =
			await sql`SELECT consecutive_failures FROM ap_dead_servers WHERE server_hostname = 'failing.server'`;
		expect(row.consecutive_failures).toBe(11);
	});

	it("marks server as dead when failures >= 50", async () => {
		const sql = getSql();
		await sql`
			INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, first_failure_at, last_failure_at)
			VALUES ('almost-dead.server', 49, NOW(), NOW())
		`;

		await sql`
			UPDATE ap_dead_servers
			SET consecutive_failures = consecutive_failures + 1,
				is_dead = (consecutive_failures + 1 >= 50),
				last_failure_at = NOW()
			WHERE server_hostname = 'almost-dead.server'
		`;

		const [row] =
			await sql`SELECT is_dead, consecutive_failures FROM ap_dead_servers WHERE server_hostname = 'almost-dead.server'`;
		expect(row.consecutive_failures).toBe(50);
		expect(row.is_dead).toBe(true);
	});

	it("selects dead servers", async () => {
		const sql = getSql();
		await sql`
			INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, is_dead, first_failure_at, last_failure_at)
			VALUES
				('dead1.server', 50, TRUE, NOW(), NOW()),
				('dead2.server', 60, TRUE, NOW(), NOW()),
				('alive.server', 5, FALSE, NOW(), NOW())
		`;

		const rows = await sql`SELECT * FROM ap_dead_servers WHERE is_dead = TRUE`;
		expect(rows).toHaveLength(2);
	});

	it("resets server for probe", async () => {
		const sql = getSql();
		const nextProbe = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 1 week
		await sql`
			INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, is_dead, first_failure_at, last_failure_at)
			VALUES ('dead.server', 50, TRUE, NOW(), NOW())
		`;

		await sql`
			UPDATE ap_dead_servers
			SET is_dead = FALSE, next_probe_at = ${nextProbe}
			WHERE server_hostname = 'dead.server'
		`;

		const [row] =
			await sql`SELECT is_dead, next_probe_at FROM ap_dead_servers WHERE server_hostname = 'dead.server'`;
		expect(row.is_dead).toBe(false);
		expect(row.next_probe_at).not.toBeNull();
	});

	it("enforces unique server_hostname", async () => {
		const sql = getSql();
		await sql`
			INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, first_failure_at, last_failure_at)
			VALUES ('dup.server', 1, NOW(), NOW())
		`;

		await expect(
			sql`INSERT INTO ap_dead_servers (server_hostname, consecutive_failures, first_failure_at, last_failure_at)
				VALUES ('dup.server', 1, NOW(), NOW())`,
		).rejects.toThrow(/unique/i);
	});
});
