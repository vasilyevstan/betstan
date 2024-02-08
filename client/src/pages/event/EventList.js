import React,  { useState, useEffect }  from "react";
import ProductList from "./product/ProductsList"
import axios from "axios";

const HandleEventList = ({sliprefresh}) => {

    const [events, setEvents] = useState({});

    const fetchEvents = async () => {
        try {
            const res = await axios.get('/api/event');

            setEvents(res.data);
        } catch (error) {
            // ignore
          }
    }

    useEffect(() => {
        fetchEvents();
    }, []);
    
    const renderedEvents = Object.values(events).map(event => {
        if (event.visibility === 'OFFLINE') {
            return '';
        }

        return <div className="card" style={{ width: '30%', marginBottom: '5px'}} key={event._id}>
            <div className="card-body">
                <h5 className="card-title">{event.name}</h5>
                <ProductList key={event.id + '_productlist'} products={event.products} eventId={event.eventId} sliprefresh={sliprefresh} resulted={event.status === 'RESULTED'}/>
            </div>
        </div>
    });

    return <div className="d-flex flex-row flex-wrap justify-content-between"> {renderedEvents} </div>;
};

export default HandleEventList;