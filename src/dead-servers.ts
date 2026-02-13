import {
	type FollowerRow,
	getDeadServersForProbe,
	isServerDead,
	recordServerFailure,
	resetServerForProbe,
} from "./db.js";

const FAILURE_THRESHOLD = 50;

export async function handleDeliveryFailure(serverHostname: string): Promise<boolean> {
	const nowDead = await recordServerFailure(serverHostname);
	if (nowDead) {
		console.warn(`Server marked as dead after ${FAILURE_THRESHOLD}+ failures: ${serverHostname}`);
	}
	return nowDead;
}

export async function shouldSkipServer(serverHostname: string): Promise<boolean> {
	return isServerDead(serverHostname);
}

export async function filterLiveFollowers(followers: FollowerRow[]): Promise<FollowerRow[]> {
	const serverChecks = new Map<string, boolean>();

	const results: FollowerRow[] = [];
	for (const follower of followers) {
		let dead = serverChecks.get(follower.follower_server);
		if (dead === undefined) {
			dead = await isServerDead(follower.follower_server);
			serverChecks.set(follower.follower_server, dead);
		}
		if (!dead) {
			results.push(follower);
		}
	}
	return results;
}

export interface ProbeResult {
	probed: number;
	revived: number;
	stillDead: number;
}

export async function probeDeadServers(
	probeFn: (hostname: string) => Promise<boolean>,
): Promise<ProbeResult> {
	const servers = await getDeadServersForProbe();
	const result: ProbeResult = { probed: 0, revived: 0, stillDead: 0 };

	for (const hostname of servers) {
		result.probed++;
		try {
			const alive = await probeFn(hostname);
			if (alive) {
				await resetServerForProbe(hostname);
				result.revived++;
				console.info(`Dead server revived after probe: ${hostname}`);
			} else {
				result.stillDead++;
			}
		} catch {
			result.stillDead++;
		}
	}

	return result;
}
