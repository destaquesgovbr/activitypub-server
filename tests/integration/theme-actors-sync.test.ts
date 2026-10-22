import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	applyThemeActorSync,
	getThemeActorStates,
	planThemeActorSync,
} from "../../src/theme-actors.js";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import {
	makeTestActor,
	TEST_ED25519_PRIVATE_JWK,
	TEST_ED25519_PUBLIC_JWK,
	TEST_RSA_PRIVATE_JWK,
	TEST_RSA_PUBLIC_JWK,
} from "../helpers/fixtures.js";

const fakeKeys = async () => ({
	rsaPublicJwk: TEST_RSA_PUBLIC_JWK as JsonWebKey,
	rsaPrivateJwk: TEST_RSA_PRIVATE_JWK as JsonWebKey,
	edPublicJwk: TEST_ED25519_PUBLIC_JWK as JsonWebKey,
	edPrivateJwk: TEST_ED25519_PRIVATE_JWK as JsonWebKey,
});

// Árvore depois do tema 26: sem 22/23, com 26.
const LABELS = new Map([
	["01", "Economia e Finanças"],
	["19", "Defesa e Forças Armadas"],
	["24", "Minorias e Grupos Especiais"],
	["26", "Defesa Civil e Gestão de Desastres"],
]);

async function insertActor(overrides: Record<string, unknown>) {
	const sql = getSql();
	const a = makeTestActor(overrides);
	await sql`
		INSERT INTO ap_actors (identifier, actor_type, display_name, agency_key, theme_code, is_active, rsa_public_key_jwk, rsa_private_key_jwk)
		VALUES (${a.identifier as string}, ${a.actor_type as string}, ${a.display_name as string}, ${a.agency_key as string | null}, ${a.theme_code as string | null}, ${(overrides.is_active as boolean | undefined) ?? true}, ${sql.json(a.rsa_public_key_jwk)}, ${sql.json(a.rsa_private_key_jwk)})
	`;
}

async function insertTheme(code: string, label: string, isActive = true) {
	await insertActor({
		identifier: `tema-${code}`,
		actor_type: "theme",
		display_name: label,
		agency_key: null,
		theme_code: code,
		is_active: isActive,
	});
}

describe("theme actor sync (tema 26)", () => {
	beforeAll(async () => {
		await setupTestDatabase();
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	it("creates tema-26, deactivates tema-22/23 and reactivates tema-24 without touching other actors", async () => {
		const sql = getSql();
		await insertActor({ identifier: "mdr", actor_type: "agency", agency_key: "mdr" });
		await insertTheme("01", "Economia e Finanças");
		await insertTheme("19", "Defesa e Forças Armadas");
		await insertTheme("22", "Eventos Oficiais e Cerimônias");
		await insertTheme("23", "Estatísticas e Dados Públicos");
		await insertTheme("24", "Minorias e Grupos Especiais", false);

		const plan = planThemeActorSync(await getThemeActorStates(sql), LABELS);
		const result = await applyThemeActorSync(sql, plan, fakeKeys);

		expect(result).toEqual({ created: 1, deactivated: 2, reactivated: 1 });

		const rows = await sql<
			{ identifier: string; is_active: boolean; theme_code: string | null; display_name: string }[]
		>`SELECT identifier, is_active, theme_code, display_name FROM ap_actors ORDER BY identifier`;
		const byId = Object.fromEntries(rows.map((r) => [r.identifier, r]));

		expect(byId["tema-26"]).toMatchObject({
			is_active: true,
			theme_code: "26",
			display_name: "Defesa Civil e Gestão de Desastres",
		});
		expect(byId["tema-22"].is_active).toBe(false);
		expect(byId["tema-23"].is_active).toBe(false);
		expect(byId["tema-24"].is_active).toBe(true);
		expect(byId["tema-01"].is_active).toBe(true);
		expect(byId.mdr.is_active).toBe(true);

		const [created] = await sql`
			SELECT actor_type, summary, rsa_public_key_jwk, ed25519_public_key_jwk
			FROM ap_actors WHERE identifier = 'tema-26'
		`;
		expect(created.actor_type).toBe("theme");
		expect(created.summary).toBe("Notícias sobre Defesa Civil e Gestão de Desastres");
		expect(created.rsa_public_key_jwk.kty).toBe("RSA");
		expect(created.ed25519_public_key_jwk.crv).toBe("Ed25519");
	});

	it("is idempotent: a second sync plans nothing", async () => {
		const sql = getSql();
		await insertTheme("01", "Economia e Finanças");
		await insertTheme("22", "Eventos Oficiais e Cerimônias");

		await applyThemeActorSync(
			sql,
			planThemeActorSync(await getThemeActorStates(sql), LABELS),
			fakeKeys,
		);
		const second = planThemeActorSync(await getThemeActorStates(sql), LABELS);

		expect(second).toEqual({ create: [], deactivate: [], reactivate: [] });
	});
});
