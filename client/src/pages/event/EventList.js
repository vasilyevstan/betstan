import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import ProductsList from './product/ProductsList';
import useLiveEvents from './useLiveEvents';
import useNow from '../../hook/useNow';
import {
  buildLiveMarketButtonLabel,
  formatCountdownDuration,
  formatIncident,
  formatLiveMarketType,
  formatMarketStatus,
  formatMinute,
  getLiveSelectionKey,
  getMarketAvailabilityLabel,
  getMarketSelectionLabel,
  getMatchProgressValue,
  getPhaseLabel,
  getScheduledKickoffTime,
  isCountdownMarketType,
  isFinishedLiveEvent,
  isInCountdownWindow,
  isLiveEvent,
  isLiveMarketSelectable,
  sortEvents,
} from '../../liveBettingUtils';

const formatEventTime = (value) => {
  const eventTime = new Date(value ?? '');
  return Number.isNaN(eventTime.getTime())
    ? 'TBD'
    : format(eventTime, 'MMMM do yyyy, HH:mm');
};

/** Approximates "when" a finished event became final, for picking the most recently finished one to retain. */
const getFinishedRecency = (event) => {
  const parsed = Date.parse(event?.live?.occurredAt ?? event?.live?.kickoffAt ?? event?.time ?? '');
  return Number.isNaN(parsed) ? -Infinity : parsed;
};

/** Same authorization rule `eventItems` is filtered by: OFFLINE events are only visible to an explicitly scoped acceptance view. */
const isEventVisibleToViewer = (event, visibleOfflineEventIds) => (
  event?.visibility !== 'OFFLINE' || visibleOfflineEventIds.has(event?.eventId)
);

// The public live feed stops returning an event once EventResultListener marks it OFFLINE, so the
// retained finished card (component state only) would otherwise vanish on a refresh/reconnect that
// remounts this component after that point, even though the client already legitimately received its
// terminal snapshot earlier in this browser session. Persisting the already-fetched snapshot to
// sessionStorage (bounded to one entry, cleared with the component's own retention rules, and
// naturally cleared by the browser when the tab closes) recovers exactly that case without requiring
// any backend change or inventing data the client never received.
const RETAINED_FINISHED_EVENT_STORAGE_KEY = 'betstan.retainedFinishedEvent.v1';

