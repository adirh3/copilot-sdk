/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectorSessionAccount, ConnectorStatus } from "../../src/index.js";
import { approveAll, CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createIdentityForHost, generateCA, type CaData } from "../../../test/harness/certUtils.js";
import { createSdkTestContext, isInProcessTransport } from "./harness/sdkTestContext.js";

const SESSION_TOKEN = "ghu_sdk_connector_session";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const CONNECTOR_FLAGS = { MANAGED_MCP_SERVERS: true, CONNECTORS: true };

/**
 * Exercises the session-owned Connector account surface through the public SDK
 * client against the built runtime: a credential-owned session selects its own
 * GitHub identity with `connectors.getAccount()`, and a targeted `reconcile`
 * replaces only the named Connector's MCP projection. The fixture stands in for
 * the GitHub API and the Connector service; no model request is made, so the
 * runtime's own RPC results are the observable completion boundary.
 */
// The in-process transport shares this test process's ambient environment, so it cannot
// take the per-client CA bundle the Connector MCP fixtures are signed with. The default
// stdio cell covers the behavior.
describe.skipIf(isInProcessTransport)("Session-owned Connector accounts", async () => {
    const { env, workDir } = await createSdkTestContext();

    // Every fixture handle starts unset and cleanup is registered before any of them is
    // acquired, so a failed startup still releases whatever was already listening.
    let fixtureDir: string | undefined;
    let mail: ConnectorMcpFixture | undefined;
    let relocatedMail: ConnectorMcpFixture | undefined;
    let calendar: ConnectorMcpFixture | undefined;
    let ordinary: ConnectorMcpFixture | undefined;
    let service: ConnectorServiceFixture | undefined;
    let client: CopilotClient | undefined;

    afterAll(async () => {
        await client?.stop().catch(() => undefined);
        await Promise.allSettled(
            [service, mail, relocatedMail, calendar, ordinary].map((fixture) => fixture?.close())
        );
        if (fixtureDir) {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

    beforeAll(async () => {
        // Connector-owned MCP endpoints must be HTTPS, so the fixtures are signed by a CA
        // appended to the harness bundle the runtime already trusts.
        const ca = generateCA();
        fixtureDir = mkdtempSync(join(tmpdir(), "sdk-connectors-"));
        mail = await startConnectorMcpServer("mail", ca);
        relocatedMail = await startConnectorMcpServer("mail-relocated", ca);
        calendar = await startConnectorMcpServer("calendar", ca);
        ordinary = await startConnectorMcpServer("ordinary", ca);
        service = await startConnectorService({
            mailUrl: mail.url,
            calendarUrl: calendar.url,
        });

        const caBundlePath = join(fixtureDir, "ca-bundle.pem");
        writeFileSync(
            caBundlePath,
            [readCaBundle(env.NODE_EXTRA_CA_CERTS), ca.certPem].filter(Boolean).join("\n")
        );
        // Point both the GitHub API and the Connector service at the fixture so the session's
        // own credential is the only identity the catalog can be read with.
        client = new CopilotClient({
            workingDirectory: workDir,
            env: {
                ...env,
                COPILOT_DEBUG_GITHUB_API_URL: service.url,
                NODE_EXTRA_CA_CERTS: caBundlePath,
                SSL_CERT_FILE: caBundlePath,
                REQUESTS_CA_BUNDLE: caBundlePath,
                CURL_CA_BUNDLE: caBundlePath,
            },
            logLevel: "error",
            connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
        });
    });

    function started() {
        if (!client || !service || !mail || !relocatedMail || !calendar || !ordinary) {
            throw new Error("Connector fixtures did not start");
        }
        return { client, service, mail, relocatedMail, calendar, ordinary };
    }

    it(
        "selects a credential-free session account and reconciles only the targeted Connector",
        { timeout: 120_000 },
        async () => {
            const { client, service, mail, relocatedMail, calendar, ordinary } = started();
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                gitHubToken: SESSION_TOKEN,
                featureFlags: CONNECTOR_FLAGS,
                disabledMcpServers: ["github-mcp-server"],
                mcpServers: {
                    ordinary: { type: "http", url: `${ordinary.url}/mcp`, tools: ["*"] },
                },
            });

            try {
                const capabilities = await session.rpc.connectors.getCapabilities();
                expect(capabilities).toMatchObject({
                    availability: "enabled",
                    sessionAccountSelection: true,
                    targetedReconcile: true,
                });

                const selected: ConnectorSessionAccount | null =
                    await session.rpc.connectors.getAccount();
                expect(selected).not.toBeNull();
                const account = selected!;
                expect(typeof account.accountId).toBe("string");
                expect(account.accountId.length).toBeGreaterThan(0);
                expect(account.authInfo).toEqual({
                    type: "token",
                    host: "https://github.com",
                    login: "octocat",
                });
                // The selection is an opaque routing identifier: no credential may reach the client.
                expect(JSON.stringify(account)).not.toContain(SESSION_TOKEN);

                // getAccount alone must not pin the session or touch the Connector service.
                expect(service.catalogReads).toBe(0);
                expect((await session.rpc.connectors.getStatus()).accountId).toBeUndefined();

                const connected = await session.rpc.connectors.reconcile({
                    accountId: account.accountId,
                    refreshCatalog: true,
                });
                expectConnected(connected, "mail");
                expectConnected(connected, "calendar");
                expect(service.catalogReads).toBeGreaterThan(0);
                expect(JSON.stringify(connected)).not.toContain(SESSION_TOKEN);
                expect(mail.authorizationHeaders.length).toBeGreaterThan(0);

                // Relocate only `mail` in the authoritative catalog, then reconcile it by name.
                service.setMailUrl(relocatedMail.url);
                const before = {
                    mail: mail.initializations,
                    relocatedMail: relocatedMail.initializations,
                    calendar: calendar.initializations,
                    ordinary: ordinary.initializations,
                };
                const targeted = await session.rpc.connectors.reconcile({
                    accountId: account.accountId,
                    refreshCatalog: true,
                    forceConnectorName: "mail",
                });
                expectConnected(targeted, "mail");
                expect(relocatedMail.initializations).toBe(before.relocatedMail + 1);
                expect(mail.initializations).toBe(before.mail);
                expect(calendar.initializations).toBe(before.calendar);
                expect(ordinary.initializations).toBe(before.ordinary);

                // An unknown Connector name is rejected rather than silently reconciling everything.
                await expect(
                    session.rpc.connectors.reconcile({
                        accountId: account.accountId,
                        forceConnectorName: "unknown",
                    })
                ).rejects.toThrow();
            } finally {
                await session.disconnect();
            }
        }
    );
});

function expectConnected(status: ConnectorStatus, connectorName: string): void {
    expect(status.runtimeServers).toEqual(
        expect.arrayContaining([expect.objectContaining({ connectorName, status: "connected" })])
    );
}

interface ConnectorServiceFixture {
    readonly url: string;
    readonly catalogReads: number;
    setMailUrl(url: string): void;
    close(): Promise<void>;
}

/**
 * Minimal GitHub API and Connector service the runtime can read a catalog from.
 * Only the session credential is accepted, so a catalog read proves the session's
 * own identity was used.
 */
async function startConnectorService({
    mailUrl,
    calendarUrl,
}: {
    mailUrl: string;
    calendarUrl: string;
}): Promise<ConnectorServiceFixture> {
    let currentMailUrl = mailUrl;
    let catalogReads = 0;
    let selfUrl = "";
    const server = createServer((request, response) => {
        const authorization = request.headers.authorization ?? "";
        const token = authorization.slice(authorization.indexOf(" ") + 1);
        response.setHeader("content-type", "application/json");
        if (request.url?.startsWith("/copilot_internal/user")) {
            if (token !== SESSION_TOKEN) {
                response.writeHead(401).end(JSON.stringify({ message: "Bad credentials" }));
                return;
            }
            response.end(
                JSON.stringify({
                    login: "octocat",
                    copilot_plan: "individual_pro",
                    is_mcp_enabled: true,
                    endpoints: { api: selfUrl },
                })
            );
            return;
        }
        if (request.url === "/copilot-connectors/api/v1/plugins") {
            if (token !== SESSION_TOKEN) {
                response.writeHead(401).end(JSON.stringify({ message: "Bad credentials" }));
                return;
            }
            catalogReads++;
            response.end(
                JSON.stringify({
                    plugins: [
                        connectorPlugin("mail", currentMailUrl),
                        connectorPlugin("calendar", calendarUrl),
                    ],
                })
            );
            return;
        }
        response.writeHead(404).end("{}");
    });
    const url = await listen(server);
    selfUrl = url;
    return {
        url,
        get catalogReads() {
            return catalogReads;
        },
        setMailUrl(next: string) {
            currentMailUrl = next;
        },
        close: () => closeServer(server),
    };
}

function connectorPlugin(name: string, url: string) {
    return {
        name,
        logo: "https://images.example/connector.svg",
        metadata: { displayName: name, tier: "standard", releaseTag: "preview" },
        connection: { status: "connected" },
        mcpServers: { mcpServers: { [name]: { type: "http", url: `${url}/mcp` } } },
    };
}

interface ConnectorMcpFixture {
    readonly url: string;
    readonly initializations: number;
    readonly authorizationHeaders: string[];
    close(): Promise<void>;
}

/** Hand-rolled Streamable HTTP MCP endpoint: enough for the runtime to initialize and list one tool. */
async function startConnectorMcpServer(name: string, ca: CaData): Promise<ConnectorMcpFixture> {
    let initializations = 0;
    const authorizationHeaders: string[] = [];
    const identity = createIdentityForHost("127.0.0.1", ca);
    const server = createHttpsServer(
        { key: identity.keyPem, cert: identity.certPem },
        (request, response) => {
            void (async () => {
                if (request.url !== "/mcp" || request.method !== "POST") {
                    response.writeHead(404, { "content-type": "application/json" }).end("{}");
                    return;
                }
                if (request.headers.authorization) {
                    authorizationHeaders.push(request.headers.authorization);
                }
                const body = await readBody(request);
                let message: unknown;
                try {
                    message = JSON.parse(body);
                } catch {
                    response.writeHead(400, { "content-type": "application/json" }).end("{}");
                    return;
                }
                const messages = Array.isArray(message) ? message : [message];
                const replies = messages
                    .map((item) =>
                        handleMcpMessage(item as McpMessage, name, () => initializations++)
                    )
                    .filter((item) => item !== undefined);
                if (replies.length === 0) {
                    response.writeHead(202, { "mcp-session-id": `${name}-session` }).end();
                    return;
                }
                response.writeHead(200, {
                    "content-type": "application/json",
                    "mcp-session-id": `${name}-session`,
                });
                response.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]));
            })().catch(() => {
                if (!response.headersSent) {
                    response.writeHead(500, { "content-type": "application/json" });
                }
                response.end("{}");
            });
        }
    );
    const url = await listen(server, "https");
    return {
        url,
        get initializations() {
            return initializations;
        },
        authorizationHeaders,
        close: () => closeServer(server),
    };
}

interface McpMessage {
    id?: unknown;
    method?: string;
    params?: { protocolVersion?: string };
}

function handleMcpMessage(
    message: McpMessage,
    name: string,
    onInitialize: () => void
): unknown | undefined {
    if (!message || typeof message !== "object" || message.id === undefined) {
        return undefined;
    }
    switch (message.method) {
        case "initialize":
            onInitialize();
            return {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    protocolVersion: message.params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name, version: "1.0.0" },
                },
            };
        case "tools/list":
            return {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    tools: [
                        {
                            name: `${name}_ping`,
                            description: `Returns the ${name} fixture principal.`,
                            inputSchema: { type: "object", properties: {} },
                        },
                    ],
                },
            };
        case "tools/call":
            return {
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: name }], isError: false },
            };
        default:
            return {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: `Method not found: ${message.method}` },
            };
    }
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("error", reject);
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

function readCaBundle(path: string | undefined): string {
    if (!path) {
        return "";
    }
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

async function listen(
    server: Server | HttpsServer,
    scheme: "http" | "https" = "http"
): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Connector fixture did not bind a TCP port");
    }
    return `${scheme}://127.0.0.1:${address.port}`;
}

function closeServer(server: Server | HttpsServer): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
    });
}
