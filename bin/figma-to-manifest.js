#!/usr/bin/env node
import { main } from '../src/transform.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
