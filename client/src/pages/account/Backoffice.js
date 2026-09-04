import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';

const MAX_TEAM_NAME_LENGTH = 80;
const MAX_SCORE = 99;
let fallbackRequestSequence = 0;

const createRequestId = () => {
  const browserCrypto = typeof window !== 'undefined' ? window.crypto : undefined;
  if (typeof browserCrypto?.randomUUID === 'function') {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(
      bytes,
      (value) => value.toString(16).padStart(2, '0')
    ).join('');
  }

  fallbackRequestSequence += 1;
  return `backoffice-${Date.now()}-${fallbackRequestSequence}`;
};

const normalizeEvents = (data) => {
  if (Array.isArray(data)) {
    return data;
  }
  return data && typeof data === 'object' ? Object.values(data) : [];
};

const initialResultValues = (events) => Object.fromEntries(events.map((event) => [
  event.eventId,
  {
    home: event.homeResult ?? '',
    away: event.awayResult ?? '',
  },
]));

const HandleBackoffice = ({ onChanged, refreshToken }) => {
  const [events, setEvents] = useState([]);
  const [eventResults, setEventResults] = useState({});
  const [newEventHome, setNewEventHome] = useState('');
  const [newEventAway, setNewEventAway] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionMessageTone, setActionMessageTone] = useState('success');
  const creationRequestId = useRef('');

  useEffect(() => {
    let isActive = true;
    const fetchEvents = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get('/api/backoffice');
        const nextEvents = normalizeEvents(response.data);
        if (isActive) {
          setEvents(nextEvents);
          setEventResults(initialResultValues(nextEvents));
          setLoadError('');
        }
      } catch (error) {
        if (isActive) {
          setEvents([]);
          setEventResults({});
          setLoadError('Unable to load Backoffice events.');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    fetchEvents();
    return () => {
      isActive = false;
    };
  }, [refreshToken]);

  const runAction = async (actionId, action, successMessage) => {
    setBusyAction(actionId);
    setActionError('');
    setActionMessage('');
    try {
      const response = await action();
      setActionMessage(response?.data?.message || successMessage);
      setActionMessageTone(response?.status === 202 ? 'warning' : 'success');
      onChanged?.();
      return true;
    } catch (error) {
      setActionError(
        error?.response?.data?.message || 'Unable to complete the Backoffice action.'
      );
      return false;
    } finally {
      setBusyAction('');
    }
  };

  const updateResultValue = (eventId, side, value) => {
    setEventResults((currentValues) => ({
      ...currentValues,
      [eventId]: {
        ...currentValues[eventId],
        [side]: value,
      },
    }));
  };

  const setResults = async (eventId, eventName) => {
    const values = eventResults[eventId] ?? {};
    if (values.home === '' || values.away === '') {
      setActionError('Enter both scores before setting the result.');
      return;
    }

    const homeResult = Number(values.home);
    const awayResult = Number(values.away);
    if (
      !Number.isInteger(homeResult)
      || !Number.isInteger(awayResult)
      || homeResult < 0
      || awayResult < 0
      || homeResult > MAX_SCORE
      || awayResult > MAX_SCORE
    ) {
      setActionError(`Scores must be whole numbers between 0 and ${MAX_SCORE}.`);
      return;
    }

    await runAction(
      `result:${eventId}`,
      () => axios.post('/api/backoffice/result', {
        eventId,
        homeResult,
        awayResult,
      }),
      `Result saved for ${eventName}.`
    );
  };

  const setVisibility = async (eventId, eventName, currentVisibility) => {
    const visibility = currentVisibility === 'ONLINE' ? 'OFFLINE' : 'ONLINE';
    await runAction(
      `visibility:${eventId}`,
      () => axios.post('/api/backoffice/event_visibility', { eventId, visibility }),
      `Visibility changed for ${eventName}.`
    );
  };

  const createNewEvent = async () => {
    const home = newEventHome.trim();
    const away = newEventAway.trim();
    if (!home || !away) {
      setActionError('Enter both home and away team names.');
      return;
    }
    if (!creationRequestId.current) {
      creationRequestId.current = createRequestId();
    }

    const wasCreated = await runAction(
      'create',
      () => axios.post('/api/backoffice/new_event', {
        home,
        away,
        requestId: creationRequestId.current,
      }),
      `${home} - ${away} was created.`
    );
    if (wasCreated) {
      creationRequestId.current = '';
      setNewEventHome('');
      setNewEventAway('');
    }
  };

  const renderedEvents = events.map((event) => {
    const isResulted = event.status === 'RESULTED';
    const values = eventResults[event.eventId] ?? { home: '', away: '' };
    const homeInputId = `backoffice-home-result-${event.eventId}`;
    const awayInputId = `backoffice-away-result-${event.eventId}`;
    const resultActionId = `result:${event.eventId}`;
    const visibilityActionId = `visibility:${event.eventId}`;

    return <article className="card backoffice-event" key={event.eventId} aria-labelledby={`backoffice-event-${event.eventId}`}>
      <div className="card-body">
        <h2 className="h5 card-title mb-3" id={`backoffice-event-${event.eventId}`}>{event.name}</h2>
        <form className="row g-2" onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          setResults(event.eventId, event.name);
        }}>
          <div className="col-12 col-md">
            <label className="form-label" htmlFor={homeInputId}>{event.home} score</label>
            <input
              id={homeInputId}
              className="form-control"
              type="number"
              min="0"
              max={MAX_SCORE}
              step="1"
              required
              value={values.home}
              disabled={isResulted || Boolean(busyAction)}
              onChange={(changeEvent) => updateResultValue(
                event.eventId,
                'home',
                changeEvent.target.value
              )}
            />
          </div>
          <div className="col-12 col-md">
            <label className="form-label" htmlFor={awayInputId}>{event.away} score</label>
            <input
              id={awayInputId}
              className="form-control"
              type="number"
              min="0"
              max={MAX_SCORE}
              step="1"
              required
              value={values.away}
              disabled={isResulted || Boolean(busyAction)}
              onChange={(changeEvent) => updateResultValue(
                event.eventId,
                'away',
                changeEvent.target.value
              )}
            />
          </div>
          <div className="col-12 col-md-auto d-grid align-self-end">
            <button
              type="submit"
              className={`btn backoffice-action ${isResulted ? 'btn-secondary' : 'btn-danger'}`}
              disabled={isResulted || Boolean(busyAction)}
              aria-label={`Set results for ${event.name}`}
            >
              {busyAction === resultActionId ? 'Saving...' : 'Set results'}
            </button>
          </div>
        </form>

        <div className="row g-2 mt-1 align-items-center">
          <div className="col-12 col-md">Event is: <strong>{event.visibility}</strong></div>
          <div className="col-12 col-md-auto d-grid">
            <button
              type="button"
              className="btn btn-warning backoffice-action backoffice-action--warn"
              disabled={Boolean(busyAction)}
              onClick={() => setVisibility(
                event.eventId,
                event.name,
                event.visibility
              )}
              aria-label={`Change visibility for ${event.name}`}
            >
              {busyAction === visibilityActionId ? 'Changing...' : 'Change visibility'}
            </button>
          </div>
        </div>
      </div>
    </article>;
  });

  return <div className="backoffice-board">
    <header className="backoffice-header">
      <h1 className="h3 mb-1">Backoffice</h1>
      <p className="mb-0">Manage event creation, visibility, and final results.</p>
    </header>
    {loadError && <div className="alert alert-danger" role="alert">{loadError}</div>}
    {actionError && <div className="alert alert-danger" role="alert">{actionError}</div>}
    {actionMessage && (
      <div className={`alert alert-${actionMessageTone}`} role="status">
        {actionMessage}
      </div>
    )}
    <div className="card backoffice-create">
      <div className="card-body">
        <h2 className="h5 card-title mb-3">Create new event</h2>
        <form className="row g-2" onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          createNewEvent();
        }}>
          <div className="col-12 col-md">
            <label className="form-label" htmlFor="backoffice-new-home">Home team</label>
            <input
              id="backoffice-new-home"
              value={newEventHome}
              className="form-control"
              maxLength={MAX_TEAM_NAME_LENGTH}
              disabled={Boolean(busyAction)}
              onChange={(event) => {
                creationRequestId.current = '';
                setNewEventHome(event.target.value);
              }}
            />
          </div>
          <div className="col-12 col-md">
            <label className="form-label" htmlFor="backoffice-new-away">Away team</label>
            <input
              id="backoffice-new-away"
              value={newEventAway}
              className="form-control"
              maxLength={MAX_TEAM_NAME_LENGTH}
              disabled={Boolean(busyAction)}
              onChange={(event) => {
                creationRequestId.current = '';
                setNewEventAway(event.target.value);
              }}
            />
          </div>
          <div className="col-12 col-md-auto d-grid align-self-end">
            <button
              type="submit"
              className="btn btn-success backoffice-action backoffice-action--create"
              disabled={Boolean(busyAction)}
            >
              {busyAction === 'create' ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
    {isLoading && <p className="mb-0" role="status">Loading Backoffice events...</p>}
    {!isLoading && !loadError && renderedEvents.length === 0 && (
      <p className="mb-0 backoffice-empty">No events are available yet.</p>
    )}
    {renderedEvents}
  </div>;
};

export default HandleBackoffice;
