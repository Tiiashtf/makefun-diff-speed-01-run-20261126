// A faster drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly makefun-diff 1.0.0's patch of { old, new }:
// the same lines, the same Myers greedy search with make.fun's
// deletion-before-insertion tie-break, the same 3 kept lines of context and
// the same hunk merging. Only the search is faster.
//
// The search runs in WebAssembly (myers.wasm, built from myers.ts in this
// repository, the same search written in AssemblyScript): it keeps, per
// edit count, one Int32Array of the furthest old-line count reached on
// each diagonal, and walks the winning path back from those stored arrays.
// The reference keeps one allocated path object per (edits, diagonal)
// cell, each carrying its own linked history, so a case costs millions of
// small allocations; the WebAssembly loop does the same choices at every
// cell over plain i32s in linear memory, with no allocation and no bounds
// checks on the hot path. The lines are interned to i32 ids first, so the
// search compares ids, and the patch is built from the runs it returns.
// When the module cannot run (or its scratch region cannot hold a search),
// the same search runs in JavaScript below, so the answer is always exact.
//
// The patch follows the reference's rule: a first line
// "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then each
// hunk "@ os ol ns nl" with one line per line it covers, "=" kept,
// "-" deleted, "+" inserted, deletions before insertions in each run of
// changes, up to 3 kept lines before and after each run, runs at most 6
// kept lines apart sharing a hunk, and a line that ends its text with no
// newline written with one and followed by a "%" line. Identical texts
// are the first line alone.

import { readFileSync } from 'node:fs';

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** The op of a kept, a deleted and an inserted line, as the patch writes them. */
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** A diagonal no path reached: no furthest old-line count exists there. */
const DEAD = -1;

// ---------------------------------------------------------------- WebAssembly

/** The module's memory, 256 MiB: large enough for any search this task draws. */
const MEMORY_PAGES = 4096;
/** Byte addresses of the regions in that memory (see myers.ts). */
const A_PTR = 0x100000;
const B_PTR = 0x140000;
const OUT_PTR = 0x180000;
const REV_PTR = 0x1a0000;
const SCRATCH_PTR = 0x200000;

/** The compiled search, or null when it cannot run (the JavaScript search below is then used). */
let wasmDiff = null;
/** The memory the search runs in. */
let wasmMemory = null;
try {
  wasmMemory = new WebAssembly.Memory({ initial: MEMORY_PAGES, maximum: 16384 });
  const bytes = readFileSync(new URL('./myers.wasm', import.meta.url));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: wasmMemory } });
  if (typeof instance.exports.diff === 'function') wasmDiff = instance.exports.diff;
} catch {
  wasmDiff = null;
  wasmMemory = null;
}

// ---------------------------------------------------------------- lines

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const parts = text.split('\n');
  const lines = [];
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) lines.push(parts[i] + '\n');
  if (parts[last] !== '') lines.push(parts[last]);
  return lines;
}

/** The ids of the lines, one id per distinct line, shared across cases. */
const lineIds = new Map();

/** The ids of lines[lo..hi), interned in the shared table. */
function intern(lines, lo, hi) {
  const ids = new Int32Array(hi - lo);
  for (let i = lo; i < hi; i++) {
    const line = lines[i];
    let id = lineIds.get(line);
    if (id === undefined) {
      id = lineIds.size;
      lineIds.set(line, id);
    }
    ids[i - lo] = id;
  }
  return ids;
}

// ---------------------------------------------------------------- the search in JavaScript (the fallback)

/**
 * The runs of the edit script of a[a0..a1) into b[b0..b1): [{ kind, count }],
 * in order, by the header's rule. A snapshot per edit count d holds, at
 * index k + d + 2, the furthest old-line count reached on diagonal k
 * (guard slots at both ends stay DEAD, so a diagonal the search never
 * reached reads as no candidate).
 */
