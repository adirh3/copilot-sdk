/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Scenario testing persistence", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("should retry from existing history with empty sendmessages", async () => {
        const session = await client.createSession({
            model: "claude-sonnet-5",
            onPermissionRequest: approveAll,
        });

        try {
            const initial = await session.sendAndWait({
                prompt: "Reply with exactly EMPTY_BATCH_CONTEXT_READY.",
            });
            expect(initial?.data.content).toBe("EMPTY_BATCH_CONTEXT_READY");

            const result = await session.rpc.sendMessages({ messages: [], wait: true });
            expect(result.messageIds).toEqual([]);

            const events = await session.getEvents();
            const finalAssistantMessage = [...events]
                .reverse()
                .find((event) => event.type === "assistant.message");
            expect(finalAssistantMessage?.data.content).toBe("EMPTY_BATCH_RETRY_DONE");
        } finally {
            await session.disconnect();
        }
    });

    it("should page persisted events backward without resuming", async () => {
        const firstPrompt = "Reply with exactly PERSISTED_SCENARIO_FIRST.";
        const secondPrompt = "Reply with exactly PERSISTED_SCENARIO_SECOND.";
        const session = await client.createSession({ onPermissionRequest: approveAll });
        const sessionId = session.sessionId;
        try {
            expect((await session.sendAndWait({ prompt: firstPrompt }))?.data.content).toContain(
                "PERSISTED_SCENARIO_FIRST"
            );
            expect((await session.sendAndWait({ prompt: secondPrompt }))?.data.content).toContain(
                "PERSISTED_SCENARIO_SECOND"
            );
            await client.rpc.sessions.save({ sessionId });
        } finally {
            await session.disconnect();
        }

        const pageSizes = [1, 3];
        for (const max of pageSizes) {
            const events: Array<{ id: string; type: string; data: unknown }> = [];
            let page = await client.rpc.sessions.readPersistedEvents({
                sessionId,
                max,
                direction: "backward",
            });
            for (;;) {
                expect(page.cursorStatus).toBe("ok");
                events.push(...page.events);
                if (!page.hasMore) {
                    break;
                }
                expect(page.cursor).toBeTruthy();
                page = await client.rpc.sessions.readPersistedEvents({
                    sessionId,
                    max,
                    cursor: page.cursor,
                });
            }
            expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
            const userMessages = events
                .filter((event) => event.type === "user.message")
                .map((event) => (event.data as { content: string }).content);
            expect(userMessages).toContain(firstPrompt);
            expect(userMessages).toContain(secondPrompt);
            expect(userMessages.indexOf(secondPrompt)).toBeLessThan(
                userMessages.indexOf(firstPrompt)
            );
        }
    }, 90_000);
});
