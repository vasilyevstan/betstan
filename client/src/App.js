import React, { useEffect, useState } from 'react'
import axios from 'axios'
import EventList from './pages/event/EventList'
import Header from './Header'
import { Route, Routes } from 'react-router-dom';
import SignUp from './pages/auth/NewUser';
import SignOut from './pages/auth/LogOut';
import SignIn from './pages/auth/LogIn';
import Backoffice from './pages/account/Backoffice'
import MyBets from './pages/account/MyBets'
import Slip from './pages/Slip';
import Statistics from './pages/account/Statistics'

const App = () => {

    const [currentUser, setCurrentUser] = useState();
    const [slipKeyValue, setSlipKeyValue] = useState(0);
    const [statsKeyValue, setStatsKeyValue] = useState(0);
    const [backOfficeKeyValue, setBackofficeKeyValue] = useState(0);

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

    return <div className='container-fluid bg-dark bg-gradient'>
        <Header currentUser={currentUser}/>

        <div className="row">
            <div className="col col-lg-2">
                <Statistics key={statsKeyValue} />
            </div>
            <div className="col">
                <Routes>
                    <Route path='/' element={<EventList sliprefresh={slipRefresh} /> } />
                    <Route path='/signup' element={<SignUp callback={elementCallback} />}  />
                    <Route path='/logout' element={<SignOut callback={elementCallback} />}  />
                    <Route path='/login' element={<SignIn callback={elementCallback} />}  />
                    <Route path='/backoffice' element={<Backoffice key={backOfficeKeyValue} refresh={backOfficeRefresh} />}  />
                    <Route path='/bets' element={<MyBets />}  />
                    <Route path="*" element={<EventList sliprefresh={slipRefresh} />} />
                </Routes>
            </div>
            <div className="col col-lg-2">
                <Slip key={slipKeyValue} currentUser={currentUser} sliprefresh={slipRefresh} statsrefresh={statsRefresh} />
            </div>
        </div>
    </div>
};

export default App;