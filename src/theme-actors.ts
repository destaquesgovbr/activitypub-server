/**
 * Atores de tema: um ator `Group` por L1 da árvore de temas (`tema-01` … `tema-26`).
 *
 * A árvore muda com o tempo: os L1 22/23 saíram (DEC-001/DEC-002) e o L1 26
 * "Defesa Civil e Gestão de Desastres" entra com a migração 034 do data-platform.
 * Por isso o seed não só cria os atores que faltam: desativa (`is_active = FALSE`)
 * os de temas que saíram da árvore e reativa os que voltaram. Nada é apagado:
 * chaves e seguidores ficam, e reverter é um UPDATE.
 */
import type postgres from "postgres";

export const THEME_ACTOR_PREFIX = "tema-";

/**
 * L1 de `themes/themes_tree.yaml`, na ordem do arquivo.
 * Formato da linha de L1: "01 - Economia e Finanças:" (L2/L3 são indentados).
 */
export function parseThemeLabels(yamlContent: string): Map<string, string> {
	const themes = new Map<string, string>();
	for (const line of yamlContent.split("\n")) {
		const match = line.match(/^(\d{2}) - (.+):$/);
		if (match) {
			themes.set(match[1], match[2]);
		}
	}
	return themes;
}

/**
 * Ator de tema de um código em qualquer nível: "26.01.03" → "tema-26".
 * Só existem atores L1, e o evento `dgb.news.enriched` traz o código mais específico.
 */
export function themeActorIdentifier(themeCode: string | null | undefined): string | null {
	const l1 = themeCode?.trim().split(".")[0];
	return l1 && /^\d{2}$/.test(l1) ? `${THEME_ACTOR_PREFIX}${l1}` : null;
}

export interface ThemeActorState {
	identifier: string;
	theme_code: string | null;
	is_active: boolean | null;
}

export interface ThemeActorSyncPlan {
	create: Array<{ identifier: string; code: string; label: string }>;
	deactivate: string[];
	reactivate: string[];
}

/** Compara os atores de tema do banco com os L1 da árvore. Não escreve nada. */
export function planThemeActorSync(
	existing: ThemeActorState[],
	themeLabels: Map<string, string>,
): ThemeActorSyncPlan {
	if (themeLabels.size === 0) {
		throw new Error(
			"Nenhum tema L1 na taxonomia (arquivo errado ou formato inesperado): " +
				"recusando desativar todos os atores de tema",
		);
	}

	const byIdentifier = new Map(existing.map((actor) => [actor.identifier, actor]));
	const wanted = new Set([...themeLabels.keys()].map((code) => `${THEME_ACTOR_PREFIX}${code}`));
	const plan: ThemeActorSyncPlan = { create: [], deactivate: [], reactivate: [] };

	for (const [code, label] of themeLabels) {
		const identifier = `${THEME_ACTOR_PREFIX}${code}`;
		const actor = byIdentifier.get(identifier);
		if (!actor) {
			plan.create.push({ identifier, code, label });
		} else if (actor.is_active === false) {
			plan.reactivate.push(identifier);
		}
	}

	for (const actor of existing) {
		// is_active NULL conta como ativo (o default da coluna é TRUE).
		if (!wanted.has(actor.identifier) && actor.is_active !== false) {
			plan.deactivate.push(actor.identifier);
		}
	}
	plan.deactivate.sort();

	return plan;
}

export async function getThemeActorStates(sql: postgres.Sql): Promise<ThemeActorState[]> {
	return sql<ThemeActorState[]>`
		SELECT identifier, theme_code, is_active FROM ap_actors
		WHERE actor_type = 'theme' ORDER BY identifier
	`;
}

export interface ActorKeys {
	rsaPublicJwk: JsonWebKey;
	rsaPrivateJwk: JsonWebKey;
	edPublicJwk: JsonWebKey;
	edPrivateJwk: JsonWebKey;
}

/** Aplica o plano numa transação: cria (com chaves novas), desativa e reativa. */
export async function applyThemeActorSync(
	sql: postgres.Sql,
	plan: ThemeActorSyncPlan,
	generateKeys: () => Promise<ActorKeys>,
): Promise<{ created: number; deactivated: number; reactivated: number }> {
	// Gera as chaves antes de abrir a transação (RSA-2048 leva algum tempo).
	const keysByIdentifier = new Map<string, ActorKeys>();
	for (const { identifier } of plan.create) {
		keysByIdentifier.set(identifier, await generateKeys());
	}

	await sql.begin(async (transaction) => {
		// TransactionSql perde as call signatures na tipagem do postgres.js 3.x (Omit em Sql).
		const tx = transaction as unknown as postgres.Sql;
		for (const { identifier, code, label } of plan.create) {
			const keys = keysByIdentifier.get(identifier) as ActorKeys;
			await tx`
				INSERT INTO ap_actors (identifier, actor_type, display_name, summary, agency_key, theme_code, rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk, ed25519_private_key_jwk)
				VALUES (${identifier}, 'theme', ${label}, ${`Notícias sobre ${label}`}, NULL, ${code}, ${tx.json(keys.rsaPublicJwk as postgres.JSONValue)}, ${tx.json(keys.rsaPrivateJwk as postgres.JSONValue)}, ${tx.json(keys.edPublicJwk as postgres.JSONValue)}, ${tx.json(keys.edPrivateJwk as postgres.JSONValue)})
			`;
		}
		if (plan.deactivate.length > 0) {
			await tx`
				UPDATE ap_actors SET is_active = FALSE
				WHERE actor_type = 'theme' AND identifier IN ${tx(plan.deactivate)}
			`;
		}
		if (plan.reactivate.length > 0) {
			await tx`
				UPDATE ap_actors SET is_active = TRUE
				WHERE actor_type = 'theme' AND identifier IN ${tx(plan.reactivate)}
			`;
		}
	});

	return {
		created: plan.create.length,
		deactivated: plan.deactivate.length,
		reactivated: plan.reactivate.length,
	};
}
