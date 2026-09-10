import React, { useCallback, useEffect, useRef, useState } from 'react';
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

const MetricCard = ({ dates, metric, metricIndex }) => {
  const label = METRICS[metricIndex][1];
  const headingId = `telemetry-metric-heading-${metricIndex}`;
  const captionId = `telemetry-metric-caption-${metricIndex}`;
  const maximumValue = Math.max(1, ...metric.values);

  return <article className="card telemetry-metric" aria-labelledby={headingId}>
    <div className="card-body">
      <h3 className="h5 telemetry-metric__heading" id={headingId}>{label}</h3>
      <figure className="telemetry-metric__figure" aria-labelledby={`${headingId} ${captionId}`}>
        <svg
          className="telemetry-metric__graph"
          viewBox="0 0 280 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {metric.values.map((value, valueIndex) => {
            const height = Math.max(2, (value / maximumValue) * 92);
            return <rect
              className="telemetry-metric__bar"
              key={valueIndex}
              x={(valueIndex * 20) + 3}
              y={98 - height}
              width="14"
              height={height}
            />;
          })}
        </svg>
        <figcaption className="visually-hidden" id={captionId}>
          Fourteen daily date and value pairs for {label}.
        </figcaption>
        <ol className="telemetry-metric__values" aria-label={`${label} daily values`}>
          {dates.map((date, valueIndex) => (
            <li className="telemetry-metric__pair" key={`${date}-${valueIndex}`}>
              <time className="telemetry-metric__date" dateTime={date}>{date}</time>
              <data className="telemetry-metric__value" value={metric.values[valueIndex]}>
                {metric.values[valueIndex]}
              </data>
            </li>
          ))}
        </ol>
      </figure>
    </div>
  </article>;
};

const Telemetry = () => {
  const [snapshot, setSnapshot] = useState(null);
  const [requestState, setRequestState] = useState('loading');
  const [hasInitialError, setHasInitialError] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const snapshotRef = useRef(null);
  const requestInFlight = useRef(false);
  const initialRequestStarted = useRef(false);
  const isMounted = useRef(true);
  const refreshButton = useRef(null);
  const shouldRestoreRefreshFocus = useRef(false);

  const loadSummary = useCallback(async (isInitialRequest) => {
    if (requestInFlight.current) {
      return;
    }

    requestInFlight.current = true;
    const hadSnapshot = snapshotRef.current !== null;
    if (isMounted.current) {
      setRequestState(isInitialRequest ? 'loading' : 'refreshing');
      setHasInitialError(false);
      setRefreshMessage('');
    }

    try {
      const response = await axios.get('/api/telemetry/summary');
      if (!isValidSummary(response.data)) {
        throw new Error('Invalid telemetry summary');
      }
      if (!isMounted.current) {
        return;
      }

      snapshotRef.current = response.data;
      setSnapshot(response.data);
      setRefreshMessage(isInitialRequest ? '' : 'Telemetry refreshed.');
    } catch {
      if (!isMounted.current) {
        return;
      }

      if (hadSnapshot) {
        setRefreshMessage(
          `Refresh failed. Showing data generated at ${snapshotRef.current.generatedAt}.`
        );
      } else {
        setHasInitialError(true);
      }
    } finally {
      requestInFlight.current = false;
      if (isMounted.current) {
        setRequestState('idle');
      }
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    if (!initialRequestStarted.current) {
      initialRequestStarted.current = true;
      loadSummary(true);
    }

    return () => {
      isMounted.current = false;
    };
  }, [loadSummary]);

  useEffect(() => {
    if (requestState === 'idle' && shouldRestoreRefreshFocus.current) {
      shouldRestoreRefreshFocus.current = false;
      refreshButton.current?.focus();
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
            <span>Generated at</span>{' '}
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
          shouldRestoreRefreshFocus.current = true;
          loadSummary(false);
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
          <h2 className="h4 mb-0" id="telemetry-activity-heading">Daily activity</h2>
          <div className="telemetry-metrics">
            {snapshot.metrics.map((metric, metricIndex) => (
              <MetricCard
                dates={snapshot.dates}
                metric={metric}
                metricIndex={metricIndex}
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
