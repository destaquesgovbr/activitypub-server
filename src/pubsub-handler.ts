import type { Federation } from "@fedify/fedify";
import type { Context as HonoContext } from "hono";
import { insertPublishQueueEntries } from "./db.js";
import { fetchArticle } from "./govbrnews-db.js";
import { processPublishQueue } from "./publisher.js";
import { themeActorIdentifier } from "./theme-actors.js";

interface PubSubEnvelope {
	message: {
		data: string;
		attributes?: Record<string, string>;
		messageId?: string;
	};
	subscription?: string;
}

interface EnrichedPayload {
	unique_id: string;
	most_specific_theme_code?: string | null;
}

/**
 * Atores que publicam um artigo: portal, órgão e o ator do L1 do tema.
 *
 * O tema vem do L1 canônico da notícia (`news.theme_l1_id`), como no DAG antigo
 * e como portal e Typesense mostram. O prefixo do código mais específico do
 * evento (ex.: "26.01.03" → "tema-26") é só fallback: o classificador às vezes
 * devolve hierarquias inconsistentes (L1 15 com mais específico 24.01), e aí
 * o prefixo apontaria para o ator errado.
 */
export function resolveActorIdentifiers(
	agencyKey: string | null | undefined,
	themeL1Code: string | null | undefined,
	mostSpecificThemeCode: string | null | undefined,
): string[] {
	const actors = ["portal"];
	if (agencyKey) {
		actors.push(agencyKey);
	}
	const themeActor =
		themeActorIdentifier(themeL1Code) ?? themeActorIdentifier(mostSpecificThemeCode);
	if (themeActor) {
		actors.push(themeActor);
	}
	return actors;
}

export function createPubSubHandler(federation: Federation<void>) {
	return async (c: HonoContext) => {
		try {
			const envelope = (await c.req.json()) as PubSubEnvelope;
			const rawData = Buffer.from(envelope.message.data, "base64").toString();
			const data = JSON.parse(rawData) as EnrichedPayload;
			const uniqueId = data.unique_id;

			if (!uniqueId) {
				console.warn("[pubsub] Message without unique_id, ACK-ing");
				return c.json({ status: "ignored", reason: "no unique_id" }, 200);
			}

			console.log(`[pubsub] Processing ${uniqueId}`);

			const article = await fetchArticle(uniqueId);
			if (!article) {
				console.warn(`[pubsub] Article not found in govbrnews: ${uniqueId}`);
				return c.json({ status: "ignored", reason: "article not found" }, 200);
			}

			// Atores: portal + órgão + tema (L1 canônico; prefixo do evento como fallback)
			const actors = resolveActorIdentifiers(
				article.agency_key,
				article.theme_l1_code,
				data.most_specific_theme_code,
			);

			// Build news_payload (same format as the DAG used)
			const newsPayload = {
				unique_id: article.unique_id,
				title: article.title,
				content_html: article.content,
				summary: null,
				image_url: article.image_url,
				tags: article.tags ?? [],
				published_at: article.published_at?.toISOString() ?? null,
				canonical_url: article.url,
			};

			const entries = actors.map((actor) => ({
				newsUniqueId: article.unique_id,
				actorIdentifier: actor,
				newsPayload,
			}));

			const inserted = await insertPublishQueueEntries(entries);
			console.log(
				`[pubsub] ${uniqueId}: ${inserted} entries queued for ${actors.length} actors (${actors.join(", ")})`,
			);

			if (inserted > 0) {
				const result = await processPublishQueue(federation);
				console.log(
					`[pubsub] ${uniqueId}: publish result — processed=${result.processed}, published=${result.published}, failed=${result.failed}`,
				);
			}

			return c.json({ status: "ok", uniqueId, actors, inserted }, 200);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[pubsub] Error processing message: ${msg}`, error);
			// ACK-always: return 200 to prevent infinite retries
			return c.json({ status: "error", error: msg }, 200);
		}
	};
}
