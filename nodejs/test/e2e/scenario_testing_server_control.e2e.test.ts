/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeConnection } from "../../src/index.js";
import type { CopilotClient } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const FAKE_CLI = `
const fs = require("node:fs");
const requests = [];
const capture = process.argv[process.argv.indexOf("--capture-file") + 1];
let queue = [], steeringMessages = [], nextId = 0, buffer = Buffer.alloc(0);
function reply(id, result) {
  const body = JSON.stringify({jsonrpc:"2.0",id,result});
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function handle(request) {
  if (request.id === undefined) return;
  const {id,method,params={}} = request;
  requests.push({method,params});
  fs.writeFileSync(capture, JSON.stringify(requests));
  if (method === "connect") return reply(id, {ok:true,protocolVersion:3,version:"scenario-control"});
  if (method === "session.create") return reply(id, {sessionId:params.sessionId || "scenario-control",workspacePath:null,capabilities:{supportsStreaming:true}});
  if (method === "session.detach") return reply(id, {success:true});
  if (method === "catalog.search") return reply(id, {kind:"succeeded", candidates:[], searchId:"scenario-search", truncated:false, negotiated:{runtimeProtocolVersion:params.contract.protocolVersion,grantedCapabilities:params.contract.requiredCapabilities}});
  if (method === "session.workflow.listRuns") return reply(id, {runs:[{runId:"workflow-run-1",workflowName:"scenario-workflow",status:"running",revision:4}],oldestSeq:7,newestSeq:7,hasMoreNewer:false});
  if (method === "session.workflow.getRunDetail") return reply(id, {runId:"workflow-run-1",workflowName:"scenario-workflow",status:"running",revision:4});
  if (method === "session.workflow.getRunProgress") return reply(id, {records:[{seq:12,phaseId:"verify",kind:"log",text:"Validation complete"}],oldestSeq:12,newestSeq:12,revision:4,hasMoreOlder:false,hasMoreNewer:false});
  if (method === "session.workflow.cancel") return reply(id, {runId:params.runId,status:"cancelled",reason:"cancelled by user",attempt:1});
  if (method === "session.autopilotObjective.getState") return reply(id, {state:{id:17,objective:"Ship the scenario.",status:"active",turnCount:3,creditCountNanoAiu:"1250000000",creditLimit:{credits:5,creditsUsed:1.25,creditsUsedNanoAiu:"1250000000"}}});
  if (method === "session.remote.enable") return reply(id, {url:"https://example.test/sessions/"+params.sessionId,remoteSteerable:params.mode==="on"});
  if (method === "session.queue.insertAt") {
    const item = {id:"queue-"+(++nextId),messageId:"message-"+nextId,kind:"message",prompt:params.message.prompt,displayText:params.message.displayPrompt||params.message.prompt,agentMode:params.message.agentMode||"interactive"};
    queue.splice(params.position,0,item); return reply(id,{id:item.id});
  }
  if (method === "session.queue.pendingItems") return reply(id,{items:queue.map(({prompt,...item})=>item),steeringMessages,inFlightSteeringCount:0});
  if (method === "session.queue.updateText") {
    const item=queue.find(x=>x.id===params.id);
    if(item){item.prompt=params.prompt;item.displayText=params.displayPrompt||params.prompt;}
    return reply(id,{updated:!!item});
  }
  if (method === "session.queue.duplicateAt") {
    const index=queue.findIndex(x=>x.id===params.id), id2="queue-"+(++nextId);
    if(index>=0)queue.splice(index+1,0,{...queue[index],id:id2,messageId:"message-"+nextId});
    return reply(id,{id:id2});
  }
  if (method === "session.queue.moveItem") {
    const index=queue.findIndex(x=>x.id===params.id);
    if(index<0)return reply(id,{changed:false});
    queue.splice(params.toPosition,0,...queue.splice(index,1));
    return reply(id,{changed:index!==params.toPosition});
  }
  if (method === "session.queue.removeAt" || method === "session.queue.sendNow") {
    const index=queue.findIndex(x=>x.id===params.id);
    if(index>=0){
      const [item]=queue.splice(index,1);
      if(method.endsWith("sendNow"))steeringMessages.push(item.displayText);
    }
    return reply(id,method.endsWith("sendNow")?{steered:index>=0}:{removed:index>=0});
  }
  reply(id,null);
}
process.stdin.on("data",chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  for(;;){
    const end=buffer.indexOf("\\r\\n\\r\\n");if(end<0)break;
    const match=/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0,end).toString());
    if(!match)throw Error("Missing Content-Length");
    const offset=end+4,size=Number(match[1]);if(buffer.length<offset+size)break;
    const message=JSON.parse(buffer.subarray(offset,offset+size).toString());
    buffer=buffer.subarray(offset+size);handle(message);
  }
});
process.stdin.resume();
`;