const readPersistedRetainedFinishedEvent = () => {
  try {
    const raw = window.sessionStorage?.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
};

const persistRetainedFinishedEvent = (event) => {
  try {
    if (event) {
      window.sessionStorage?.setItem(RETAINED_FINISHED_EVENT_STORAGE_KEY, JSON.stringify(event));
    } else {
      window.sessionStorage?.removeItem(RETAINED_FINISHED_EVENT_STORAGE_KEY);
    }
  } catch (error) {
    // sessionStorage may be unavailable (private browsing, storage disabled); retention simply
    // falls back to in-memory-only behavior for the rest of this render tree's lifetime.
  }
};

const formatQuoteValidity = (value) => {
  const validUntil = new Date(value ?? '');
  return Number.isNaN(validUntil.getTime())
    ? null
    : format(validUntil, 'HH:mm:ss');
};

const buildCardClass = (uiVariant) => (uiVariant === 'v3' ? 'col-12' : 'col-12 col-md-6 col-xl-4');
const EMPTY_EVENT_IDS = new Set();

const FeedStatus = ({ feedState }) => {
  if (feedState === 'open') {
    return null;
  }

  const message = feedState === 'polling'
    ? 'Live feed reconnecting. Polling fallback is active.'
    : feedState === 'reconnecting'
      ? 'Reconnecting to the live feed…'
      : 'Connecting to the live feed…';

  return <div className="card card-body event-stage__status" role="status">{message}</div>;
};

const LiveMarketCard = ({ event, market, onSelectionPlaced, selectedSelectionKeys, uiVariant }) => {
  const isSelectable = isLiveMarketSelectable(event, market);
  const quoteValidLabel = formatQuoteValidity(market?.quoteValidUntil);
  const marketAvailability = getMarketAvailabilityLabel(event, market);

  const handleSelection = async (selectionId) => {
    try {
      await axios.post('/api/event/odds', {
        eventId: event.eventId,
        marketId: market.marketId,
        marketVersion: market.marketVersion,
        quoteVersion: market.quoteVersion,
        selectionId,
      });
      onSelectionPlaced?.();
    } catch (error) {
      // ignore
    }
  };

  return <div className={`card event-market-card${isSelectable ? '' : ' event-market-card--inactive'} event-market-card--${uiVariant}`}>
    <div className="card-body">
      <div className="d-flex justify-content-between align-items-start gap-2 mb-2">
        <div>
          <div className="fw-semibold">{formatLiveMarketType(market.marketType)}</div>
          <div className="event-market-meta">
            <span>Quote v{market.quoteVersion}</span>
            <span>{formatMarketStatus(market.status)}</span>
            {quoteValidLabel ? <span>Valid until {quoteValidLabel}</span> : <span>No expiry</span>}
          </div>
        </div>
        <span className={`event-market-status event-market-status--${isSelectable ? 'open' : 'inactive'}`}>{marketAvailability}</span>
      </div>
      <div className="event-market-buttons">
        {(market.selections ?? []).map((selection) => {
          const selectionKey = getLiveSelectionKey({
            eventId: event.eventId,
            marketId: market.marketId,
            marketVersion: market.marketVersion,
            selectionId: selection.selectionId,
          });
          const isSelected = selectionKey ? selectedSelectionKeys?.has(selectionKey) : false;
          const selectedClass = isSelected ? ' product-button--selected' : '';

          return <button
            aria-label={buildLiveMarketButtonLabel(event, market, selection)}
            className={`btn product-button product-button--${uiVariant} event-market-button${selectedClass}`}
            disabled={!isSelectable}
            key={selection.selectionId}
            type="button"
            onClick={() => handleSelection(selection.selectionId)}
          >
            <span>{getMarketSelectionLabel(market, selection, event)}</span>
            <strong>{selection.odds}</strong>
          </button>;
        })}
      </div>
    </div>
  </div>;
};

const LiveEventCard = ({ event, onSelectionPlaced, selectedSelectionKeys, uiVariant }) => {
  const incidents = (event.live?.incidentHistory ?? [])
    .map((incident) => formatIncident(incident, event))
    .filter(Boolean)
    .slice(-5)
    .reverse();
  const liveMarkets = (event.live?.currentMarkets ?? []).slice(0, 5);
  const progressValue = getMatchProgressValue(event.live);

  return <article className="card event-card event-card--live h-100" aria-label={event.name}>
    <div className="card-body event-card__live-body">
      <div className="event-card__live-head">
        <div>
          <div className="event-card__badges">
            <span className="event-card__badge event-card__badge--live">LIVE</span>
            <span className="event-card__badge event-card__badge--phase">{getPhaseLabel(event.live?.phase)}</span>
          </div>
          <h5 className="card-title mb-1">{event.name}</h5>
          <h6 className="card-subtitle text-secondary mb-0">Kickoff {formatEventTime(event.live?.kickoffAt ?? event.time)}</h6>
        </div>
        <div className="event-scoreboard" aria-label={`Score ${event.home ?? 'Home'} ${event.live?.homeScore ?? 0}, ${event.away ?? 'Away'} ${event.live?.awayScore ?? 0}`}>
          <div className="event-scoreboard__teams">
            <span>{event.home ?? 'Home'}</span>
            <span>{event.away ?? 'Away'}</span>
          </div>
          <div className="event-scoreboard__score">
            <span>{event.live?.homeScore ?? 0}</span>
            <span>:</span>
            <span>{event.live?.awayScore ?? 0}</span>
          </div>
        </div>
      </div>

      <div className="event-progress" role="progressbar" aria-label="Match progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue}>
        <div className="event-progress__labels">
          <span>{formatMinute(event.live?.minute, event.live?.addedTime)}</span>
          <span>{getPhaseLabel(event.live?.phase)}</span>
        </div>
        <div className="event-progress__track">
          <div className="event-progress__fill" style={{ width: `${progressValue}%` }}></div>
          <div className="event-progress__ticks" aria-hidden="true">
            {Array.from({ length: 11 }).map((_, index) => <span key={index}></span>)}
          </div>
        </div>
      </div>

      <div className="event-card__section">
        <div className="event-card__section-title">Latest incidents</div>
        {incidents.length === 0 ? (
          <div className="event-card__empty text-secondary">Waiting for live incidents…</div>
        ) : (
          <ul className="event-incidents list-unstyled mb-0">
            {incidents.map((incident, index) => <li key={`${incident}-${index}`} className="event-incidents__item">{incident}</li>)}
          </ul>
        )}
      </div>

      <div className="event-card__section">
        <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
          <div className="event-card__section-title">Current markets</div>
          <small className="text-secondary">Top {liveMarkets.length || 0} of 5</small>
        </div>
        {liveMarkets.length === 0 ? (
          <div className="event-card__empty text-secondary">Waiting for the next live quote…</div>
        ) : (
          <div className="event-market-grid">
            {liveMarkets.map((market) => <LiveMarketCard
              event={event}
              key={`${market.marketId}-${market.marketVersion}`}
              market={market}
              onSelectionPlaced={onSelectionPlaced}
              selectedSelectionKeys={selectedSelectionKeys}
              uiVariant={uiVariant}
            />)}
          </div>
        )}
      </div>
    </div>
  </article>;
};

const CountdownEventCard = ({ event, now, onSelectionPlaced, selectedSelectionKeys, uiVariant }) => {
  const kickoffTime = getScheduledKickoffTime(event);
  const remainingMs = kickoffTime === null ? null : kickoffTime - now;
  const countdownLabel = remainingMs === null
    ? 'Kickoff time unavailable'
    : (remainingMs > 0 ? formatCountdownDuration(remainingMs) : 'Kickoff imminent');
  const countdownMarkets = (event.live?.currentMarkets ?? [])
    .filter((market) => isCountdownMarketType(market?.marketType));
  const preMatchProducts = event.products ?? [];

  return <article className="card event-card event-card--live event-card--countdown h-100" aria-label={event.name}>
    <div className="card-body event-card__live-body">
      <div className="event-card__live-head">
        <div>
          <div className="event-card__badges">
            <span className="event-card__badge event-card__badge--countdown">KICKOFF SOON</span>
          </div>
          <h5 className="card-title mb-1">{event.name}</h5>
          <h6 className="card-subtitle text-secondary mb-0">Scheduled kickoff {formatEventTime(event.live?.kickoffAt ?? event.time)}</h6>
        </div>
        <div
          aria-label={`Kickoff countdown: ${countdownLabel}`}
          className="event-countdown"
          role="timer"
        >
          <span className="event-countdown__eyebrow">Kickoff in</span>
          <span aria-hidden="true" className="event-countdown__value">{countdownLabel}</span>
        </div>
      </div>

      {preMatchProducts.length > 0 ? (
        <div className="event-card__section">
          <div className="event-card__badges mb-2">
            <span className="event-card__badge event-card__badge--prematch">PRE-MATCH</span>
          </div>
          <div className="event-card__section-title">Pre-match markets</div>
          {/* Same ProductsList/click path as PreMatchEventCard: pre-match boards accept selections
              up to kickoff (enforced server-side by EventOddsClicked), independent of the new
              live-slip countdown markets below. */}
          <ProductsList
            eventId={event.eventId}
            onSelectionPlaced={onSelectionPlaced}
            products={preMatchProducts}
            resulted={event.status === 'RESULTED'}
            selectedSelectionKeys={selectedSelectionKeys}
            uiVariant={uiVariant}
          />
        </div>
      ) : null}

      <div className="event-card__section">
        <div className="event-card__section-title">Pre-kickoff markets</div>
        {countdownMarkets.length === 0 ? (
          <div className="event-card__empty text-secondary">Pre-kickoff markets opening soon…</div>
        ) : (
          <div className="event-market-grid">
            {countdownMarkets.map((market) => <LiveMarketCard
              event={event}
              key={`${market.marketId}-${market.marketVersion}`}
              market={market}
              onSelectionPlaced={onSelectionPlaced}
              selectedSelectionKeys={selectedSelectionKeys}
              uiVariant={uiVariant}
            />)}
          </div>
        )}
      </div>
    </div>
  </article>;
};

const RetainedFinishedEventCard = ({ event }) => {
  const incidents = (event.live?.incidentHistory ?? [])
    .map((incident) => formatIncident(incident, event))
    .filter(Boolean)
    .slice(-5)
    .reverse();

  return <article className="card event-card event-card--live event-card--finished h-100" aria-label={event.name}>
    <div className="card-body event-card__live-body">
      <div className="event-card__live-head">
        <div>
          <div className="event-card__badges">
            <span className="event-card__badge event-card__badge--finished">FULL-TIME</span>
          </div>
          <h5 className="card-title mb-1">{event.name}</h5>
          <h6 className="card-subtitle text-secondary mb-0">Final score</h6>
        </div>
        <div className="event-scoreboard" aria-label={`Final score ${event.home ?? 'Home'} ${event.live?.homeScore ?? 0}, ${event.away ?? 'Away'} ${event.live?.awayScore ?? 0}`}>
          <div className="event-scoreboard__teams">
            <span>{event.home ?? 'Home'}</span>
            <span>{event.away ?? 'Away'}</span>
          </div>
          <div className="event-scoreboard__score">
            <span>{event.live?.homeScore ?? 0}</span>
            <span>:</span>
            <span>{event.live?.awayScore ?? 0}</span>
          </div>
        </div>
      </div>

      {incidents.length > 0 ? (
        <div className="event-card__section">
          <div className="event-card__section-title">Match summary</div>
          <ul className="event-incidents list-unstyled mb-0">
            {incidents.map((incident, index) => <li key={`${incident}-${index}`} className="event-incidents__item">{incident}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  </article>;
};

const PreMatchEventCard = ({ event, onSelectionPlaced, selectedSelectionKeys, uiVariant }) => <article className="card event-card h-100" aria-label={event.name}>
  <div className="card-body">
    <div className="event-card__badges mb-2">
      <span className="event-card__badge event-card__badge--prematch">PRE-MATCH</span>
    </div>
    <h5 className="card-title mb-1">{event.name}</h5>
    <h6 className="card-subtitle mb-3 text-secondary">{formatEventTime(event.time)}</h6>
    <ProductsList
      eventId={event.eventId}
      onSelectionPlaced={onSelectionPlaced}
      products={event.products ?? []}
      resulted={event.status === 'RESULTED'}
      selectedSelectionKeys={selectedSelectionKeys}
      uiVariant={uiVariant}
    />
  </div>
</article>;

const NextLiveEvent = ({ event, uiVariant }) => <aside
  aria-labelledby="next-live-event-title"
  className={`card event-next-live event-next-live--${uiVariant}`}
>
  <div className="card-body event-next-live__body">
    <div>
      <div className="event-card__badges mb-2">
        <span className="event-card__badge event-card__badge--live">NEXT LIVE</span>
      </div>
      <h2 className="event-next-live__title" id="next-live-event-title">Next live event</h2>
      <div className="event-next-live__name">{event.name}</div>
    </div>
    <div className="event-next-live__schedule">
      <span className="text-secondary">Scheduled kickoff</span>
      <time dateTime={event.time}>{formatEventTime(event.time)}</time>
      <small className="text-secondary">Pre-match markets are open now. Live markets appear at kickoff.</small>
    </div>
  </div>
</aside>;

const EventSection = ({ children, title, uiVariant }) => <section className={`event-group event-group--${uiVariant}`} aria-labelledby={`event-group-${title.replace(/\s+/g, '-').toLowerCase()}`}>
  <div className="event-group__heading">
    <h2 id={`event-group-${title.replace(/\s+/g, '-').toLowerCase()}`} className="event-group__title">{title}</h2>
  </div>
  <div className="row g-3 justify-content-center">{children}</div>
</section>;

const HandleEventList = ({
  onSelectionPlaced,
  selectedSelectionKeys,
  uiVariant,
  visibleOfflineEventIds = EMPTY_EVENT_IDS,
  onScopedAccessFailure,
}) => {
  const { events, feedState, isLoading } = useLiveEvents(
    visibleOfflineEventIds,
    onScopedAccessFailure,
  );
  const now = useNow(1000);

  const eventItems = useMemo(() => sortEvents(
    (events ?? []).filter((event) => isEventVisibleToViewer(event, visibleOfflineEventIds)),
  ), [events, visibleOfflineEventIds]);

  // Bounded (single) retention of the most recently finished live event so its final score keeps
  // showing in the upper live area even after the server stops returning it, until the next event
  // enters its own T-10 countdown. Rehydrated from sessionStorage so a refresh/reconnect that
  // remounts this component doesn't lose a card the client already legitimately received this
  // session (see `persistRetainedFinishedEvent` above).
  const [retainedFinishedEvent, setRetainedFinishedEvent] = useState(readPersistedRetainedFinishedEvent);

  useEffect(() => {
    persistRetainedFinishedEvent(retainedFinishedEvent);
  }, [retainedFinishedEvent]);

  useEffect(() => {
    // A retained event scoped to an acceptance view must not survive that authorization being
    // revoked (e.g. its id leaving `visibleOfflineEventIds`), even though it isn't otherwise present
    // in `eventItems` (which is already filtered to only authorized events) to trigger replacement.
    if (retainedFinishedEvent && !isEventVisibleToViewer(retainedFinishedEvent, visibleOfflineEventIds)) {
      setRetainedFinishedEvent(null);
      return;
    }

    // Only one event is ever live/counting-down at a time system-wide (see
    // `LiveEventReadModel`'s retirement handoff), and the server tombstones any previously
    // retained finished event no later than the moment the next event's own T-10 countdown
    // becomes authoritative -- strictly before that next event can ever go live. So a remount
    // that observes *any* currently live event (not just one still in its own countdown window)
    // is proof the previously cached finished card is stale, even if this client never itself
    // observed that next event's countdown (e.g. a refresh/reconnect that lands after kickoff).
    const hasNewerActiveEvent = eventItems.some((event) => (
      isLiveEvent(event) || isInCountdownWindow(event, now)
    ));

    if (hasNewerActiveEvent) {
      setRetainedFinishedEvent(null);
      return;
    }

    const latestFinishedEvent = eventItems
      .filter(isFinishedLiveEvent)
      .reduce((mostRecent, candidate) => (
        !mostRecent || getFinishedRecency(candidate) > getFinishedRecency(mostRecent)
          ? candidate
          : mostRecent
      ), null);

    if (latestFinishedEvent) {
      setRetainedFinishedEvent(latestFinishedEvent);
    }
  }, [eventItems, now, retainedFinishedEvent, visibleOfflineEventIds]);

  const liveEvents = eventItems.filter(isLiveEvent);
  const countdownEvents = eventItems.filter((event) => (
    !isLiveEvent(event) && isInCountdownWindow(event, now)
  ));
  const preMatchEvents = eventItems.filter((event) => (
    !isLiveEvent(event)
    && !isFinishedLiveEvent(event)
    && !countdownEvents.some((countdownEvent) => countdownEvent.eventId === event.eventId)
  ));
  const cardClass = buildCardClass(uiVariant);
  const upperLiveEvents = [...countdownEvents, ...liveEvents];
  // A countdown event is already occupying the upper live area with its own imminent kickoff, so the
  // "next live event" banner (which points at some other, later-scheduled event) must not also show
  // alongside it -- otherwise the truly-next event is both counting down above and mislabeled below.
  const nextLiveEvent = upperLiveEvents.length === 0
    ? preMatchEvents.find((event) => (
      event.status !== 'RESULTED'
      && event.live?.phase !== 'FULL_TIME'
    ))
    : null;

  if (isLoading && eventItems.length === 0) {
    return <section className={`event-stage event-stage--${uiVariant}`}>
      <div className="card event-stage__empty card-body">Loading live events…</div>
    </section>;
  }

  if (eventItems.length === 0 && !retainedFinishedEvent) {
    return <section className={`event-stage event-stage--${uiVariant}`}>
      <FeedStatus feedState={feedState} />
      <div className="card event-stage__empty card-body">No events are available in the current live window.</div>
    </section>;
  }

  const content = <>
    <FeedStatus feedState={feedState} />
    {nextLiveEvent ? <NextLiveEvent event={nextLiveEvent} uiVariant={uiVariant} /> : null}
    {upperLiveEvents.length > 0 || retainedFinishedEvent ? <EventSection title="Live now" uiVariant={uiVariant}>
      {countdownEvents.map((event) => <div className={cardClass} key={event.eventId}>
        <CountdownEventCard
          event={event}
          now={now}
          onSelectionPlaced={onSelectionPlaced}
          selectedSelectionKeys={selectedSelectionKeys}
          uiVariant={uiVariant}
        />
      </div>)}
      {liveEvents.map((event) => <div className={cardClass} key={event.eventId}>
        <LiveEventCard
          event={event}
          onSelectionPlaced={onSelectionPlaced}
          selectedSelectionKeys={selectedSelectionKeys}
          uiVariant={uiVariant}
        />
      </div>)}
      {retainedFinishedEvent ? <div className={cardClass} key={retainedFinishedEvent.eventId}>
        <RetainedFinishedEventCard event={retainedFinishedEvent} />
      </div> : null}
    </EventSection> : null}
    {preMatchEvents.length > 0 ? <EventSection title="Pre-match" uiVariant={uiVariant}>
      {preMatchEvents.map((event) => <div className={cardClass} key={event.eventId}>
        <PreMatchEventCard
          event={event}
          onSelectionPlaced={onSelectionPlaced}
          selectedSelectionKeys={selectedSelectionKeys}
          uiVariant={uiVariant}
        />
      </div>)}
    </EventSection> : null}
  </>;

  if (uiVariant === 'v3') {
    return <section className={`event-stage event-stage--${uiVariant}`}>
      <div className="event-editorial">
        <div className="event-editorial__line"></div>
        <div className="event-editorial__content">{content}</div>
      </div>
    </section>;
  }

  return <section className={`event-stage event-stage--${uiVariant}`}>{content}</section>;
};

export default HandleEventList;
export {
  RETAINED_FINISHED_EVENT_STORAGE_KEY,
};
