#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const log = process.env.TF_AXI_CALL_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), env: process.env })}\n`);
const code = Number(process.env.TF_AXI_EXIT_CODE ?? 0);
const fixture = process.env.TF_AXI_FIXTURE;
if (fixture) process.stdout.write(readFileSync(resolve(fixture), "utf8"));
if (process.env.TF_AXI_STDERR) process.stderr.write(process.env.TF_AXI_STDERR);
process.exitCode = code;
