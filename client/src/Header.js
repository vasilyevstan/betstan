import React, { useRef, useState } from "react";
import { Link, useLocation } from 'react-router-dom';
import getRouteIdentity from './routeIdentity';

const Header = ({ currentUser, uiVariant, theme }) => {
    const location = useLocation();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuToggle = useRef(null);
    const routeIdentity = getRouteIdentity(location.pathname);
    const themeOptions = ['dark', 'light'];
    const explicitRouteIdentities = new Set([
       '/backoffice', '/bets', '/profile', '/login', '/logout', '/signup', '/telemetry',
    ]);
    const isEventsRoute = routeIdentity === '/' || !explicitRouteIdentities.has(routeIdentity);

    const links = [
       { label: 'Backoffice', href: '/backoffice', icon: '/icons/backoffice.svg', showLabel: true },
       { label: 'Telemetry', href: '/telemetry', icon: '/icons/telemetry.svg', showLabel: true },
       !currentUser && { label: 'Create account', href: '/signup', icon: '/icons/signup.svg' },
       !currentUser && { label: 'Log in', href: '/login', icon: '/icons/login.svg' },
       currentUser && { label: 'My bets', href: '/bets', icon: '/icons/bets.svg' },
       currentUser && { label: 'Log out', href: '/logout', icon: '/icons/logout.svg' }
     ]
     .filter(Boolean);

    const effectiveName = currentUser
        ? (currentUser.displayName ?? currentUser.email.split('@')[0])
        : '';
    const displayName = Array.from(effectiveName).slice(0, 16).join('');
    const initial = Array.from(displayName)[0]?.toUpperCase() ?? '';
    const buildSearch = (updates = {}) => {
       const params = new URLSearchParams(location.search);
       Object.entries(updates).forEach(([key, value]) => {
           if (value === null || value === undefined || value === '') {
               params.delete(key);
           } else {
               params.set(key, value);
           }
       });

       const search = params.toString();
       return search ? `?${search}` : '';
    };
    const linkTo = (pathname, updates = {}) => ({
       pathname,
       search: buildSearch(updates),
    });

    const logoLink = linkTo('/', { ui: uiVariant, theme });
    const themeLink = (nextTheme) => ({
       pathname: location.pathname,
       search: buildSearch({ theme: nextTheme }),
    });
    const brandSource = theme === 'dark'
        ? '/brand/betstan-wordmark-dark.svg'
        : '/brand/betstan-wordmark-light.svg';
    const closeMenu = () => {
        if (menuOpen) {
            setMenuOpen(false);
            menuToggle.current?.focus();
        }
    };

    return <nav
       aria-label="Primary navigation"
       className={`navbar navbar-expand-lg sticky-top app-navbar ${theme === 'light' ? 'navbar-light' : 'navbar-dark'}`}
       onKeyDown={(event) => {
           if (event.key === 'Escape' && menuOpen) {
               event.preventDefault();
               closeMenu();
           }
       }}
    >
       <div className="container-fluid">
           <Link
               aria-current={isEventsRoute ? 'page' : undefined}
               className="navbar-brand mb-0 fw-semibold d-flex align-items-center gap-2"
               to={logoLink}
               onClick={closeMenu}
           >
               <img className="brand-wordmark" src={brandSource} alt="BetStan home" />
           </Link>
           <button
               ref={menuToggle}
               className="navbar-toggler"
               type="button"
               aria-label="Toggle navigation"
               aria-controls="betstan-navbar"
               aria-expanded={menuOpen}
               onClick={() => setMenuOpen((open) => !open)}
           >
               <span className="navbar-toggler-icon" aria-hidden="true" />
           </button>
           <div id="betstan-navbar" className={`collapse navbar-collapse app-navbar__content${menuOpen ? ' show' : ''}`}>
               <div className="navbar-meta">
                   {currentUser && (
                       <Link className="user-chip" title={effectiveName}
                           aria-label="My profile" aria-current={routeIdentity === '/profile' ? 'page' : undefined}
                           to={linkTo('/profile')} onClick={closeMenu}>
                           <span className="user-chip__avatar">{initial}</span>
                           <span className="user-chip__name">{displayName}</span>
                       </Link>
                   )}
               </div>
               <div className="app-navbar__workspace">
                   <div className="presentation-control" role="group" aria-label="Theme">
                       <div className="presentation-control__options">
                       {themeOptions.map((themeOption) => (
                           <Link
                               aria-current={theme === themeOption ? 'true' : undefined}
                               key={themeOption}
                               to={themeLink(themeOption)}
                               title={themeOption === 'dark' ? 'Dark' : 'Light'}
                               className={`presentation-option${theme === themeOption ? ' presentation-option--active' : ''}`}
                           >
                               <img className="nav-icon" src={`/icons/theme-${themeOption}.svg`} alt="" />
                               <span className="visually-hidden">{themeOption === 'dark' ? 'Dark' : 'Light'}</span>
                           </Link>
                       ))}
                       </div>
                   </div>
                   <ul className="navbar-nav app-navbar__links">
                       {links.map(({ label, href, icon, showLabel }) => {
                           const isCurrent = routeIdentity === getRouteIdentity(href);
                           return <li key={href} className="nav-item">
                               <Link
                                   aria-current={isCurrent ? 'page' : undefined}
                                   className="app-nav-link"
                                   title={label}
                                   to={linkTo(href)}
                                   onClick={closeMenu}
                               >
                                   <img className="nav-icon" src={icon} alt="" />
                                   <span className={`app-nav-link__label${showLabel ? '' : ' visually-hidden'}`}>{label}</span>
                               </Link>
                           </li>;
                       })}
                   </ul>
               </div>
           </div>
       </div>
    </nav>;
};

export default Header;