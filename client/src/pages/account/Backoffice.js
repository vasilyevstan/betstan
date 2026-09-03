import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useLocation } from 'react-router-dom';

const HandleBackoffice = ({
  currentUser,
  isCurrentUserResolved,
  onChanged,
  refreshToken,
}) => {
  const location = useLocation();
  const [events, setEvents] = useState({});
  const [newEventHome, setNewEventHome] = useState('');
  const [newEventAway, setNewEventAway] = useState('');
  const [loadError, setLoadError] = useState('');
  const isAdmin = currentUser?.role === 'ADMIN';

  useEffect(() => {
    if (!isCurrentUserResolved || !isAdmin) {
      setEvents({});
      setLoadError('');
      return undefined;
    }

    let isActive = true;
    const fetchEvents = async () => {
      try {
        const response = await axios.get('/api/backoffice');
        const data = response.data;
        if (isActive) {
          setEvents(data && typeof data === 'object' ? data : {});
          setLoadError('');
        }
      } catch (error) {
        if (isActive) {
          setEvents({});
          setLoadError('Unable to load Backoffice events.');
        }
      }
    };

    fetchEvents();
    return () => {
      isActive = false;
    };
  }, [isAdmin, isCurrentUserResolved, refreshToken]);

  if (!isCurrentUserResolved) {
    return <section className="card backoffice-create" aria-labelledby="backoffice-access-title">
      <div className="card-body">
        <h1 className="h4" id="backoffice-access-title">Backoffice</h1>
        <p className="mb-0" role="status">Checking administrator access...</p>
      </div>
    </section>;
  }

  if (!isAdmin) {
    return <section className="card backoffice-create" aria-labelledby="backoffice-access-title">
      <div className="card-body">
        <h1 className="h4" id="backoffice-access-title">Backoffice</h1>
        <p>
          {currentUser
            ? 'Administrator access is required to use Backoffice.'
            : 'Log in with an administrator account to use Backoffice.'}
        </p>
        {!currentUser && (
          <Link
            className="btn btn-primary"
            to={{ pathname: '/login', search: location.search }}
          >
            Log in
          </Link>
        )}
      </div>
    </section>;
  }

  const eventValues = [];

  const setHomeResult = (event, value) => {
    const eventId = event.currentTarget.getAttribute('eventid');
    const eventValue = eventValues.find((result) => result.id === eventId);
    if (eventValue) {
      eventValue.home = value;
    }
  };

  const setAwayResult = (event, value) => {
    const eventId = event.currentTarget.getAttribute('eventid');
    const eventValue = eventValues.find((result) => result.id === eventId);
    if (eventValue) {
      eventValue.away = value;
    }
  };

  const setResults = async (event) => {
    const eventId = event.currentTarget.getAttribute('eventid');
    const eventValue = eventValues.find((result) => result.id === eventId);

    await axios.post('/api/backoffice/result', {
      eventId,
      homeResult: eventValue?.home,
      awayResult: eventValue?.away,
    });

    onChanged?.();
  };

  const setVisibility = async (event) => {
    const eventId = event.currentTarget.getAttribute('eventid');

    await axios.post('/api/backoffice/event_visibility', { eventId });
    onChanged?.();
  };

  const createNewEvent = async () => {
    await axios.post('/api/backoffice/new_event', { home: newEventHome, away: newEventAway });
    setNewEventHome('');
    setNewEventAway('');
    onChanged?.();
  };

  const renderedEvents = Object.values(events ?? {}).map((event) => {
    eventValues.push({ id: event.eventId, home: event.homeResult, away: event.awayResult });

    const buttonOptions = event.status === 'RESULT' ? ' btn-secondary disabled' : ' btn-danger';

    return <div className="card backoffice-event" key={event.eventId}>
      <div className="card-body">
        <h5 className="card-title mb-3">{event.name}</h5>
        <div className="row g-2">
          <div className="col-12 col-md">
            <input className="form-control" eventid={event.eventId} onChange={(changeEvent) => setHomeResult(changeEvent, changeEvent.target.value)} placeholder={`${event.home} result`} defaultValue={event.homeResult} />
          </div>
          <div className="col-12 col-md">
            <input className="form-control" eventid={event.eventId} onChange={(changeEvent) => setAwayResult(changeEvent, changeEvent.target.value)} placeholder={`${event.away} result`} defaultValue={event.awayResult} />
          </div>
          <div className="col-12 col-md-auto d-grid">
            <button eventid={event.eventId} className={`btn backoffice-action${buttonOptions}`} onClick={setResults}>Set results</button>
          </div>
        </div>

        <div className="row g-2 mt-1 align-items-center">
          <div className="col-12 col-md">Event is: <strong>{event.visibility}</strong></div>
          <div className="col-12 col-md-auto d-grid">
            <button eventid={event.eventId} className="btn btn-warning backoffice-action backoffice-action--warn" onClick={setVisibility}>Change</button>
          </div>
        </div>
      </div>
    </div>;
  });

  return <div className="backoffice-board">
    {loadError && <div className="alert alert-danger" role="alert">{loadError}</div>}
    <div className="card backoffice-create">
      <div className="card-body">
        <h5 className="card-title mb-3">Create new event</h5>
        <div className="row g-2">
          <div className="col-12 col-md">
            <input value={newEventHome} className="form-control" onChange={(event) => setNewEventHome(event.target.value)} placeholder="Home team" />
          </div>
          <div className="col-12 col-md">
            <input value={newEventAway} className="form-control" onChange={(event) => setNewEventAway(event.target.value)} placeholder="Away team" />
          </div>
          <div className="col-12 col-md-auto d-grid">
            <button className="btn btn-success backoffice-action backoffice-action--create" onClick={createNewEvent}>Create</button>
          </div>
        </div>
      </div>
    </div>
    {renderedEvents}
  </div>;
};

export default HandleBackoffice;
