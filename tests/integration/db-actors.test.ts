import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { makeTestActor, TEST_ACTORS } from "../helpers/fixtures.js";

describe("ap_actors table", () => {
	beforeAll(async () => {
		await setupTestDatabase();
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	it("inserts and selects actor by identifier", async () => {
		const sql = getSql();
		const a = TEST_ACTORS.agricultura;
		await sql`
			INSERT INTO ap_actors (identifier, actor_type, display_name, summary, agency_key, rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk, ed25519_private_key_jwk)
			VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${a.summary}, ${a.agency_key}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)}, ${sql.json(a.ed25519_public_key_jwk)}, ${sql.json(a.ed25519_private_key_jwk)})
		`;

		const [row] = await sql`SELECT * FROM ap_actors WHERE identifier = ${a.identifier}`;
		expect(row.identifier).toBe("agricultura");
		expect(row.actor_type).toBe("agency");
		expect(row.display_name).toBe("Ministério da Agricultura");
		expect(row.is_active).toBe(true);
	});

	it("stores and retrieves RSA/Ed25519 JWK keys correctly", async () => {
		const sql = getSql();
		const a = TEST_ACTORS.portal;
		await sql`
			INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk, ed25519_private_key_jwk)
			VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)}, ${sql.json(a.ed25519_public_key_jwk)}, ${sql.json(a.ed25519_private_key_jwk)})
		`;

		const [row] =
			await sql`SELECT rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk FROM ap_actors WHERE identifier = 'portal'`;
		expect(row.rsa_public_key_jwk.kty).toBe("RSA");
		expect(row.rsa_private_key_jwk.d).toBeDefined();
		expect(row.ed25519_public_key_jwk.crv).toBe("Ed25519");
	});

	it("enforces unique identifier constraint", async () => {
		const sql = getSql();
		const a = TEST_ACTORS.agricultura;
		await sql`
			INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk)
			VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})
		`;

		await expect(
			sql`INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk)
				VALUES (${a.identifier}, ${a.actor_type}, 'Duplicate', ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})`,
		).rejects.toThrow(/unique/i);
	});

	it("rejects invalid actor_type", async () => {
		const sql = getSql();
		const a = makeTestActor({ identifier: "bad-type", actor_type: "invalid" });
		await expect(
			sql`INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk)
				VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})`,
		).rejects.toThrow();
	});

	it("filters actors by actor_type", async () => {
		const sql = getSql();
		for (const a of Object.values(TEST_ACTORS)) {
			await sql`
				INSERT INTO ap_actors (identifier, actor_type, display_name, agency_key, theme_code, rsa_public_key_jwk, rsa_private_key_jwk)
				VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${a.agency_key}, ${a.theme_code}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})
			`;
		}

		const agencies = await sql`SELECT * FROM ap_actors WHERE actor_type = 'agency'`;
		expect(agencies).toHaveLength(1);
		expect(agencies[0].identifier).toBe("agricultura");

		const themes = await sql`SELECT * FROM ap_actors WHERE actor_type = 'theme'`;
		expect(themes).toHaveLength(1);

		const portals = await sql`SELECT * FROM ap_actors WHERE actor_type = 'portal'`;
		expect(portals).toHaveLength(1);
	});

	it("defaults is_active to true", async () => {
		const sql = getSql();
		const a = TEST_ACTORS.agricultura;
		await sql`
			INSERT INTO ap_actors (identifier, actor_type, display_name, rsa_public_key_jwk, rsa_private_key_jwk)
			VALUES (${a.identifier}, ${a.actor_type}, ${a.display_name}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})
		`;

		const [row] = await sql`SELECT is_active FROM ap_actors WHERE identifier = ${a.identifier}`;
		expect(row.is_active).toBe(true);
	});
});
