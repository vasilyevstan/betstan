import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import axios from 'axios';

const METRICS = [
  ['MAIN_PAGE_VISIT', 'Main page visits'],
  ['ADMIN_PAGE_VISIT', 'Backoffice page visits'],
  ['SLIP_CREATED', 'Slips created'],
  ['BET_PLACED', 'Bets placed'],
  ['RESULTING_SETTLED', 'Results settled'],
  ['GAMECENTER_EVENT_EMITTED', 'Gamecenter events emitted'],
  ['USER_CREATED', 'Users created'],
  ['USER_LOGGED_IN', 'User logins'],
];

const SERVICES = [
  ['auth', 'Authentication'],
  ['backoffice', 'Backoffice'],
  ['bet', 'Betting'],
  ['client', 'Client'],
  ['event', 'Events'],
  ['gamemaster', 'Game master'],
  ['moderation', 'Moderation'],
  ['resulting', 'Resulting'],
  ['slip', 'Slip'],
  ['telemetry', 'Telemetry'],
];

const STATUSES = {
  green: { label: 'Healthy', modifier: 'healthy' },
  yellow: { label: 'Degraded', modifier: 'degraded' },
  red: { label: 'Unavailable', modifier: 'unavailable' },
};

const hasExactKeys = (value, expectedKeys) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === expectedKeys.length
  && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isCanonicalIsoInstant = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

