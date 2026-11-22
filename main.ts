// Sokoban solver for sokoban-solver-01-run-20261121 (Node 22, standard library only).
//
// How it wins: the levels this contest draws are built as one hallway with
// self-contained rooms off it, and a box pushed out of its room can never
// come back — so a level is the sum of independent room puzzles. This solver
// finds that decomposition itself (flood-fill the floor once the hallway row
// is removed), then solves every room PUSH-OPTIMALLY with an A* over pushes:
//
//   - cost is pushes, not moves, which is what the checker scores;
//   - the estimate is a minimum-cost matching of boxes to goals over true
//     push distances (reverse BFS on the push graph), an admissible bound;
//   - squares no push can ever bring a box out of ("dead squares", corners
//     included) are pruned before the search starts, and 2x2 blocks with a
//     box off its goal are pruned as they form.
//
// Concatenating push-optimal room solutions gives a push-optimal level
// solution whenever the decomposition holds; when it does not (a box outside
// any room, a room the search cannot finish), the same push A* runs on the
// whole level instead. Deterministic: fixed orders everywhere, expansion
// caps rather than clocks, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** BFS walk for the player over floor cells that are not blocked; returns the move letters, or null. */
function walkPath(lv: Level, blocked: Set<number>, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Map<number, { p: number; ch: string }>();
  const queue = [from];
  prev.set(from, { p: -1, ch: '' });
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (cur === to) break;
    const cx = cur % lv.w, cy = Math.floor(cur / lv.w);
    for (const d of DIRS) {
      const nx = cx + d.dx, ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (lv.wall[n] || blocked.has(n) || prev.has(n)) continue;
      prev.set(n, { p: cur, ch: d.ch });
      queue.push(n);
    }
  }
  if (!prev.has(to)) return null;
  let out = '';
  for (let cur = to; cur !== from; ) {
    const step = prev.get(cur)!;
    out = step.ch + out;
    cur = step.p;
  }
  return out;
}

/**
 * Push-optimal A* inside one region: `cells` is the set of squares boxes and
 * the player may occupy, `start` the player's square, `boxes`/`goals` inside
 * it. Returns the move letters solving it, or null.
 */
