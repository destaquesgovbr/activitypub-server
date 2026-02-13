import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db.js", () => ({
	getPool: vi.fn(),
	recordServerFailure: vi.fn(),
	isServerDead: vi.fn(),
	getDeadServersForProbe: vi.fn(),
	resetServerForProbe: vi.fn(),
}));

import type { FollowerRow } from "../../src/db.js";
import {
	getDeadServersForProbe,
	isServerDead,
	recordServerFailure,
	resetServerForProbe,
} from "../../src/db.js";
import {
	filterLiveFollowers,
	handleDeliveryFailure,
	probeDeadServers,
	shouldSkipServer,
} from "../../src/dead-servers.js";

const mockedRecord = vi.mocked(recordServerFailure);
const mockedIsDead = vi.mocked(isServerDead);
const mockedGetProbe = vi.mocked(getDeadServersForProbe);
const mockedReset = vi.mocked(resetServerForProbe);

describe("dead-servers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleDeliveryFailure", () => {
		it("records failure and returns false when not yet dead", async () => {
			mockedRecord.mockResolvedValue(false);

			const result = await handleDeliveryFailure("example.com");
			expect(result).toBe(false);
			expect(mockedRecord).toHaveBeenCalledWith("example.com");
		});

		it("records failure and returns true when threshold reached", async () => {
			mockedRecord.mockResolvedValue(true);

			const result = await handleDeliveryFailure("dead.server");
			expect(result).toBe(true);
			expect(mockedRecord).toHaveBeenCalledWith("dead.server");
		});
	});

	describe("shouldSkipServer", () => {
		it("returns false for live servers", async () => {
			mockedIsDead.mockResolvedValue(false);

			expect(await shouldSkipServer("live.server")).toBe(false);
		});

		it("returns true for dead servers", async () => {
			mockedIsDead.mockResolvedValue(true);

			expect(await shouldSkipServer("dead.server")).toBe(true);
		});
	});

	describe("filterLiveFollowers", () => {
		function makeFollower(uri: string, server: string): FollowerRow {
			return {
				id: 1,
				actor_id: 1,
				follower_uri: uri,
				follower_inbox_uri: `https://${server}/inbox`,
				follower_shared_inbox_uri: null,
				follower_server: server,
				follow_activity_uri: null,
				status: "active",
				followed_at: new Date(),
			};
		}

		it("returns all followers when no servers are dead", async () => {
			mockedIsDead.mockResolvedValue(false);

			const followers = [
				makeFollower("https://a.com/u/1", "a.com"),
				makeFollower("https://b.com/u/2", "b.com"),
			];

			const result = await filterLiveFollowers(followers);
			expect(result).toHaveLength(2);
		});

		it("filters out followers from dead servers", async () => {
			mockedIsDead.mockImplementation(async (hostname) => hostname === "dead.server");

			const followers = [
				makeFollower("https://live.server/u/1", "live.server"),
				makeFollower("https://dead.server/u/2", "dead.server"),
				makeFollower("https://dead.server/u/3", "dead.server"),
			];

			const result = await filterLiveFollowers(followers);
			expect(result).toHaveLength(1);
			expect(result[0].follower_server).toBe("live.server");
		});

		it("caches server status checks per hostname", async () => {
			mockedIsDead.mockResolvedValue(false);

			const followers = [
				makeFollower("https://same.server/u/1", "same.server"),
				makeFollower("https://same.server/u/2", "same.server"),
				makeFollower("https://same.server/u/3", "same.server"),
			];

			await filterLiveFollowers(followers);
			// Should only check once per unique server
			expect(mockedIsDead).toHaveBeenCalledTimes(1);
		});

		it("returns empty array when all followers are from dead servers", async () => {
			mockedIsDead.mockResolvedValue(true);

			const followers = [
				makeFollower("https://dead1.com/u/1", "dead1.com"),
				makeFollower("https://dead2.com/u/2", "dead2.com"),
			];

			const result = await filterLiveFollowers(followers);
			expect(result).toHaveLength(0);
		});
	});

	describe("probeDeadServers", () => {
		it("returns zero counts when no servers to probe", async () => {
			mockedGetProbe.mockResolvedValue([]);

			const result = await probeDeadServers(async () => true);
			expect(result).toEqual({ probed: 0, revived: 0, stillDead: 0 });
		});

		it("revives servers that respond to probe", async () => {
			mockedGetProbe.mockResolvedValue(["revived.server"]);
			mockedReset.mockResolvedValue(undefined);

			const probeFn = vi.fn().mockResolvedValue(true);
			const result = await probeDeadServers(probeFn);

			expect(result.probed).toBe(1);
			expect(result.revived).toBe(1);
			expect(result.stillDead).toBe(0);
			expect(mockedReset).toHaveBeenCalledWith("revived.server");
		});

		it("keeps servers dead when probe fails", async () => {
			mockedGetProbe.mockResolvedValue(["still-dead.server"]);

			const probeFn = vi.fn().mockResolvedValue(false);
			const result = await probeDeadServers(probeFn);

			expect(result.probed).toBe(1);
			expect(result.revived).toBe(0);
			expect(result.stillDead).toBe(1);
			expect(mockedReset).not.toHaveBeenCalled();
		});

		it("handles probe function throwing errors", async () => {
			mockedGetProbe.mockResolvedValue(["error.server"]);

			const probeFn = vi.fn().mockRejectedValue(new Error("timeout"));
			const result = await probeDeadServers(probeFn);

			expect(result.probed).toBe(1);
			expect(result.stillDead).toBe(1);
			expect(result.revived).toBe(0);
		});

		it("processes multiple servers with mixed results", async () => {
			mockedGetProbe.mockResolvedValue(["alive.com", "dead.com", "error.com"]);
			mockedReset.mockResolvedValue(undefined);

			const probeFn = vi.fn().mockImplementation(async (hostname: string) => {
				if (hostname === "alive.com") return true;
				if (hostname === "dead.com") return false;
				throw new Error("network error");
			});

			const result = await probeDeadServers(probeFn);

			expect(result.probed).toBe(3);
			expect(result.revived).toBe(1);
			expect(result.stillDead).toBe(2);
			expect(mockedReset).toHaveBeenCalledOnce();
			expect(mockedReset).toHaveBeenCalledWith("alive.com");
		});
	});
});
