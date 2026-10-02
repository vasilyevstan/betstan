import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import ProductCS from './ProductCS';

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

describe('ProductCS', () => {
  const product = {
    id: 'product-cs',
    name: 'Correct score',
    odds: [{ id: 'home', name: '1-0', value: 5 }],
  };

  beforeEach(() => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({});
  });

  it('places a selected score through fixed event and product identifiers', async () => {
    const onSelectionPlaced = jest.fn();
    render(
      <ProductCS
        eventId="event-1"
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        selectedSelectionKeys={new Set(['PRE_MATCH:event-1:product-cs:home'])}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'Select Correct score 1-0 at 5',
    });
    expect(button).toHaveClass('product-button--v1');
    expect(button).toHaveClass('product-button--selected');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.querySelector('.product-button__selected-cue')).toHaveTextContent('✓');
    fireEvent.click(button);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
        eventId: 'event-1',
        productId: 'product-cs',
        oddsId: 'home',
      });
      expect(onSelectionPlaced).toHaveBeenCalledTimes(1);
    });
  });

  it('does not report selection success when the request fails', async () => {
    const onSelectionPlaced = jest.fn();
    axios.post.mockRejectedValue(new Error('offline'));
    render(
      <ProductCS
        eventId="event-1"
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    expect(onSelectionPlaced).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Selection could not be added to your slip. Please try again.'
    );
    expect(screen.queryByText('offline')).toBeNull();
  });

  it('handles a missing board and disables resulted selections', () => {
    const { rerender } = render(
      <ProductCS
        eventId="event-1"
        product={{ ...product, odds: undefined }}
        resulted
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <ProductCS
        eventId="event-1"
        product={product}
        resulted
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveClass('disabled');
  });

  it('keeps the latest Correct Score success authoritative when an older request fails later', async () => {
    const olderRequest = createDeferred();
    const latestRequest = createDeferred();
    const onSelectionPlaced = jest.fn();
    const raceProduct = {
      ...product,
      odds: [
        ...product.odds,
        { id: 'draw', name: '1-1', value: 6 },
      ],
    };
    axios.post
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(latestRequest.promise);
    render(
      <ProductCS
        eventId="event-1"
        onSelectionPlaced={onSelectionPlaced}
        product={raceProduct}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    const olderSelection = screen.getByRole('button', {
      name: 'Select Correct score 1-0 at 5',
    });
    const latestSelection = screen.getByRole('button', {
      name: 'Select Correct score 1-1 at 6',
    });

    fireEvent.click(olderSelection);
    fireEvent.click(latestSelection);
    latestSelection.focus();

    expect(axios.post.mock.calls).toEqual([
      ['/api/event/odds', {
        eventId: 'event-1',
        productId: 'product-cs',
        oddsId: 'home',
      }],
      ['/api/event/odds', {
        eventId: 'event-1',
        productId: 'product-cs',
        oddsId: 'draw',
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
    expect(screen.getByRole('button', {
      name: 'Select Correct score 1-1 at 6',
    })).toBe(latestSelection);
    expect(latestSelection).toHaveFocus();
  });

  it('keeps the latest Correct Score failure authoritative when an older request succeeds later', async () => {
    const olderRequest = createDeferred();
    const latestRequest = createDeferred();
    const onSelectionPlaced = jest.fn();
    const raceProduct = {
      ...product,
      odds: [
        ...product.odds,
        { id: 'draw', name: '1-1', value: 6 },
      ],
    };
    axios.post
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(latestRequest.promise);
    render(
      <ProductCS
        eventId="event-1"
        onSelectionPlaced={onSelectionPlaced}
        product={raceProduct}
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    const olderSelection = screen.getByRole('button', {
      name: 'Select Correct score 1-0 at 5',
    });
    const latestSelection = screen.getByRole('button', {
      name: 'Select Correct score 1-1 at 6',
    });

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
    expect(screen.getByRole('button', {
      name: 'Select Correct score 1-1 at 6',
    })).toBe(latestSelection);
    expect(latestSelection).toHaveFocus();
  });
});
