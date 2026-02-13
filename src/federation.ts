import {
	createFederation as createFedifyFederation,
	type Federation,
	InProcessMessageQueue,
	MemoryKvStore,
} from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { registerActors } from "./actors.js";
import { getPool } from "./db.js";

const isTest = process.env.NODE_ENV === "test";

export function createFederation(): Federation<void> {
	const nodeType = process.env.NODE_TYPE ?? "web";

	const fedi = isTest
		? createFedifyFederation<void>({
				kv: new MemoryKvStore(),
				queue: new InProcessMessageQueue(),
				manuallyStartQueue: true,
			})
		: createFedifyFederation<void>({
				kv: new PostgresKvStore(getPool()),
				queue: new PostgresMessageQueue(getPool()),
				manuallyStartQueue: nodeType === "web",
			});

	registerActors(fedi);
	return fedi;
}
