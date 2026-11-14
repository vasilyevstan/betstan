import React, { useRef, useState } from 'react';
import { gridLayout, layoutError, layoutRows, tileStyle } from '../../marketLayout';
import { marketActionClass } from '../../marketUi';

const MarketLayoutEditor = ({ outcomes, layout, onChange, onRename, disabled }) => {
  const identity = (outcome) => outcome?.localId ?? outcome?.key;
  const [selectedKey, setSelectedKey] = useState(identity(outcomes[0]));
  const [error, setError] = useState('');
  const [dropCell, setDropCell] = useState('');
  const drag = useRef(null);
  const skipClick = useRef(false);
  const selected = outcomes.find((outcome) => identity(outcome) === selectedKey) ?? outcomes[0];
  const tile = layout.tiles.find((item) => item.outcomeKey === selected?.key);
  const update = (next) => {
    const problem = layoutError(next, outcomes);
    setError(problem);
    if (!problem) onChange(next);
  };
  const move = (key, changes) => update({
    ...layout, tiles: layout.tiles.map((item) => item.outcomeKey === key ? { ...item, ...changes } : item),
  });
  const rows = Math.min(64, layoutRows(layout) + 1);
  const cells = [];
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= layout.columns; column += 1) {
      const item = layout.tiles.find((position) => row >= position.row && row < position.row + position.height
        && column >= position.column && column < position.column + position.width);
      if (!item || (item.row === row && item.column === column)) cells.push({ row, column, tile: item });
    }
  }
  const label = (outcome) => outcome?.label?.trim() || `Outcome ${outcomes.indexOf(outcome) + 1}`;
  const targetCell = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-layout-row]');
    if (!target || !event.currentTarget.closest('.market-designer__canvas')?.contains(target)) return null;
    return { row: Number(target.dataset.layoutRow), column: Number(target.dataset.layoutColumn) };
  };
  const dragStart = (event, outcome) => {
    if (disabled || event.button !== 0) return;
    setSelectedKey(identity(outcome));
    drag.current = { key: outcome.key, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dragMove = (event) => {
    if (!drag.current) return;
    if (Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 6) drag.current.moved = true;
    const target = drag.current.moved && targetCell(event);
    setDropCell(target ? `${target.row}:${target.column}` : '');
  };
  const dragEnd = (event) => {
    const previous = drag.current;
    drag.current = null;
    setDropCell('');
    skipClick.current = Boolean(previous?.moved);
    const target = previous?.moved && targetCell(event);
    if (!disabled && target) move(previous.key, target);
  };
  const selectTile = (outcome) => {
    if (skipClick.current) { skipClick.current = false; return; }
    setSelectedKey(identity(outcome));
    setError('');
  };
  return <fieldset className="market-designer" disabled={disabled}>
    <legend>Design the player view</legend>
    <p className="market-help">Drag a tile, or select it and tap an empty square. Change its width and height to build your layout.
      Empty squares are spacing, not betting options.</p>
    <div className="market-designer__toolbar">
      <label>Grid columns<select className="form-select" value={layout.columns} onChange={(event) => {
        // Changing the grid is explicit: a denser grid must never silently discard outcomes.
        const columns = Number(event.target.value);
        update({ ...gridLayout(outcomes, columns), tileShape: layout.tileShape });
      }}>
        {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label>Tile shape<select className="form-select" value={layout.tileShape}
        onChange={(event) => update({ ...layout, tileShape: event.target.value })}>
        <option value="rectangle">Straight corners</option><option value="rounded">Rounded</option><option value="pill">Pill</option>
      </select></label>
      <button className={marketActionClass()} type="button" onClick={() => update({
        ...gridLayout(outcomes, layout.columns), tileShape: layout.tileShape,
      })}>Arrange evenly</button>
    </div>
    <p className="market-help">Changing the column count arranges the tiles evenly.</p>
    <div className="market-designer__workspace">
      <div className={`market-designer__canvas market-layout market-layout--${layout.tileShape}`}
        role="group" aria-label="Market layout canvas" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}>
        {cells.map((cell) => {
          const outcome = cell.tile && outcomes.find((item) => item.key === cell.tile.outcomeKey);
          return outcome ? <button type="button" key={outcome.key}
            style={tileStyle(cell.tile)} className="market-designer__tile"
            data-layout-row={cell.row} data-layout-column={cell.column} data-drop-target={dropCell === `${cell.row}:${cell.column}` || undefined}
            aria-label={`Design ${label(outcome)}`} aria-pressed={selected?.key === outcome.key}
            onClick={() => selectTile(outcome)} onPointerDown={(event) => dragStart(event, outcome)}
            onPointerMove={dragMove} onPointerUp={dragEnd}
            onPointerCancel={() => { drag.current = null; setDropCell(''); }}>
            <span>{label(outcome)}</span><strong aria-hidden="true">–</strong>
          </button> : <button type="button" key={`empty-${cell.row}-${cell.column}`}
            className="market-designer__empty" style={{ gridRow: cell.row, gridColumn: cell.column }}
            data-layout-row={cell.row} data-layout-column={cell.column} data-drop-target={dropCell === `${cell.row}:${cell.column}` || undefined}
            aria-label={`Place ${label(selected)} at row ${cell.row}, column ${cell.column}`}
            onClick={() => move(selected.key, { row: cell.row, column: cell.column })}>
            <span aria-hidden="true">+</span>
          </button>;
        })}
      </div>
      {tile ? <div className="market-designer__inspector">
        <label>Selected outcome<input className="form-control" value={selected.label} maxLength={120}
          onChange={(event) => onRename(selected.key, event.target.value)} /></label>
        <div className="market-form-grid">
          <label>Tile width<select className="form-select" value={tile.width}
            onChange={(event) => move(selected.key, { width: Number(event.target.value) })}>
            {Array.from({ length: layout.columns }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} {value === 1 ? 'column' : 'columns'}</option>)}
          </select></label>
          <label>Tile height<select className="form-select" value={tile.height}
            onChange={(event) => move(selected.key, { height: Number(event.target.value) })}>
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} {value === 1 ? 'row' : 'rows'}</option>)}
          </select></label>
        </div>
        <div className="market-designer__moves" role="group" aria-label="Move selected tile">
          {[
            ['Up', { row: tile.row - 1 }], ['Down', { row: tile.row + 1 }],
            ['Left', { column: tile.column - 1 }], ['Right', { column: tile.column + 1 }],
          ].map(([name, changes]) => <button key={name} type="button" className={marketActionClass()}
            onClick={() => move(selected.key, changes)}>{name}</button>)}
        </div>
        <p className="market-help" role="status">{label(selected)}: row {tile.row}, column {tile.column}.</p>
      </div> : null}
    </div>
    {error || layoutError(layout, outcomes) ? <p className="market-notice market-notice--danger" role="alert">
      {error || layoutError(layout, outcomes)}
    </p> : null}
  </fieldset>;
};

export default MarketLayoutEditor;
