import type { Federation } from "@fedify/fedify";
import type { Context as HonoContext } from "hono";
import { buildArticleActivity, type NewsRow } from "./article-builder.js";
import { getActorByIdentifier, getPendingPublishQueue, markFailed, markPublished } from "./db.js";

const FEDERATION_AUTH_TOKEN = process.env.FEDERATION_AUTH_TOKEN ?? "dev-token";

export function createTriggerPublishHandler(federation: Federation<void>) {
	return async (c: HonoContext) => {
		const authHeader = c.req.header("Authorization");
		if (authHeader !== `Bearer ${FEDERATION_AUTH_TOKEN}`) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const limit = Number(c.req.query("limit") ?? "100");
		const result = await processPublishQueue(federation, limit);
		return c.json(result);
	};
}

export interface PublishResult {
	processed: number;
	published: number;
	failed: number;
	errors: string[];
}

function parseNewsPayload(payload: Record<string, unknown>): NewsRow {
	return {
		unique_id: payload.unique_id as string,
		title: payload.title as string,
		content_html: payload.content_html as string,
		summary: (payload.summary as string) ?? null,
		image_url: (payload.image_url as string) ?? null,
		tags: (payload.tags as string[]) ?? [],
		published_at: new Date(payload.published_at as string),
		canonical_url: payload.canonical_url as string,
	};
}

export async function processPublishQueue(
	federation: Federation<void>,
	limit = 100,
): Promise<PublishResult> {
	const domain = process.env.AP_DOMAIN ?? "localhost";
	const items = await getPendingPublishQueue(limit);
	const result: PublishResult = { processed: 0, published: 0, failed: 0, errors: [] };

	for (const item of items) {
		result.processed++;
		try {
			const actor = await getActorByIdentifier(item.actor_identifier);
			if (!actor) {
				await markFailed(item.id, `Actor not found: ${item.actor_identifier}`);
				result.failed++;
				result.errors.push(`Actor not found: ${item.actor_identifier}`);
				continue;
			}

			if (!item.news_payload) {
				await markFailed(item.id, `Missing news_payload for: ${item.news_unique_id}`);
				result.failed++;
				result.errors.push(`Missing news_payload for: ${item.news_unique_id}`);
				continue;
			}

			const news = parseNewsPayload(item.news_payload);
			const activity = buildArticleActivity(news, item.actor_identifier, domain);

			const ctx = federation.createContext(new URL(`https://${domain}`), undefined as undefined);
			await ctx.sendActivity({ identifier: item.actor_identifier }, "followers", activity, {
				preferSharedInbox: true,
			});

			await markPublished(item.id);
			result.published++;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			await markFailed(item.id, msg);
			result.failed++;
			result.errors.push(`${item.news_unique_id}: ${msg}`);
		}
	}

	return result;
}
