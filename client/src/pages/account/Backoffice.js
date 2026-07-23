
import React,  { useState, useEffect }  from "react";
import axios from "axios";

const HandleBackoffice = ({refresh}) => {

    const [events, setEvents] = useState({});
    const [newEventHome, setNewEventHome] = useState('');
    const [newEventAway, setNewEventAway] = useState('');

    const fetchEvents = async () => {
        try {
          const res = await axios.get('/api/backoffice');
          const data = res.data;
          setEvents(data && typeof data === 'object' ? data : {});
        } catch (error) {
          // ignore
        }
    }

    useEffect(() => {
        fetchEvents();
    }, []);

    const eventValues = [];

    const setHomeResult = (event, value) => {
      const eventId = event.currentTarget.getAttribute("eventid");
      // console.log('home', value, eventId);

      const eventValue = eventValues.find(result => result.id === eventId);
      eventValue.home = value;
    }

    const setAwayResult = (event, value) => {
      const eventId = event.currentTarget.getAttribute("eventid");
      // console.log('away', value, eventId);

      const eventValue = eventValues.find(result => result.id === eventId);
      eventValue.away = value;
    }

    const setResults = async (event) => {
      const eventId = event.currentTarget.getAttribute("eventid");

      const eventValue = eventValues.find(result => result.id === eventId);

      await axios.post('/api/backoffice/result', { eventId, homeResult: eventValue.home, awayResult: eventValue.away });

      // sessionStorage.setItem("scrollPosition", window.scrollY);

      refresh();
    }

    const setVisibility = async (event) => {
      const eventId = event.currentTarget.getAttribute("eventid");

      await axios.post('/api/backoffice/event_visibility', { eventId });

      // sessionStorage.setItem("scrollPosition", window.scrollY);

      refresh();
    }

    const createNewEvent = async () => {
      await axios.post('/api/backoffice/new_event', { home: newEventHome, away: newEventAway });
      setNewEventHome('');
      setNewEventAway('');
      refresh();
    }
    
    const newEvent = <div className="card backoffice-create" key='new_event'>
      <div className="card-body">
              <h5 className="card-title mb-3">Create new event</h5>
              <div className="row g-2">
                <div className="col-12 col-md">
                  <input value={newEventHome} className="form-control" onChange={e => setNewEventHome(e.target.value)} placeholder={'Home team'} />
                </div>
                <div className="col-12 col-md">
                  <input value={newEventAway} className="form-control" onChange={e => setNewEventAway(e.target.value)} placeholder={'Away team'} />
                </div>
                <div className="col-12 col-md-auto d-grid">
                  <button className={"btn btn-success backoffice-action backoffice-action--create"} onClick={(e) => createNewEvent(e)}>Create</button>
                </div>
              </div>
        </div>
    </div>

    const renderedEvents = Object.values(events ?? {}).map(event => {
      eventValues.push({id: event.eventId, home: event.homeResult, away: event.awayResult});

      const buttonOptions = event.status === "RESULT" ? ' btn-secondary disabled' : ' btn-danger';
      // const inputOption = event.status === "RESULT" ? ' readonly' : ' ';

      return <div className="card backoffice-event" key={event.eventId}>
        <div className="card-body">
              <h5 className="card-title mb-3">{event.name}</h5>
              <div className="row g-2">
                <div className="col-12 col-md">
                  <input className="form-control" eventid={event.eventId} onChange={e => setHomeResult(e, e.target.value)} placeholder={event.home + ' result'} defaultValue={event.homeResult} />
                </div>
                <div className="col-12 col-md">
                  <input className="form-control" eventid={event.eventId} onChange={e => setAwayResult(e, e.target.value)} placeholder={event.away + ' result'} defaultValue={event.awayResult} />
                </div>
                <div className="col-12 col-md-auto d-grid">
                  <button eventid={event.eventId} className={"btn backoffice-action" + buttonOptions } onClick={(e) => setResults(e)}>Set results</button>
                </div>
              </div>
              
              <div className="row g-2 mt-1 align-items-center">
                <div className='col-12 col-md'>Event is: <strong>{event.visibility}</strong></div>
                <div className="col-12 col-md-auto d-grid">
                  <button eventid={event.eventId} className={"btn btn-warning backoffice-action backoffice-action--warn"} onClick={(e) => setVisibility(e)}>Change</button>
                </div>
              </div>
        </div>
      </div>
    });

    return <div className="backoffice-board"> {newEvent}{renderedEvents} </div>;
};



export default HandleBackoffice;