describe("Scenario server control generated RPC", async () => {
    const { createClient, workDir } = await createSdkTestContext();

    async function withFakeCli(
        action: (
            client: CopilotClient,
            requests: () => Array<{ method: string; params: Record<string, unknown> }>
        ) => Promise<void>
    ) {
        const cliPath = join(workDir, "scenario-control-cli.js");
        const capturePath = join(workDir, "scenario-control-requests.json");
        writeFileSync(cliPath, FAKE_CLI);
        const client = createClient({
            connection: RuntimeConnection.forStdio({
                path: cliPath,
                args: ["--capture-file", capturePath],
            }),
            useLoggedInUser: false,
        });
        try {
            await client.start();
            await action(client, () => JSON.parse(readFileSync(capturePath, "utf8")));
        } finally {
            await client.forceStop();
        }
    }

    it.each([
        ["all", ["mcp-server", "ai-skill"], ["mcp-server-card", "ai-skill-discovery"]],
        ["mcp", ["mcp-server"], ["mcp-server-card"]],
        ["skills", ["ai-skill"], ["ai-skill-discovery"]],
    ] as const)(
        "searches server catalog for %s category",
        async (_category, kinds, capabilities) => {
            await withFakeCli(async (client, requests) => {
                const result = await client.rpc.catalog.search({
                    contract: { protocolVersion: 3, requiredCapabilities: [...capabilities] },
                    query: "scenario search",
                    limit: 50,
                    kinds: [...kinds],
                });
                expect(result).toMatchObject({
                    kind: "succeeded",
                    candidates: [],
                    searchId: "scenario-search",
                    negotiated: { runtimeProtocolVersion: 3, grantedCapabilities: capabilities },
                    truncated: false,
                });
                expect(
                    requests().find((request) => request.method === "catalog.search")?.params
                ).toMatchObject({
                    query: "scenario search",
                    limit: 50,
                    kinds,
                    contract: { protocolVersion: 3, requiredCapabilities: capabilities },
                });
            });
        }
    );

    it("should observe page and cancel factory run", async () => {
        await withFakeCli(async (client, requests) => {
            const session = await client.createSession({});
            const runs = await session.rpc.workflow.listRuns({
                afterSeq: 3,
                beforeSeq: 20,
                limit: 10,
            });
            expect(runs).toMatchObject({ oldestSeq: 7, newestSeq: 7, hasMoreNewer: false });
            expect(runs.runs[0]).toMatchObject({
                runId: "workflow-run-1",
                workflowName: "scenario-workflow",
                status: "running",
            });
            const detail = await session.rpc.workflow.getRunDetail({ runId: "workflow-run-1" });
            expect(detail).toMatchObject({
                runId: "workflow-run-1",
                workflowName: "scenario-workflow",
                status: "running",
                revision: 4,
            });
            const progress = await session.rpc.workflow.getRunProgress({
                runId: "workflow-run-1",
                phaseId: "verify",
                afterSeq: 5,
                beforeSeq: 20,
                limit: 25,
            });
            expect(progress.records[0]).toMatchObject({
                seq: 12,
                phaseId: "verify",
                kind: "log",
                text: "Validation complete",
            });
            expect(await session.rpc.workflow.cancel({ runId: "workflow-run-1" })).toMatchObject({
                runId: "workflow-run-1",
                status: "cancelled",
                reason: "cancelled by user",
            });
            expect(
                requests().find((request) => request.method === "session.workflow.listRuns")?.params
            ).toMatchObject({
                afterSeq: 3,
                beforeSeq: 20,
                limit: 10,
            });
            expect(
                requests().find((request) => request.method === "session.workflow.getRunProgress")
                    ?.params
            ).toMatchObject({
                runId: "workflow-run-1",
                phaseId: "verify",
                afterSeq: 5,
                beforeSeq: 20,
                limit: 25,
            });
            await session.disconnect();
        });
    });

    it.each([
        ["on", true],
        ["export", false],
    ] as const)(
        "should read autopilot state and enable remote mode %s",
        async (mode, steerable) => {
            await withFakeCli(async (client, requests) => {
                const session = await client.createSession({});
                expect((await session.rpc.autopilotObjective.getState()).state).toMatchObject({
                    id: 17,
                    objective: "Ship the scenario.",
                    status: "active",
                    turnCount: 3,
                    creditCountNanoAiu: "1250000000",
                    creditLimit: {
                        credits: 5,
                        creditsUsed: 1.25,
                        creditsUsedNanoAiu: "1250000000",
                    },
                });
                expect(await session.rpc.remote.enable({ mode })).toMatchObject({
                    remoteSteerable: steerable,
                    url: `https://example.test/sessions/${session.sessionId}`,
                });
                expect(
                    requests().find((request) => request.method === "session.remote.enable")?.params
                ).toMatchObject({
                    sessionId: session.sessionId,
                    mode,
                });
                await session.disconnect();
            });
        }
    );

    it("should edit reorder duplicate remove and send queued items", async () => {
        await withFakeCli(async (client, requests) => {
            const session = await client.createSession({});
            await session.rpc.queue.setDrainPaused({ paused: true });
            const first = await session.rpc.queue.insertAt({
                position: 0,
                message: {
                    prompt: "First hidden prompt",
                    displayPrompt: "First visible prompt",
                    agentMode: "interactive",
                },
            });
            const second = await session.rpc.queue.insertAt({
                position: 1,
                message: {
                    prompt: "Second hidden prompt",
                    displayPrompt: "Second visible prompt",
                    agentMode: "plan",
                },
            });
            expect(
                (
                    await session.rpc.queue.updateText({
                        id: first.id,
                        prompt: "Updated hidden prompt",
                        displayPrompt: "Updated visible prompt",
                    })
                ).updated
            ).toBe(true);
            const duplicate = await session.rpc.queue.duplicateAt({ id: first.id });
            expect(duplicate.id).not.toBe(first.id);
            expect(
                (await session.rpc.queue.moveItem({ id: second.id, toPosition: 0 })).changed
            ).toBe(true);
            const items = (await session.rpc.queue.pendingItems()).items;
            expect(items.map((item) => item.id)).toEqual([second.id, first.id, duplicate.id]);
            expect(items[1]).toMatchObject({
                displayText: "Updated visible prompt",
                agentMode: "interactive",
            });
            expect((await session.rpc.queue.sendNow({ id: second.id })).steered).toBe(true);
            expect((await session.rpc.queue.pendingItems()).steeringMessages).toEqual([
                "Second visible prompt",
            ]);
            expect((await session.rpc.queue.removeAt({ id: duplicate.id })).removed).toBe(true);
            expect((await session.rpc.queue.pendingItems()).items).toEqual([
                expect.objectContaining({
                    id: first.id,
                    displayText: "Updated visible prompt",
                }),
            ]);
            await session.rpc.queue.setDrainPaused({ paused: false });
            expect(
                requests()
                    .filter((request) => request.method === "session.queue.setDrainPaused")
                    .map((request) => request.params.paused)
            ).toEqual([true, false]);
            await session.disconnect();
        });
    });
});
