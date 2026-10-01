/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import type { CopilotSession } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

describe("RPC boundary semantics", async () => {
    const { copilotClient: client, workDir } = await createSdkTestContext();

    async function withSession(action: (session: CopilotSession) => Promise<void>): Promise<void> {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            await action(session);
        } finally {
            await session.disconnect();
        }
    }

    it("shell exec with zero timeout does not kill a running command", async () => {
        await withSession(async (session) => {
            const marker = join(workDir, `zero-timeout-${randomUUID()}.txt`);
            const command =
                process.platform === "win32"
                    ? `ping 127.0.0.1 -n 2 >nul & echo alive>"${marker}" & ping 127.0.0.1 -n 61 >nul`
                    : `sleep 1; printf alive > '${marker}'; sleep 60`;
            const result = await session.rpc.shell.exec({ command, cwd: workDir, timeout: 0 });
            expect(result.processId).toBeTruthy();
            let observedRunning = false;
            try {
                await waitForCondition(() => existsSync(marker), {
                    timeoutMessage: `Zero-timeout shell command did not write ${marker}`,
                });
                observedRunning = true;
            } finally {
                const killed = await session.rpc.shell.kill({ processId: result.processId });
                if (observedRunning) {
                    expect(killed.killed).toBe(true);
                }
            }
        });
    }, 60_000);

    it("workspace files round-trip empty, Unicode with NUL, and large content", async () => {
        await withSession(async (session) => {
            const files = new Map([
                [`empty-${randomUUID()}.txt`, ""],
                [`unicode-${randomUUID()}.txt`, "Hello, 世界! 🚀✨ Привет\u0000end"],
                [
                    `large-${randomUUID()}.txt`,
                    "abcdefghijklmnopqrstuvwxyz".repeat(10_083).slice(0, 256 * 1024),
                ],
            ]);
            for (const [path, content] of files) {
                await session.rpc.workspaces.createFile({ path, content });
                expect((await session.rpc.workspaces.readFile({ path })).content).toBe(content);
            }
            const listed = (await session.rpc.workspaces.listFiles()).files;
            expect(listed).toEqual(expect.arrayContaining([...files.keys()]));
        });
    });

    it("workspace listing retains every created file and getWorkspace stays stable", async () => {
        await withSession(async (session) => {
            const paths = Array.from({ length: 5 }, (_, i) => `order-${randomUUID()}-${i}.txt`);
            for (const path of paths) {
                await session.rpc.workspaces.createFile({ path, content: `content-${path}` });
            }
            for (let i = 0; i < 2; i++) {
                expect((await session.rpc.workspaces.listFiles()).files).toEqual(
                    expect.arrayContaining(paths)
                );
            }
            const first = await session.rpc.workspaces.getWorkspace();
            expect(await session.rpc.workspaces.getWorkspace()).toEqual(first);
        });
    });

    it("empty plan update and repeated delete preserve empty plan state", async () => {
        await withSession(async (session) => {
            await session.rpc.plan.update({ content: "" });
            expect((await session.rpc.plan.read()).content).toBe("");
            await session.rpc.plan.delete();
            await session.rpc.plan.delete();
            expect(await session.rpc.plan.read()).toMatchObject({
                exists: false,
                content: null,
            });
        });
    });

    it("repeated mode, Unicode name, and permission toggles round-trip", async () => {
        await withSession(async (session) => {
            for (let i = 0; i < 3; i++) {
                await session.rpc.mode.set({ mode: "plan" });
            }
            expect(await session.rpc.mode.get()).toBe("plan");

            const name = "セッション 名前 ☕ – test";
            await session.rpc.name.set({ name });
            expect((await session.rpc.name.get()).name).toBe(name);

            expect((await session.rpc.permissions.resetSessionApprovals()).success).toBe(true);
            for (const enabled of [true, true, false, false]) {
                expect((await session.rpc.permissions.setApproveAll({ enabled })).success).toBe(
                    true
                );
            }
        });
    });

    it("fresh session metrics have zero tokens and a populated start time", async () => {
        await withSession(async (session) => {
            const metrics = await session.rpc.usage.getMetrics();
            expect(metrics.lastCallInputTokens).toBe(0);
            expect(metrics.lastCallOutputTokens).toBe(0);
            expect(metrics.totalUserRequests).toBe(0);
            expect(Number.isNaN(Date.parse(metrics.sessionStartTime))).toBe(false);
        });
    });
});
