#!/usr/bin/env node
// Print bounded windows around occurrences of a needle in a large file.
// Usage: node tools/slice.cjs <file> <needle> [before] [after] [max]
'use strict';

const fs = require('fs');

const [file, needle, beforeArg, afterArg, maxArg] = process.argv.slice(2);
if (!file || !needle) {
  console.error('usage: node tools/slice.cjs <file> <needle> [before] [after] [max]');
  process.exit(2);
}

const before = Number(beforeArg ?? 300);
const after = Number(afterArg ?? 600);
const max = Number(maxArg ?? 5);
const text = fs.readFileSync(file, 'utf8');

let index = 0;
let count = 0;
while ((index = text.indexOf(needle, index)) >= 0 && count < max) {
  count += 1;
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + needle.length + after);
  console.log(`=== match ${count} offset=${index} ===`);
  console.log(text.slice(start, end).replace(/\s+/g, ' '));
  index += needle.length;
}

console.log(`total_shown=${count}`);
