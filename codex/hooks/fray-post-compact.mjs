#!/usr/bin/env node
import { findProjectDir, loadFray, readStdinJson, returnedUnreconciled } from './fray-hook-lib.mjs';

const input = readStdinJson();
const projectDir = findProjectDir(input.cwd);
const fray = loadFray(projectDir);
if (!fray.enabled) process.exit(0);

const returned = returnedUnreconciled(projectDir).rows.length;

process.stdout.write(JSON.stringify({
  continue: true,
  suppressOutput: returned === 0,
  stopReason: returned
    ? `Fray PostCompact notice: ${returned} returned dispatch(es) are unreconciled; rely on SessionStart(source=compact) for Fray context injection.`
    : undefined,
}));
