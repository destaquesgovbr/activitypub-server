import { Create, type Federation } from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";
import { getPublishedItemsForActor } from "./db.js";

const PAGE_SIZE = 20;

export function registerOutbox(federation: Federation<void>) {
	federation
		.setOutboxDispatcher("/ap/actors/{identifier}/outbox", async (_ctx, identifier, cursor) => {
			const domain = process.env.AP_DOMAIN ?? "localhost";
			const offset = cursor ? Number.parseInt(cursor, 10) : 0;
			const { items, totalCount } = await getPublishedItemsForActor(identifier, PAGE_SIZE, offset);

			const activities = items.map((item) => {
				const actorUri = new URL(`/ap/actors/${identifier}`, `https://${domain}`);
				const activityUri = new URL(
					`/ap/activities/${item.news_unique_id}-${identifier}`,
					`https://${domain}`,
				);
				const articleUri = new URL(`/ap/articles/${item.news_unique_id}`, `https://${domain}`);

				return new Create({
					id: activityUri,
					actor: actorUri,
					object: articleUri,
					published: item.processed_at
						? Temporal.Instant.fromEpochMilliseconds(item.processed_at.getTime())
						: undefined,
				});
			});

			const nextOffset = offset + PAGE_SIZE;
			return {
				items: activities,
				nextCursor: nextOffset < totalCount ? String(nextOffset) : null,
			};
		})
		.setCounter(async (_ctx, identifier) => {
			const { totalCount } = await getPublishedItemsForActor(identifier, 0, 0);
			return totalCount;
		})
		.setFirstCursor(async (_ctx, _identifier) => "0")
		.setLastCursor(async (_ctx, identifier) => {
			const { totalCount } = await getPublishedItemsForActor(identifier, 0, 0);
			if (totalCount === 0) return null;
			const lastPageOffset = Math.max(0, Math.floor((totalCount - 1) / PAGE_SIZE) * PAGE_SIZE);
			return String(lastPageOffset);
		});
}
