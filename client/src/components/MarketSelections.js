import React from 'react';
import { describeMarketRule, selectionKey } from '../marketUi';

const MarketSelections = ({ marketBet }) => <div className="market-manifest">
  {marketBet.kind === 'BUILDER' ? <p className="market-help">One combined exposure, {marketBet.selections.length} selections.</p> : null}
  <ul aria-label="Frozen market selections">
    {marketBet.selections.map((selection) => <li key={selectionKey(selection)}>
      <span>{selection.marketName}: <strong>{selection.label}</strong></span>
      <small>{selection.settlementMode === 'MANUAL' ? 'Operator-declared result' : describeMarketRule(selection.rule)}</small>
      {selection.terms ? <details><summary>Settlement terms</summary><p>{selection.terms}</p></details> : null}
    </li>)}
  </ul>
</div>;

export default MarketSelections;
