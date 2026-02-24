import { configure, getConsoleSink } from "@logtape/logtape";
import { federation } from "@fedify/hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFederation } from "./federation.js";
import { createTriggerPublishHandler } from "./publisher.js";

await configure({
	sinks: { console: getConsoleSink() },
	filters: {},
	loggers: [
		{
			category: "fedify",
			sinks: ["console"],
			lowestLevel: "info",
		},
	],
});

const nodeType = process.env.NODE_TYPE ?? "web";
const port = Number(process.env.PORT ?? 3000);

const fedi = createFederation();
const app = new Hono();

app.use(federation(fedi, () => undefined));

app.get("/health", (c) => {
	return c.json({ status: "ok", nodeType, timestamp: new Date().toISOString() });
});

app.post("/trigger-publish", createTriggerPublishHandler(fedi));

if (nodeType === "worker") {
	console.log("Starting federation worker (message queue processor)...");
	fedi.startQueue();
}

serve({ fetch: app.fetch, port }, () => {
	console.log(`Federation ${nodeType} listening on port ${port}`);
});
