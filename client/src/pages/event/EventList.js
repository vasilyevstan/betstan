import React, { useMemo } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import ProductsList from './product/ProductsList';
import useLiveEvents from './useLiveEvents';
import {
  buildLiveMarketButtonLabel,
  formatIncident,
  formatLiveMarketType,
  formatMarketStatus,
  formatMinute,
  getLiveSelectionKey,
  getMarketAvailabilityLabel,
  getMatchProgressValue,
  getPhaseLabel,
  getSideLabel,
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
            <span>{getSideLabel(selection.side, event)}</span>
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

  const eventItems = useMemo(() => sortEvents(
    (events ?? []).filter((event) => (
      event.visibility !== 'OFFLINE'
      || visibleOfflineEventIds.has(event.eventId)
    )),
  ), [events, visibleOfflineEventIds]);

  const liveEvents = eventItems.filter(isLiveEvent);
  const preMatchEvents = eventItems.filter((event) => !isLiveEvent(event));
  const cardClass = buildCardClass(uiVariant);

  if (isLoading && eventItems.length === 0) {
    return <section className={`event-stage event-stage--${uiVariant}`}>
      <div className="card event-stage__empty card-body">Loading live events…</div>
    </section>;
  }

  if (eventItems.length === 0) {
    return <section className={`event-stage event-stage--${uiVariant}`}>
      <FeedStatus feedState={feedState} />
      <div className="card event-stage__empty card-body">No events are available in the current live window.</div>
    </section>;
  }

  const content = <>
    <FeedStatus feedState={feedState} />
    {liveEvents.length > 0 ? <EventSection title="Live now" uiVariant={uiVariant}>
      {liveEvents.map((event) => <div className={cardClass} key={event.eventId}>
        <LiveEventCard
          event={event}
          onSelectionPlaced={onSelectionPlaced}
          selectedSelectionKeys={selectedSelectionKeys}
          uiVariant={uiVariant}
        />
      </div>)}
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
