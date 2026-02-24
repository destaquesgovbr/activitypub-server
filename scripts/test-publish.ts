/**
 * Manual test: publishes a test article via the portal actor.
 *
 * Usage:
 *   DATABASE_URL=... AP_DOMAIN=... pnpm tsx scripts/test-publish.ts
 */

import { createFederation } from "../src/federation.js";
import { buildArticleActivity, type NewsRow } from "../src/article-builder.js";

const domain = process.env.AP_DOMAIN;
if (!domain) {
	console.error("AP_DOMAIN is required");
	process.exit(1);
}

const testNews: NewsRow = {
	unique_id: "test-" + Date.now().toString(36),
	title: "Brasil anuncia nova política de dados abertos",
	content_html:
		"<p>O governo federal lançou hoje uma nova política de dados abertos, " +
		"ampliando o acesso da população a informações públicas. A iniciativa " +
		"prevê a publicação de datasets em formatos abertos e acessíveis.</p>" +
		"<p>Esta é uma mensagem de teste do servidor de federação ActivityPub " +
		"do portal Destaques GOV.BR.</p>",
	summary: "Governo federal amplia acesso a dados públicos com nova política de dados abertos.",
	image_url: null,
	tags: ["dadosabertos", "transparencia", "govbr"],
	published_at: new Date(),
	canonical_url: `https://${domain}/test-article`,
};

async function main() {
	console.log("Creating federation instance...");
	const fedi = createFederation();

	console.log(`Building article activity for portal actor on ${domain}...`);
	const activity = buildArticleActivity(testNews, "portal", domain);

	console.log("Sending activity to followers...");
	const ctx = fedi.createContext(new URL(`https://${domain}`), undefined as void);
	await ctx.sendActivity({ identifier: "portal" }, "followers", activity, {
		preferSharedInbox: true,
	});

	console.log("Activity queued for delivery!");
	console.log(`Article: ${testNews.title}`);
	console.log(`Unique ID: ${testNews.unique_id}`);

	// Give the queue a moment to process
	console.log("Waiting 5s for queue processing...");
	await new Promise((r) => setTimeout(r, 5000));
	console.log("Done. Check your Mastodon timeline!");

	process.exit(0);
}

main().catch((err) => {
	console.error("Test publish failed:", err);
	process.exit(1);
});
