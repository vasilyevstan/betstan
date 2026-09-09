import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Route, Routes, useLocation } from 'react-router-dom';
import EventList from './pages/event/EventList';
import Header from './Header';
import NewUser from './pages/auth/NewUser';
import LogOut from './pages/auth/LogOut';
import LogIn from './pages/auth/LogIn';
import Backoffice from './pages/account/Backoffice';
import MyBets from './pages/account/MyBets';
import Slip from './pages/Slip';
import Statistics from './pages/account/Statistics';
import Telemetry from './pages/Telemetry';

const allowedVariants = new Set(['v1', 'v2', 'v3']);
const allowedThemes = new Set(['dark', 'light']);

const getParam = (search, key, fallback, allowedValues) => {
  const value = new URLSearchParams(search).get(key);
  return allowedValues.has(value) ? value : fallback;
};

const getUiVariant = (search) => getParam(search, 'ui', 'v1', allowedVariants);
const getTheme = (search) => getParam(search, 'theme', 'dark', allowedThemes);

const App = () => {
  const location = useLocation();
  const lastReportedPath = useRef(null);
  const uiVariant = useMemo(() => getUiVariant(location.search), [location.search]);
  const theme = useMemo(() => getTheme(location.search), [location.search]);
  const isTelemetryRoute = location.pathname === '/telemetry';

  const [currentUser, setCurrentUser] = useState();
  const [isCurrentUserResolved, setIsCurrentUserResolved] = useState(false);
  const [selectedSelectionKeys, setSelectedSelectionKeys] = useState(new Set());
  const [slipRefreshSignal, setSlipRefreshSignal] = useState(0);
  const [statsRefreshToken, setStatsRefreshToken] = useState(0);
  const [backofficeRefreshToken, setBackofficeRefreshToken] = useState(0);
  const visibleOfflineEventIds = useMemo(() => {
    if (currentUser?.role !== 'ADMIN') {
      return new Set();
    }

    const rawIds = new URLSearchParams(location.search)
      .get('acceptanceEventIds')
      ?.split(',')
      .slice(0, 10) ?? [];
    return new Set(rawIds.filter((eventId) => /^[a-f0-9]{24}$/.test(eventId)));
  }, [currentUser, location.search]);

  const fetchData = useCallback(async () => {
    setIsCurrentUserResolved(false);
    try {
      const response = await axios.get('/api/auth/currentuser');
      setCurrentUser(response.data.currentUser);
    } catch {
      setCurrentUser();
    } finally {
      setIsCurrentUserResolved(true);
    }
  }, []);

  const requestSlipRefresh = useCallback(() => {
    setSlipRefreshSignal((currentSignal) => currentSignal + 1);
  }, []);

  const refreshStats = useCallback(() => {
    setStatsRefreshToken((currentToken) => currentToken + 1);
  }, []);

  const refreshBackoffice = useCallback(() => {
    setBackofficeRefreshToken((currentToken) => currentToken + 1);
  }, []);

  const handleAuthChange = useCallback(() => {
    fetchData();
    requestSlipRefresh();
  }, [fetchData, requestSlipRefresh]);

  useEffect(() => {
    document.documentElement.setAttribute('data-bs-theme', theme);
  }, [theme]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (lastReportedPath.current === location.pathname) {
      return;
    }
    lastReportedPath.current = location.pathname;

    const page = location.pathname === '/'
      ? 'main'
      : location.pathname === '/backoffice'
        ? 'admin'
        : null;
    if (page) {
      axios.post('/api/telemetry/page-view', { page }).catch(() => undefined);
    }
  }, [location.pathname]);

  return <div className={`app-shell ui-variant-${uiVariant} ui-theme-${theme}`}>
    <Header currentUser={currentUser} uiVariant={uiVariant} theme={theme} />

    <div className={`container-fluid app-shell__content app-shell__content--${uiVariant}`}>
      <div className="row g-3 justify-content-center">
        {!isTelemetryRoute ? (
          <div className="col-12 col-xl-2 order-2 order-xl-1">
            <section className="section-panel app-shell__sidebar">
              <Statistics refreshToken={statsRefreshToken} uiVariant={uiVariant} />
            </section>
          </div>
        ) : null}
        <div className={isTelemetryRoute ? 'col-12 order-1' : 'col-12 col-xl-8 order-1 order-xl-2'}>
          <main className="app-shell__main">
            <Routes>
              <Route
                path="/"
                element={<EventList
                  onSelectionPlaced={requestSlipRefresh}
                  selectedSelectionKeys={selectedSelectionKeys}
                  uiVariant={uiVariant}
                  visibleOfflineEventIds={visibleOfflineEventIds}
                  onScopedAccessFailure={fetchData}
                  isScopedAccessResolved={isCurrentUserResolved}
                />}
              />
              <Route path="/signup" element={<NewUser callback={handleAuthChange} />} />
              <Route path="/logout" element={<LogOut callback={handleAuthChange} />} />
              <Route path="/login" element={<LogIn callback={handleAuthChange} />} />
              <Route
                path="/backoffice"
                element={<Backoffice
                  onChanged={refreshBackoffice}
                  refreshToken={backofficeRefreshToken}
                />}
              />
              <Route path="/bets" element={<MyBets />} />
              <Route path="/telemetry" element={<Telemetry />} />
              <Route
                path="*"
                element={<EventList
                  onSelectionPlaced={requestSlipRefresh}
                  selectedSelectionKeys={selectedSelectionKeys}
                  uiVariant={uiVariant}
                  visibleOfflineEventIds={visibleOfflineEventIds}
                  onScopedAccessFailure={fetchData}
                  isScopedAccessResolved={isCurrentUserResolved}
                />}
              />
            </Routes>
          </main>
        </div>
        {!isTelemetryRoute ? (
          <div className="col-12 col-xl-2 order-3">
            <section className="section-panel app-shell__sidebar">
              <Slip
                currentUser={currentUser}
                onBoardSubmitted={refreshStats}
                onSelectionKeysChange={setSelectedSelectionKeys}
                refreshSignal={slipRefreshSignal}
                uiVariant={uiVariant}
              />
            </section>
          </div>
        ) : null}
      </div>
    </div>
  </div>;
};

export default App;
