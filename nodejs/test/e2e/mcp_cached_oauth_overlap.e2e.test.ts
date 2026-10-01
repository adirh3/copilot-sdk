/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import {
    approveAll,
    CopilotClient,
    RuntimeConnection,
    type CopilotSession,
    type McpAuthHandler,
    type MCPServerConfig,
    type McpAuthRequest,
    type NamedProviderConfig,
    type ProviderModelConfig,
    type SessionEvent,
} from "../../src/index.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";
import { stopChildProcess, waitForCondition } from "./harness/sdkTestHelper.js";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const TEST_MCP_OAUTH_SERVER = resolve(__dirname, "../../../test/harness/test-mcp-oauth-server.mjs");
const TEST_MCP_SERVER = resolve(__dirname, "../../../test/harness/test-mcp-server.mjs");
const EXPECTED_TOKEN = "sdk-cached-overlap-token";
const STEP_TIMEOUT_MS = 60_000;

type LiveCatalog = "unchanged" | "removed" | "changed-schema";

describe("cached MCP OAuth overlap", async () => {
    const { env: harnessEnv } = await createSdkTestContext();

    test.for(["unchanged", "removed", "changed-schema"] as const)(
        "holds a cached model call across authentication completion (%s)",
        { timeout: 180_000 },
        async (liveCatalog: LiveCatalog) => {
            const directory = await mkdtemp(join(tmpdir(), "mcp-cached-oauth-overlap-"));
            const clients: CopilotClient[] = [];
            let model: ReturnType<typeof createServer> | undefined;
            let startingOAuthServer: ReturnType<typeof startOAuthMcpServer> | undefined;
            onTestFinished(async () => {
                const errors: unknown[] = [];
                const [oauthStartup] = await Promise.allSettled(
                    startingOAuthServer ? [startingOAuthServer] : []
                );
                for (const client of clients.reverse()) {
                    try {
                        errors.push(...(await client.stop()));
                    } catch (error) {
                        errors.push(error);
                    }
                }
                model?.closeAllConnections();
                if (model?.listening) {
                    try {
                        await new Promise<void>((resolvePromise, reject) => {
                            model?.close((error) => (error ? reject(error) : resolvePromise()));
                        });
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (oauthStartup?.status === "fulfilled") {
                    try {
                        await oauthStartup.value.stop();
                    } catch (error) {
                        errors.push(error);
                    }
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
                if (errors.length) {
                    throw new AggregateError(errors, "Cached OAuth E2E cleanup failed");
                }
            });

            const workdir = await realpath(directory);
            execFileSync("git", ["init", "--quiet", workdir], { windowsHide: true });
            const events: SessionEvent[] = [];
            const advertisedTools: string[][] = [];
            let modelFailure: Error | undefined;
            let modelRequests = 0;
            const modelEntered = Promise.withResolvers<void>();
            const releaseModel = Promise.withResolvers<void>();
            model = createServer((request, response) => {
                void (async () => {
                    const body = JSON.parse(await text(request)) as {
                        tools?: Array<{ function?: { name: string } }>;
                    };
                    const tools =
                        body.tools?.flatMap((tool) =>
                            tool.function ? [tool.function.name] : []
                        ) ?? [];
                    advertisedTools.push(tools);
                    const step = modelRequests++;
                    if (step === 0) {
                        modelEntered.resolve();
                        await releaseModel.promise;
                        const workiqTool = tools.find((name) => name.endsWith("-whoami"));
                        if (!workiqTool) throw new Error("Cached WorkIQ tool was not advertised");
                        respondModel(response, {
                            role: "assistant",
                            content: null,
                            tool_calls: [
                                {
                                    id: "cached-oauth-call",
                                    type: "function",
                                    function: { name: workiqTool, arguments: "{}" },
                                },
                            ],
                        });
                        return;
                    }
                    if (step === 1) {
                        respondModel(response, {
                            role: "assistant",
                            content: `CACHED_OAUTH_${liveCatalog.toUpperCase()}_DONE`,
                        });
                        return;
                    }
                    throw new Error(`Unexpected model request ${step}`);
                })().catch((error: unknown) => {
                    modelFailure = error instanceof Error ? error : new Error(String(error));
                    response.writeHead(500).end();
                });
            });
            startingOAuthServer = startOAuthMcpServer();
            const oauthServer = await startingOAuthServer;
            await new Promise<void>((resolvePromise, reject) => {
                model.once("error", reject);
                model.listen(0, "127.0.0.1", resolvePromise);
            });
            const modelAddress = model.address();
            if (!modelAddress || typeof modelAddress === "string") {
                throw new Error("No model fixture port");
            }

            const providers: NamedProviderConfig[] = [
                {
                    name: "local",
                    type: "openai",
                    baseUrl: `http://127.0.0.1:${modelAddress.port}`,
                    apiKey: "test",
                    wireApi: "completions",
                },
            ];
            const models: ProviderModelConfig[] = [
                { id: "model", provider: "local", modelId: "test-model", wireModel: "test-model" },
            ];
            const cacheHome = join(workdir, "cache");
            const makeClient = (profile: string) => {
                const client = new CopilotClient({
                    workingDirectory: workdir,
                    env: {
                        ...harnessEnv,
                        COPILOT_HOME: join(workdir, profile),
                        COPILOT_CACHE_HOME: cacheHome,
                        COPILOT_DISABLE_KEYTAR: "1",
                        COPILOT_MCP_APPS: "false",
                        COPILOT_MCP_TOOL_CACHE: "true",
                        TOOL_SEARCH_DISABLED: "1",
                    },
                    gitHubToken: DEFAULT_GITHUB_TOKEN,
                    connection: RuntimeConnection.forStdio({
                        path: process.env.COPILOT_CLI_PATH,
                    }),
                });
                clients.push(client);
                return client;
            };
            const sessionOptions = (onMcpAuthRequest: McpAuthHandler) => ({
                onPermissionRequest: approveAll,
                onMcpAuthRequest,
                workingDirectory: workdir,
                mcpServers: {
                    workiq: {
                        type: "http",
                        url: `${oauthServer.url}/mcp`,
                        tools: ["*"],
                        oauthClientId: "sdk-cached-overlap-client",
                        oauthPublicClient: true,
                    } as unknown as MCPServerConfig,
                    peer: {
                        type: "local",
                        command: process.execPath,
                        args: [TEST_MCP_SERVER, "--server-name", "peer"],
                        tools: ["*"],
                    } as MCPServerConfig,
                },
                providers,
                models,
                model: "local/model",
            });
            const project = async (session: CopilotSession) => {
                await session.rpc.tools.initializeAndValidate();
                const metadata = await session.rpc.tools.getCurrentMetadata();
                return (metadata.tools ?? []).map((tool) => tool.name);
            };

            const seedClient = makeClient("seed-profile");
            const seedSession = await seedClient.createSession(
                sessionOptions(async () => ({
                    kind: "token",
                    accessToken: EXPECTED_TOKEN,
                    tokenType: "Bearer",
                    expiresIn: 3600,
                }))
            );
            await waitForMcpServerStatus(seedSession, "workiq", "connected");
            const seededTools = await project(seedSession);
            expect(seededTools).toContain("workiq-whoami");
            expect(seededTools).toContain("peer-get_env");
            await seedClient.deleteSession(seedSession.sessionId);
            const seedStopErrors = await seedClient.stop();
            expect(seedStopErrors).toEqual([]);
            clients.splice(clients.indexOf(seedClient), 1);

            await oauthServer.setToolMode(liveCatalog);
            const authEntered = Promise.withResolvers<McpAuthRequest>();
            let credentialsAvailable = false;
            const liveClient = makeClient("live-profile");
            const session = await liveClient.createSession(
                sessionOptions(async (request) => {
                    authEntered.resolve(request);
                    if (!credentialsAvailable) {
                        return { kind: "cancelled" };
                    }
                    return {
                        kind: "token",
                        accessToken: EXPECTED_TOKEN,
                        tokenType: "Bearer",
                        expiresIn: 3600,
                    };
                })
            );
            session.on((event) => events.push(event));

            const cachedTools = await project(session);
            expect(cachedTools).toContain("workiq-whoami");
            expect(cachedTools).toContain("peer-get_env");
            const turn = session.send({ prompt: "Run the cached WorkIQ identity tool." });
            await Promise.all([modelEntered.promise, authEntered.promise]);
            await waitForMcpServerStatus(session, "workiq", "needs-auth");
            expect(advertisedTools[0]).toContain("workiq-whoami");
            expect(advertisedTools[0]).toContain("peer-get_env");

            credentialsAvailable = true;
            try {
                await session.rpc.mcp.oauth.authenticationStateChanged({ serverName: "workiq" });
            } catch (error) {
                expect(String(error)).toContain(
                    'MCP server "workiq" still requires authentication'
                );
            }
            await waitForMcpServerStatus(session, "workiq", "connected");
            releaseModel.resolve();
            await turn;

            const finalReply = `CACHED_OAUTH_${liveCatalog.toUpperCase()}_DONE`;
            await waitForCondition(
                () => {
                    if (modelFailure) throw modelFailure;
                    return events.some(
                        (event) =>
                            event.type === "assistant.message" && event.data.content === finalReply
                    );
                },
                { timeoutMs: STEP_TIMEOUT_MS, timeoutMessage: `No reply ${finalReply}` }
            );
            const completion = events.find(
                (event) =>
                    event.type === "tool.execution_complete" &&
                    event.data.toolCallId === "cached-oauth-call"
            );
            expect(completion?.type).toBe("tool.execution_complete");
            if (completion?.type !== "tool.execution_complete") {
                throw new Error("No cached OAuth tool completion");
            }
            expect(completion.data.success).toBe(liveCatalog === "unchanged");
            expect(advertisedTools[1]).toContain("peer-get_env");

            const requests = await oauthServer.requests();
            const toolCalls = requests.filter((request) => {
                if (!request.body) return false;
                const body = JSON.parse(request.body) as { method?: string };
                return body.method === "tools/call";
            });
            expect(toolCalls).toHaveLength(liveCatalog === "unchanged" ? 1 : 0);
            if (liveCatalog !== "unchanged") {
                expect(completion.data.error?.message).toContain(
                    'MCP tool catalog changed before tool "workiq-whoami" could be invoked'
                );
            }
        }
    );
});

function respondModel(
    response: import("node:http").ServerResponse,
    message: Record<string, unknown>
): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
        JSON.stringify({
            id: "cached-oauth-completion",
            object: "chat.completion",
            created: 0,
            model: "test-model",
            choices: [
                {
                    index: 0,
                    message,
                    finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        })
    );
}

async function waitForMcpServerStatus(
    session: CopilotSession,
    serverName: string,
    expectedStatus: string
): Promise<void> {
    let lastStatus = "<not listed>";
    await waitForCondition(
        async () => {
            const result = await session.rpc.mcp.list();
            const server = result.servers.find((entry) => entry.name === serverName);
            lastStatus = server?.status ?? "<not listed>";
            return server?.status === expectedStatus;
        },
        {
            timeoutMs: STEP_TIMEOUT_MS,
            intervalMs: 200,
            timeoutMessage: `${serverName} did not reach ${expectedStatus}; last status was ${lastStatus}`,
        }
    );
}

async function startOAuthMcpServer(): Promise<{
    url: string;
    requests(): Promise<Array<{ authorization: string | null; body: string | null; path: string }>>;
    setToolMode(mode: LiveCatalog): Promise<void>;
    stop(): Promise<void>;
}> {
    const child = spawn(process.execPath, [TEST_MCP_OAUTH_SERVER], {
        env: { ...process.env, EXPECTED_TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    let url: string;
    try {
        url = await new Promise<string>((resolvePromise, reject) => {
            const lines = createInterface({ input: child.stdout });
            const timeout = setTimeout(() => {
                lines.close();
                reject(new Error(`Timed out waiting for OAuth server. ${stderr.join("")}`));
            }, 10_000);
            child.once("exit", (code, signal) => {
                clearTimeout(timeout);
                lines.close();
                reject(
                    new Error(
                        `OAuth server exited before listening. code=${code} signal=${signal} ${stderr.join("")}`
                    )
                );
            });
            lines.on("line", (line) => {
                const match = /^Listening: (.+)$/.exec(line);
                if (!match) return;
                clearTimeout(timeout);
                lines.close();
                resolvePromise(match[1]);
            });
        });
    } catch (error) {
        await stopChildProcess(child);
        throw error;
    }
    return {
        url,
        requests: async () => {
            const response = await fetch(`${url}/__requests`);
            if (!response.ok) throw new Error(`Failed to fetch requests: ${response.status}`);
            return response.json();
        },
        setToolMode: async (mode) => {
            const response = await fetch(`${url}/__tool-mode`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ mode }),
            });
            if (!response.ok) throw new Error(`Failed to set tool mode: ${response.status}`);
        },
        stop: () => stopChildProcess(child),
    };
}
