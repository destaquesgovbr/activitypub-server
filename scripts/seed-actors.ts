/**
 * Seed script: reads agencies.yaml + themes_tree.yaml, generates key pairs,
 * and inserts 182 actors into the ap_actors table.
 *
 * Usage: DATABASE_URL=postgres://... pnpm seed
 *   or:  DATABASE_URL=postgres://... tsx scripts/seed-actors.ts
 *
 * Idempotent: uses ON CONFLICT to skip existing actors (keys not overwritten).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { parse } from "yaml";
import { generateEd25519KeyPair, generateRsaKeyPair } from "../src/keys.js";

const AGENCIES_PATH =
	process.env.AGENCIES_YAML ?? join(import.meta.dirname, "../../agencies/agencies.yaml");
const THEMES_PATH =
	process.env.THEMES_YAML ?? join(import.meta.dirname, "../../themes/themes_tree.yaml");

interface AgencyEntry {
	name: string;
	type: string;
	parent: string;
	url: string;
}

async function generateKeys() {
	const rsa = await generateRsaKeyPair();
	const rsaPublicJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
	const rsaPrivateJwk = await crypto.subtle.exportKey("jwk", rsa.privateKey);
	const ed = await generateEd25519KeyPair();
	const edPublicJwk = await crypto.subtle.exportKey("jwk", ed.publicKey);
	const edPrivateJwk = await crypto.subtle.exportKey("jwk", ed.privateKey);
	return { rsaPublicJwk, rsaPrivateJwk, edPublicJwk, edPrivateJwk };
}

function parseThemeLabels(yamlContent: string): Map<string, string> {
	const themes = new Map<string, string>();
	// themes_tree.yaml has format: "01 - Economia e Finanças:"
	// We only want L1 themes (2-digit codes)
	for (const line of yamlContent.split("\n")) {
		const match = line.match(/^(\d{2}) - (.+):$/);
		if (match) {
			themes.set(match[1], match[2]);
		}
	}
	return themes;
}

async function main() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error("DATABASE_URL environment variable is required");
		process.exit(1);
	}

	const sql = postgres(databaseUrl);

	// Load data files
	console.log(`Loading agencies from: ${AGENCIES_PATH}`);
	const agenciesYaml = readFileSync(AGENCIES_PATH, "utf-8");
	const agenciesData = parse(agenciesYaml) as { sources: Record<string, AgencyEntry> };

	console.log(`Loading themes from: ${THEMES_PATH}`);
	const themesYaml = readFileSync(THEMES_PATH, "utf-8");
	const themeLabels = parseThemeLabels(themesYaml);

	const actors: Array<{
		identifier: string;
		actor_type: string;
		display_name: string;
		summary: string | null;
		agency_key: string | null;
		theme_code: string | null;
	}> = [];

	// 1. Portal actor
	actors.push({
		identifier: "portal",
		actor_type: "portal",
		display_name: "Destaques GOV.BR",
		summary: "Portal de notícias do governo federal brasileiro",
		agency_key: null,
		theme_code: null,
	});

	// 2. Agency actors
	for (const [key, agency] of Object.entries(agenciesData.sources)) {
		actors.push({
			identifier: key,
			actor_type: "agency",
			display_name: agency.name,
			summary: `Notícias de ${agency.name}`,
			agency_key: key,
			theme_code: null,
		});
	}

	// 3. Theme actors (L1 only)
	for (const [code, label] of themeLabels) {
		actors.push({
			identifier: `tema-${code}`,
			actor_type: "theme",
			display_name: label,
			summary: `Notícias sobre ${label}`,
			agency_key: null,
			theme_code: code,
		});
	}

	console.log(
		`Seeding ${actors.length} actors (1 portal + ${Object.keys(agenciesData.sources).length} agencies + ${themeLabels.size} themes)...`,
	);

	let created = 0;
	let skipped = 0;

	for (const actor of actors) {
		// Check if actor already exists
		const existing =
			await sql`SELECT id FROM ap_actors WHERE identifier = ${actor.identifier}`;
		if (existing.length > 0) {
			skipped++;
			continue;
		}

		const keys = await generateKeys();

		await sql`
			INSERT INTO ap_actors (identifier, actor_type, display_name, summary, agency_key, theme_code, rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk, ed25519_private_key_jwk)
			VALUES (${actor.identifier}, ${actor.actor_type}, ${actor.display_name}, ${actor.summary}, ${actor.agency_key}, ${actor.theme_code}, ${sql.json(keys.rsaPublicJwk)}, ${sql.json(keys.rsaPrivateJwk)}, ${sql.json(keys.edPublicJwk)}, ${sql.json(keys.edPrivateJwk)})
		`;
		created++;

		if (created % 20 === 0) {
			console.log(`  ...created ${created} actors`);
		}
	}

	console.log(`\nDone! Created: ${created}, Skipped (already exist): ${skipped}`);
	console.log(`Total actors in DB: ${created + skipped}`);

	await sql.end();
}

main().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});
