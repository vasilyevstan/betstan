export const gridLayout = (outcomes, columns = 2) => ({
  version: 1, columns, tileShape: 'rounded',
  tiles: outcomes.map((outcome, index) => ({
    outcomeKey: outcome.key, row: Math.floor(index / columns) + 1, column: index % columns + 1, width: 1, height: 1,
  })),
});

export const tileStyle = (tile) => ({
  gridColumn: `${tile.column} / span ${tile.width}`,
  gridRow: `${tile.row} / span ${tile.height}`,
});
export const layoutRows = (layout) => Math.max(1, ...layout.tiles.map((tile) => tile.row + tile.height - 1));
const integer = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
export const layoutError = (layout, outcomes) => {
  if (!layout || layout.version !== 1 || !integer(layout.columns, 4)
    || !['rectangle', 'rounded', 'pill'].includes(layout.tileShape) || !Array.isArray(layout.tiles)) {
    return 'This layout is not supported.';
  }
  const keys = new Set(outcomes.map((outcome) => outcome.key));
  if (layout.tiles.length !== keys.size) return 'Place every outcome exactly once.';
  const occupied = new Set();
  for (const tile of layout.tiles) {
    if (!tile || !keys.delete(tile.outcomeKey)) return 'Place every outcome exactly once.';
    if (!integer(tile.row, 64) || !integer(tile.column, layout.columns) || !integer(tile.width, layout.columns)
      || !integer(tile.height, 4) || tile.column + tile.width - 1 > layout.columns || tile.row + tile.height - 1 > 64) {
      return 'Keep tiles inside the grid (up to 64 rows).';
    }
    for (let row = tile.row; row < tile.row + tile.height; row += 1) {
      for (let column = tile.column; column < tile.column + tile.width; column += 1) {
        const key = `${row}:${column}`;
        if (occupied.has(key)) return 'That space is occupied. Move the other tile first.';
        occupied.add(key);
      }
    }
  }
  return '';
};

// Keep existing positions when labels/keys change, outcomes are added, or one is removed.
export const reconcileLayout = (layout, outcomes, previous = outcomes) => {
  if (!layout) return gridLayout(outcomes);
  const tiles = layout.tiles.flatMap((tile) => {
    const old = previous.find((outcome) => outcome.key === tile.outcomeKey);
    const next = outcomes.find((outcome) => old?.localId ? outcome.localId === old.localId : outcome.key === tile.outcomeKey);
    return next ? [{ ...tile, outcomeKey: next.key }] : [];
  });
  for (const outcome of outcomes) {
    if (tiles.some((tile) => tile.outcomeKey === outcome.key)) continue;
    let placed = false;
    for (let row = 1; row <= 64 && !placed; row += 1) {
      for (let column = 1; column <= layout.columns && !placed; column += 1) {
        const tile = { outcomeKey: outcome.key, row, column, width: 1, height: 1 };
        const candidate = [...tiles, tile];
        if (!layoutError({ ...layout, tiles: candidate }, candidate.map((item) => ({ key: item.outcomeKey })))) {
          tiles.push(tile);
          placed = true;
        }
      }
    }
  }
  return { ...layout, tiles };
};

const fixedDesign = (id, name, labels, columns) => {
  const definition = { name, parameters: [], outcomes: labels.map((label, index) => ({ key: `${id}-${index}`, label })) };
  return { id: `standard:${id}`, kind: 'standard', definition, layout: gridLayout(definition.outcomes, columns) };
};

// These are previews of the existing products, not authorable settlement definitions.
export const standardMarketDesigns = [
  fixedDesign('1x2', '1X2', ['1', 'X', '2'], 3),
  fixedDesign('correct-score', 'Correct Score', ['0 - 0', '0 - 1', '1 - 0', '1 - 1', '1 - 2', '2 - 0', '2 - 1', '2 - 2', '3 - 0', '3 - 1'], 2),
];
