import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import UseRequest from '../../hook/UseRequest';
import AuthPanel from './AuthPanel';
import authCopy from './authCopy.json';

const ForgotPassword = () => {
  const [identifier, setIdentifier] = useState('');
  const [isReset, setIsReset] = useState(false);
  const location = useLocation();
  // The endpoint answers every valid request identically, so the page never
  // reads the response body: success is only a 2xx status.
  const { doRequest, errors } = UseRequest({
    url: '/api/auth/forgot-password',
    method: 'post',
    body: { email: identifier },
    onSuccess: () => setIsReset(true),
  });

  const onSubmit = (event) => {
    event.preventDefault();
    setIsReset(false);
    doRequest();
  };

  return (
    <AuthPanel
      icon="/icons/login.svg"
      title={authCopy.forgotPassword.title}
      subtitle="Enter your username or email to reset your password."
      footer={(
        <Link
          className="auth-card__link inline-control-target"
          to={{ pathname: '/login', search: location.search }}
        >
          Back to log in
        </Link>
      )}
    >
      <form className="auth-form" onSubmit={onSubmit}>
        <div className="auth-field">
          <label className="auth-label" htmlFor="forgot-password-identifier">Username or email</label>
          <input
            id="forgot-password-identifier"
            name="username"
            type="text"
            value={identifier}
            onChange={(event) => {
              setIdentifier(event.target.value);
              setIsReset(false);
            }}
            className="form-control auth-control"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            minLength={3}
            maxLength={254}
            required
          />
        </div>
        <div className="auth-errors" aria-live="polite">{errors}</div>
        <button className="btn auth-submit w-100" type="submit">{authCopy.forgotPassword.submit}</button>
      </form>
      {/* Always rendered and never display:none, so assistive tech has the live region before it is filled. */}
      <div className="auth-status" role="status">
        {isReset ? (
          <p className="alert alert-success">{authCopy.forgotPassword.confirmation}</p>
        ) : null}
      </div>
    </AuthPanel>
  );
};

export default ForgotPassword;
