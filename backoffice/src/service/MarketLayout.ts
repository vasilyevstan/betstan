import { MarketDefinition, marketKey, marketObject, MarketValidationError } from "@betstan/common";

export interface MarketTile {
  outcomeKey: string;
  row: number;
  column: number;
  width: number;
  height: number;
}

export interface MarketLayout {
  version: 1;
  columns: number;
  tileShape: "rectangle" | "rounded" | "pill";
  tiles: MarketTile[];
}

const integer = (value: unknown, maximum: number, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new MarketValidationError(`${label} must be a whole number from 1 to ${maximum}`);
  }
  return value;
};

// Presentation is deliberately outside the shared pricing/settlement configuration.
export const parseMarketLayout = (value: unknown, definition: MarketDefinition): MarketLayout => {
  const input = marketObject(value, ["version", "columns", "tileShape", "tiles"], "Market layout");
  if (input.version !== 1) throw new MarketValidationError("Unsupported market layout version");
  const columns = integer(input.columns, 4, "Layout columns");
  if (input.tileShape !== "rectangle" && input.tileShape !== "rounded" && input.tileShape !== "pill") {
    throw new MarketValidationError("Unsupported outcome tile shape");
  }
  if (!Array.isArray(input.tiles) || input.tiles.length !== definition.outcomes.length) {
    throw new MarketValidationError("The layout must show every outcome exactly once");
  }
  const remaining = new Set(definition.outcomes.map(outcome => outcome.key));
  const occupied = new Set<string>();
  const tiles = input.tiles.map(value => {
    const tile = marketObject(value, ["outcomeKey", "row", "column", "width", "height"], "Outcome tile");
    const outcomeKey = marketKey(tile.outcomeKey, "Layout outcome key");
    if (!remaining.delete(outcomeKey)) throw new MarketValidationError("Layout has an unknown or duplicate outcome");
    const row = integer(tile.row, 64, "Tile row");
    const column = integer(tile.column, columns, "Tile column");
    const width = integer(tile.width, columns, "Tile width");
    const height = integer(tile.height, 4, "Tile height");
    if (column + width - 1 > columns || row + height - 1 > 64) {
      throw new MarketValidationError("Outcome tile extends outside the layout");
    }
    for (let y = row; y < row + height; y += 1) {
      for (let x = column; x < column + width; x += 1) {
        const cell = `${y}:${x}`;
        if (occupied.has(cell)) throw new MarketValidationError("Outcome tiles must not overlap");
        occupied.add(cell);
      }
    }
    return { outcomeKey, row, column, width, height };
  });
  return { version: 1, columns, tileShape: input.tileShape, tiles };
};

export const gridLayout = (definition: MarketDefinition, columns: number): MarketLayout => ({
  version: 1, columns, tileShape: "rounded",
  tiles: definition.outcomes.map((outcome, index) => ({
    outcomeKey: outcome.key, row: Math.floor(index / columns) + 1, column: index % columns + 1, width: 1, height: 1,
  })),
});
