import React, { useState } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TabList from './TabList';

const TABS = [
  { id: 'PRE_MATCH', label: 'Pre-match', count: 0 },
  { id: 'LIVE', label: 'Live', count: 2 },
  { id: 'ARCHIVE', label: 'Archive' },
];

// Callers own the panels, so the harness renders them the way the contract describes.
const Harness = ({ initialId = 'PRE_MATCH', tabs = TABS, onChange = () => {} }) => {
  const [activeId, setActiveId] = useState(initialId);
  return (
    <div>
      <TabList
        idPrefix="demo"
        label="Demo tabs"
        tabs={tabs}
        activeId={activeId}
        onChange={(id) => {
          onChange(id);
          setActiveId(id);
        }}
      />
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`demo-panel-${tab.id}`}
          aria-labelledby={`demo-tab-${tab.id}`}
          hidden={tab.id !== activeId}
        >
          {tab.label} content
        </div>
      ))}
    </div>
  );
};

const tab = (name) => screen.getByRole('tab', { name });

describe('TabList', () => {
  it('renders a labelled tablist of buttons with the documented ids and relationships', () => {
    render(<Harness />);

    const list = screen.getByRole('tablist', { name: 'Demo tabs' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    tabs.forEach((element) => {
      expect(list).toContainElement(element);
      expect(element.tagName).toBe('BUTTON');
      expect(element).toHaveAttribute('type', 'button');
      expect(element).not.toHaveAttribute('title');
    });

    expect(tabs.map((element) => element.id)).toEqual([
      'demo-tab-PRE_MATCH',
      'demo-tab-LIVE',
      'demo-tab-ARCHIVE',
    ]);
    expect(tabs.map((element) => element.getAttribute('aria-controls'))).toEqual([
      'demo-panel-PRE_MATCH',
      'demo-panel-LIVE',
      'demo-panel-ARCHIVE',
    ]);
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels.map((panel) => panel.id)).toEqual(tabs.map((element) => element.getAttribute('aria-controls')));
    expect(panels.map((panel) => panel.getAttribute('aria-labelledby'))).toEqual(tabs.map((element) => element.id));
  });

  it('marks only the active tab as selected, focusable and styled', () => {
    render(<Harness initialId="LIVE" />);

    const [preMatch, live, archive] = screen.getAllByRole('tab');
    expect(live).toHaveAttribute('aria-selected', 'true');
    expect(live).toHaveAttribute('tabindex', '0');
    expect(live).toHaveClass('is-active');
    [preMatch, archive].forEach((element) => {
      expect(element).toHaveAttribute('aria-selected', 'false');
      expect(element).toHaveAttribute('tabindex', '-1');
      expect(element).not.toHaveClass('is-active');
    });
    expect(screen.getByRole('tabpanel', { name: 'Live (2)' })).toHaveTextContent('Live content');
    expect(screen.queryByRole('tabpanel', { name: 'Pre-match' })).not.toBeInTheDocument();
  });

  it('names a tab by its label, adding the count in parentheses only when it is positive', () => {
    render(<Harness />);

    expect(tab('Pre-match')).toHaveAccessibleName('Pre-match');
    expect(tab('Live (2)')).toHaveAccessibleName('Live (2)');
    expect(tab('Archive')).toHaveAccessibleName('Archive');
    expect(screen.queryByRole('tab', { name: 'Pre-match (0)' })).not.toBeInTheDocument();
  });

  it('shows the count as a decorative badge that never doubles the spoken name', () => {
    render(<Harness />);

    const badge = within(tab('Live (2)')).getByText('2');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge).toHaveClass('tab-list__count');
    expect(within(tab('Pre-match')).queryByText(/\d/)).not.toBeInTheDocument();
    expect(within(tab('Archive')).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('reflects live count changes in the accessible name', () => {
    const { rerender } = render(
      <TabList idPrefix="demo" label="Demo tabs" tabs={TABS} activeId="LIVE" onChange={() => {}} />,
    );
    expect(tab('Live (2)')).toBeInTheDocument();

    rerender(
      <TabList
        idPrefix="demo"
        label="Demo tabs"
        tabs={[TABS[0], { ...TABS[1], count: 11 }, TABS[2]]}
        activeId="LIVE"
        onChange={() => {}}
      />,
    );
    expect(tab('Live (11)')).toBeInTheDocument();

    rerender(
      <TabList
        idPrefix="demo"
        label="Demo tabs"
        tabs={[TABS[0], { ...TABS[1], count: 0 }, TABS[2]]}
        activeId="LIVE"
        onChange={() => {}}
      />,
    );
    expect(tab('Live')).toBeInTheDocument();
  });

  it('activates a tab on click and ignores a click on the active tab', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(tab('Live (2)'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('LIVE');
    expect(tab('Live (2)')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Pre-match')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Live (2)' })).toBeVisible();
    expect(screen.queryByRole('tabpanel', { name: 'Pre-match' })).not.toBeInTheDocument();

    fireEvent.click(tab('Live (2)'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moves focus and activation with ArrowRight and wraps from the last tab to the first', () => {
    const onChange = jest.fn();
    render(<Harness initialId="LIVE" onChange={onChange} />);

    tab('Live (2)').focus();
    fireEvent.keyDown(tab('Live (2)'), { key: 'ArrowRight' });
    expect(tab('Archive')).toHaveFocus();
    expect(tab('Archive')).toHaveAttribute('aria-selected', 'true');
    expect(onChange).toHaveBeenLastCalledWith('ARCHIVE');

    fireEvent.keyDown(tab('Archive'), { key: 'ArrowRight' });
    expect(tab('Pre-match')).toHaveFocus();
    expect(tab('Pre-match')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Pre-match')).toHaveAttribute('tabindex', '0');
    expect(onChange).toHaveBeenLastCalledWith('PRE_MATCH');
  });

  it('moves focus and activation with ArrowLeft and wraps from the first tab to the last', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);

    tab('Pre-match').focus();
    fireEvent.keyDown(tab('Pre-match'), { key: 'ArrowLeft' });
    expect(tab('Archive')).toHaveFocus();
    expect(tab('Archive')).toHaveAttribute('aria-selected', 'true');
    expect(onChange).toHaveBeenLastCalledWith('ARCHIVE');

    fireEvent.keyDown(tab('Archive'), { key: 'ArrowLeft' });
    expect(tab('Live (2)')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('LIVE');
  });

  it('jumps to the first and last tab with Home and End', () => {
    const onChange = jest.fn();
    render(<Harness initialId="LIVE" onChange={onChange} />);

    tab('Live (2)').focus();
    fireEvent.keyDown(tab('Live (2)'), { key: 'End' });
    expect(tab('Archive')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('ARCHIVE');

    fireEvent.keyDown(tab('Archive'), { key: 'Home' });
    expect(tab('Pre-match')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('PRE_MATCH');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not re-activate when Home or End lands on the already active tab', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);

    tab('Pre-match').focus();
    fireEvent.keyDown(tab('Pre-match'), { key: 'Home' });
    expect(tab('Pre-match')).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('consumes handled keys, and leaves other keys and modified shortcuts alone', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    const preMatch = tab('Pre-match');
    preMatch.focus();

    expect(fireEvent.keyDown(preMatch, { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(tab('Live (2)'), { key: 'ArrowLeft' })).toBe(false);
    onChange.mockClear();

    expect(fireEvent.keyDown(tab('Pre-match'), { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(tab('Pre-match'), { key: 'ArrowDown' })).toBe(true);
    ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].forEach((modifier) => {
      expect(fireEvent.keyDown(tab('Pre-match'), { key: 'ArrowRight', [modifier]: true })).toBe(true);
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(tab('Pre-match')).toHaveAttribute('aria-selected', 'true');
  });
});
