// myers.ts — makefun-diff 1.0.0's Myers greedy search, in AssemblyScript.
//
// This is the same search as solve.js (and as the reference): for d edits
// and diagonal k, the furthest point is one old line past the furthest
// (d-1)-point on k-1 (a deletion) or one new line past the furthest
// (d-1)-point on k+1 (an insertion), whichever reaches further into the
// old text, the deletion when both reach one point; a move past the end of
// either text is no candidate; then every run of lines equal in both is
// followed as far as it goes. The first path to reach both ends is the
// script, and the walk back replays those same choices.
//
// It runs on i32 line ids in linear memory (the caller interns the lines),
// keeps one snapshot per edit count in the scratch region, and writes the
// script's runs to the output region as (kind, count) i32 pairs:
// kind 0 = keep, 1 = delete, 2 = insert. It returns the number of runs,
// or -1 when the scratch region cannot hold the search (the caller then
// falls back to the JavaScript search, which is always correct).
//
// Memory layout (all addresses are byte addresses, set by the caller):
//   A at aPtr, aLen i32s; B at bPtr, bLen i32s.
//   The output region at outPtr holds the runs, and a second region at
//   revPtr holds them while they are collected backwards (both need room
//   for 2*D+1 pairs of i32s).
//   The scratch region at scratch holds the snapshots: snapshot d lives at
//   scratch + (d*d + 4*d)*4 bytes and holds 2*d+5 i32s, its values at
//   indices 2..2*d+2 (index k+d+2) and DEAD in the guard slots at both ends.
//   scratchLimit is the last byte the snapshots may use.

// A diagonal no path reached: no furthest old-line count exists there.
const DEAD: i32 = -1;

/** The byte address of snapshot d in the scratch region. */
function snapAddr(scratch: i32, d: i32): i32 {
  return scratch + (d * d + 4 * d) * 4;
}

/**
 * The runs of the edit script of A into B: the number of (kind, count)
 * pairs written to outPtr, or -1 when the scratch region runs out.
 */
export function diff(aPtr: i32, aLen: i32, bPtr: i32, bLen: i32, outPtr: i32, revPtr: i32, scratch: i32, scratchLimit: i32): i32 {
  const N: i32 = aLen;
  const M: i32 = bLen;
  // d = 0: one diagonal, the run of equal lines from the first lines.
  let s0: i32 = snapAddr(scratch, 0);
  if (s0 + 20 > scratchLimit) return -1;
  store<i32>(s0 + 0, DEAD);
  store<i32>(s0 + 4, DEAD);
  store<i32>(s0 + 12, DEAD);
  store<i32>(s0 + 16, DEAD);
  let x: i32 = 0;
  let y: i32 = 0;
  while (x < N && y < M && load<i32>(aPtr + x * 4) == load<i32>(bPtr + y * 4)) {
    x++;
    y++;
  }
  store<i32>(s0 + 8, x);
  let D: i32 = 0;
  let kEnd: i32 = 0;
  if (x < N || y < M) {
    let found: bool = false;
    for (let d: i32 = 1; d <= N + M && !found; d++) {
      const prev: i32 = snapAddr(scratch, d - 1);
      const cur: i32 = snapAddr(scratch, d);
      if (cur + (2 * d + 5) * 4 > scratchLimit) return -1;
      store<i32>(cur + 0, DEAD);
      store<i32>(cur + 4, DEAD);
      store<i32>(cur + (2 * d + 3) * 4, DEAD);
      store<i32>(cur + (2 * d + 4) * 4, DEAD);
      // Only the diagonals the search can reach, k = -d, -d+2, ..., d:
      // i = k + d is even, so the loop steps by 2.
      for (let i: i32 = 0; i <= 2 * d; i += 2) {
        const k: i32 = i - d;
        const vm1: i32 = load<i32>(prev + i * 4);
        const vp1: i32 = load<i32>(prev + (i + 2) * 4);
        const canDel: bool = vm1 >= 0 && vm1 < N;
        const canIns: bool = vp1 >= 0 && vp1 - k <= M;
        let xx: i32;
        if (canDel && (!canIns || vm1 + 1 >= vp1)) xx = vm1 + 1;
        else if (canIns) xx = vp1;
        else {
          store<i32>(cur + (i + 2) * 4, DEAD);
          continue;
        }
        let yy: i32 = xx - k;
        while (xx < N && yy < M && load<i32>(aPtr + xx * 4) == load<i32>(bPtr + yy * 4)) {
          xx++;
          yy++;
        }
        store<i32>(cur + (i + 2) * 4, xx);
        if (xx >= N && yy >= M) {
          D = d;
          kEnd = k;
          found = true;
          break;
        }
      }
    }
    if (!found) return -1;
  }
  // Walk the winning path back from the stored snapshots, replaying each
  // cell's choice, and collect the runs backwards into the rev region,
  // then reverse them into the output region.
  let rc: i32 = 0;
  let xx: i32 = N;
  let yy: i32 = M;
  let k: i32 = kEnd;
  for (let d: i32 = D; d >= 1; d--) {
    const prev: i32 = snapAddr(scratch, d - 1);
    const i: i32 = k + d;
    const vm1: i32 = load<i32>(prev + i * 4);
    const vp1: i32 = load<i32>(prev + (i + 2) * 4);
    const canDel: bool = vm1 >= 0 && vm1 < N;
    const canIns: bool = vp1 >= 0 && vp1 - k <= M;
    let x0: i32;
    let del: bool;
    if (canDel && (!canIns || vm1 + 1 >= vp1)) {
      del = true;
      x0 = vm1 + 1;
    } else {
      del = false;
      x0 = vp1;
    }
    const y0: i32 = x0 - k;
    if (xx > x0) {
      store<i32>(revPtr + rc * 8, 0);
      store<i32>(revPtr + rc * 8 + 4, xx - x0);
      rc++;
    }
    store<i32>(revPtr + rc * 8, del ? 1 : 2);
    store<i32>(revPtr + rc * 8 + 4, 1);
    rc++;
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
  if (xx > 0) {
    store<i32>(revPtr + rc * 8, 0);
    store<i32>(revPtr + rc * 8 + 4, xx);
    rc++;
  }
  // Reverse the collected runs into the output region.
  for (let i: i32 = 0; i < rc; i++) {
    const kind: i32 = load<i32>(revPtr + (rc - 1 - i) * 8);
    const count: i32 = load<i32>(revPtr + (rc - 1 - i) * 8 + 4);
    store<i32>(outPtr + i * 8, kind);
    store<i32>(outPtr + i * 8 + 4, count);
  }
  return rc;
}
