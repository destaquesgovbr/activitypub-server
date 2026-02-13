import { federation } from "@fedify/hono";
import { Hono } from "hono";
import { createFederation } from "../../src/federation.js";

export async function createTestApp() {
	const fedi = createFederation();
	const app = new Hono();
	app.use(federation(fedi, () => undefined));
	app.get("/health", (c) => c.json({ status: "ok" }));
	return app;
}
