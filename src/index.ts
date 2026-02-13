import { federation } from "@fedify/hono";
import { Hono } from "hono";
import { createFederation } from "./federation.js";
import { createTriggerPublishHandler } from "./publisher.js";

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
} else {
	console.log(`Starting federation web on port ${port}...`);
}

export default {
	port,
	fetch: app.fetch,
};
