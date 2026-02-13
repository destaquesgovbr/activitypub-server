import { Accept, type Federation, Follow, isActor, Undo } from "@fedify/fedify";
import { getActorByIdentifier, insertFollower, removeFollower } from "./db.js";

export function registerInbox(federation: Federation<void>) {
	federation
		.setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
		.on(Follow, async (ctx, follow) => {
			if (follow.objectId == null) return;
			const parsed = ctx.parseUri(follow.objectId);
			if (parsed?.type !== "actor") return;

			const localActor = await getActorByIdentifier(parsed.identifier);
			if (!localActor) return;

			const follower = await follow.getActor(ctx);
			if (follower == null || !isActor(follower)) return;
			if (follower.id == null || follower.inboxId == null) return;

			const server = follower.id.hostname;
			const endpoints = follower.endpoints;
			const sharedInbox = endpoints?.sharedInbox ?? null;

			await insertFollower({
				actorId: localActor.id,
				followerUri: follower.id.href,
				followerInboxUri: follower.inboxId.href,
				followerSharedInboxUri: sharedInbox?.href ?? null,
				followerServer: server,
				followActivityUri: follow.id?.href ?? null,
			});

			await ctx.sendActivity(
				{ identifier: parsed.identifier },
				follower,
				new Accept({
					actor: follow.objectId,
					object: follow,
				}),
			);
		})
		.on(Undo, async (ctx, undo) => {
			const activity = await undo.getObject(ctx);
			if (!(activity instanceof Follow)) return;

			const targetUri = activity.objectId;
			if (targetUri == null) return;
			const parsed = ctx.parseUri(targetUri);
			if (parsed?.type !== "actor") return;

			const localActor = await getActorByIdentifier(parsed.identifier);
			if (!localActor) return;

			const unfollowerUri = undo.actorId;
			if (unfollowerUri == null) return;

			await removeFollower(localActor.id, unfollowerUri.href);
		})
		.onError((_ctx, error) => {
			console.error("Inbox listener error:", error);
		});
}
