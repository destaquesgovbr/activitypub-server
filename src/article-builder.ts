import { Article, Create, Hashtag, Image } from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";

export interface NewsRow {
	unique_id: string;
	title: string;
	content_html: string;
	summary: string | null;
	image_url: string | null;
	tags: string[];
	published_at: Date;
	canonical_url: string;
}

export function buildArticleActivity(
	news: NewsRow,
	actorIdentifier: string,
	domain: string,
): Create {
	const actorUri = new URL(`/ap/actors/${actorIdentifier}`, `https://${domain}`);
	const articleUri = new URL(`/ap/articles/${news.unique_id}`, `https://${domain}`);
	const activityUri = new URL(
		`/ap/activities/${news.unique_id}-${actorIdentifier}`,
		`https://${domain}`,
	);
	const followersUri = new URL(`/ap/actors/${actorIdentifier}/followers`, `https://${domain}`);
	const published = Temporal.Instant.fromEpochMilliseconds(news.published_at.getTime());

	const article = new Article({
		id: articleUri,
		attribution: actorUri,
		name: news.title,
		content: news.content_html,
		summary: news.summary,
		url: new URL(news.canonical_url),
		published,
		image: news.image_url ? new Image({ url: new URL(news.image_url) }) : null,
		tags: news.tags.map((tag) => new Hashtag({ name: `#${tag}`, href: null })),
	});

	return new Create({
		id: activityUri,
		actor: actorUri,
		object: article,
		published,
		tos: [new URL("https://www.w3.org/ns/activitystreams#Public")],
		ccs: [followersUri],
	});
}
