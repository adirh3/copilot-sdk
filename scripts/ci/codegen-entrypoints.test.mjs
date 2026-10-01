/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const codegenRoot = fileURLToPath(new URL("../codegen/", import.meta.url));
const loader = createRequire(new URL("../codegen/package.json", import.meta.url)).resolve("tsx");

for (const language of ["python", "go", "csharp"]) {
    test(`runs the ${language} generator through a Bazel-style symlink`, (t) => {
        const directory = mkdtempSync(join(tmpdir(), "codegen-entrypoint-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const entry = join(directory, `${language}.ts`);
        symlinkSync(join(codegenRoot, `${language}.ts`), entry);
        const missingSchema = join(directory, "missing-schema.json");
        // Supplying both schema paths prevents standalone generators from acquiring a published runtime.
        const result = spawnSync(
            process.execPath,
            ["--import", pathToFileURL(loader).href, entry, missingSchema, missingSchema],
            {
                cwd: directory,
                encoding: "utf8",
                windowsHide: true,
                timeout: process.platform === "win32" ? 60_000 : 30_000,
                env: { ...process.env, COPILOT_CODEGEN_OUTPUT_ROOT: join(directory, "output") },
            },
        );
        const diagnostics = `${result.stdout}\n${result.stderr}`;
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, `Expected ${language} to reject the missing local schemas.\n${diagnostics}`);
        assert.match(result.stderr, /missing-schema\.json/, diagnostics);
    });
}
