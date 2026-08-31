import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import axios from 'axios';
import Product1X2 from './Product1X2';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const product = {
  id: 'product-1',
  type: '1X2',
  name: '1X2',
  odds: [
    { id: 'home-odd', name: 'Falcons', value: 1.6 },
    { id: 'draw-odd', name: 'Draw', value: 3.2 },
    { id: 'away-odd', name: 'Owls', value: 4.5 },
  ],
};

describe('Product1X2', () => {
  beforeEach(() => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({});
  });

  it('renders the actual selection name (not a generic Home/Away placeholder) as the visible label, satisfying label-in-name', () => {
    render(
      <Product1X2
        eventId="event-1"
        product={product}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    // The visible label must be the real selection name...
    expect(screen.getByText('Falcons')).toBeInTheDocument();
    expect(screen.getByText('Draw')).toBeInTheDocument();
    expect(screen.getByText('Owls')).toBeInTheDocument();
    // ...and never a generic positional placeholder standing in for it.
    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.queryByText('Away')).toBeNull();

    // Label-in-name: the visible text must be a substring of the accessible name.
    const homeButton = screen.getByRole('button', { name: 'Select 1X2 Falcons at 1.6' });
    const drawButton = screen.getByRole('button', { name: 'Select 1X2 Draw at 3.2' });
    const awayButton = screen.getByRole('button', { name: 'Select 1X2 Owls at 4.5' });

    expect(homeButton).toHaveAccessibleName(expect.stringContaining('Falcons'));
    expect(drawButton).toHaveAccessibleName(expect.stringContaining('Draw'));
    expect(awayButton).toHaveAccessibleName(expect.stringContaining('Owls'));
    expect(homeButton.querySelector('.product-button__label')).toHaveTextContent('Falcons');
    expect(drawButton.querySelector('.product-button__label')).toHaveTextContent('Draw');
    expect(awayButton.querySelector('.product-button__label')).toHaveTextContent('Owls');
  });

  it('retains price, disabled state, and click behavior alongside the corrected label', async () => {
    const onSelectionPlaced = jest.fn();
    render(
      <Product1X2
        eventId="event-1"
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    const homeButton = screen.getByRole('button', { name: 'Select 1X2 Falcons at 1.6' });
    expect(homeButton).toHaveTextContent('1.6');
    expect(homeButton).toBeEnabled();

    fireEvent.click(homeButton);
    expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
      eventId: 'event-1',
      productId: 'product-1',
      oddsId: 'home-odd',
    });
  });

  it('disables every control when the event is resulted', () => {
    render(
      <Product1X2
        eventId="event-1"
        product={product}
        resulted
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    expect(screen.getByRole('button', { name: 'Select 1X2 Falcons at 1.6' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select 1X2 Draw at 3.2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select 1X2 Owls at 4.5' })).toBeDisabled();
  });
});
