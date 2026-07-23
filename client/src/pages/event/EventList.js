import React, { useState, useEffect } from "react";
import ProductList from "./product/ProductsList"
import axios from "axios";
import { format } from "date-fns";

const HandleEventList = ({ sliprefresh, uiVariant }) => {

    const [events, setEvents] = useState({});
    const [selectedOdds, setSelectedOdds] = useState(new Set());

    const fetchEvents = async () => {
        try {
            const res = await axios.get('/api/event');
            const data = res.data;
            setEvents(data && typeof data === 'object' ? data : {});
        } catch (error) {
            // ignore
          }
    }

    useEffect(() => {
        fetchEvents();
    }, []);

    const fetchSlipSelection = async () => {
        try {
            const res = await axios.get('/api/slip');
            const rows = Array.isArray(res?.data?.rows) ? res.data.rows : [];
            const selected = new Set(rows.map((row) => `${row.eventId}:${row.productId}:${row.oddsId}`));
            setSelectedOdds(selected);
        } catch (error) {
            setSelectedOdds(new Set());
        }
    };

    useEffect(() => {
        fetchSlipSelection();
        const syncTimer = setInterval(() => {
            fetchSlipSelection();
        }, 3000);
        return () => clearInterval(syncTimer);
    }, []);
    
    const eventItems = Object.values(events ?? {}).filter(event => event.visibility !== 'OFFLINE');
    const eventCards = eventItems.map(event => {
        const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
        const eventTime = new Date(event.time);
        const formattedTime = Number.isNaN(eventTime.getTime())
            ? 'TBD'
            : format(eventTime, 'MMMM do yyyy, HH:mm z', { timeZone });
        const cardClass = uiVariant === 'v3' ? 'col-12' : 'col-12 col-md-6 col-xl-4';

        return <div className={cardClass} key={event._id}>
            <div className="card event-card h-100">
                <div className="card-body">
                    <h5 className="card-title mb-1">{event.name}</h5>
                    <h6 className="card-subtitle mb-3 text-secondary">{formattedTime}</h6>
                    <ProductList key={event._id + '_productlist'} products={event.products ?? []} eventId={event.eventId} sliprefresh={sliprefresh} resulted={event.status === 'RESULTED'} uiVariant={uiVariant} selectedOdds={selectedOdds} onOddsPlaced={fetchSlipSelection}/>
                </div>
            </div>
        </div>;
    });

    const renderClassic = () => <div className="row g-3 justify-content-center">{eventCards}</div>;

    const renderEditorial = () => <div className="event-editorial">
        <div className="event-editorial__line"></div>
        <div className="row g-4">{eventCards}</div>
    </div>;

    const renderEditorialEmpty = () => <div className="event-editorial">
        <div className="event-editorial__line"></div>
        <div className="row g-4">
            <div className="col-12">
                <div className="card event-stage__empty card-body">
                    Loading live events...
                </div>
            </div>
            <div className="col-12">
                <div className="card event-stage__empty card-body">
                    Waiting for editorial feed updates...
                </div>
            </div>
        </div>
    </div>;

    const renderByVariant = () => {
        if (uiVariant === 'v3') return renderEditorial();
        return renderClassic();
    };

    return <section className={`event-stage event-stage--${uiVariant}`}>
        {eventItems.length === 0 ? (uiVariant === 'v3' ? renderEditorialEmpty() : <div className="card event-stage__empty card-body">Loading live events...</div>) : renderByVariant()}
    </section>;
};

export default HandleEventList;