import React, { useRef } from 'react';

// WAI-ARIA tabs with automatic activation. Callers render the tabpanels:
// role="tabpanel", id `${idPrefix}-panel-${id}`, aria-labelledby `${idPrefix}-tab-${id}`.
const TabList = ({ idPrefix, label, tabs, activeId, onChange }) => {
  const tabRefs = useRef({});

  const activate = (id) => {
    if (id !== activeId) onChange(id);
  };

  const onKeyDown = (event, index) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const targetIndex = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (targetIndex === undefined) return;
    event.preventDefault();
    const { id } = tabs[targetIndex];
    tabRefs.current[id]?.focus();
    activate(id);
  };

  return (
    <div className="tab-list" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeId;
        const hasCount = typeof tab.count === 'number' && tab.count > 0;
        return (
          <button
            key={tab.id}
            ref={(node) => { tabRefs.current[tab.id] = node; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            className={`tab-list__tab${isActive ? ' is-active' : ''}`}
            aria-selected={isActive}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            aria-label={hasCount ? `${tab.label} (${tab.count})` : undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={() => activate(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
            {hasCount ? <span className="tab-list__count" aria-hidden="true">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
};

export default TabList;
