import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import EventList from './pages/event/EventList'
import Header from './Header'
import { Route, Routes } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import NewUser from './pages/auth/NewUser';
import LogOut from './pages/auth/LogOut';
import LogIn from './pages/auth/LogIn';
import Backoffice from './pages/account/Backoffice'
import MyBets from './pages/account/MyBets'
import Slip from './pages/Slip';
import Statistics from './pages/account/Statistics'

const allowedVariants = new Set(['v1', 'v2', 'v3']);
const allowedThemes = new Set(['dark', 'light']);

const getParam = (search, key, fallback, allowedValues) => {
    const value = new URLSearchParams(search).get(key);
    return allowedValues.has(value) ? value : fallback;
};

const getUiVariant = (search) => {
    return getParam(search, 'ui', 'v1', allowedVariants);
};

const getTheme = (search) => {
    return getParam(search, 'theme', 'dark', allowedThemes);
};

const App = () => {
    const location = useLocation();
    const uiVariant = useMemo(() => getUiVariant(location.search), [location.search]);
    const theme = useMemo(() => getTheme(location.search), [location.search]);

    const [currentUser, setCurrentUser] = useState();
    const [slipKeyValue, setSlipKeyValue] = useState(0);
    const [statsKeyValue, setStatsKeyValue] = useState(0);
    const [backOfficeKeyValue, setBackofficeKeyValue] = useState(0);

    useEffect(() => {
        document.documentElement.setAttribute('data-bs-theme', theme);
    }, [theme]);

    useEffect(() => {
        fetchData();
      }, []);

    const fetchData = async () => {
        await axios.get('/api/auth/currentuser').then((response) => {
            setCurrentUser(response.data.currentUser);
        }).catch((error) => {
            setCurrentUser();
        });
    }

    const elementCallback = () => {
        fetchData();
        slipRefresh();
    }

    const slipRefresh = () => {
        setSlipKeyValue(Math.random());
    }

    const statsRefresh = () => {
        setStatsKeyValue(Math.random());
    }

    const backOfficeRefresh = () => {
        setBackofficeKeyValue(Math.random())
    }

    return <div className={`app-shell ui-variant-${uiVariant} ui-theme-${theme}`}>
        <Header currentUser={currentUser} uiVariant={uiVariant} theme={theme} />

        <div className={`container-fluid app-shell__content app-shell__content--${uiVariant}`}>
            <div className="row g-3 justify-content-center">
                <div className="col-12 col-xl-2 order-2 order-xl-1">
                    <section className="section-panel app-shell__sidebar">
                        <Statistics key={statsKeyValue} uiVariant={uiVariant} />
                    </section>
                </div>
                <div className="col-12 col-xl-8 order-1 order-xl-2">
                    <main className="app-shell__main">
                        <Routes>
                            <Route path='/' element={<EventList sliprefresh={slipRefresh} uiVariant={uiVariant} theme={theme} /> } />
                            <Route path='/signup' element={<NewUser callback={elementCallback} />}  />
                            <Route path='/logout' element={<LogOut callback={elementCallback} />}  />
                            <Route path='/login' element={<LogIn callback={elementCallback} />}  />
                            <Route path='/backoffice' element={<Backoffice key={backOfficeKeyValue} refresh={backOfficeRefresh} />}  />
                            <Route path='/bets' element={<MyBets />}  />
                            <Route path="*" element={<EventList sliprefresh={slipRefresh} uiVariant={uiVariant} theme={theme} />} />
                        </Routes>
                    </main>
                </div>
                <div className="col-12 col-xl-2 order-3">
                    <section className="section-panel app-shell__sidebar">
                        <Slip key={slipKeyValue} uiVariant={uiVariant} currentUser={currentUser} sliprefresh={slipRefresh} statsrefresh={statsRefresh} />
                    </section>
                </div>
            </div>
        </div>
    </div>
};

export default App;