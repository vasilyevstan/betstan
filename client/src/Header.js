import React from "react";
import { Link, useLocation } from 'react-router-dom';
import getRouteIdentity from './routeIdentity';

const Header = ({ currentUser, uiVariant, theme }) => {
    const location = useLocation();
    const routeIdentity = getRouteIdentity(location.pathname);
    const variantOptions = [
       { value: 'v1', label: 'Standard' },
       { value: 'v2', label: 'Compact' },
       { value: 'v3', label: 'Spacious' },
    ];
    const themeOptions = ['dark', 'light'];
    const explicitRouteIdentities = new Set([
       '/backoffice', '/bets', '/login', '/logout', '/signup', '/telemetry',
    ]);
    const isEventsRoute = routeIdentity === '/' || !explicitRouteIdentities.has(routeIdentity);

    const links = [
       { label: 'Events', href: '/', current: isEventsRoute },
       { label: 'Backoffice', href: '/backoffice' },
       { label: 'Telemetry', href: '/telemetry' },
       !currentUser && { label: 'Create account', href: '/signup' },
       !currentUser && { label: 'Log in', href: '/login', kind: 'primary' },
       currentUser && { label: 'My bets', href: '/bets' },
       currentUser && { label: 'Log out', href: '/logout' }
     ]
     .filter(Boolean);

    const displayName = currentUser
        ? (currentUser.email.split('@')[0].slice(0, 16))
        : '';
    const initial = displayName ? displayName[0].toUpperCase() : '';
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
    const variantLink = (nextVariant) => ({
       pathname: location.pathname,
       search: buildSearch({ ui: nextVariant }),
    });
    const brandSource = theme === 'dark'
        ? '/brand/betstan-wordmark-dark.svg'
        : '/brand/betstan-wordmark-light.svg';

    return <nav
       aria-label="Primary navigation"
       className={`navbar sticky-top app-navbar ${theme === 'light' ? 'navbar-light' : 'navbar-dark'}`}
    >
       <div className="container-fluid">
           <Link className="navbar-brand mb-0 fw-semibold d-flex align-items-center gap-2" to={logoLink}>
               <img className="brand-wordmark" src={brandSource} alt="BetStan home" />
           </Link>
           <div className="app-navbar__content">
               <div className="navbar-meta">
                   {currentUser && (
                       <div className="user-chip" title={currentUser.email}>
                           <span className="user-chip__avatar">{initial}</span>
                           <span className="user-chip__name">{displayName}</span>
                       </div>
                   )}
               </div>
               <div className="app-navbar__workspace">
                   <div className="presentation-control" role="group" aria-label="Layout">
                       <span className="presentation-control__label">Layout</span>
                       <div className="presentation-control__options">
                           {variantOptions.map(({ value, label }) => (
                               <Link
                                   aria-current={uiVariant === value ? 'true' : undefined}
                                   className={`presentation-option${uiVariant === value ? ' presentation-option--active' : ''}`}
                                   key={value}
                                   to={variantLink(value)}
                               >
                                   {uiVariant === value ? <span aria-hidden="true">✓ </span> : null}
                                   {label}
                               </Link>
                           ))}
                       </div>
                   </div>
                   <div className="presentation-control" role="group" aria-label="Theme">
                       <span className="presentation-control__label">Theme</span>
                       <div className="presentation-control__options">
                       {themeOptions.map((themeOption) => (
                           <Link
                               aria-current={theme === themeOption ? 'true' : undefined}
                               key={themeOption}
                               to={themeLink(themeOption)}
                               className={`presentation-option${theme === themeOption ? ' presentation-option--active' : ''}`}
                           >
                               {theme === themeOption ? <span aria-hidden="true">✓ </span> : null}
                               {themeOption === 'dark' ? 'Dark' : 'Light'}
                           </Link>
                       ))}
                       </div>
                   </div>
                   <ul className="navbar-nav app-navbar__links">
                       {links.map(({ label, href, kind, current }) => {
                           const isCurrent = current ?? routeIdentity === getRouteIdentity(href);
                           return <li key={href} className="nav-item">
                               <Link
                                   aria-current={isCurrent ? 'page' : undefined}
                                   className={`app-nav-link${kind === 'primary' ? ' app-nav-link--primary' : ''}`}
                                   title={label}
                                   to={linkTo(href)}
                               >
                                   <span className="app-nav-link__label">{label}</span>
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