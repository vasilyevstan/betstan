import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import Product1X2 from './Product1X2';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

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
    expect(homeButton).toHaveAttribute('aria-pressed', 'false');
    expect(drawButton).toHaveAttribute('aria-pressed', 'false');
    expect(awayButton).toHaveAttribute('aria-pressed', 'false');
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

  it('exposes a non-color selected cue without changing the exact selection identity', () => {
    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        product={product}
        selectedSelectionKeys={new Set(['PRE_MATCH:event-1:product-1:home-odd'])}
        uiVariant="v2"
      />,
    );

    const homeButton = screen.getByRole('button', {
      name: 'Select 1X2 1: Falcons in Falcons - Owls at 1.6',
    });
    expect(homeButton).toHaveAttribute('aria-pressed', 'true');
    expect(homeButton.querySelector('.product-button__selected-cue')).toHaveTextContent('✓');
    expect(screen.getByRole('button', { name: /Select 1X2 X:/ }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('shows fixed adjacent feedback without exposing a technical placement error', async () => {
    axios.post.mockRejectedValueOnce(new Error('socket hang up at event.internal'));
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

    fireEvent.click(screen.getByRole('button', { name: /Select 1X2 1:/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Selection could not be added to your slip. Please try again.'
    );
    expect(screen.queryByText(/socket hang up|event\.internal/)).toBeNull();
  });

  it('keeps the latest 1X2 success authoritative when an older request fails later', async () => {
    const olderRequest = createDeferred();
    const latestRequest = createDeferred();
    const onSelectionPlaced = jest.fn();
    axios.post
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(latestRequest.promise);
    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    const olderSelection = screen.getByRole('button', { name: /Select 1X2 1:/ });
    const latestSelection = screen.getByRole('button', { name: /Select 1X2 X:/ });

    fireEvent.click(olderSelection);
    fireEvent.click(latestSelection);
    latestSelection.focus();

    expect(axios.post.mock.calls).toEqual([
      ['/api/event/odds', {
        eventId: 'event-1',
        productId: 'product-1',
        oddsId: 'home-odd',
      }],
      ['/api/event/odds', {
        eventId: 'event-1',
        productId: 'product-1',
        oddsId: 'draw-odd',
      }],
    ]);

    await act(async () => {
      olderRequest.reject(new Error('older placement failed'));
      await olderRequest.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      latestRequest.resolve({ data: {} });
      await latestRequest.promise;
    });
    await waitFor(() => expect(onSelectionPlaced).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /Select 1X2 X:/ })).toBe(latestSelection);
    expect(latestSelection).toHaveFocus();
  });

  it('keeps the latest 1X2 failure authoritative when an older request succeeds later', async () => {
    const olderRequest = createDeferred();
    const latestRequest = createDeferred();
    const onSelectionPlaced = jest.fn();
    axios.post
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(latestRequest.promise);
    render(
      <Product1X2
        away="Owls"
        eventId="event-1"
        eventName="Falcons - Owls"
        home="Falcons"
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    const olderSelection = screen.getByRole('button', { name: /Select 1X2 1:/ });
    const latestSelection = screen.getByRole('button', { name: /Select 1X2 X:/ });

    fireEvent.click(olderSelection);
    fireEvent.click(latestSelection);
    latestSelection.focus();

    await act(async () => {
      latestRequest.reject(new Error('latest placement failed'));
      await latestRequest.promise.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Selection could not be added to your slip. Please try again.'
    );

    await act(async () => {
      olderRequest.resolve({ data: {} });
      await olderRequest.promise;
    });
    await waitFor(() => expect(onSelectionPlaced).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Selection could not be added to your slip. Please try again.'
    );
    expect(screen.getByRole('button', { name: /Select 1X2 X:/ })).toBe(latestSelection);
    expect(latestSelection).toHaveFocus();
  });
});
