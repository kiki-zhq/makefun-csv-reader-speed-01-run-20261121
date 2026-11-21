// Driver for the csv-reader-speed-01-run-20261121 bounty.
// Reads /input/cases.json (an array of {id, input}), answers each case
// alone with run() from ./solve.js, and writes the array of answers to
// /output/answers.json. Paths come from MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR when set, falling back to the container defaults
// /input and /output. V8's incremental marking is off, set before solve.js
// is imported so all of its work runs under it, as the house baseline runs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
