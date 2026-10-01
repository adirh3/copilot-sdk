/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Scenario permission mode RPC", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it.each([
        ["assisted", "gpt-5.5"],
        ["allow-all", undefined],
    ] as const)("sets, resets and reads authoritative %s permission mode", async (mode, model) => {
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            featureFlags: { AUTO_APPROVAL: true },
        });
        try {
            expect((await session.rpc.permissions.getMode()).mode).toBe("manual");
            const set = await session.rpc.permissions.setMode({
                mode,
                assistedApprovalModel: model,
                source: "rpc",
            });
            expect(set).toMatchObject({ success: true, mode });
            expect((await session.rpc.permissions.getMode()).mode).toBe(mode);
            expect(
                await session.rpc.permissions.setMode({ mode: "manual", source: "rpc" })
            ).toMatchObject({ success: true, mode: "manual" });
            expect((await session.rpc.permissions.getMode()).mode).toBe("manual");
        } finally {
            await session.disconnect();
        }
    });
});
