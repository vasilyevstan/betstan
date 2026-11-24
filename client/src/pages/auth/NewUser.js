
import React, { useState } from "react";
import { useLocation, useNavigate } from 'react-router-dom';
import UseRequest from "../../hook/UseRequest";
import authCopy from "./authCopy.json";

const HandleNewUser = ({ callback }) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const { doRequest, errors } = UseRequest({
    url: '/api/auth/new',
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
    <form className="auth-form" onSubmit={onSubmit}>
      <div className="auth-field">
        <label className="auth-label" htmlFor="signup-identifier">Username</label>
        <input
          id="signup-identifier"
          name="username"
          type="text"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          className="form-control auth-control"
          aria-describedby="signup-identifier-hint"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          minLength={3}
          maxLength={40}
          pattern="[A-Za-z0-9][A-Za-z0-9._%+@-]*"
          required
        />
        <span className="auth-field__hint" id="signup-identifier-hint">
          3–40 characters, no spaces
        </span>
      </div>
      <div className="auth-field">
        <label className="auth-label" htmlFor="signup-password">Password</label>
        <input
          id="signup-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="form-control auth-control"
          aria-describedby="signup-password-hint"
          autoComplete="new-password"
          minLength={4}
          maxLength={20}
          required
        />
        <span className="auth-field__hint" id="signup-password-hint">
          4–20 characters
        </span>
      </div>
      <div className="auth-errors" aria-live="polite">{errors}</div>
      <button className="btn auth-submit w-100" type="submit">{authCopy.signup.submit}</button>
    </form>
  );
};

export default HandleNewUser;