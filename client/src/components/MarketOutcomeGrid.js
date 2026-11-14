import React from 'react';
import { layoutError, tileStyle } from '../marketLayout';
import '../styles/market-designer.css';

const MarketOutcomeGrid = ({ outcomes, layout, children, as: Element = 'div' }) => {
  const designed = layout && !layoutError(layout, outcomes);
  const ordered = designed ? [...layout.tiles].sort((a, b) => a.row - b.row || a.column - b.column) : null;
  return <Element className={designed ? `market-layout market-layout--${layout.tileShape}` : 'product-custom-grid'}
    style={designed ? { gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` } : undefined}>
    {ordered ? ordered.map((tile) => <span className="market-layout__tile" key={tile.outcomeKey} style={tileStyle(tile)}>
      {children(outcomes.find((outcome) => outcome.key === tile.outcomeKey))}
    </span>) : outcomes.map(children)}
  </Element>;
};

export default MarketOutcomeGrid;