function editRuns(a, b, a0, a1, b0, b1) {
  const N = a1 - a0;
  const M = b1 - b0;
  const snaps = [];
  // d = 0: one diagonal, the run of equal lines from the first lines.
  let cur = new Int32Array(5);
  cur[0] = DEAD;
  cur[1] = DEAD;
  cur[3] = DEAD;
  cur[4] = DEAD;
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[a0 + x] === b[b0 + y]) {
    x++;
    y++;
  }
  cur[2] = x;
  snaps.push(cur);
  let D = 0;
  let kEnd = 0;
  if (x < N || y < M) {
    let found = false;
    for (let d = 1; d <= N + M && !found; d++) {
      const prev = snaps[d - 1];
      cur = new Int32Array(2 * d + 5);
      cur[0] = DEAD;
      cur[1] = DEAD;
      cur[2 * d + 3] = DEAD;
      cur[2 * d + 4] = DEAD;
      for (let i = 0; i <= 2 * d; i += 2) {
        const k = i - d;
        const vm1 = prev[i]; // furthest (d-1)-point on k - 1
        const vp1 = prev[i + 2]; // furthest (d-1)-point on k + 1
        const canDel = vm1 >= 0 && vm1 < N;
        const canIns = vp1 >= 0 && vp1 - k <= M;
        let xx;
        if (canDel && (!canIns || vm1 + 1 >= vp1)) xx = vm1 + 1;
        else if (canIns) xx = vp1;
        else {
          cur[i + 2] = DEAD;
          continue;
        }
        let yy = xx - k;
        while (xx < N && yy < M && a[a0 + xx] === b[b0 + yy]) {
          xx++;
          yy++;
        }
        cur[i + 2] = xx;
        if (xx >= N && yy >= M) {
          D = d;
          kEnd = k;
          found = true;
          break;
        }
      }
      snaps.push(cur);
    }
    if (!found) throw new Error('makefun-diff: the search ended without reaching both ends');
  }
  // Walk the winning path back from the stored arrays, replaying each
  // cell's choice, and collect the runs in reverse.
  const rev = [];
  let xx = N;
  let yy = M;
  let k = kEnd;
  for (let d = D; d >= 1; d--) {
    const prev = snaps[d - 1];
    const i = k + d;
    const vm1 = prev[i];
    const vp1 = prev[i + 2];
    const canDel = vm1 >= 0 && vm1 < N;
    const canIns = vp1 >= 0 && vp1 - k <= M;
    let x0;
    let del;
    if (canDel && (!canIns || vm1 + 1 >= vp1)) {
      del = true;
      x0 = vm1 + 1;
    } else {
      del = false;
      x0 = vp1;
    }
    const y0 = x0 - k;
    if (xx > x0) rev.push({ kind: KEEP, count: xx - x0 });
    rev.push({ kind: del ? DELETE : INSERT, count: 1 });
    if (del) {
      xx = x0 - 1;
      yy = y0;
      k = k - 1;
    } else {
      xx = x0;
      yy = y0 - 1;
      k = k + 1;
    }
  }
  if (xx > 0) rev.push({ kind: KEEP, count: xx });
  rev.reverse();
  return rev;
}

// ---------------------------------------------------------------- the patch

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** The patch of the texts from the script's runs, by the header's rule. */
function patchFromRuns(a, b, runs) {
  const n = a.length;
  const m = b.length;
  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.at(-1);
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }
  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.at(-1);
    const prev = h?.at(-1);
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h.at(-1);
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, a[at]));
  }
  return out.join('');
}

// ---------------------------------------------------------------- the entry

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  let runs = null;
  if (wasmDiff !== null) {
    const A = intern(a, prefix, n - suffix);
    const B = intern(b, prefix, m - suffix);
    const mem = new Int32Array(wasmMemory.buffer);
    mem.set(A, A_PTR / 4);
    mem.set(B, B_PTR / 4);
    const rc = wasmDiff(A_PTR, A.length, B_PTR, B.length, OUT_PTR, REV_PTR, SCRATCH_PTR, wasmMemory.buffer.byteLength);
    if (rc >= 0) {
      runs = [];
      if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
      const base = OUT_PTR / 4;
      for (let i = 0; i < rc; i++) {
        const kind = mem[base + i * 2];
        runs.push({ kind: kind === 0 ? KEEP : kind === 1 ? DELETE : INSERT, count: mem[base + i * 2 + 1] });
      }
      if (suffix > 0) runs.push({ kind: KEEP, count: suffix });
    }
  }
  if (runs === null) {
    runs = [];
    if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
    runs.push(...editRuns(a, b, prefix, n - suffix, prefix, m - suffix));
    if (suffix > 0) runs.push({ kind: KEEP, count: suffix });
  }
  return patchFromRuns(a, b, runs);
}
