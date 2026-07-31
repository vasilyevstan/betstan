import React from 'react';

const AuthPanel = ({ icon, title, subtitle, children, footer }) => (
  <section className="card auth-card" aria-labelledby="auth-panel-title">
    <div className="card-body">
      <header className="auth-card__header">
        <span className="auth-card__icon" aria-hidden="true">
          <img src={icon} alt="" />
        </span>
        <h1 className="auth-card__title" id="auth-panel-title">{title}</h1>
        <p className="auth-card__subtitle">{subtitle}</p>
      </header>
      {children}
      <footer className="auth-card__footer">{footer}</footer>
    </div>
  </section>
);

export default AuthPanel;
