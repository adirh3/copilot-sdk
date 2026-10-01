/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Session workspace checkpoint RPC", async () => {
    const { copilotClient: client, createClient, workDir } = await createSdkTestContext();

    it("should list no checkpoints for fresh session", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const result = await session.rpc.workspaces.listCheckpoints();
            expect(result.checkpoints).toEqual([]);
        } finally {
            await session.disconnect();
        }
    });

    it("should return null or empty content for unknown checkpoint", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            // A high but 32-bit-safe checkpoint number that will never exist in a fresh
            // session, so the read reports the checkpoint as missing.
            const result = await session.rpc.workspaces.readCheckpoint({ number: 4294967294 });
            expect(result.content ?? "").toBe("");
        } finally {
            await session.disconnect();
        }
    });

    it.each(["session", "unstaged", "branch"] as const)(
        "should return typed workspace diff result for %s mode",
        async (mode) => {
            // Git-root discovery caches misses, so use a fresh path for each repo fixture.
            const gitWorkDir = mkdtempSync(join(workDir, "diff-"));
            const modifiedName = `modified-${randomUUID()}.txt`;
            const deletedName = `deleted-${randomUUID()}.txt`;
            execFileSync("git", ["init", "--quiet"], { cwd: gitWorkDir });
            writeFileSync(join(gitWorkDir, modifiedName), "before");
            writeFileSync(join(gitWorkDir, deletedName), "before");
            execFileSync("git", ["add", "--", modifiedName, deletedName], { cwd: gitWorkDir });
            execFileSync(
                "git",
                [
                    "-c",
                    "user.name=SDK Test",
                    "-c",
                    "user.email=sdk-test@example.test",
                    "commit",
                    "--quiet",
                    "-m",
                    "Create workspace diff fixture",
                ],
                { cwd: gitWorkDir }
            );
            writeFileSync(join(gitWorkDir, modifiedName), "after");
            unlinkSync(join(gitWorkDir, deletedName));
            const gitClient = createClient({ workingDirectory: gitWorkDir });
            try {
                const session = await gitClient.createSession({
                    onPermissionRequest: approveAll,
                });
                try {
                    const result = await session.rpc.workspaces.diff({ mode });
                    expect(result.requestedMode).toBe(mode);
                    if (mode === "unstaged") {
                        expect(result.mode).toBe("unstaged");
                        expect(result.isFallback).toBe(false);
                        expect(result.unavailableReason).toBeUndefined();
                    } else {
                        expect([mode, "unstaged"]).toContain(result.mode);
                        expect(result.isFallback).toBe(
                            result.mode === "unstaged" ||
                                result.unavailableReason === "session-busy"
                        );
                        expect(result.unavailableReason !== undefined).toBe(
                            mode === "session" && result.isFallback
                        );
                    }
                    expect(Array.isArray(result.changes)).toBe(true);
                    if (result.mode === "session") {
                        expect(result.changes).toEqual([]);
                    } else {
                        expect(
                            result.changes.find((change) => change.path.endsWith(modifiedName))
                                ?.changeType
                        ).toBe("modified");
                        expect(
                            result.changes.find((change) => change.path.endsWith(deletedName))
                                ?.changeType
                        ).toBe("deleted");
                    }
                    for (const change of result.changes) {
                        expect(change.path.trim()).toBeTruthy();
                        expect(["added", "modified", "deleted", "renamed"]).toContain(
                            change.changeType
                        );
                        expect(typeof change.diff).toBe("string");
                    }
                } finally {
                    await session.disconnect();
                }
            } finally {
                await gitClient.stop();
            }
        }
    );

    it("should save large paste and expose readable content", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const content = "Large paste payload 🚀\n".repeat(512);
            const result = await session.rpc.workspaces.saveLargePaste({ content });
            const saved = result.saved;

            expect(saved).not.toBeNull();
            expect(saved!.filename.trim()).toBeTruthy();
            expect(saved!.filePath.trim()).toBeTruthy();
            expect(saved!.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));

            try {
                const read = await session.rpc.workspaces.readFile({ path: saved!.filename });
                expect(read.content).toBe(content);
            } catch (err: unknown) {
                expect(existsSync(saved!.filePath)).toBe(true);
                expect(readFileSync(saved!.filePath, "utf8")).toBe(content);
                expect(err).toBeDefined();
            }
        } finally {
            await session.disconnect();
        }
    });
});
