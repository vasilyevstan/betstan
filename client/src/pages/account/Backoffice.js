
import React,  { useState, useEffect }  from "react";
import axios from "axios";

const HandleBackoffice = ({refresh}) => {

    const [events, setEvents] = useState({});
    const [newEventHome, setNewEventHome] = useState('');
    const [newEventAway, setNewEventAway] = useState('');

    const fetchEvents = async () => {
        try {
          const res = await axios.get('/api/backoffice');

          setEvents(res.data);
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
    
    const newEvent = <div className="card" key='new_event'>
      <div className="card-body">
              <h5 className="card-title">Create new event</h5>
              <div className="row">
                <input value={newEventHome} style={{marginRight: '5px'}} className="col" onChange={e => setNewEventHome(e.target.value)} placeholder={'Home team'} />
                <input value={newEventAway} style={{marginRight: '5px'}} className="col" onChange={e => setNewEventAway(e.target.value)} placeholder={'Away team'} />
                <button className={"col btn btn-success" }  onClick={(e) => createNewEvent(e)}>Create</button>
              </div>
        </div>
    </div>

    const renderedEvents = Object.values(events).map(event => {
      eventValues.push({id: event.eventId, home: event.homeResult, away: event.awayResult});

      const buttonOptions = event.status === "RESULT" ? ' btn-secondary disabled' : ' btn-danger';
      // const inputOption = event.status === "RESULT" ? ' readonly' : ' ';

      return <div className="card" key={event.eventId}>
        <div className="card-body">
              <h5 className="card-title">{event.name}</h5>
              <div className="row">
                <input style={{marginRight: '5px'}} className="col" eventid={event.eventId} onChange={e => setHomeResult(e, e.target.value)} placeholder={event.home + ' result'} defaultValue={event.homeResult} />
                <input style={{marginRight: '5px'}} className="col" eventid={event.eventId} onChange={e => setAwayResult(e, e.target.value)} placeholder={event.away + ' result'} defaultValue={event.awayResult} />
                <button eventid={event.eventId} className={"col btn" + buttonOptions }  onClick={(e) => setResults(e)}>Set results</button>
              </div>
              
              <div className="row">
                <div style={{marginRight: '5px'}} className='col'>Event is: </div>
                <div style={{marginRight: '5px'}} className='col'>{event.visibility}</div>
                <button eventid={event.eventId} className={"col btn btn-warning"}  onClick={(e) => setVisibility(e)}>Change</button>
              </div>
        </div>
      </div>
    });

    return <div className="flex-wrap"> {newEvent}{renderedEvents} </div>;
};



export default HandleBackoffice;