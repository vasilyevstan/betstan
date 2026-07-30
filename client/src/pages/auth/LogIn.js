
import React, { useState } from "react";
import { Link, useLocation, useNavigate } from 'react-router-dom';
import UseRequest from "../../hook/UseRequest";
import AuthPanel from "./AuthPanel";

const HandleLogIn = ({callback}) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const { doRequest, errors } = UseRequest({
    url: '/api/auth/login',
    method: 'post',
    body: {
      email: identifier,
      password,
    },
    onSuccess: () => {
      navigate({ pathname: '/', search: location.search });
      callback();
    }
  });

  const onSubmit = (event) => {
    event.preventDefault();
    doRequest();
  };

  return (
    <AuthPanel
      icon="/icons/login.svg"
      title="Log in to your account"
      subtitle="Enter your username or email and password to continue."
      footer={(
        <>
          <span>New to BetStan?</span>
          <Link
            className="auth-card__link"
            to={{ pathname: '/signup', search: location.search }}
          >
            Create an account
          </Link>
        </>
      )}
    >
      <form className="auth-form" onSubmit={onSubmit}>
        <div className="auth-field">
          <label className="auth-label" htmlFor="login-identifier">Username or email</label>
          <input
            id="login-identifier"
            name="username"
            type="text"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            className="form-control auth-control"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            minLength={3}
            maxLength={254}
            required
          />
        </div>
        <div className="auth-field">
          <label className="auth-label" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="form-control auth-control"
            autoComplete="current-password"
            required
          />
        </div>
        <div className="auth-errors" aria-live="polite">{errors}</div>
        <button className="btn auth-submit w-100" type="submit">Log in</button>
      </form>
    </AuthPanel>
  );
};

export default HandleLogIn;