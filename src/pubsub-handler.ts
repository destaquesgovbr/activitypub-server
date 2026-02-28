import type { Federation } from "@fedify/fedify";
import type { Context as HonoContext } from "hono";
import { insertPublishQueueEntries } from "./db.js";
import { fetchArticle } from "./govbrnews-db.js";
import { processPublishQueue } from "./publisher.js";

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

			// Determine actors: portal + agency + theme
			const actors: string[] = ["portal"];
			if (article.agency_key) {
				actors.push(article.agency_key);
			}
			if (data.most_specific_theme_code) {
				actors.push(`tema-${data.most_specific_theme_code}`);
			}

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