function solveRegion(
  lv: Level,
  cells: Set<number>,
  start: number,
  boxes0: number[],
  goals: number[],
  cap: number,
  noBox?: Set<number>,
): string | null {
  const { w } = lv;
  // Reverse push distances: dist[j][c] = fewest pushes taking a box from c to goals[j].
  const dist: number[][] = goals.map((g) => {
    const d = new Array<number>(w * lv.h).fill(Infinity);
    d[g] = 0;
    const q = [g];
    for (let head = 0; head < q.length; head++) {
      const cur = q[head]!;
      const cx = cur % w, cy = Math.floor(cur / w);
      for (const dir of DIRS) {
        const px = cx - dir.dx, py = cy - dir.dy, sx = cx - 2 * dir.dx, sy = cy - 2 * dir.dy;
        if (px < 0 || py < 0 || px >= w || py >= lv.h || sx < 0 || sy < 0 || sx >= w || sy >= lv.h) continue;
        const prevBox = py * w + px; // box square before this push
        const stand = sy * w + sx; // player square for it
        if (!cells.has(prevBox) || !cells.has(stand) || d[prevBox] !== Infinity) continue;
        d[prevBox] = d[cur]! + 1;
        q.push(prevBox);
      }
    }
    return d;
  });
  const dead = new Uint8Array(w * lv.h);
  for (const c of cells) if (dist.every((d) => d[c] === Infinity)) dead[c] = 1;
  if (boxes0.some((b) => dead[b] && !lv.goal[b])) return null;

  const estimate = (boxes: number[]): number => {
    // Minimum-cost matching of boxes to goals (boxes <= 16; rooms hold <= 4,
    // and the whole-level fallback is capped long before this bites).
    const n = boxes.length;
    if (n === 0) return 0;
    if (n <= 8) {
      let best = Infinity;
      const used = new Array<boolean>(goals.length).fill(false);
      const go = (i: number, acc: number): void => {
        if (acc >= best) return;
        if (i === n) { best = acc; return; }
        for (let j = 0; j < goals.length; j++) {
          if (used[j]) continue;
          const c = dist[j]![boxes[i]!]!;
          if (c === Infinity) continue;
          used[j] = true; go(i + 1, acc + c); used[j] = false;
        }
      };
      go(0, 0);
      return best;
    }
    return boxes.reduce((a, b) => a + Math.min(...goals.map((_, j) => dist[j]![b]!)), 0);
  };

  interface Node { boxes: number[]; player: number; g: number; moves: string; }
  const keyOf = (boxes: number[], canon: number) => boxes.join(',') + '|' + canon;
  const heap: { f: number; h: number; node: Node }[] = [];
  const heapPush = (e: { f: number; h: number; node: Node }): void => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p]!.f < heap[i]!.f || (heap[p]!.f === heap[i]!.f && heap[p]!.h <= heap[i]!.h)) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const heapPop = (): { f: number; h: number; node: Node } => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && (heap[c + 1]!.f < heap[c]!.f || (heap[c + 1]!.f === heap[c]!.f && heap[c + 1]!.h < heap[c]!.h))) c++;
        if (heap[c]!.f > heap[i]!.f || (heap[c]!.f === heap[i]!.f && heap[c]!.h >= heap[i]!.h)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const startBoxes = [...boxes0].sort((a, b) => a - b);
  const h0 = estimate(startBoxes);
  if (h0 === Infinity) return null;
  heapPush({ f: h0, h: h0, node: { boxes: startBoxes, player: start, g: 0, moves: '' } });
  const best = new Map<string, number>();
  let expanded = 0;

  while (heap.length > 0 && expanded < cap) {
    const { node } = heapPop();
    const boxSet = new Set(node.boxes);
    // Player reachability + canonical representative + walk parents.
    const reach = new Map<number, { p: number; ch: string }>();
    reach.set(node.player, { p: -1, ch: '' });
    const q = [node.player];
    let canon = node.player;
    for (let head = 0; head < q.length; head++) {
      const cur = q[head]!;
      if (cur < canon) canon = cur;
      const cx = cur % w, cy = Math.floor(cur / w);
      for (const d of DIRS) {
        const n = (cy + d.dy) * w + (cx + d.dx);
        if (!cells.has(n) || boxSet.has(n) || reach.has(n)) continue;
        reach.set(n, { p: cur, ch: d.ch });
        q.push(n);
      }
    }
    const k = keyOf(node.boxes, canon);
    if (best.has(k) && best.get(k)! <= node.g) continue;
    best.set(k, node.g);
    if (node.boxes.every((b) => lv.goal[b])) return node.moves;
    expanded++;
    const walkTo = (target: number): string => {
      let out = '';
      for (let cur = target; cur !== node.player; ) {
        const s = reach.get(cur)!;
        out = s.ch + out;
        cur = s.p;
      }
      return out;
    };
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi]!;
      const bx = b % w, by = Math.floor(b / w);
      for (const d of DIRS) {
        const stand = (by - d.dy) * w + (bx - d.dx);
        const dest = (by + d.dy) * w + (bx + d.dx);
        if (!reach.has(stand) || !cells.has(dest) || boxSet.has(dest)) continue;
        if (noBox !== undefined && noBox.has(dest)) continue;
        if (dead[dest] && !lv.goal[dest]) continue;
        const nb = node.boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        // 2x2 freeze: a solid 2x2 of walls/boxes holding a box off its goal never moves again.
        let frozen = false;
        outer: for (let y = 0; y + 1 < lv.h; y++) {
          for (let x = 0; x + 1 < w; x++) {
            const quad = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
            if (quad.every((c) => !cells.has(c) || nb.includes(c)) && quad.some((c) => nb.includes(c) && !lv.goal[c])) { frozen = true; break outer; }
          }
        }
        if (frozen) continue;
        const hh = estimate(nb);
        if (hh === Infinity) continue;
        heapPush({
          f: node.g + 1 + hh,
          h: hh,
          node: { boxes: nb, player: b, g: node.g + 1, moves: node.moves + walkTo(stand) + d.ch.toUpperCase() },
        });
      }
    }
  }
  return null;
}

