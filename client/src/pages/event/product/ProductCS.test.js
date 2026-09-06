import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import ProductCS from './ProductCS';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

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
});
