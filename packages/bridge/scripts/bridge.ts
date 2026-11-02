#!/usr/bin/env bun
import { runCli } from "../src/server/cli.ts";

process.exitCode = await runCli(Bun.argv.slice(2));