function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const { w, h } = lv;
  const allGoals = [...lv.goal].map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
  const hallwayRow = Math.floor(lv.player / w);
  const hallway = new Set<number>();
  for (let x = 0; x < w; x++) {
    const i = hallwayRow * w + x;
    if (!lv.wall[i]) hallway.add(i);
  }
  // Rooms: floor components once the hallway row is taken away.
  const seen = new Set<number>(hallway);
  const rooms: { cells: Set<number>; boxes: number[]; goals: number[]; door: number; hall: number }[] = [];
  let decomposed = true;
  for (let i = 0; i < w * h; i++) {
    if (lv.wall[i] || seen.has(i)) continue;
    const cells = new Set<number>();
    const q = [i];
    seen.add(i);
    for (let head = 0; head < q.length; head++) {
      const cur = q[head]!;
      cells.add(cur);
      const cx = cur % w, cy = Math.floor(cur / w);
      for (const d of DIRS) {
        const n = (cy + d.dy) * w + (cx + d.dx);
        if (n < 0 || n >= w * h || lv.wall[n] || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    const boxes = lv.boxes.filter((b) => cells.has(b));
    if (boxes.length === 0) continue;
    const goals = allGoals.filter((g) => cells.has(g));
    // The door: a room square next to a hallway square.
    let door = -1, hall = -1;
    for (const c of cells) {
      const cx = c % w, cy = Math.floor(c / w);
      for (const d of DIRS) {
        const n = (cy + d.dy) * w + (cx + d.dx);
        if (hallway.has(n)) { door = c; hall = n; break; }
      }
      if (door >= 0) break;
    }
    if (door < 0 || goals.length !== boxes.length) { decomposed = false; break; }
    rooms.push({ cells, boxes, goals, door, hall });
  }
  if (rooms.reduce((a, r) => a + r.boxes.length, 0) !== lv.boxes.length) decomposed = false;

  if (decomposed && rooms.length > 0) {
    const boxesNow = new Set(lv.boxes);
    let player = lv.player;
    let out = '';
    let ok = true;
    rooms.sort((a, b) => a.door - b.door);
    for (const room of rooms) {
      const walkIn = walkPath(lv, boxesNow, player, room.hall);
      if (walkIn === null) { ok = false; break; }
      // The room's region extends one square into the hallway: the player
      // starts there, so a box sitting on the door square itself can be
      // pushed in as the first move. Boxes may never be pushed onto that
      // hallway square (noBox) — out of the room is out for good.
      const region = new Set(room.cells);
      region.add(room.hall);
      const inner = solveRegion(lv, region, room.hall, room.boxes, room.goals, 400_000, new Set([room.hall]));
      if (inner === null) { ok = false; break; }
      const seq = walkIn + inner;
      out += seq;
      // Replay the room's moves on the shared board to update boxes and player.
      let p = player;
      for (const chRaw of seq) {
        const ch = chRaw.toLowerCase();
        const d = DIRS.find((dd) => dd.ch === ch)!;
        const next = p + d.dy * w + d.dx;
        if (boxesNow.has(next)) {
          boxesNow.delete(next);
          boxesNow.add(next + d.dy * w + d.dx);
        }
        p = next;
      }
      player = p;
      // Walk back out to the hallway for the next room.
      const back = walkPath(lv, boxesNow, player, room.hall);
      if (back === null) { ok = false; break; }
      out += back;
      player = room.hall;
    }
    if (ok && [...boxesNow].every((b) => lv.goal[b])) return out;
  }

  // Fallback: the same push A* on the whole level at once.
  const all = new Set<number>();
  for (let i = 0; i < w * h; i++) if (!lv.wall[i]) all.add(i);
  return solveRegion(lv, all, lv.player, lv.boxes, allGoals, 3_000_000) ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