const isValidDateInventory = (dates, generatedAt) => {
  if (!Array.isArray(dates) || dates.length !== 14) {
    return false;
  }

  const dateTimes = dates.map((date) => {
    if (typeof date !== 'string' || !CANONICAL_DATE_PATTERN.test(date)) {
      return null;
    }

    const parsed = new Date(`${date}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime())
      && parsed.toISOString().slice(0, 10) === date
    ) ? parsed.getTime() : null;
  });
  if (
    dateTimes.some((dateTime) => dateTime === null)
    || new Set(dates).size !== dates.length
    || dateTimes.some((dateTime, index) => (
      index > 0 && dateTime !== dateTimes[index - 1] + DAY_IN_MILLISECONDS
    ))
  ) {
    return false;
  }

  return dates[dates.length - 1] === new Date(generatedAt).toISOString().slice(0, 10);
};

const isValidSummary = (value) => {
  if (!hasExactKeys(value, ['generatedAt', 'dates', 'metrics', 'health'])) {
    return false;
  }

  if (
    !isCanonicalIsoInstant(value.generatedAt)
    || !isValidDateInventory(value.dates, value.generatedAt)
  ) {
    return false;
  }

  if (
    !Array.isArray(value.metrics)
    || value.metrics.length !== METRICS.length
    || !value.metrics.every((entry, index) => (
      hasExactKeys(entry, ['metric', 'values'])
      && entry.metric === METRICS[index][0]
      && Array.isArray(entry.values)
      && entry.values.length === value.dates.length
      && entry.values.every((metricValue) => (
        Number.isInteger(metricValue) && metricValue >= 0
      ))
    ))
  ) {
    return false;
  }

  return (
    Array.isArray(value.health)
    && value.health.length === SERVICES.length
    && value.health.every((entry, index) => (
      hasExactKeys(entry, ['service', 'status'])
      && entry.service === SERVICES[index][0]
      && Object.prototype.hasOwnProperty.call(STATUSES, entry.status)
    ))
  );
};

const isValidHourlyRequest = (metric, day) => (
  METRICS.some(([name]) => name === metric)
  && typeof day === 'string'
  && CANONICAL_DATE_PATTERN.test(day)
  && isCanonicalIsoInstant(`${day}T00:00:00.000Z`)
);

const isValidHourly = (value, metric, day) => (
  isValidHourlyRequest(metric, day)
  && hasExactKeys(value, ['generatedAt', 'metric', 'date', 'hours', 'values'])
  && isCanonicalIsoInstant(value.generatedAt)
  && value.metric === metric
  && value.date === day
  && Array.isArray(value.hours)
  && value.hours.length === 24
  && value.hours.every((hour, index) => (
    hour === `${day}T${String(index).padStart(2, '0')}:00:00.000Z`
  ))
  && Array.isArray(value.values)
  && value.values.length === 24
  && value.values.every((count) => Number.isSafeInteger(count) && count >= 0)
);

const OVERVIEW = Object.freeze({ mode: 'overview' });
const acceptedDetail = (record) => record.mode === 'ready' ? record.detail : record.prior;
const containsPoint = (box, x, y) => (
  box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
);
const overlaps = (a, b) => (
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
);

// The overlay never receives pointer events. Only the actual bar, overlay bounds,
// and a narrow connecting corridor retain pointer hover; focus is independent.
const inTooltipRegion = (placement, x, y) => {
  if (!placement) return false;
  const { anchor, box } = placement;
  if (containsPoint(anchor, x, y) || containsPoint(box, x, y)) return true;
  const above = box.bottom <= anchor.top;
  const start = above ? box.bottom : anchor.bottom;
  const end = above ? anchor.top : box.top;
  if (y < start || y > end || end === start) return false;
  const anchorX = (anchor.left + anchor.right) / 2;
  const tipX = Math.max(box.left, Math.min(box.right, anchorX));
  const fraction = (y - start) / (end - start);
  const center = above
    ? tipX + (anchorX - tipX) * fraction
    : anchorX + (tipX - anchorX) * fraction;
  return Math.abs(x - center) <= 6;
};

const MetricCard = ({ dates, metric, metricIndex, record, serverDay, generatedAt, onOpen, onBack }) => {
  const label = METRICS[metricIndex][1];
  const headingId = `telemetry-metric-heading-${metricIndex}`;
  const captionId = `telemetry-metric-caption-${metricIndex}`;
  const isDaily = record.mode === 'overview';
  const detail = acceptedDetail(record);
  const currentServerDay = detail?.generatedAt.slice(0, 10) > serverDay
    ? detail.generatedAt.slice(0, 10) : serverDay;
  const values = isDaily ? metric.values : detail?.values;
  const buckets = isDaily ? dates : detail?.hours;
  const freshness = isDaily ? generatedAt : detail?.generatedAt;
  const maximumValue = Math.max(1, ...(values || []));
  const card = useRef(null);
  const bars = useRef([]);
  const buttons = useRef([]);
  const back = useRef(null);
  const heading = useRef(null);
  const tooltip = useRef(null);
  const viewport = useRef(null);
  const pendingFocus = useRef(null);
  const originDay = useRef(null);
  const [pointerIndex, setPointerIndex] = useState(null);
  const [focusIndex, setFocusIndex] = useState(null);
  const [suppressed, setSuppressed] = useState(false);
  const [placement, setPlacement] = useState(null);
  const activeIndex = suppressed ? null : (pointerIndex ?? focusIndex);

  const dismiss = useCallback(() => {
    setPointerIndex(null);
    setFocusIndex(null);
    setPlacement(null);
  }, []);

  useLayoutEffect(() => {
    dismiss();
  }, [values, buckets, record.mode, dismiss]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    let destination;
    if (pendingFocus.current === 'back' && !isDaily) {
      destination = back.current;
    } else if (pendingFocus.current === 'origin' && isDaily) {
      const index = dates.indexOf(originDay.current);
      destination = buttons.current[index] || heading.current;
    }
    destination?.focus({ preventScroll: true });
    if (destination) {
      if (viewport.current?.contains(destination) && viewport.current.clientHeight > 0) {
        const frame = viewport.current.getBoundingClientRect();
        const target = destination.getBoundingClientRect();
        const top = frame.top + viewport.current.clientTop + 6;
        const bottom = frame.top + viewport.current.clientTop + viewport.current.clientHeight - 6;
        viewport.current.scrollTop += target.top < top
          ? target.top - top : target.bottom > bottom ? target.bottom - bottom : 0;
      }
      const box = destination.getBoundingClientRect();
      const headerBottom = document.querySelector('.app-navbar')?.getBoundingClientRect().bottom || 0;
      // Reveal only a user-initiated focus destination, including its 3px/2px
      // focus ring. Native automatic scrolling does not account for the sticky navbar.
      const visibleTop = Math.max(0, headerBottom) + 8;
      const visibleBottom = window.innerHeight - 8;
      const offset = box.top < visibleTop
        ? box.top - visibleTop
        : box.bottom > visibleBottom ? box.bottom - visibleBottom : 0;
      if (box.height > 0 && offset !== 0) {
        window.scrollBy({ top: offset, behavior: 'instant' });
      }
    }
    pendingFocus.current = null;
  }, [isDaily, record.mode, dates]);

  useLayoutEffect(() => {
    if (activeIndex === null || !tooltip.current || !bars.current[activeIndex]) {
      setPlacement(null);
      return;
    }
    const cardBox = card.current.getBoundingClientRect();
    const headerBottom = document.querySelector('.app-navbar')?.getBoundingClientRect().bottom || 0;
    const top = Math.max(8, headerBottom + 8, cardBox.top + 8);
    const bottom = Math.min(window.innerHeight - 8, cardBox.bottom - 8);
    let anchor = bars.current[activeIndex].getBoundingClientRect();
    if (pointerIndex === null && (anchor.top < top || anchor.bottom > bottom)) {
      anchor = buttons.current[activeIndex]?.getBoundingClientRect() || anchor;
    }
    const measured = tooltip.current.getBoundingClientRect();
    const left = Math.max(
      Math.max(8, cardBox.left + 8),
      Math.min(
        (anchor.left + anchor.right - measured.width) / 2,
        Math.min(window.innerWidth - 8, cardBox.right - 8) - measured.width
      )
    );
    const protectedBoxes = [...card.current.querySelectorAll('button:focus, .telemetry-metric__viewport:focus, .telemetry-metric__action')]
      .map((element) => element.getBoundingClientRect());
    const candidates = [anchor.top - measured.height - 6, anchor.bottom + 6];
    const maximumTop = bottom - measured.height;
    if (top <= maximumTop) {
      candidates.push(...candidates.map((y) => Math.max(top, Math.min(maximumTop, y))));
    }
    const candidate = candidates.map((y) => ({
      left, right: left + measured.width, top: y, bottom: y + measured.height,
    })).find((box) => (
      box.top >= top && box.bottom <= bottom
      && !protectedBoxes.some((protectedBox) => overlaps(box, protectedBox))
    ));
    setPlacement(candidate ? {
      anchor,
      box: candidate,
      left: candidate.left - cardBox.left - card.current.clientLeft,
      top: candidate.top - cardBox.top - card.current.clientTop,
    } : null);
  }, [activeIndex, pointerIndex, values, buckets, record.mode]);

  useEffect(() => {
    const escape = (event) => {
      if (event.key === 'Escape') setSuppressed(true);
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [dismiss]);

  useEffect(() => {
    if (pointerIndex === null) return undefined;
    const move = (event) => {
      if (!inTooltipRegion(placement, event.clientX, event.clientY)
        && !containsPoint(bars.current[pointerIndex]?.getBoundingClientRect(), event.clientX, event.clientY)) {
        setPointerIndex(null);
      }
    };
    document.addEventListener('mousemove', move);
    return () => document.removeEventListener('mousemove', move);
  }, [pointerIndex, placement]);

  const openDay = (day, event) => {
    originDay.current = day;
    if (event.currentTarget === document.activeElement) pendingFocus.current = 'back';
    dismiss();
    onOpen(metric.metric, day);
  };

  return <article className="card telemetry-metric" aria-labelledby={headingId} ref={card}>
    <div className="card-body">
      <header className="telemetry-metric__header">
        <h3 className="h5 telemetry-metric__heading" id={headingId} tabIndex={-1} ref={heading}>{label}</h3>
        {!isDaily ? <button
          type="button"
          className="btn telemetry-metric__action"
          ref={back}
          onClick={() => {
            pendingFocus.current = 'origin';
            dismiss();
            onBack(metric.metric);
          }}
        >Back to 14 days</button> : <span className="btn telemetry-metric__back-space" aria-hidden="true">Back to 14 days</span>}
        <p className="telemetry-metric__day mb-0">
          {isDaily ? <>
            <time dateTime={dates[0]}>{dates[0]}</time>{' – '}
            <time dateTime={dates[dates.length - 1]}>{dates[dates.length - 1]}</time>{' · UTC'}
          </> : <>
            <time dateTime={record.day}>{record.day}</time>{' · UTC'}
            {record.day === currentServerDay ? ' · In progress' : ''}
          </>}
        </p>
      </header>
      <figure className="telemetry-metric__figure" aria-labelledby={`${headingId} ${captionId}`}>
        <svg
          className="telemetry-metric__graph"
          viewBox="0 0 280 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {(values || []).map((value, valueIndex) => {
            const height = Math.max(2, (value / maximumValue) * 92);
            const slot = 280 / values.length;
            return <rect
              className={`telemetry-metric__bar${isDaily ? ' telemetry-metric__bar--daily' : ''}`}
              key={valueIndex}
              ref={(element) => { bars.current[valueIndex] = element; }}
              x={slot * (valueIndex + 0.15)}
              y={98 - height}
              width={slot * 0.7}
              height={height}
              onMouseEnter={() => {
                setPointerIndex(valueIndex);
                setSuppressed(false);
              }}
              onMouseLeave={(event) => {
                if (!inTooltipRegion(placement, event.clientX, event.clientY)) setPointerIndex(null);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={isDaily ? (event) => openDay(dates[valueIndex], event) : undefined}
            />;
          })}
        </svg>
        <figcaption className="visually-hidden" id={captionId}>
          {isDaily ? 'Fourteen daily date' : 'Twenty-four UTC hour'} and value pairs for {label}.
        </figcaption>
        <div
          className="telemetry-metric__viewport"
          ref={viewport}
          role={isDaily ? undefined : 'region'}
          tabIndex={isDaily ? -1 : 0}
          aria-label={isDaily ? undefined : `${label}, ${record.day} UTC, hourly values and status`}
        >
          {freshness ? <p className="telemetry-metric__generated mb-0">
            {isDaily ? 'Overview data generated at' : 'Hourly data generated at'}{' '}
            <time dateTime={freshness}>{freshness}</time>
          </p> : null}
          {record.mode === 'loading' ? <p className="telemetry-notice telemetry-notice--progress mb-0" role="status">
            {detail ? 'Refreshing hourly data. Showing the last accepted snapshot.' : 'Loading hourly data...'}
          </p> : null}
          {record.mode === 'error' ? <div className="telemetry-notice telemetry-notice--error" role="alert">
            <p className="mb-0">
              {record.errorKind === 'expired'
                ? 'This UTC day is no longer available in the 14-day window.'
                : 'Hourly data is unavailable. Retry or go back to 14 days.'}
              {detail ? ' Showing the last accepted hourly snapshot.' : ''}
            </p>
            {record.errorKind !== 'expired' ? <button
              className="btn telemetry-metric__action"
              type="button"
              onClick={(event) => openDay(record.day, event)}
            >Retry</button> : null}
          </div> : null}
        {values ? <ol className={`telemetry-metric__values${isDaily ? '' : ' telemetry-metric__values--hourly'}`} aria-label={`${label} ${isDaily ? 'daily' : 'hourly UTC'} values`}>
          {buckets.map((bucket, valueIndex) => {
            const pair = <>
              <time className="telemetry-metric__date" dateTime={bucket}>
                {isDaily ? bucket : bucket.slice(11, 16)}
              </time>
              <data className="telemetry-metric__value" value={values[valueIndex]}>{values[valueIndex]}</data>
            </>;
            return <li
              className={`telemetry-metric__pair${isDaily ? ' telemetry-metric__pair--daily' : ''}`}
              key={bucket}
            >
              {isDaily ? <button
                type="button"
                className="telemetry-metric__date-button"
                ref={(element) => { buttons.current[valueIndex] = element; }}
                aria-label={`${label}, ${bucket} UTC, ${values[valueIndex]}`}
                onClick={(event) => openDay(bucket, event)}
                onFocus={() => {
                  setFocusIndex(valueIndex);
                  setSuppressed(false);
                }}
                onBlur={() => setFocusIndex(null)}
              >{pair}</button> : pair}
            </li>;
          })}
        </ol> : null}
        </div>
      </figure>
    </div>
    {activeIndex !== null && values ? <div
      className="telemetry-metric__tooltip"
      role="tooltip"
      ref={tooltip}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: placement ? 'visible' : 'hidden',
      }}
    >
      <time className="telemetry-metric__date" dateTime={buckets[activeIndex]}>
        {isDaily ? '00:00-24:00 UTC' : `${buckets[activeIndex].slice(11, 16)} UTC`}
      </time>
      <data className="telemetry-metric__value" value={values[activeIndex]}>
        {values[activeIndex]}
      </data>
    </div> : null}
  </article>;
};

const Telemetry = () => {
  const [snapshot, setSnapshot] = useState(null);
  const [requestState, setRequestState] = useState('loading');
  const [hasInitialError, setHasInitialError] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const snapshotRef = useRef(null);
  const [records, setRecords] = useState({});
  const recordsRef = useRef({});
  const operations = useRef({});
  const summaryOperation = useRef(null);
  const refreshBatch = useRef(null);
  const isMounted = useRef(true);
  const refreshButton = useRef(null);
  const shouldRestoreRefreshFocus = useRef(false);

  const replaceRecord = useCallback((metric, record) => {
    recordsRef.current = { ...recordsRef.current, [metric]: record };
    setRecords(recordsRef.current);
  }, []);

  const invalidateDetail = useCallback((metric) => {
    const previous = operations.current[metric];
    delete operations.current[metric]; // Invalidate BEFORE abort, including synchronous abort handlers.
    previous?.controller.abort();
  }, []);

  const loadDetail = useCallback(async (metric, day, supersede = false) => {
    if (!isValidHourlyRequest(metric, day)) return 'failed';
    if (!supersede && operations.current[metric]?.day === day) return 'neutral';
    invalidateDetail(metric);
    const operation = Object.freeze({ day, controller: new AbortController() });
    operations.current[metric] = operation;
    const previous = recordsRef.current[metric] || OVERVIEW;
    const prior = previous.day === day ? acceptedDetail(previous) : undefined;
    replaceRecord(metric, { mode: 'loading', day, prior });
    const isCurrent = () => (
      isMounted.current && operations.current[metric] === operation
      && recordsRef.current[metric]?.day === day
    );
    try {
      const response = await axios.get(`/api/telemetry/metrics/${metric}/days/${day}`, {
        signal: operation.controller.signal, timeout: 10000,
      });
      if (!isCurrent()) return 'neutral';
      if (!isValidHourly(response.data, metric, day)) throw new Error('Invalid hourly data');
      replaceRecord(metric, { mode: 'ready', day, detail: response.data });
      return 'success';
    } catch (error) {
      if (!isCurrent()) return 'neutral';
      replaceRecord(metric, {
        mode: 'error', day, prior,
        errorKind: error.response?.status === 400 && isValidHourlyRequest(metric, day)
          ? 'expired' : 'transient',
      });
      return 'failed';
    } finally {
      if (isCurrent()) delete operations.current[metric];
    }
  }, [invalidateDetail, replaceRecord]);

  const loadSummary = useCallback(async () => {
    const operation = Object.freeze({ controller: new AbortController() });
    summaryOperation.current = operation;
    const isCurrent = () => isMounted.current && summaryOperation.current === operation;
    try {
      const response = await axios.get('/api/telemetry/summary', {
        signal: operation.controller.signal, timeout: 10000,
      });
      if (!isCurrent()) return 'neutral';
      if (!isValidSummary(response.data)) throw new Error('Invalid telemetry summary');
      snapshotRef.current = response.data;
      setSnapshot(response.data);
      Object.entries(recordsRef.current).forEach(([metric, record]) => {
        // An older cached overview may omit a newer UTC day without proving expiry.
        if (record.mode !== 'overview' && record.day < response.data.dates[0]) {
          invalidateDetail(metric);
          replaceRecord(metric, {
            mode: 'error', day: record.day, errorKind: 'expired', prior: acceptedDetail(record),
          });
        }
      });
      return 'success';
    } catch {
      if (!isCurrent()) return 'neutral';
      if (!snapshotRef.current) setHasInitialError(true);
      return 'failed';
    } finally {
      if (isCurrent()) summaryOperation.current = null;
    }
  }, [invalidateDetail, replaceRecord]);

  const refresh = useCallback(async (initial = false) => {
    if (refreshBatch.current) return;
    const selected = Object.entries(recordsRef.current)
      .filter(([, record]) => record.mode !== 'overview')
      .map(([metric, record]) => [metric, record.day]);
    const batch = Object.freeze({ selected });
    refreshBatch.current = batch;
    setRequestState(initial ? 'loading' : 'refreshing');
    setHasInitialError(false);
    setRefreshMessage('');
    // Capture membership before dispatch: later opens never extend this batch.
    const outcomes = await Promise.allSettled([
      loadSummary(),
      ...selected.map(([metric, day]) => loadDetail(metric, day, true)),
    ]);
    if (!isMounted.current || refreshBatch.current !== batch) return;
    const failed = outcomes.some((outcome) => outcome.status === 'rejected' || outcome.value === 'failed')
      || selected.some(([metric, day]) => (
        recordsRef.current[metric]?.day === day && recordsRef.current[metric]?.errorKind === 'expired'
      ));
    if (!initial && snapshotRef.current) {
      setRefreshMessage(failed
        ? selected.length
          ? 'Refresh failed for some telemetry data. Successful updates are shown; unavailable views retain their last accepted snapshot.'
          : `Refresh failed. Showing data generated at ${snapshotRef.current.generatedAt}.`
        : 'Telemetry refreshed.');
    }
    refreshBatch.current = null;
    setRequestState('idle');
  }, [loadSummary, loadDetail]);

  useEffect(() => {
    isMounted.current = true;
    refresh(true);
    return () => {
      isMounted.current = false;
      refreshBatch.current = null;
      const summary = summaryOperation.current;
      summaryOperation.current = null;
      const active = Object.values(operations.current);
      operations.current = {};
      summary?.controller.abort();
      active.forEach((operation) => operation.controller.abort());
    };
  }, [refresh]);

  useEffect(() => {
    const moved = (event) => {
      if (event.target !== refreshButton.current) shouldRestoreRefreshFocus.current = false;
    };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', moved);
    document.addEventListener('keydown', moved);
    return () => {
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', moved);
      document.removeEventListener('keydown', moved);
    };
  }, []);

  useLayoutEffect(() => {
    if (requestState === 'idle' && shouldRestoreRefreshFocus.current) {
      shouldRestoreRefreshFocus.current = false;
      refreshButton.current?.focus({ preventScroll: true });
    }
  }, [requestState]);

  const isBusy = requestState !== 'idle';
  const statusText = requestState === 'loading'
    ? 'Loading telemetry...'
    : requestState === 'refreshing'
      ? 'Refreshing...'
      : '';

  return <section className="telemetry-page" aria-labelledby="telemetry-page-heading" aria-busy={isBusy}>
    <header className="telemetry-page__header">
      <div>
        <h1 className="h3 mb-1" id="telemetry-page-heading">Telemetry and service health</h1>
        {snapshot ? (
          <p className="telemetry-page__generated mb-0">
            <span>Overview and service health generated at</span>{' '}
            <time dateTime={snapshot.generatedAt}>{snapshot.generatedAt}</time>
          </p>
        ) : null}
      </div>
      <button
        className="btn btn-primary telemetry-refresh"
        type="button"
        disabled={isBusy}
        ref={refreshButton}
        onClick={() => {
          shouldRestoreRefreshFocus.current = document.activeElement === refreshButton.current;
          refresh(false);
        }}
      >
        Refresh
      </button>
    </header>

    {statusText ? (
      <p className="telemetry-notice telemetry-notice--progress mb-0" role="status" aria-live="polite">
        {statusText}
      </p>
    ) : null}
    {hasInitialError ? (
      <p className="telemetry-notice telemetry-notice--error mb-0" role="alert">
        Telemetry is unavailable. Try again.
      </p>
    ) : null}
    {refreshMessage ? (
      <p
        className={`telemetry-notice mb-0${refreshMessage.startsWith('Refresh failed') ? ' telemetry-notice--error' : ' telemetry-notice--success'}`}
        role={refreshMessage.startsWith('Refresh failed') ? 'alert' : 'status'}
        aria-live="polite"
      >
        {refreshMessage}
      </p>
    ) : null}

    {snapshot ? (
      <>
        <section className="telemetry-section" aria-labelledby="telemetry-health-heading">
          <h2 className="h4 mb-0" id="telemetry-health-heading">Service health</h2>
          <ul className="telemetry-health">
            {snapshot.health.map((entry, index) => {
              const status = STATUSES[entry.status];
              return <li className="card telemetry-health__item" key={entry.service}>
                <span className="telemetry-health__service">{SERVICES[index][1]}</span>
                <span className={`telemetry-health__status telemetry-health__status--${status.modifier}`}>
                  <span className="telemetry-health__indicator" aria-hidden="true"></span>
                  <span>{status.label}</span>
                </span>
              </li>;
            })}
          </ul>
        </section>

        <section className="telemetry-section" aria-labelledby="telemetry-activity-heading">
          <h2 className="h4 mb-0" id="telemetry-activity-heading">Activity</h2>
          <div className="telemetry-metrics">
            {snapshot.metrics.map((metric, metricIndex) => (
              <MetricCard
                dates={snapshot.dates}
                metric={metric}
                metricIndex={metricIndex}
                record={records[metric.metric] || OVERVIEW}
                serverDay={snapshot.generatedAt.slice(0, 10)}
                generatedAt={snapshot.generatedAt}
                onOpen={loadDetail}
                onBack={(name) => {
                  invalidateDetail(name);
                  replaceRecord(name, OVERVIEW);
                }}
                key={metric.metric}
              />
            ))}
          </div>
        </section>
      </>
    ) : null}
  </section>;
};

export default Telemetry;
