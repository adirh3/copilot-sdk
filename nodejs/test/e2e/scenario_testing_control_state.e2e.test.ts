/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Scenario control state RPC", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("should compose mode name plan client metadata and objective state", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const name = "Scenario control state";
            const plan = "# Scenario plan\n- Verify control state";
            const objective = '{"objective":"VERIFY_SCENARIO_CONTROL","status":"active"}';
            await session.rpc.mode.set({ mode: "plan" });
            await session.rpc.name.set({ name });
            await session.rpc.plan.update({ content: plan });
            const metadata = await session.rpc.metadata.updateClientMetadata({
                set: {
                    "scenario-client/control-mode": "plan",
                    "scenario-client/objective": "VERIFY_SCENARIO_CONTROL",
                },
            });
            expect(
                (await session.rpc.workspaces.writeAutopilotObjective({ content: objective }))
                    .operation
            ).toBe("create");
            expect((await session.rpc.workspaces.autopilotObjectiveExists()).exists).toBe(true);
            expect((await session.rpc.workspaces.readAutopilotObjective()).content).toBe(objective);
            expect((await session.rpc.plan.read()).content).toBe(plan);
            expect((await session.rpc.name.get()).name).toBe(name);
            expect(metadata["scenario-client/objective"]).toBe("VERIFY_SCENARIO_CONTROL");
            const snapshot = await session.rpc.metadata.snapshot();
            expect(snapshot.sessionId).toBe(session.sessionId);
            expect(snapshot.currentMode).toBe("plan");
            expect(snapshot.initialName ?? null).toBeNull();
            expect((await session.rpc.workspaces.deleteAutopilotObjective()).deleted).toBe(true);
            expect((await session.rpc.workspaces.autopilotObjectiveExists()).exists).toBe(false);
        } finally {
            await session.disconnect();
        }
    });
});
