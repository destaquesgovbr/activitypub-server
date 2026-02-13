import { Accept, Endpoints, Follow, Person, Undo } from "@fedify/fedify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db module
vi.mock("../../src/db.js", () => ({
	getPool: vi.fn(),
	getActorByIdentifier: vi.fn(),
	insertFollower: vi.fn(),
	removeFollower: vi.fn(),
}));

import { getActorByIdentifier, insertFollower, removeFollower } from "../../src/db.js";
import { TEST_ACTORS } from "../helpers/fixtures.js";

const mockedGetActor = vi.mocked(getActorByIdentifier);
const mockedInsertFollower = vi.mocked(insertFollower);
const mockedRemoveFollower = vi.mocked(removeFollower);

function captureHandlers() {
	let followHandler: ((ctx: unknown, follow: unknown) => Promise<void>) | undefined;
	let undoHandler: ((ctx: unknown, undo: unknown) => Promise<void>) | undefined;

	const mockFederation = {
		setInboxListeners: vi.fn().mockReturnValue({
			on: vi.fn().mockImplementation(function (this: unknown, type: unknown, handler: unknown) {
				if (type === Follow) followHandler = handler as typeof followHandler;
				if (type === Undo) undoHandler = handler as typeof undoHandler;
				return this;
			}),
			onError: vi.fn().mockReturnThis(),
		}),
	};

	// biome-ignore lint/style/noNonNullAssertion: handlers are set synchronously by registerInbox
	return { mockFederation, getFollow: () => followHandler!, getUndo: () => undoHandler! };
}

describe("inbox Follow handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers Follow and Undo handlers on federation", async () => {
		const { registerInbox } = await import("../../src/inbox.js");
		const { mockFederation } = captureHandlers();
		registerInbox(mockFederation as never);

		expect(mockFederation.setInboxListeners).toHaveBeenCalledWith(
			"/ap/actors/{identifier}/inbox",
			"/ap/inbox",
		);
	});

	it("stores follower and sends Accept on Follow", async () => {
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);
		mockedInsertFollower.mockResolvedValue({} as never);

		const { registerInbox } = await import("../../src/inbox.js");
		const { mockFederation, getFollow } = captureHandlers();
		registerInbox(mockFederation as never);

		const mockSendActivity = vi.fn();
		const mockCtx = {
			parseUri: vi.fn().mockReturnValue({ type: "actor", identifier: "agricultura" }),
			sendActivity: mockSendActivity,
		};

		const mockFollower = new Person({
			id: new URL("https://mastodon.social/users/alice"),
			inbox: new URL("https://mastodon.social/users/alice/inbox"),
			endpoints: new Endpoints({ sharedInbox: new URL("https://mastodon.social/inbox") }),
		});

		const follow = new Follow({
			id: new URL("https://mastodon.social/activities/follow-123"),
			actor: new URL("https://mastodon.social/users/alice"),
			object: new URL("https://example.com/ap/actors/agricultura"),
		});

		// Override getActor on the instance to return our mock Person
		Object.defineProperty(follow, "getActor", {
			value: () => Promise.resolve(mockFollower),
			configurable: true,
		});

		await getFollow()(mockCtx, follow);

		expect(mockedInsertFollower).toHaveBeenCalledWith({
			actorId: 1,
			followerUri: "https://mastodon.social/users/alice",
			followerInboxUri: "https://mastodon.social/users/alice/inbox",
			followerSharedInboxUri: "https://mastodon.social/inbox",
			followerServer: "mastodon.social",
			followActivityUri: "https://mastodon.social/activities/follow-123",
		});
		expect(mockSendActivity).toHaveBeenCalledWith(
			{ identifier: "agricultura" },
			mockFollower,
			expect.any(Accept),
		);
	});

	it("removes follower on Undo{Follow}", async () => {
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);
		mockedRemoveFollower.mockResolvedValue(undefined);

		const { registerInbox } = await import("../../src/inbox.js");
		const { mockFederation, getUndo } = captureHandlers();
		registerInbox(mockFederation as never);

		const mockCtx = {
			parseUri: vi.fn().mockReturnValue({ type: "actor", identifier: "agricultura" }),
		};
		const mockFollow = new Follow({
			actor: new URL("https://mastodon.social/users/alice"),
			object: new URL("https://example.com/ap/actors/agricultura"),
		});
		const mockUndo = {
			actorId: new URL("https://mastodon.social/users/alice"),
			getObject: vi.fn().mockResolvedValue(mockFollow),
		};

		await getUndo()(mockCtx, mockUndo);

		expect(mockedRemoveFollower).toHaveBeenCalledWith(1, "https://mastodon.social/users/alice");
	});

	it("ignores Follow with null objectId", async () => {
		const { registerInbox } = await import("../../src/inbox.js");
		const { mockFederation, getFollow } = captureHandlers();
		registerInbox(mockFederation as never);

		await getFollow()({}, { objectId: null });
		expect(mockedInsertFollower).not.toHaveBeenCalled();
	});

	it("ignores Follow when local actor not found", async () => {
		mockedGetActor.mockResolvedValue(null);

		const { registerInbox } = await import("../../src/inbox.js");
		const { mockFederation, getFollow } = captureHandlers();
		registerInbox(mockFederation as never);

		const mockCtx = {
			parseUri: vi.fn().mockReturnValue({ type: "actor", identifier: "unknown" }),
		};
		await getFollow()(mockCtx, {
			objectId: new URL("https://example.com/ap/actors/unknown"),
		});

		expect(mockedInsertFollower).not.toHaveBeenCalled();
	});
});
