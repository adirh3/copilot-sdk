/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** SDK coverage using a real stdio MCP server and a local, deterministic model. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import {
    approveAll,
    CopilotClient,
    RuntimeConnection,
    type CopilotSession,
    type NamedProviderConfig,
    type ProviderModelConfig,
    type SessionEvent,
} from "../../src/index.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CATALOG_RECOVERY_SERVER = resolve(
    __dirname,
    "../../../test/harness/test-mcp-catalog-recovery-server.mjs"
);
const STEP_TIMEOUT_MS = 60_000;

describe("MCP catalog recovery", async () => {
    const { env: harnessEnv } = await createSdkTestContext();

    test.for(["live", "cached-startup"] as const)(
        "MCP tools remain callable after timeouts and failed discovery recovers without a restart (%s)",
        { timeout: 180_000 },
        async (scenario) => {
            const cachedStartup = scenario === "cached-startup";
            const directory = await mkdtemp(join(tmpdir(), "mcp-catalog-recovery-"));
            let failure: Error | undefined;
            let modelRequests = 0;
            const advertisedTools: string[][] = [];
            const events: SessionEvent[] = [];
            const model = createServer((request, response) => {
                void (async () => {
                    const body = JSON.parse(await text(request)) as {
                        tools?: Array<{ function?: { name: string } }>;
                    };
                    advertisedTools.push(
                        body.tools?.flatMap((tool) =>
                            tool.function ? [tool.function.name] : []
                        ) ?? []
                    );
                    const step = modelRequests++;
                    const toolName = new Map([
                        [0, "probe-ping"],
                        [1, "probe-stall"],
                        [3, "probe-refresh"],
                        [5, "probe-recovered"],
                    ]).get(step);
                    const reply = new Map([
                        [2, "TIMEOUT_TURN_DONE"],
                        [4, "DEGRADED_TURN_DONE"],
                        [6, "CATALOG_RECOVERY_DONE"],
                        [7, "DISABLED_TURN_DONE"],
                    ]).get(step);
                    if (!toolName && !reply) throw new Error(`Unexpected model request ${step}`);
                    const message = toolName
                        ? {
                              role: "assistant",
                              content: null,
                              tool_calls: [
                                  {
                                      id: `catalog-call-${step}`,
                                      type: "function",
                                      function: { name: toolName, arguments: "{}" },
                                  },
                              ],
                          }
                        : {
                              role: "assistant",
                              content: reply,
                          };
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(
                        JSON.stringify({
                            id: `completion-${step}`,
                            object: "chat.completion",
                            created: 0,
                            model: "test-model",
                            choices: [
                                {
                                    index: 0,
                                    message,
                                    finish_reason: toolName ? "tool_calls" : "stop",
                                },
                            ],
                            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
                        })
                    );
                })().catch((error: unknown) => {
                    failure = error instanceof Error ? error : new Error(String(error));
                    response.writeHead(500).end();
                });
            });

            const workdir = await realpath(directory);
            execFileSync("git", ["init", "--quiet", workdir], { windowsHide: true });
            const trafficPath = join(workdir, "traffic.log");
            const startupReleasePath = join(workdir, "startup-release");
            const recoveryReleasePath = join(workdir, "recovery-release");
            await writeFile(startupReleasePath, "release");
            const traffic = async () => (await readFile(trafficPath, "utf8")).trim().split(/\r?\n/);
            await new Promise<void>((resolve, reject) => {
                model.once("error", reject);
                model.listen(0, "127.0.0.1", resolve);
            });
            const address = model.address();
            if (!address || typeof address === "string") throw new Error("No model fixture port");

            const client = new CopilotClient({
                workingDirectory: workdir,
                env: {
                    ...harnessEnv,
                    TOOL_SEARCH_DISABLED: "1",
                    COPILOT_MCP_TOOL_CACHE: String(cachedStartup),
                    // MCP Apps performs separate post-call metadata probes, outside catalog recovery.
                    COPILOT_MCP_APPS: "false",
                    COPILOT_CACHE_HOME: join(workdir, "cache"),
                    COPILOT_DISABLE_KEYTAR: "1",
                },
                gitHubToken: DEFAULT_GITHUB_TOKEN,
                connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
            });

            onTestFinished(async () => {
                const errors: unknown[] = [];
                try {
                    // stop() reports teardown failures by returning them, not by throwing.
                    errors.push(...(await client.stop()));
                } catch (error) {
                    errors.push(error);
                }
                model.closeAllConnections();
                try {
                    if (model.listening) {
                        await new Promise<void>((resolve, reject) => {
                            model.close((error) => (error ? reject(error) : resolve()));
                        });
                    }
                } catch (error) {
                    errors.push(error);
                }
                try {
                    await rm(directory, {
                        recursive: true,
                        force: true,
                        maxRetries: 10,
                        retryDelay: 100,
                    });
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length)
                    throw new AggregateError(errors, "MCP catalog fixture cleanup failed");
            });

            const providers: NamedProviderConfig[] = [
                {
                    name: "local",
                    type: "openai",
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiKey: "test",
                    wireApi: "completions",
                },
            ];
            const models: ProviderModelConfig[] = [
                { id: "model", provider: "local", modelId: "test-model", wireModel: "test-model" },
            ];
            const createProbeSession = async (): Promise<CopilotSession> => {
                const created = await client.createSession({
                    onPermissionRequest: approveAll,
                    workingDirectory: workdir,
                    mcpServers: {
                        probe: {
                            type: "local",
                            command: process.execPath,
                            args: [
                                CATALOG_RECOVERY_SERVER,
                                trafficPath,
                                startupReleasePath,
                                recoveryReleasePath,
                            ],
                            tools: ["*"],
                            timeout: 2_500,
                        },
                    },
                    providers,
                    models,
                    model: "local/model",
                });
                created.on((event) => {
                    events.push(event);
                });
                return created;
            };

            let session = await createProbeSession();
            const project = async () => {
                await session.rpc.tools.initializeAndValidate();
                const metadata = await session.rpc.tools.getCurrentMetadata();
                return (metadata.tools ?? []).map((tool) => tool.name);
            };
            const sendTurn = async (prompt: string, reply: string) => {
                const idleCount = events.filter((event) => event.type === "session.idle").length;
                await session.send({ prompt });
                // Validate the final assistant response arrived (guards against a lost turn)
                await waitForCondition(
                    () => {
                        if (failure) throw failure;
                        return events.some(
                            (event) =>
                                event.type === "assistant.message" && event.data.content === reply
                        );
                    },
                    { timeoutMs: STEP_TIMEOUT_MS, timeoutMessage: `No assistant reply ${reply}` }
                );
                await waitForCondition(
                    () =>
                        events.filter((event) => event.type === "session.idle").length > idleCount,
                    { timeoutMs: STEP_TIMEOUT_MS, timeoutMessage: `Turn for ${reply} never idled` }
                );
            };
            const pollTraffic = async (line: string, message: string) =>
                waitForCondition(async () => (await traffic()).includes(line), {
                    timeoutMs: STEP_TIMEOUT_MS,
                    timeoutMessage: message,
                });

            expect(await project()).toContain("probe-ping");
            if (cachedStartup) {
                const previousSessionId = session.sessionId;
                await client.deleteSession(previousSessionId);
                await rm(startupReleasePath);
                session = await createProbeSession();
                const cachedTools = await project();
                expect(cachedTools).toContain("probe-obsolete");
                expect(cachedTools).not.toContain("probe-recovered");
                await pollTraffic("startup-held", "Fixture never held its startup listing");
                await writeFile(startupReleasePath, "release");
                await pollTraffic("list-cancelled", "Held startup listing was never cancelled");
                const retryProjections: string[][] = [];
                await waitForCondition(
                    async () => {
                        retryProjections.push(await project());
                        return (await traffic()).includes("list-failed");
                    },
                    { timeoutMs: STEP_TIMEOUT_MS, timeoutMessage: "Discovery retry never failed" }
                );
                for (const names of retryProjections) {
                    expect(names).toContain("probe-ping");
                    expect(names).toContain("probe-obsolete");
                    expect(names).not.toContain("probe-recovered");
                }
                await writeFile(recoveryReleasePath, "release");
                // Do not invoke a tool or emit a notification that could mask a lost
                // background failure; only subsequent catalog projections may recover.
                await waitForCondition(
                    async () => {
                        const names = await project();
                        expect(names).toContain("probe-ping");
                        return names.includes("probe-recovered");
                    },
                    {
                        timeoutMs: STEP_TIMEOUT_MS,
                        timeoutMessage: "Catalog never recovered after the failed retry",
                    }
                );
            }
            await sendTurn("Call ping, then stall.", "TIMEOUT_TURN_DONE");
            await pollTraffic("tool-cancelled", "Timed-out tool call was never cancelled");
            const afterTimeout = await traffic();
            const stallIndex = afterTimeout.indexOf("tools/call:stall");
            expect(stallIndex).toBeGreaterThanOrEqual(0);
            expect(afterTimeout.slice(stallIndex)).not.toContain("tools/list");
            expect(advertisedTools[2]).toContain("probe-ping");
            const completed = () =>
                events.filter((event) => event.type === "tool.execution_complete");
            expect(completed()[0].data).toMatchObject({ success: true });
            expect(completed()[1].data).toMatchObject({ success: false });
            expect(JSON.stringify(completed()[1].data)).toContain("Request timed out");

            const cancelledListsBeforeRefresh = (await traffic()).filter(
                (line) => line === "list-cancelled"
            ).length;
            await sendTurn("Call refresh.", "DEGRADED_TURN_DONE");
            expect(events.filter((event) => event.type === "session.error")).toEqual([]);
            await waitForCondition(
                () =>
                    events.some(
                        (event) =>
                            event.type === "session.warning" &&
                            event.data.warningType === "mcp" &&
                            event.data.message ===
                                'MCP server "probe" announced changed tools, but refreshing its catalog failed. Some tools may be unavailable or outdated; discovery will retry on the next turn.'
                    ),
                {
                    timeoutMs: STEP_TIMEOUT_MS,
                    timeoutMessage: "No degraded-catalog MCP warning was emitted",
                }
            );
            expect(modelRequests).toBe(5);
            expect(advertisedTools[4]).toContain("probe-ping");
            if (cachedStartup) {
                expect(advertisedTools[4]).toContain("probe-recovered");
            } else {
                expect(advertisedTools[4]).not.toContain("probe-recovered");
            }
            await waitForCondition(
                async () =>
                    (await traffic()).filter((line) => line === "list-cancelled").length ===
                    cancelledListsBeforeRefresh + 1,
                {
                    timeoutMs: STEP_TIMEOUT_MS,
                    timeoutMessage: "The announced-change listing was never cancelled",
                }
            );

            // The fixture recovers after cancellation without another notification.
            await waitForCondition(async () => (await project()).includes("probe-recovered"), {
                timeoutMs: STEP_TIMEOUT_MS,
                timeoutMessage: "Catalog never recovered after the degraded refresh",
            });
            await sendTurn("Call recovered.", "CATALOG_RECOVERY_DONE");
            expect(completed()).toHaveLength(4);
            expect(completed()[3].data).toMatchObject({ success: true });
            expect(JSON.stringify(completed()[3].data)).toContain("RECOVERED_TOOL_REPLY");
            expect(advertisedTools[5]).toContain("probe-recovered");
            expect(advertisedTools[5]).not.toContain("probe-obsolete");
            const finalTraffic = await traffic();
            expect(finalTraffic.filter((line) => line === "started")).toHaveLength(
                cachedStartup ? 2 : 1
            );
            expect(finalTraffic.filter((line) => line === "list-cancelled")).toHaveLength(
                cachedStartup ? 2 : 1
            );

            await session.rpc.mcp.disable({ serverName: "probe" });
            await sendTurn("Reply without tools.", "DISABLED_TURN_DONE");
            expect(advertisedTools[7].filter((name) => name.startsWith("probe-"))).toEqual([]);
        }
    );
});
