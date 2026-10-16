/**
 * Lays out checkpoints as newest-first rows with `git log --graph`-style lanes.
 * Only first parents are followed; a parent outside `checkpoints` ends its lane.
 * @param {Object<string, {parent: string|null, created: string, order?: number}>} checkpoints
 *   keyed by id; `order` (ascending = newer) wins over `created` and must list
 *   every child before its parent.
 * @returns {{rows: {id: string, lane: number, above: number[], below: number[], joins: number[]}[],
 *   laneCount: number}} per row: `lane` holds the commit dot; `above`/`below` are lanes
 *   with a line crossing the row's top/bottom edge; `joins` are lanes (≠ `lane`) whose
 *   line ends at this row's dot because they branched off from it.
 */
function layoutHistory(checkpoints) {
  const ids = Object.keys(checkpoints).sort((a, b) => {
    const ca = checkpoints[a], cb = checkpoints[b];
    if (ca.order != null && cb.order != null) return ca.order - cb.order;
    return new Date(cb.created) - new Date(ca.created);
  });

  // lanes[i] = id of the commit the line in lane i is heading to, or null when free.
  const lanes = [];
  const active = () => lanes.flatMap((v, i) => (v === null ? [] : [i]));
  const rows = [];
  let laneCount = 0;

  for (const id of ids) {
    const above = active();
    const waiting = above.filter((i) => lanes[i] === id);
    let lane = waiting.length ? waiting[0] : lanes.indexOf(null);
    if (lane === -1) lane = lanes.length;
    const joins = waiting.filter((i) => i !== lane);

    const parent = checkpoints[id].parent;
    lanes[lane] = parent && checkpoints[parent] ? parent : null;
    for (const i of joins) lanes[i] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    const below = active();
    rows.push({ id, lane, above, below, joins });
    laneCount = Math.max(laneCount, lane + 1, ...above.map((i) => i + 1), ...below.map((i) => i + 1));
  }

  return { rows, laneCount };
}

module.exports = { layoutHistory };
