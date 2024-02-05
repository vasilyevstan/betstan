import React  from "react";
import Product1X2 from './Product1X2';
import ProductCS from './ProductCS';

const Handle = ({ eventId, products, sliprefresh, resulted }) => {

    const renderedProducts = products.map(product => {
        if (product.type === '1X2') {
            // console.log('handling 1x2', product);
            return <Product1X2 key={product.id} product={product} eventId={eventId} sliprefresh={sliprefresh} resulted={resulted}/>;
        } else if (product.type === 'CS') {
            // console.log('handling cs', product);
            return <ProductCS key={product.id} product={product} eventId={eventId} sliprefresh={sliprefresh} resulted={resulted}/>;
        }

        return '';
    });

    return renderedProducts;
};

export default Handle;