import React  from "react";
import { Link, useLocation } from 'react-router-dom';

const Header = ({ currentUser, uiVariant, theme }) => {
    const location = useLocation();
    const themeOptions = ['dark', 'light'];
    const isV2 = uiVariant === 'v2';

    const links = [
       currentUser && { label: 'Backoffice', href: '/backoffice', icon: '/icons/backoffice.svg' },
       !currentUser && { label: 'Create account', href: '/signup', icon: '/icons/signup.svg' },
       !currentUser && { label: 'Log in', href: '/login', icon: '/icons/login.svg', kind: 'login' },
       currentUser && { label: 'My bets', href: '/bets', icon: '/icons/bets.svg' },
       currentUser && { label: 'Log out', href: '/logout', icon: '/icons/logout.svg' }
     ]
     .filter(Boolean);

    const greetings = (currentUser) ? `welcome, ${currentUser.email}` : '';
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
        ? (isV2 ? '/brand/betstan-v2-mark-dark.svg' : '/brand/betstan-wordmark-dark.svg')
        : (isV2 ? '/brand/betstan-v2-mark-light.svg' : '/brand/betstan-wordmark-light.svg');

    return <nav className={`navbar navbar-expand-lg sticky-top app-navbar${isV2 ? ' app-navbar--v2' : ''} ${theme === 'light' ? 'navbar-light' : 'navbar-dark'}`}> 
       <div className="container-fluid">
           <Link className="navbar-brand mb-0 fw-semibold d-flex align-items-center gap-2" to={logoLink}>
               <img className={`brand-wordmark${isV2 ? ' brand-wordmark--v2' : ''}`} src={brandSource} alt="BetStan" />
           </Link>
           <button className="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#betstan-navbar" aria-controls="betstan-navbar" aria-expanded="false" aria-label="Toggle navigation">
               <span className="navbar-toggler-icon"></span>
           </button>
           <div className="collapse navbar-collapse justify-content-between" id="betstan-navbar">
               <div className="navbar-text small text-secondary py-2 py-lg-0 d-flex flex-column flex-lg-row gap-1 gap-lg-3 navbar-meta">
                   <span>{greetings}</span>
                   <span className="text-uppercase navbar-meta__badge">UI {uiVariant}</span>
                   <span className="text-uppercase navbar-meta__badge">Mode {theme}</span>
               </div>
               <div className="d-flex flex-column flex-lg-row align-items-lg-center gap-2">
                   <div className="btn-group ui-switcher" role="group" aria-label="Theme switcher">
                       {themeOptions.map((themeOption) => (
                           <Link
                               key={themeOption}
                               to={themeLink(themeOption)}
                               className={`btn btn-sm ${theme === themeOption ? 'btn-primary btn-primary--v2' : 'btn-shell btn-shell--v2'}`}
                               title={`${themeOption} mode`}
                           >
                               <img
                                   className="nav-icon nav-icon--small"
                                   src={`/icons/theme-${themeOption}.svg`}
                                   alt=""
                               />
                           </Link>
                       ))}
                   </div>
                   <ul className="navbar-nav align-items-lg-center gap-lg-1">
                       {links.map(({ label, href, icon, kind }) => (
                           <li key={href} className="nav-item">
                               <Link className={isV2 ? `nav-picture-button${kind === 'login' ? ' nav-picture-button--login' : ''}` : 'nav-icon-link'} to={linkTo(href)} title={label}>
                                   {isV2 ? (
                                       <>
                                           <span className="nav-picture-button__icon-wrap">
                                               <img className="nav-icon nav-icon--v2" src={icon} alt="" />
                                           </span>
                                           <span className="nav-picture-button__label">{label}</span>
                                       </>
                                   ) : (
                                       <>
                                           <img className="nav-icon" src={icon} alt="" />
                                           <span className="visually-hidden">{label}</span>
                                       </>
                                   )}
                               </Link>
                           </li>
                       ))}
                   </ul>
               </div>
           </div>
       </div>
    </nav>;
};

export default Header;