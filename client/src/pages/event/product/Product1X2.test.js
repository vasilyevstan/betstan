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

  it('renders a safely mapped board as semantic 1/X/2 controls with full accessible identity', () => {
    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        product={product}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    const homeButton = screen.getByRole('button', {
      name: 'Select 1X2 1: Falcons in Falcons - Owls at 1.6',
    });
    const drawButton = screen.getByRole('button', {
      name: 'Select 1X2 X: Draw in Falcons - Owls at 3.2',
    });
    const awayButton = screen.getByRole('button', {
      name: 'Select 1X2 2: Owls in Falcons - Owls at 4.5',
    });

    expect(homeButton.querySelector('.product-button__label')).toHaveTextContent('1');
    expect(drawButton.querySelector('.product-button__label')).toHaveTextContent('X');
    expect(awayButton.querySelector('.product-button__label')).toHaveTextContent('2');
    expect(homeButton).toHaveAccessibleName(expect.stringContaining('Falcons'));
    expect(awayButton).toHaveAccessibleName(expect.stringContaining('Owls'));
  });

  it('preserves the exact odds ID and price when semantic presentation reorders the board', async () => {
    const onSelectionPlaced = jest.fn();
    const reorderedProduct = {
      ...product,
      odds: [product.odds[2], product.odds[0], product.odds[1]],
    };
    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        onSelectionPlaced={onSelectionPlaced}
        product={reorderedProduct}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    const homeButton = screen.getByRole('button', {
      name: 'Select 1X2 1: Falcons in Falcons - Owls at 1.6',
    });
    expect(homeButton).toHaveTextContent('1.6');
    expect(homeButton).toBeEnabled();

    fireEvent.click(homeButton);
    expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
      eventId: 'event-1',
      productId: 'product-1',
      oddsId: 'home-odd',
    });
  });

  it('falls back to original labels and order when event identity is ambiguous', () => {
    const malformedProduct = {
      ...product,
      odds: [
        { id: 'draw-home', name: 'Draw', value: 1.6 },
        { id: 'draw', name: 'Draw', value: 3.2 },
        { id: 'away', name: 'Owls', value: 4.5 },
      ],
    };

    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Draw - Owls"
        home="Draw"
        product={malformedProduct}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    expect(screen.getAllByText('Draw')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Select 1X2 Owls at 4.5' }))
      .toBeInTheDocument();
    expect(screen.queryByText('1')).toBeNull();
  });

  it('keeps an incomplete legacy board balanced with a disabled placeholder', () => {
    const incompleteProduct = {
      ...product,
      odds: product.odds.slice(0, 2),
    };
    const { container } = render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        product={incompleteProduct}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    expect(container.querySelectorAll('.product-1x2-grid > div')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Select 1X2 Falcons at 1.6' }))
      .toBeEnabled();
    expect(screen.getByRole('button', { name: 'Select 1X2 Draw at 3.2' }))
      .toBeEnabled();
    expect(screen.getByRole('button', { name: 'Unavailable 1X2 selection' }))
      .toBeDisabled();
  });

  it('disables every control when the event is resulted', () => {
    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        product={product}
        resulted
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    expect(screen.getByRole('button', { name: /Select 1X2 1:/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Select 1X2 X:/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Select 1X2 2:/ })).toBeDisabled();
  });
});
