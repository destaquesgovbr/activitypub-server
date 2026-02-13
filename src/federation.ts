import {
	createFederation as createFedifyFederation,
	InProcessMessageQueue,
	MemoryKvStore,
} from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { getPool } from "./db.js";

const isTest = process.env.NODE_ENV === "test";

export function createFederation() {
	const nodeType = process.env.NODE_TYPE ?? "web";

	if (isTest) {
		return createFedifyFederation<void>({
			kv: new MemoryKvStore(),
			queue: new InProcessMessageQueue(),
			manuallyStartQueue: true,
		});
	}

	const pool = getPool();
	return createFedifyFederation<void>({
		kv: new PostgresKvStore(pool),
		queue: new PostgresMessageQueue(pool),
		manuallyStartQueue: nodeType === "web",
	});
}
