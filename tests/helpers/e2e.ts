import postgres from "postgres";
import { generateEd25519KeyPair, generateRsaKeyPair } from "../../src/keys.js";

const E2E_DB_URL =
	process.env.E2E_DATABASE_URL ?? "postgres://test:test@localhost:5433/federation_test";
const E2E_SERVER_URL = process.env.E2E_SERVER_URL ?? "http://localhost:3000";
const E2E_AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? "test-token-e2e";

let sql: postgres.Sql;

export function getE2EServerUrl(): string {
	return E2E_SERVER_URL;
}

export function getE2EAuthToken(): string {
	return E2E_AUTH_TOKEN;
}

export async function setupE2E() {
	sql = postgres(E2E_DB_URL);
	// Wait for DB to be ready
	for (let i = 0; i < 10; i++) {
		try {
			await sql`SELECT 1`;
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	return sql;
}

export async function teardownE2E() {
	if (sql) await sql.end();
}

export async function cleanE2ETables() {
	await sql`TRUNCATE ap_publish_queue, ap_delivery_log, ap_activities, ap_followers, ap_dead_servers, ap_actors RESTART IDENTITY CASCADE`;
}

export async function seedActor(params: {
	identifier: string;
	actorType: "agency" | "theme" | "portal";
	displayName: string;
	summary?: string;
}): Promise<number> {
	const rsaKeys = await generateRsaKeyPair();
	const rsaPublicJwk = await crypto.subtle.exportKey("jwk", rsaKeys.publicKey);
	const rsaPrivateJwk = await crypto.subtle.exportKey("jwk", rsaKeys.privateKey);
	const ed25519Keys = await generateEd25519KeyPair();
	const ed25519PublicJwk = await crypto.subtle.exportKey("jwk", ed25519Keys.publicKey);
	const ed25519PrivateJwk = await crypto.subtle.exportKey("jwk", ed25519Keys.privateKey);

	const [row] = await sql`
		INSERT INTO ap_actors (identifier, actor_type, display_name, summary, rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk, ed25519_private_key_jwk)
		VALUES (${params.identifier}, ${params.actorType}, ${params.displayName}, ${params.summary ?? null}, ${sql.json(rsaPublicJwk)}, ${sql.json(rsaPrivateJwk)}, ${sql.json(ed25519PublicJwk)}, ${sql.json(ed25519PrivateJwk)})
		ON CONFLICT (identifier) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			rsa_public_key_jwk = EXCLUDED.rsa_public_key_jwk,
			rsa_private_key_jwk = EXCLUDED.rsa_private_key_jwk,
			ed25519_public_key_jwk = EXCLUDED.ed25519_public_key_jwk,
			ed25519_private_key_jwk = EXCLUDED.ed25519_private_key_jwk,
			is_active = TRUE
		RETURNING id
	`;
	return row.id as number;
}

export async function enqueuePublish(newsUniqueId: string, actorIdentifier: string) {
	await sql`
		INSERT INTO ap_publish_queue (news_unique_id, actor_identifier)
		VALUES (${newsUniqueId}, ${actorIdentifier})
		ON CONFLICT (news_unique_id, actor_identifier) DO NOTHING
	`;
}

export async function getPublishQueueStatus(newsUniqueId: string) {
	const [row] = await sql`
		SELECT status, error_message FROM ap_publish_queue
		WHERE news_unique_id = ${newsUniqueId}
	`;
	return row;
}

export function getE2ESql() {
	return sql;
}
