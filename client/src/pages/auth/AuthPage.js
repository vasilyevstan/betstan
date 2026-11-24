import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import TabList from '../../components/TabList';
import AuthPanel from './AuthPanel';
import LogIn from './LogIn';
import NewUser from './NewUser';
import authCopy from './authCopy.json';

// The route is the single source of truth for the active tab, so deep links to
// /signup and browser back/forward keep working. Only the active form is mounted.
const authTabs = {
  login: {
    path: '/login',
    icon: '/icons/login.svg',
    subtitle: 'Enter your username or email and password to continue.',
    Form: LogIn,
  },
  signup: {
    path: '/signup',
    icon: '/icons/signup.svg',
    subtitle: 'Choose a username and password to get started.',
    Form: NewUser,
  },
};

const tabs = Object.keys(authTabs).map((id) => ({ id, label: authCopy[id].tab }));

const AuthPage = ({ tab = 'login', callback }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { icon, subtitle, Form } = authTabs[tab];

  return (
    <AuthPanel
      icon={icon}
      title={authCopy[tab].title}
      subtitle={subtitle}
      footer={tab === 'login' ? (
        <Link
          className="auth-card__link inline-control-target"
          to={{ pathname: '/forgot-password', search: location.search }}
        >
          Forgot password?
        </Link>
      ) : null}
    >
      <TabList
        idPrefix="auth"
        label="Account access"
        tabs={tabs}
        activeId={tab}
        onChange={(id) => navigate({ pathname: authTabs[id].path, search: location.search })}
      />
      <div role="tabpanel" id={`auth-panel-${tab}`} aria-labelledby={`auth-tab-${tab}`}>
        <Form callback={callback} />
      </div>
    </AuthPanel>
  );
};

export default AuthPage;
