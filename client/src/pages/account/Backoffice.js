import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';

const MAX_TEAM_NAME_LENGTH = 80;
const BACKOFFICE_KICKOFF_DELAY_SECONDS = 15 * 60;
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

const formatKickoff = (value) => {
  const parsed = new Date(value ?? '');
  return Number.isNaN(parsed.getTime()) ? null : format(parsed, 'MMMM do, yyyy H:mm');
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

const captureEventFocus = (version) => {
  const control = document.activeElement;
  const card = control?.closest?.('.backoffice-event');
  return card ? { control, card, version } : null;
};

const HandleBackoffice = ({ onChanged, refreshToken }) => {
  const [events, setEvents] = useState([]);
  const [eventResults, setEventResults] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [resultFilter, setResultFilter] = useState('ALL');
  const [visibilityFilter, setVisibilityFilter] = useState('ALL');
  const [newEventHome, setNewEventHome] = useState('');
  const [newEventAway, setNewEventAway] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionMessageTone, setActionMessageTone] = useState('success');
  const creationRequestId = useRef('');
  const resultsHeading = useRef(null);
  const focusVersion = useRef(0);
  const actionFocus = useRef(null);
  const refreshFocus = useRef(null);

  useEffect(() => {
    const noteFocusMovement = () => { focusVersion.current += 1; };
    document.addEventListener('focusin', noteFocusMovement);
    document.addEventListener('pointerdown', noteFocusMovement);
    window.addEventListener('blur', noteFocusMovement);
    return () => {
      document.removeEventListener('focusin', noteFocusMovement);
      document.removeEventListener('pointerdown', noteFocusMovement);
      window.removeEventListener('blur', noteFocusMovement);
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    // Disabling a submitting control can drop focus to body before the GET starts.
    const beforeRefresh = actionFocus.current ?? captureEventFocus(focusVersion.current);
    actionFocus.current = null;
    const fetchEvents = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get('/api/backoffice');
        const nextEvents = normalizeEvents(response.data);
        if (isActive) {
          refreshFocus.current = beforeRefresh;
          setEvents(nextEvents);
          setEventResults(initialResultValues(nextEvents));
          setLoadError('');
        }
      } catch (error) {
        if (isActive) {
          refreshFocus.current = beforeRefresh;
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

  useLayoutEffect(() => {
    if (isLoading) return;
    const previous = refreshFocus.current;
    refreshFocus.current = null;
    // One-shot recovery only for a removed card, never a surviving/disabled control
    // or a user who focused/clicked elsewhere while the request was in flight.
    if (
      previous
      && previous.version === focusVersion.current
      && !previous.card.isConnected
      && !previous.control.isConnected
      && document.activeElement === document.body
    ) {
      resultsHeading.current?.focus();
    }
  }, [events, isLoading]);

  const visibleEvents = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    return events.filter((event) => (
      (resultFilter === 'ALL' || event.status === resultFilter)
      && (visibilityFilter === 'ALL' || event.visibility === visibilityFilter)
      && (!search || [event.name, event.home, event.away].some((name) => (
        typeof name === 'string' && name.toLowerCase().includes(search)
      )))
    ));
  }, [events, searchTerm, resultFilter, visibilityFilter]);

  const changeFilter = (setter, value) => {
    // Local discovery must never trigger the asynchronous focus fallback.
    focusVersion.current += 1;
    setter(value);
  };

  const clearFilters = () => {
    focusVersion.current += 1;
    setSearchTerm('');
    setResultFilter('ALL');
    setVisibilityFilter('ALL');
  };

  const runAction = async (actionId, action, successMessage) => {
    const beforeAction = captureEventFocus(focusVersion.current);
    setBusyAction(actionId);
    setActionError('');
    setActionMessage('');
    try {
      const response = await action();
      setActionMessage(response?.data?.message || successMessage);
      setActionMessageTone(response?.status === 202 ? 'warning' : 'success');
      actionFocus.current = beforeAction;
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
        kickoffDelaySeconds: BACKOFFICE_KICKOFF_DELAY_SECONDS,
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

  const renderedEvents = visibleEvents.map((event) => {
    const isResulted = event.status === 'RESULTED';
    const eventName = event.name || `${event.home || 'Home team unavailable'} - ${event.away || 'Away team unavailable'}`;
    const resultLabel = isResulted ? 'Recorded'
      : event.status === 'NO_RESULT' ? 'Not recorded'
        : event.status ? 'Unknown' : 'Unavailable';
    const visibilityLabel = event.visibility === 'ONLINE' ? 'Online'
      : event.visibility === 'OFFLINE' ? 'Offline'
        : event.visibility ? 'Unknown' : 'Unavailable';
    const visibilityActionLabel = event.visibility === 'ONLINE' ? 'Take offline' : 'Make online';
    const values = eventResults[event.eventId] ?? { home: '', away: '' };
    const homeInputId = `backoffice-home-result-${event.eventId}`;
    const awayInputId = `backoffice-away-result-${event.eventId}`;
    const resultActionId = `result:${event.eventId}`;
    const visibilityActionId = `visibility:${event.eventId}`;
    const kickoffLabel = formatKickoff(event.time);

    return <article className="card backoffice-event" key={event.eventId} aria-labelledby={`backoffice-event-${event.eventId}`}>
      <div className="card-body backoffice-event__body">
        <header className="backoffice-event__identity">
          <h3 className="h5 backoffice-event__name" id={`backoffice-event-${event.eventId}`}>{eventName}</h3>
          <p className="backoffice-kickoff">
            {kickoffLabel
              ? <>Kickoff: <time dateTime={event.time}>{kickoffLabel}</time></>
              : 'Kickoff time unavailable'}
          </p>
          <div className="backoffice-states">
            <span className={`backoffice-state${isResulted ? ' backoffice-state--recorded' : ''}`}>
              Final result: <strong>{resultLabel}</strong>
            </span>
            <span className={`backoffice-state${event.visibility === 'ONLINE' ? ' backoffice-state--online' : ''}`}>
              Visibility: <strong>{visibilityLabel}</strong>
            </span>
          </div>
        </header>
        <div className="backoffice-event__controls">
          <section
            className="backoffice-task backoffice-task--result"
            aria-label={`Final result task for ${eventName}`}
          >
            <div className="backoffice-task__heading">
              <h4>Final result</h4>
              <span>{isResulted ? 'Recorded and locked' : 'Not yet recorded'}</span>
            </div>
            <form className="backoffice-result-form" aria-label={`Final result for ${eventName}`}
              aria-describedby="backoffice-result-help" onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              setResults(event.eventId, eventName);
            }}>
              <div className="backoffice-scores">
                <div className="backoffice-field">
                  <label className="form-label" htmlFor={homeInputId}>Home score</label>
                  <input
                    id={homeInputId}
                    aria-label={`Home score for ${event.home || 'home team unavailable'} in ${eventName}`}
                    className="form-control backoffice-control"
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
                <div className="backoffice-field">
                  <label className="form-label" htmlFor={awayInputId}>Away score</label>
                  <input
                    id={awayInputId}
                    aria-label={`Away score for ${event.away || 'away team unavailable'} in ${eventName}`}
                    className="form-control backoffice-control"
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
              </div>
              <button
                type="submit"
                className="btn backoffice-control backoffice-action backoffice-action--primary"
                disabled={isResulted || Boolean(busyAction)}
                aria-label={`Save final result for ${eventName}`}
              >
                {busyAction === resultActionId ? 'Saving...' : 'Save final result'}
              </button>
            </form>
          </section>
          <section
            className="backoffice-task backoffice-task--visibility"
            aria-label={`Visibility task for ${eventName}`}
          >
            <div className="backoffice-task__heading">
              <h4>Visibility</h4>
              <span>Current: {visibilityLabel}</span>
            </div>
            <p className="backoffice-task__target">
              Target: <strong>{event.visibility === 'ONLINE' ? 'OFFLINE' : 'ONLINE'}</strong>
            </p>
            <button
              type="button"
              className="btn backoffice-control backoffice-action"
              disabled={Boolean(busyAction)}
              onClick={() => setVisibility(
                event.eventId,
                eventName,
                event.visibility
              )}
              aria-label={`${visibilityActionLabel} for ${eventName}`}
            >
              {busyAction === visibilityActionId ? 'Changing...' : visibilityActionLabel}
            </button>
          </section>
        </div>
      </div>
    </article>;
  });

  return <div className="backoffice-board">
    <header className="backoffice-header">
      <h1 className="h3 mb-1">Backoffice</h1>
      <p className="mb-0">Manage event creation, visibility, and final results.</p>
    </header>
    <div className="card backoffice-create">
      <div className="card-body">
        <h2 className="h5 card-title">Create new event</h2>
        <form className="backoffice-create__form" onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          createNewEvent();
        }}>
          <div className="backoffice-field">
            <label className="form-label" htmlFor="backoffice-new-home">Home team</label>
            <input
              id="backoffice-new-home"
              value={newEventHome}
              className="form-control backoffice-control"
              maxLength={MAX_TEAM_NAME_LENGTH}
              disabled={Boolean(busyAction)}
              onChange={(event) => {
                creationRequestId.current = '';
                setNewEventHome(event.target.value);
              }}
            />
          </div>
          <div className="backoffice-field">
            <label className="form-label" htmlFor="backoffice-new-away">Away team</label>
            <input
              id="backoffice-new-away"
              value={newEventAway}
              className="form-control backoffice-control"
              maxLength={MAX_TEAM_NAME_LENGTH}
              disabled={Boolean(busyAction)}
              onChange={(event) => {
                creationRequestId.current = '';
                setNewEventAway(event.target.value);
              }}
            />
          </div>
          <button
            type="submit"
            className="btn backoffice-control backoffice-action backoffice-action--primary"
            disabled={Boolean(busyAction)}
          >
            {busyAction === 'create' ? 'Creating...' : 'Create'}
          </button>
        </form>
        <p className="backoffice-help">Kickoff is scheduled 15 minutes after creation.</p>
      </div>
    </div>
    <section className="backoffice-discovery" aria-label="Find events">
      <div className="backoffice-filters">
        <div className="backoffice-field backoffice-search">
          <label className="form-label" htmlFor="backoffice-search">Search events</label>
          <input id="backoffice-search" type="search" className="form-control backoffice-control"
            placeholder="Event or team name" value={searchTerm}
            onChange={(event) => changeFilter(setSearchTerm, event.target.value)} />
        </div>
        <div className="backoffice-field">
          <label className="form-label" htmlFor="backoffice-result-filter">Final result</label>
          <select id="backoffice-result-filter" className="form-select backoffice-control" value={resultFilter}
            onChange={(event) => changeFilter(setResultFilter, event.target.value)}>
            <option value="ALL">All</option>
            <option value="NO_RESULT">Not recorded</option>
            <option value="RESULTED">Recorded</option>
          </select>
        </div>
        <div className="backoffice-field">
          <label className="form-label" htmlFor="backoffice-visibility-filter">Visibility</label>
          <select id="backoffice-visibility-filter" className="form-select backoffice-control" value={visibilityFilter}
            onChange={(event) => changeFilter(setVisibilityFilter, event.target.value)}>
            <option value="ALL">All</option>
            <option value="ONLINE">Online</option>
            <option value="OFFLINE">Offline</option>
          </select>
        </div>
        <button type="button" className="btn backoffice-control backoffice-action" onClick={clearFilters}>
          Clear filters
        </button>
      </div>
      <h2 className="backoffice-results-heading" ref={resultsHeading} tabIndex={-1} id="backoffice-results-heading">
        Events
        <span aria-live="polite">
          {!isLoading && !loadError ? `Showing ${visibleEvents.length} of ${events.length} events` : ''}
        </span>
      </h2>
      <p className="backoffice-help" id="backoffice-result-help">Final results cannot be changed once recorded.</p>
    </section>
    <div className="backoffice-feedback">
      {loadError && <div className="alert alert-danger" role="alert">{loadError}</div>}
      {actionError && <div className="alert alert-danger" role="alert">{actionError}</div>}
      {actionMessage && (
        <div className={`alert alert-${actionMessageTone}`} role="status">
          {actionMessage}
        </div>
      )}
    </div>
    <section className="backoffice-events" aria-labelledby="backoffice-results-heading">
      {isLoading && <p className="mb-0" role="status">Loading Backoffice events...</p>}
      {!isLoading && !loadError && events.length === 0 && (
        <p className="mb-0 backoffice-empty">No events are available yet.</p>
      )}
      {!isLoading && !loadError && events.length > 0 && visibleEvents.length === 0 && (
        <p className="mb-0 backoffice-empty">No events match these filters. Try another name or clear the filters.</p>
      )}
      {renderedEvents}
    </section>
  </div>;
};

export default HandleBackoffice;
