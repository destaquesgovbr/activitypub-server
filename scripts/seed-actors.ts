/**
 * Seed script: reads agencies.yaml + themes_tree.yaml, generates key pairs,
 * and creates the actors in the ap_actors table (1 portal + agencies + 1 per L1 theme).
 *
 * Usage: DATABASE_URL=postgres://... pnpm seed [--dry-run]
 *   or:  DATABASE_URL=postgres://... tsx scripts/seed-actors.ts [--dry-run]
 *
 * Idempotent: existing actors are skipped (keys not overwritten).
 * Theme actors follow the current theme tree (src/theme-actors.ts): missing L1
 * actors are created (e.g. tema-26), actors of L1 themes that left the tree are
 * deactivated (e.g. tema-22/23, is_active = FALSE, nothing deleted) and actors of
 * themes that came back are reactivated. --dry-run prints the plan and writes nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { parse } from "yaml";
import { generateEd25519KeyPair, generateRsaKeyPair } from "../src/keys.js";
import {
	type ActorKeys,
	applyThemeActorSync,
	getThemeActorStates,
	parseThemeLabels,
	planThemeActorSync,
} from "../src/theme-actors.js";

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

async function generateKeys(): Promise<ActorKeys> {
	const rsa = await generateRsaKeyPair();
	const rsaPublicJwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
	const rsaPrivateJwk = await crypto.subtle.exportKey("jwk", rsa.privateKey);
	const ed = await generateEd25519KeyPair();
	const edPublicJwk = await crypto.subtle.exportKey("jwk", ed.publicKey);
	const edPrivateJwk = await crypto.subtle.exportKey("jwk", ed.privateKey);
	return { rsaPublicJwk, rsaPrivateJwk, edPublicJwk, edPrivateJwk };
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
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

	// 3. Theme actors (L1 only): planned against the current tree, before any write
	//    (planThemeActorSync refuses an empty tree instead of deactivating every theme).
	const themePlan = planThemeActorSync(await getThemeActorStates(sql), themeLabels);
	console.log(
		`Theme actors: ${themeLabels.size} L1 in the tree; create [${themePlan.create.map((t) => t.identifier).join(", ")}], deactivate [${themePlan.deactivate.join(", ")}], reactivate [${themePlan.reactivate.join(", ")}]`,
	);

	console.log(
		`${dryRun ? "[dry-run] Would seed" : "Seeding"} ${actors.length} actors (1 portal + ${Object.keys(agenciesData.sources).length} agencies)...`,
	);

	if (dryRun) {
		const missing: string[] = [];
		for (const actor of actors) {
			const existing =
				await sql`SELECT id FROM ap_actors WHERE identifier = ${actor.identifier}`;
			if (existing.length === 0) missing.push(actor.identifier);
		}
		console.log(`[dry-run] Missing portal/agency actors: ${missing.length} [${missing.join(", ")}]`);
		console.log("[dry-run] Nothing written.");
		await sql.end();
		return;
	}

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
			VALUES (${actor.identifier}, ${actor.actor_type}, ${actor.display_name}, ${actor.summary}, ${actor.agency_key}, ${actor.theme_code}, ${sql.json(keys.rsaPublicJwk as postgres.JSONValue)}, ${sql.json(keys.rsaPrivateJwk as postgres.JSONValue)}, ${sql.json(keys.edPublicJwk as postgres.JSONValue)}, ${sql.json(keys.edPrivateJwk as postgres.JSONValue)})
		`;
		created++;

		if (created % 20 === 0) {
			console.log(`  ...created ${created} actors`);
		}
	}

	const themes = await applyThemeActorSync(sql, themePlan, generateKeys);

	console.log(`\nDone! Created: ${created}, Skipped (already exist): ${skipped}`);
	console.log(
		`Theme actors: created ${themes.created}, deactivated ${themes.deactivated}, reactivated ${themes.reactivated}`,
	);

	await sql.end();
}

main().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});
