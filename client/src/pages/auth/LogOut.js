import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import axios from "axios";

const HandleLogOut = ({callback}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState('pending');
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const doRequest = useCallback(async () => {
    setStatus('pending');
    try {
      await axios.post('/api/auth/logout');
      setStatus('complete');
      callbackRef.current?.();
      navigate({ pathname: '/', search: location.search });
    } catch {
      setStatus('error');
    }
  }, [location.search, navigate]);

  useEffect(() => {
    void doRequest();
  }, [doRequest]);

  if (status === 'error') {
    return <section className="card auth-card logout-card" aria-live="polite">
      <div className="card-body">
        <header className="auth-card__header">
          <h1 className="auth-card__title">We couldn’t log you out</h1>
          <p className="auth-card__subtitle">
            Your session may still be active. Try again or return to Events.
          </p>
        </header>
        <div className="logout-card__actions">
          <button className="btn auth-submit" type="button" onClick={() => void doRequest()}>
            Retry log out
          </button>
          <Link
            className="btn btn-shell logout-card__safe-link"
            to={{ pathname: '/', search: location.search }}
          >
            Return to Events
          </Link>
        </div>
      </div>
    </section>;
  }

  if (status === 'complete') {
    return <section className="card auth-card logout-card" aria-live="polite">
      <div className="card-body">
        <h1 className="auth-card__title">You’re logged out</h1>
        <p className="auth-card__subtitle">Returning to Events…</p>
      </div>
    </section>;
  }

  return <section className="card auth-card logout-card" aria-busy="true" aria-live="polite">
    <div className="card-body">
      <h1 className="auth-card__title">Logging you out</h1>
      <p className="auth-card__subtitle">Ending this browser session…</p>
    </div>
  </section>;
};

export default HandleLogOut;
