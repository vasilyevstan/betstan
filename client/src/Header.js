import React  from "react";
import { Link } from 'react-router-dom';

const Header = ({currentUser}) => {
   

    const links = [
        !currentUser && { label: 'Create account', href: '/signup'},
        !currentUser && { label: 'Log in', href: '/login'},
        currentUser && { label: 'Backoffice', href: '/backoffice', options: ' '},
        currentUser && { label: 'My bets', href: '/bets', options: ''},
         currentUser && { label: 'Log out', href: '/logout'}
     ]
     .filter(linkConfig => linkConfig)
     .map(({label, href, options}) => {
         return <li key={href} className="nav-item">
             <Link className={"nav-link navbar-toggler" + options}  to={href}>{label}</Link>
         </li>
     })

    const greetings = (currentUser) ? `welcome, ${currentUser.email}` : '';

    return <nav className="navbar navbar-light sticky-top bg-dark bg-gradient" style={{ height: '75px'}}> 
        <Link className="navbar-brand mb-0 h1" to='/'>BetStan</Link>
        {greetings}

        <div className="d-flex justify-content-end">
            <ul className="nav align-items-center">
                {links}
            </ul>
        </div>
    </nav>;
};

export default Header;