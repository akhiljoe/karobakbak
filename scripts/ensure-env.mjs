#!/usr/bin/env node
/**
 * Create a local env file from its tracked template if it does not exist yet.
 *
 *   node scripts/ensure-env.mjs .env.loadtest
 *
 * The load-test and VPS-rehearsal env files used to be tracked directly. They
 * are templates now (`.env.loadtest.example`, `.env.vps.example`) so a local
 * edit cannot end up committed, and the npm scripts call this first so a fresh
 * clone still works with one command. An existing file is never overwritten.
 */

import { copyFileSync, existsSync } from 'node:fs';

const target = process.argv[2];
if (!target || !/^\.env\.[a-z]+$/.test(target)) {
  console.error('usage: node scripts/ensure-env.mjs .env.<name>');
  process.exit(2);
}

if (!existsSync(target)) {
  const template = `${target}.example`;
  if (!existsSync(template)) {
    console.error(`${template} not found`);
    process.exit(1);
  }
  copyFileSync(template, target);
  console.log(`created ${target} from ${template}`);
}
