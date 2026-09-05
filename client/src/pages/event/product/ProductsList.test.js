import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import ProductsList from './ProductsList';

jest.mock('./Product1X2', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'div',
    { 'data-testid': 'product-1x2' },
    props.product.id,
  );
});

jest.mock('./ProductCS', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'div',
    { 'data-testid': 'product-cs' },
    props.product.id,
  );
});

it('routes known products and ignores missing or unknown products', () => {
  const { rerender } = render(<ProductsList products={undefined} />);
  expect(screen.queryByTestId('product-1x2')).toBeNull();
  expect(screen.queryByTestId('product-cs')).toBeNull();

  rerender(
    <ProductsList
      away="Away"
      eventId="event-1"
      eventName="Home - Away"
      home="Home"
      products={[
        { id: 'one', type: '1X2' },
        { id: 'two', type: 'CS' },
        { id: 'three', type: 'UNKNOWN' },
      ]}
      resulted={false}
      selectedSelectionKeys={new Set()}
      uiVariant="v2"
    />,
  );

  expect(screen.getByTestId('product-1x2')).toHaveTextContent('one');
  expect(screen.getByTestId('product-cs')).toHaveTextContent('two');
  expect(screen.queryByText('three')).toBeNull();
});
